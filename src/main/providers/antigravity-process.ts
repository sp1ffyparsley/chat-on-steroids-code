/**
 * Persistent Antigravity CLI process boundary.
 *
 * This module is dormant: constructing the class does not start `agy`, and the application does
 * not instantiate it today. A future opted-in adapter can keep one class instance warm and feed it
 * one prompt at a time. Tests inject a synthetic child process; no provider authentication or live
 * account is required.
 */

import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import type { Readable, Writable } from 'node:stream';
import { StringDecoder } from 'node:string_decoder';
import type {
  ProviderFailure,
  ProviderProgressEvent,
  ProviderProgressSink,
  ProviderTerminalResult
} from '../../shared/provider-adapter.js';
import { logInfo, logWarn } from '../logger.js';
import {
  AntigravityNdjsonParser,
  AntigravityProtocolError,
  antigravityStepWorkState,
  antigravityTerminalWorkState,
  classifyAntigravityFailure,
  normalizeAntigravityResult,
  normalizeAntigravityUsage,
  type AntigravityInitEvent,
  type AntigravityResultEvent,
  type AntigravityStepUpdateEvent,
  type AntigravityStreamEvent
} from './antigravity-stream.js';

const DEFAULT_STARTUP_TIMEOUT_MS = 15_000;
const DEFAULT_CLOSE_TIMEOUT_MS = 5_000;
const MAX_STDERR_CHARS = 16_384;
const MAX_TOOL_ERROR_CHARS = 1_024;

export interface AntigravityChildProcess extends EventEmitter {
  stdin: Writable;
  stdout: Readable;
  stderr: Readable;
  pid?: number;
  exitCode: number | null;
  kill(signal?: NodeJS.Signals | number): boolean;
}

export type AntigravitySpawn = (
  executable: string,
  args: readonly string[],
  options: { cwd: string; windowsHide: true; stdio: ['pipe', 'pipe', 'pipe']; shell: false }
) => AntigravityChildProcess;

export interface AntigravityProcessOptions {
  cwd: string;
  selectedModel: string;
  nativeConversationId?: string | null;
  executable?: string;
  startupTimeoutMs?: number;
  closeTimeoutMs?: number;
  spawnProcess?: AntigravitySpawn;
  now?: () => number;
  onConversation?: (nativeConversationId: string) => void | Promise<void>;
}

export interface AntigravityTurnHooks {
  /** Durable submission intent. The process writes stdin only after this resolves. */
  beforeWrite: () => void | Promise<void>;
  onAccepted?: () => void | Promise<void>;
  onTerminal?: (result: ProviderTerminalResult, accepted: boolean) => void | Promise<void>;
  progress?: ProviderProgressSink;
}

interface PendingTurn {
  turnId: string;
  hooks: AntigravityTurnHooks;
  resolve: (result: ProviderTerminalResult) => void;
  reject: (error: Error) => void;
  accepted: boolean;
  sawProviderWork: boolean;
  /** True once the durable beforeWrite barrier has committed, before stdin I/O starts. */
  submitted: boolean;
  /** Diagnostics only for this turn so an old stderr notice cannot classify a later failure. */
  stderrTail: string;
  settled: boolean;
}

export class AntigravityProcessError extends Error {
  readonly failure: ProviderFailure;

  constructor(message: string, failure: ProviderFailure) {
    super(message);
    this.name = 'AntigravityProcessError';
    this.failure = failure;
  }
}

function defaultSpawn(
  executable: string,
  args: readonly string[],
  options: { cwd: string; windowsHide: true; stdio: ['pipe', 'pipe', 'pipe']; shell: false }
): AntigravityChildProcess {
  return spawn(executable, [...args], options) as AntigravityChildProcess;
}

function validateRequired(value: string, label: string): string {
  const clean = value.trim();
  if (!clean) throw new Error(`${label} must not be empty`);
  return clean;
}

