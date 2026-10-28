import { promises as fs } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { collectSupportReport, type SupportReportProbes } from '../src/main/support-report.js';
import { formatSupportReport, MAX_SUPPORT_REPORT_BYTES } from '../src/shared/support-report.js';
import { defaultConfig, initConfigPath, saveConfig } from '../src/main/config.js';
import { makeTempDir, removeTempDir } from './helpers.js';

const privateText = 'SECRET draft prompt token request-private-native-id C:\\private\\project';
function probes(): SupportReportProbes {
  return {
    runtime: () => ({ appVersion: '2.1.39', packaged: true, platform: 'win32', arch: 'x64', nodeVersion: '24.19.0', electronVersion: '44.3.0',
      source: { commit: 'a'.repeat(40), tree: 'b'.repeat(40), dirty: false, checkoutPath: privateText }, credential: privateText }),
    connection: () => ({ state: 'connected', detail: privateText, publicUrl: privateText, localUrl: privateText,
      handshakeAt: 10, lastRequestAt: 11, lastToolCallAt: 12,
      surfaces: [{ id: 'core', state: 'live', available: true, lastRequestAt: 11, lastToolCallAt: 12, connectorName: privateText }] }),
    companion: () => ({ running: true, paired: true, present: true, authState: 'signed-in', extensionVersion: '2.1.39', token: privateText }),
    automation: () => ({ paused: true, admission: 'draining', owner: privateText }),
    lifecycle: () => ({ phase: 'draining-update', admission: { mode: 'draining', owner: privateText }, profileId: privateText,
      blockers: [{ category: 'ambiguous-send', count: 2, detail: privateText }, { category: privateText, count: 1 }] }),
    queue: () => [
      { id: privateText, text: privateText, state: 'queued' },
      { id: privateText, objective: privateText, state: 'failed', recoveryFailure: { phase: 'pre_send_preparation', retrySafe: true, detail: privateText } },
      { id: privateText, state: 'browser', sendAuthorizedAt: 20, recoveryFailure: { phase: 'native_send_ambiguous', retrySafe: false } },
      { id: privateText, state: 'sent', deliveredAt: 30, messageId: privateText },
      { id: privateText, state: 'cancelled', deliveredAt: 30 },
      { id: privateText, state: 'tool', offeredAt: 20 },
      { id: privateText, state: 'queued', deliveryAttentionAt: 40 },
      { id: privateText, state: 'sent' }
    ],
    activity: () => ({ runningTools: 2, settlingTools: 1, mcpRequests: 3, managedProcesses: 1, browserCommands: 2, commandLine: privateText }),
    events: () => [
      { level: 'error', event: 'worker.failed', message: privateText, agent: privateText },
      { level: 'warn', event: 'profile.operation.failed', message: privateText },
      { level: 'error', event: privateText, message: privateText },
      { level: 'info', event: 'input.queued', message: privateText }
    ]
  };
}
let root: string | null = null;
afterEach(async () => {
  vi.restoreAllMocks();
  if (root) await removeTempDir(root);
  root = null;
});