function toolActivity(step: AntigravityStepUpdateEvent['step_update']): ProviderProgressEvent['tool'] {
  if (step.step_type !== 'tool') return undefined;
  const info = step.tool_info;
  const name = step.tool_name ?? info?.name ?? 'unknown';
  const error = info?.error?.message ?? info?.error?.type;
  return {
    name,
    // Raw tool parameters/output may contain credentials or multi-megabyte payloads. Higher-level
    // recording has explicit redaction owners; this process boundary publishes only bounded status.
    ...(error ? { error: error.slice(0, MAX_TOOL_ERROR_CHARS) } : {})
  };
}

function subagentRefs(value: unknown): ProviderProgressEvent['subagents'] {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const candidates = (value as Record<string, unknown>)['subagents'];
  if (!Array.isArray(candidates)) return undefined;
  const refs = candidates.flatMap(item => {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) return [];
    const raw = item as Record<string, unknown>;
    return [{
      ...(typeof raw['conversation_id'] === 'string' ? { nativeConversationId: raw['conversation_id'] } : {}),
      ...(typeof raw['role'] === 'string' ? { role: raw['role'] } : {}),
      ...(typeof raw['type_name'] === 'string' ? { type: raw['type_name'] } : {})
    }];
  });
  return refs.length ? refs : undefined;
}

function terminalSignature(event: AntigravityResultEvent): string {
  return JSON.stringify([
    event.result.conversation_id,
    event.result.status,
    event.result.response,
    event.result.error ?? '',
    event.result.num_turns ?? null
  ]);
}

/**
 * One warmed Antigravity CLI stream. It deliberately has no internal turn queue: provider-level
 * fairness/concurrency belongs to higher orchestration, and overlapping writes are refused here.
 */
export class AntigravityCliProcess {
  private readonly options: Required<Pick<AntigravityProcessOptions, 'cwd' | 'selectedModel'>> & AntigravityProcessOptions;
  private child: AntigravityChildProcess | null = null;
  private parser = new AntigravityNdjsonParser();
  private stdoutDecoder = new StringDecoder('utf8');
  private stderrDecoder = new StringDecoder('utf8');
  private stderrTail = '';
  private ready = false;
  private opening: Promise<void> | null = null;
  private openingResolve: (() => void) | null = null;
  private openingReject: ((error: Error) => void) | null = null;
  private openingTimer: NodeJS.Timeout | null = null;
  private eventWork: Promise<void> = Promise.resolve();
  private current: PendingTurn | null = null;
  private nativeConversationId: string | null;
  private availableTools: string[] = [];
  private lastTerminalSignature: string | null = null;
  private stopping = false;
  private processGeneration = 0;
  private readonly closedChildren = new WeakSet<AntigravityChildProcess>();
  private readonly closeWork = new WeakMap<AntigravityChildProcess, Promise<void>>();
  /** A retired child still owns the provider slot until its real `close` event is observed. */
  private retiringChild: AntigravityChildProcess | null = null;
  private retirement: Promise<void> | null = null;
  /** Sticky fail-closed state when an owned child cannot be proven closed. */
  private lifecycleFailure: AntigravityProcessError | null = null;

  constructor(options: AntigravityProcessOptions) {
    this.options = {
      ...options,
      cwd: validateRequired(options.cwd, 'cwd'),
      selectedModel: validateRequired(options.selectedModel, 'selectedModel')
    };
    this.nativeConversationId = options.nativeConversationId?.trim() || null;
  }

  capabilities(): {
    persistentSession: true;
    nativeResume: true;
    cancellation: 'process';
    modelDiscovery: true;
    mcp: true;
    tools: true;
  } {
    return {
      persistentSession: true,
      nativeResume: true,
      cancellation: 'process',
      modelDiscovery: true,
      mcp: true,
      tools: true
    };
  }

  inspect(): {
    running: boolean;
    ready: boolean;
    nativeConversationId: string | null;
    selectedModel: string;
    availableTools: readonly string[];
    busy: boolean;
  } {
    return {
      running:
        (this.child !== null && this.child.exitCode === null) ||
        (this.retiringChild !== null && this.retiringChild.exitCode === null),
      ready: this.ready,
      nativeConversationId: this.nativeConversationId,
      selectedModel: this.options.selectedModel,
      availableTools: [...this.availableTools],
      busy: this.current !== null
    };
  }

  private spawnArgs(): string[] {
    return [
      '--input-format', 'stream-json',
      '--output-format', 'stream-json',
      '--model', this.options.selectedModel,
      ...(this.nativeConversationId ? ['--conversation', this.nativeConversationId] : [])
    ];
  }

  private appendStderr(chunk: string): void {
    if (!chunk) return;
    this.stderrTail = `${this.stderrTail}${chunk}`.slice(-MAX_STDERR_CHARS);
    const current = this.current;
    if (current && !current.settled) {
      current.stderrTail = `${current.stderrTail}${chunk}`.slice(-MAX_STDERR_CHARS);
    }
  }

  private enqueueEvent(event: AntigravityStreamEvent, generation: number): void {
    this.eventWork = this.eventWork
      .then(() => this.handleEvent(event, generation))
      .catch(error => this.failProtocol(error instanceof Error ? error : new Error(String(error)), generation));
  }

  private onStdoutData(chunk: Buffer | string, generation: number): void {
    if (generation !== this.processGeneration) return;
    try {
      const text = typeof chunk === 'string' ? chunk : this.stdoutDecoder.write(chunk);
      for (const event of this.parser.push(text)) this.enqueueEvent(event, generation);
    } catch (error) {
      this.failProtocol(error instanceof Error ? error : new Error(String(error)), generation);
    }
  }

  private onStderrData(chunk: Buffer | string, generation: number): void {
    if (generation !== this.processGeneration) return;
    this.appendStderr(typeof chunk === 'string' ? chunk : this.stderrDecoder.write(chunk));
  }

  private async onProcessClosed(
    child: AntigravityChildProcess,
    generation: number,
    code: number | null,
    signal: NodeJS.Signals | null
  ): Promise<void> {
    if (this.child !== child || generation !== this.processGeneration) return;
    try {
      const stdoutTail = this.stdoutDecoder.end();
      if (stdoutTail) for (const event of this.parser.push(stdoutTail)) this.enqueueEvent(event, generation);
      for (const event of this.parser.finish()) this.enqueueEvent(event, generation);
      this.appendStderr(this.stderrDecoder.end());
    } catch (error) {
      this.failProtocol(error instanceof Error ? error : new Error(String(error)), generation);
    }
    // stdout data events are delivered before close, but durable progress hooks may still be
    // settling. Let that ordered chain publish a terminal result before deciding it was lost.
    await this.eventWork.catch(() => undefined);
    if (this.child !== child || generation !== this.processGeneration) return;
    this.child = null;
    this.ready = false;
    this.rejectOpening(this.processFailure(
      `Antigravity CLI closed before initialization (exit ${code ?? 'none'}, signal ${signal ?? 'none'}).`
    ));
    const current = this.current;
    if (current && !current.settled) {
      this.rejectTurn(current, this.processFailure(
        `Antigravity CLI closed before turn ${current.turnId} produced a terminal result.`,
        !current.submitted
      ));
    }
    if (!this.stopping) logWarn(`antigravity process closed exit=${code ?? 'none'} signal=${signal ?? 'none'}`);
  }

  private processFailure(message: string, safeToRetry = !this.current?.submitted): AntigravityProcessError {
    // stderr has no turn identity and can arrive after a previous stdout terminal result. It is
    // safe as startup diagnostics only; after the first terminal envelope, classify process
    // failures from their own message rather than borrowing stale stderr from another turn.
    const diagnostics = this.lastTerminalSignature === null
      ? (this.current?.stderrTail ?? this.stderrTail)
      : '';
    const classified = classifyAntigravityFailure(message, diagnostics);
    const failure = classified.kind === 'provider'
      ? {
          ...classified,
          kind: 'unavailable' as const,
          message,
          advice: {
            ...classified.advice,
            retryable: safeToRetry,
            reason: safeToRetry
              ? 'The provider process failed before a turn crossed the transport boundary.'
              : 'The provider process failed after submission began; inspect durable state before any retry.'
          }
        }
      : safeToRetry
        ? classified
        : {
            ...classified,
            advice: {
              ...classified.advice,
              retryable: false,
              reason: 'The provider process failed after submission began; inspect durable state before any retry.'
            }
          };
    return new AntigravityProcessError(message, failure);
  }