describe('bounded support report', () => {
  it('projects actual states/counts while excluding all arbitrary owner strings and contents', async () => {
    const report = await collectSupportReport(probes(), { now: () => 1_000 });
    expect(report.collection).toBe('complete');
    expect(report.runtime).toMatchObject({ state: 'available', value: { packaged: true, source: { commit: 'a'.repeat(40), dirty: false } } });
    expect(report.lifecycle).toEqual({ state: 'available', value: { phase: 'draining-update', admission: 'draining',
      blockers: [{ category: 'ambiguous-send', count: 2 }, { category: 'other', count: 1 }] } });
    expect(report.queue).toMatchObject({ state: 'available', value: { basis: 'persisted', total: 8, inspected: 8, truncated: false,
      attention: 6, ambiguous: 4, states: { queued: 2, sent: 2, browser: 1, failed: 1, cancelled: 1, tool: 1 } } });
    expect(report.events).toMatchObject({ state: 'available', value: { errors: 2, warnings: 1,
      categories: [{ category: 'worker', errors: 1 }, { category: 'profile', warnings: 1 }, { category: 'other', errors: 1 }] } });
    for (const output of [formatSupportReport(report, 'text'), formatSupportReport(report, 'json')]) {
      expect(output).not.toContain(privateText);
      expect(output).not.toContain('publicUrl');
      expect(output).not.toContain('messageId');
      expect(output).not.toContain('objective');
      expect(Buffer.byteLength(output)).toBeLessThan(MAX_SUPPORT_REPORT_BYTES);
    }
  });

  it('retains useful sections when one subsystem throws a private error and another is not ready', async () => {
    const dependencies = probes();
    dependencies.companion = () => { throw Object.assign(new Error(privateText), { code: 'EACCES' }); };
    dependencies.lifecycle = () => null;
    const report = await collectSupportReport(dependencies);
    expect(report.collection).toBe('partial');
    expect(report.companion).toEqual({ state: 'unavailable', reason: 'permission' });
    expect(report.lifecycle).toEqual({ state: 'unavailable', reason: 'not-ready' });
    expect(report.runtime.state).toBe('available');
    expect(report.queue.state).toBe('available');
    expect(formatSupportReport(report)).not.toContain(privateText);
  });

  it('bounds a stuck probe and consumes a late rejection without suppressing the other results', async () => {
    const dependencies = probes();
    let rejectLate: (error: Error) => void = () => undefined;
    dependencies.connection = () => new Promise((_, reject) => { rejectLate = reject; });
    const report = await collectSupportReport(dependencies, { timeoutMs: 10 });
    expect(report.connection).toEqual({ state: 'unavailable', reason: 'timeout' });
    expect(report.companion.state).toBe('available');
    rejectLate(new Error(privateText));
    await new Promise(resolve => setImmediate(resolve));
    expect(formatSupportReport(report)).not.toContain(privateText);
  });

  it('limits queue inspection and error categories without inventing a complete census', async () => {
    const dependencies = probes();
    dependencies.queue = () => Array.from({ length: 5_001 }, () => ({ state: 'queued', text: privateText }));
    dependencies.events = () => Array.from({ length: 800 }, () => ({ level: 'error', event: privateText, message: privateText }));
    const report = await collectSupportReport(dependencies);
    expect(report.queue).toMatchObject({ state: 'available', value: { total: 5_001, inspected: 5_000, truncated: true, states: { queued: 5_000 } } });
    expect(report.events).toMatchObject({ state: 'available', value: { total: 800, inspected: 500, truncated: true, errors: 500,
      categories: [{ category: 'other', errors: 500 }] } });
  });

  it.each([null, {}, [{ state: 'queued' }, null]])('marks malformed persisted queue data unavailable instead of reporting no work: %j', async value => {
    const dependencies = probes(); dependencies.queue = () => value;
    expect((await collectSupportReport(dependencies)).queue).toEqual({ state: 'unavailable', reason: 'invalid-data' });
  });

  it('keeps one-sided and malformed receipts uncertain while respecting confirmed native receipts', async () => {
    const dependencies = probes();
    dependencies.queue = () => [
      { state: 'browser', sendAuthorizedAt: 1, messageId: '' },
      { state: 'sent', messageId: 'known-native-id' },
      { state: 'sent', deliveredAt: 2 },
      { state: 'sent', deliveredAt: 2, messageId: 'known-native-id' }
    ];
    expect((await collectSupportReport(dependencies)).queue).toMatchObject({ state: 'available', value: { ambiguous: 3, attention: 3 } });
  });

  it('does not mistake ordinary browser authorization prerequisites for blocked or ambiguous work', async () => {
    const dependencies = probes();
    dependencies.queue = () => [{ state: 'browser', requiresAuthorization: true }];
    expect((await collectSupportReport(dependencies)).queue).toMatchObject({ state: 'available', value: { ambiguous: 0, attention: 0, states: { browser: 1 } } });
  });

  it('removes unknown fields again at export instead of trusting a report object supplied by a caller', async () => {
    const report = await collectSupportReport(probes());
    const unsafe = { ...report, prompt: privateText };
    expect(formatSupportReport(unsafe, 'json')).not.toContain(privateText);
  });

  it('rejects duplicate surface identity and negative counters instead of claiming a healthy observation', async () => {
    const dependencies = probes();
    dependencies.connection = () => ({ state: 'connected', surfaces: [{ id: 'core' }, { id: 'core' }] });
    dependencies.activity = () => ({ runningTools: -1, settlingTools: 0, mcpRequests: 0, managedProcesses: 0, browserCommands: 0 });
    const report = await collectSupportReport(dependencies);
    expect(report.connection).toEqual({ state: 'unavailable', reason: 'invalid-data' });
    expect(report.activity).toEqual({ state: 'unavailable', reason: 'invalid-data' });
  });

  it('reads the real active persisted queue without rewriting its bytes or exposing its task text', async () => {
    root = await makeTempDir('cos-support-report-');
    initConfigPath(root);
    await saveConfig(defaultConfig());
    const state = path.join(root, 'state');
    await fs.mkdir(state, { recursive: true });
    const file = path.join(state, 'session-input.json');
    const source = JSON.stringify([{ state: 'queued', text: privateText, stages: ['A stage that must never be materialized by diagnostics'] }]);
    await fs.writeFile(file, source);
    const dependencies = probes();
    const { queue: _queue, ...otherProbes } = dependencies;
    const report = await collectSupportReport(otherProbes);
    expect(report.queue).toMatchObject({ state: 'available', value: { total: 1, states: { queued: 1 } } });
    expect(await fs.readFile(file, 'utf8')).toBe(source);
    expect(formatSupportReport(report)).not.toContain(privateText);
    expect(await fs.readdir(state)).toEqual(['session-input.json']);
  });

  it('refuses oversized and corrupt real queue files without importing their contents', async () => {
    root = await makeTempDir('cos-support-report-bad-');
    initConfigPath(root);
    await saveConfig(defaultConfig());
    const state = path.join(root, 'state'); await fs.mkdir(state, { recursive: true });
    const file = path.join(state, 'session-input.json');
    const { queue: _queue, ...otherProbes } = probes();
    await fs.writeFile(file, Buffer.alloc(8 * 1024 * 1024 + 1));
    expect((await collectSupportReport(otherProbes)).queue).toEqual({ state: 'unavailable', reason: 'oversized' });
    await fs.writeFile(file, '{"private":');
    expect((await collectSupportReport(otherProbes)).queue).toEqual({ state: 'unavailable', reason: 'invalid-data' });
    await fs.unlink(file);
    expect((await collectSupportReport(otherProbes)).queue).toMatchObject({ state: 'available', value: { total: 0 } });
  });
});