  private shutdownDeadlineMs(): number {
    return Math.max(1, this.options.closeTimeoutMs ?? DEFAULT_CLOSE_TIMEOUT_MS);
  }

  private lifecycleCloseFailure(reason: string): AntigravityProcessError {
    return new AntigravityProcessError(
      `Antigravity CLI ownership is unresolved after ${reason}.`,
      {
        kind: 'unavailable',
        message: `Antigravity CLI ownership is unresolved after ${reason}.`,
        advice: {
          retryable: false,
          retryAfterMs: null,
          reason: 'The owned provider process did not reach its close event; do not start another process until ownership is reconciled.'
        }
      }
    );
  }

  private waitForChildClose(child: AntigravityChildProcess): Promise<boolean> {
    if (this.closedChildren.has(child)) return Promise.resolve(true);
    return new Promise(resolve => {
      let settled = false;
      const finish = (closed: boolean): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        child.off('close', onClose);
        resolve(closed);
      };
      const onClose = (): void => finish(true);
      child.once('close', onClose);
      const timer = setTimeout(() => finish(false), this.shutdownDeadlineMs());
      timer.unref?.();
    });
  }

  private async awaitChildCloseHandling(child: AntigravityChildProcess): Promise<void> {
    const work = this.closeWork.get(child);
    if (work) await work;
    else await this.eventWork.catch(() => undefined);
  }

  /**
   * Retires an invalid process incarnation without relinquishing ownership early. A replacement may
   * spawn only after the old child emits its real `close` event. If that proof never arrives, this
   * process owner stays fail-closed for the rest of its lifetime.
   */
  private retireChild(child: AntigravityChildProcess, reason: string): void {
    if (this.retiringChild === child && this.retirement) return;
    if (this.lifecycleFailure) return;

    if (this.child === child) {
      this.child = null;
      this.ready = false;
      this.processGeneration += 1;
    }
    this.retiringChild = child;

    const work = (async () => {
      if (!this.closedChildren.has(child)) {
        if (child.exitCode === null) child.kill();
        if (!(await this.waitForChildClose(child))) {
          // An exited process can still hold its stdio close event behind open pipes. We own all
          // three streams, so retire those handles before the final bounded close proof.
          child.stdin.destroy();
          child.stdout.destroy();
          child.stderr.destroy();
          if (child.exitCode === null) child.kill();
          if (!(await this.waitForChildClose(child))) throw this.lifecycleCloseFailure(reason);
        }
      }
      await this.awaitChildCloseHandling(child);
    })();

    this.retirement = work;
    void work.then(
      () => {
        if (this.retirement === work) this.retirement = null;
        if (this.retiringChild === child) this.retiringChild = null;
      },
      error => {
        const failure = error instanceof AntigravityProcessError
          ? error
          : this.lifecycleCloseFailure(reason);
        this.lifecycleFailure = failure;
        if (this.retirement === work) this.retirement = null;
        logWarn(`antigravity process retirement failed: ${failure.message}`);
      }
    );
  }

  private async awaitRetirement(): Promise<void> {
    if (this.lifecycleFailure) throw this.lifecycleFailure;
    const work = this.retirement;
    if (work) {
      try {
        await work;
      } catch {
        // The attached retirement handler records the canonical sticky lifecycle failure.
      }
    }
    if (this.lifecycleFailure) throw this.lifecycleFailure;
  }

  private rejectTurn(current: PendingTurn, error: Error): void {
    if (current.settled) return;
    current.settled = true;
    if (this.current === current) this.current = null;
    current.reject(error);
  }

  private failProtocol(error: Error, generation = this.processGeneration): void {
    if (generation !== this.processGeneration) return;
    const protocol = error instanceof AntigravityProtocolError
      ? error
      : new AntigravityProtocolError(error.message);
    this.rejectOpening(protocol);
    const current = this.current;
    if (current) this.rejectTurn(current, protocol);
    const child = this.child;
    if (child) this.retireChild(child, 'stream protocol failure');
    logWarn(`antigravity stream protocol failure: ${protocol.message}`);
  }

  private async handleInit(event: AntigravityInitEvent, generation: number): Promise<void> {
    if (generation !== this.processGeneration) return;
    if (this.ready) {
      if (event.conversation_id === this.nativeConversationId) return;
      throw new AntigravityProtocolError('Antigravity emitted a second conflicting init event');
    }
    if (this.nativeConversationId && event.conversation_id !== this.nativeConversationId) {
      throw new AntigravityProtocolError('Antigravity resumed a different conversation than requested');
    }
    if (event.init.model && event.init.model !== this.options.selectedModel) {
      throw new AntigravityProtocolError(
        `Antigravity opened model ${event.init.model} instead of pinned model ${this.options.selectedModel}`
      );
    }
    this.nativeConversationId = event.conversation_id;
    this.availableTools = event.init.tools ? [...event.init.tools] : [];
    await this.options.onConversation?.(event.conversation_id);
    // The durable hook may be slower than the startup deadline. Never let its late completion
    // resurrect a process incarnation that the timeout already retired.
    if (
      generation !== this.processGeneration ||
      !this.child ||
      this.child.exitCode !== null
    ) return;
    this.ready = true;
    this.resolveOpening();
    logInfo(`antigravity process ready model=${this.options.selectedModel} tools=${this.availableTools.length}`);
  }

  private assertConversation(conversationId: string): void {
    if (!this.nativeConversationId) throw new AntigravityProtocolError('Antigravity activity arrived before init');
    if (conversationId !== this.nativeConversationId) {
      throw new AntigravityProtocolError('Antigravity activity changed native conversation identity');
    }
  }

  private progress(
    current: PendingTurn,
    event: Omit<ProviderProgressEvent, 'providerId' | 'time' | 'nativeConversationId'>
  ): Promise<void> {
    if (!current.hooks.progress) return Promise.resolve();
    return Promise.resolve(current.hooks.progress({
      providerId: 'antigravity',
      time: this.options.now?.() ?? Date.now(),
      nativeConversationId: this.nativeConversationId,
      ...event
    }));
  }

  private async acceptCurrent(current: PendingTurn): Promise<void> {
    if (current.accepted) return;
    if (this.current !== current || !current.submitted) {
      throw new AntigravityProtocolError('Antigravity accepted a turn before its local submission barrier');
    }
    current.accepted = true;
    await current.hooks.onAccepted?.();
    await this.progress(current, { state: 'accepted', nativeEvent: { type: 'user_input', state: 'DONE' } });
    logInfo(`antigravity turn accepted id=${current.turnId}`);
  }

  private async handleStep(event: AntigravityStepUpdateEvent): Promise<void> {
    const step = event.step_update;
    this.assertConversation(step.conversation_id);
    const current = this.current;
    if (!current) throw new AntigravityProtocolError('Antigravity emitted step activity with no active local turn');
    if (!current.submitted) {
      throw new AntigravityProtocolError('Antigravity emitted turn activity before the prompt was submitted');
    }
    if (step.step_type === 'user_input' && step.state === 'DONE') {
      await this.acceptCurrent(current);
      return;
    }
    current.sawProviderWork = true;
    const state = antigravityStepWorkState(step);
    if (!state) return;
    const tool = toolActivity(step);
    const subagents = subagentRefs(step.subagent_info);
    await this.progress(current, {
      state,
      ...(step.text_delta !== undefined ? { textDelta: step.text_delta } : {}),
      ...(step.tool_name ? { toolName: step.tool_name } : {}),
      nativeEvent: { type: step.step_type, index: step.step_index, state: step.state },
      ...(tool ? { tool } : {}),
      ...(subagents ? { subagents } : {}),
      ...(step.usage ? { usage: normalizeAntigravityUsage(step.usage, 'step')! } : {})
    });
  }

  private async handleResult(event: AntigravityResultEvent): Promise<void> {
    const signature = terminalSignature(event);
    if (signature === this.lastTerminalSignature) {
      logWarn('antigravity duplicate terminal result ignored');
      return;
    }
    const current = this.current;
    if (!current) {
      throw new AntigravityProtocolError('Antigravity emitted a terminal result with no active local turn');
    }

    if (!this.ready) {
      if (!['ERROR', 'INVALID'].includes(event.result.status)) {
        throw new AntigravityProtocolError(
          `Antigravity returned ${event.result.status} before its init event`
        );
      }
      const result = normalizeAntigravityResult(event, current.stderrTail);
      const failure = result.failure ?? classifyAntigravityFailure(event.result.error ?? '', current.stderrTail);
      const startupError = new AntigravityProcessError(
        `Antigravity failed before initialization: ${failure.message}`,
        failure
      );
      this.rejectOpening(startupError);
      const child = this.child;
      if (child) this.retireChild(child, 'pre-init terminal failure');
      return;
    }

    if (!event.result.conversation_id) {
      throw new AntigravityProtocolError('Antigravity terminal result lost its initialized conversation id');
    }
    this.assertConversation(event.result.conversation_id);
    if (!current.submitted) {
      throw new AntigravityProtocolError('Antigravity returned a turn result before the prompt was submitted');
    }
    // A result is provider-correlated; stderr is not. Never let an untagged late stderr line from
    // an earlier turn change this turn's failure class or retry advice.
    const result = normalizeAntigravityResult(event);
    const accepted = current.accepted || current.sawProviderWork || result.outcome === 'completed';
    if (accepted) await this.acceptCurrent(current);
    await this.progress(current, { state: antigravityTerminalWorkState(result) });
    await current.hooks.onTerminal?.(result, accepted);
    current.settled = true;
    this.current = null;
    this.lastTerminalSignature = signature;
    current.resolve(result);
    logInfo(`antigravity turn terminal id=${current.turnId} status=${result.providerStatus} outcome=${result.outcome}`);
  }

  private async handleEvent(event: AntigravityStreamEvent, generation: number): Promise<void> {
    if (generation !== this.processGeneration) return;
    if (event.event === 'unknown') {
      logWarn(`antigravity ignored unknown stream event type=${event.eventName.slice(0, 80)}`);
      return;
    }
    if (event.event === 'init') return this.handleInit(event, generation);
    if (event.event === 'step_update') return this.handleStep(event);
    return this.handleResult(event);
  }

  private clearOpeningTimer(): void {
    if (this.openingTimer) clearTimeout(this.openingTimer);
    this.openingTimer = null;
  }

  private resolveOpening(): void {
    const resolve = this.openingResolve;
    this.openingResolve = null;
    this.openingReject = null;
    this.clearOpeningTimer();
    resolve?.();
  }

  private rejectOpening(error: Error): void {
    const reject = this.openingReject;
    this.openingResolve = null;
    this.openingReject = null;
    this.clearOpeningTimer();
    reject?.(error);
  }

  private async open(): Promise<void> {
    if (this.stopping) throw new Error('Antigravity process is stopping');
    await this.awaitRetirement();
    if (this.ready && this.child && this.child.exitCode === null) return;
    if (this.opening) return this.opening;

    this.opening = (async () => {
      this.parser = new AntigravityNdjsonParser();
      this.stdoutDecoder = new StringDecoder('utf8');
      this.stderrDecoder = new StringDecoder('utf8');
      this.stderrTail = '';
      this.availableTools = [];
      this.ready = false;
      const spawnProcess = this.options.spawnProcess ?? defaultSpawn;
      const executable = this.options.executable?.trim() || 'agy';
      const child = spawnProcess(executable, this.spawnArgs(), {
        cwd: this.options.cwd,
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
        shell: false
      });
      this.child = child;
      const generation = ++this.processGeneration;
      child.stdout.on('data', chunk => this.onStdoutData(chunk as Buffer | string, generation));
      child.stderr.on('data', chunk => this.onStderrData(chunk as Buffer | string, generation));
      child.once('error', error => {
        if (generation !== this.processGeneration) return;
        this.appendStderr(error.message);
        void this.onProcessClosed(child, generation, child.exitCode, null);
      });
      child.once('close', (code: number | null, signal: NodeJS.Signals | null) => {
        this.closedChildren.add(child);
        const work = this.onProcessClosed(child, generation, code, signal);
        this.closeWork.set(child, work);
        void work;
      });
      logInfo(`antigravity process opening model=${this.options.selectedModel} resume=${this.nativeConversationId ? 'yes' : 'no'}`);
      await new Promise<void>((resolve, reject) => {
        this.openingResolve = resolve;
        this.openingReject = reject;
        this.openingTimer = setTimeout(() => {
          const failure = new AntigravityProcessError(
            'Antigravity CLI did not emit init before the startup deadline.',
            {
              kind: 'startup_timeout',
              message: 'Antigravity CLI did not emit init before the startup deadline.',
              advice: {
                retryable: true,
                retryAfterMs: null,
                reason: 'Startup may be retried because no prompt crossed the durable submission barrier.'
              }
            }
          );
          this.rejectOpening(failure);
          if (this.child === child) {
            this.retireChild(child, 'startup timeout');
          }
        }, Math.max(1, this.options.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS));
        this.openingTimer.unref?.();
      });
    })().finally(() => {
      this.opening = null;
    });
    return this.opening;
  }

  private async startTurn(current: PendingTurn, content: string): Promise<void> {
    try {
      await this.progress(current, { state: 'opening provider' });
      await this.open();
      if (this.current !== current) return;
      await current.hooks.beforeWrite();
      current.submitted = true;
      if (this.current !== current || !this.child || this.child.exitCode !== null) {
        throw this.processFailure(
          'Antigravity process became unavailable before the prompt could be written.',
          false
        );
      }
      const message = JSON.stringify({ event: 'user', message: { content } });
      try {
        await new Promise<void>((writeResolve, writeReject) => {
          this.child!.stdin.write(`${message}\n`, 'utf8', error => error ? writeReject(error) : writeResolve());
        });
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        throw this.processFailure(`Antigravity stdin write failed: ${detail}`, false);
      }
    } catch (error) {
      this.rejectTurn(current, error instanceof Error ? error : new Error(String(error)));
    }
  }

  sendTurn(turnId: string, content: string, hooks: AntigravityTurnHooks): Promise<ProviderTerminalResult> {
    const id = validateRequired(turnId, 'turnId');
    validateRequired(content, 'content');
    if (this.current) {
      return Promise.reject(new Error(`Antigravity process already has active turn ${this.current.turnId}`));
    }

    let resolve!: (result: ProviderTerminalResult) => void;
    let reject!: (error: Error) => void;
    const result = new Promise<ProviderTerminalResult>((res, rej) => { resolve = res; reject = rej; });
    const current: PendingTurn = {
      turnId: id,
      hooks,
      resolve,
      reject,
      accepted: false,
      sawProviderWork: false,
      submitted: false,
      stderrTail: '',
      settled: false
    };
    // Reserve synchronously before any await. The CLI protocol permits exactly one prompt until
    // that prompt's terminal result, so a second caller must never race through process startup.
    this.current = current;
    void this.startTurn(current, content);
    return result;
  }

  /** Process-level interruption; the caller must inspect durable state before any resubmission. */
  async cancelCurrent(): Promise<void> {
    const child = this.child;
    if (!child || child.exitCode !== null || !this.current) return;
    logInfo(`antigravity turn cancellation requested id=${this.current.turnId}`);
    child.kill('SIGINT');
  }

  /** Graceful session close. No prompt is written and no live application process uses this today. */
  async close(): Promise<void> {
    this.stopping = true;
    await this.awaitRetirement();
    if (this.lifecycleFailure) throw this.lifecycleFailure;
    const child = this.child;
    if (!child) return;
    const closeFailure = (): AntigravityProcessError => this.lifecycleCloseFailure('bounded shutdown');

    if (child.exitCode === null) {
      try {
        child.stdin.end();
      } catch {
        if (!child.kill()) throw closeFailure();
      }
    }
    if (await this.waitForChildClose(child)) {
      await this.awaitChildCloseHandling(child);
      return;
    }
    if (child.exitCode === null) {
      logWarn('antigravity process did not exit after stdin closed; forcing owned child shutdown');
      if (!child.kill()) throw closeFailure();
    } else {
      // Node may publish `exit`/exitCode before stdio has closed. We own these three pipes, so close
      // them after the graceful deadline to unblock the actual `close` lifecycle event.
      child.stdin.destroy();
      child.stdout.destroy();
      child.stderr.destroy();
    }
    if (!(await this.waitForChildClose(child))) throw closeFailure();
    await this.awaitChildCloseHandling(child);
  }
}
