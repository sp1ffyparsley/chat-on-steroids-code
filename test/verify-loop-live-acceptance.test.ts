import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

const SCRIPT = path.resolve('scripts/verify-loop-live-acceptance.mjs');
const MODEL = 'gpt-6-thinking';
const EFFORT = 'high';

type FixtureOptions = {
  anchorDelivery?: 'confirmed' | 'offered';
  nextEffort?: string;
  nextAutomaticGoal?: boolean;
  nextGoalOriginMissing?: boolean;
  nextGoalHasOutboxId?: boolean;
  duplicateAnchorInput?: boolean;
  omitNextCore?: boolean;
  omitNextFinal?: boolean;
  firstCoreEffort?: string;
  nextCoreEffort?: string;
  selectedEffort?: string;
  selectedObservedAt?: number;
  includeRecovery?: boolean;
};

function put(dir: string, name: string, value: unknown): void {
  writeFileSync(path.join(dir, name), JSON.stringify(value), 'utf8');
}

function fixture(options: FixtureOptions = {}): string {
  const root = mkdtempSync(path.join(tmpdir(), 'cos-live-acceptance-'));
  const messages = path.join(root, 'messages');
  mkdirSync(messages);
  put(root, 'meta.json', {
    id: 'fixture-session',
    conversationId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    chatIds: [
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
    ],
    lastCommittedResumeHandoffId: 'fixture-handoff',
    selectedModel: {
      conversationId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      model: MODEL,
      reasoningEffort: options.selectedEffort ?? EFFORT,
      observedAt: options.selectedObservedAt ?? 12
    }
  });
  put(messages, 'anchor.json', {
    seq: 1, time: 1, source: 'app', kind: 'user_message',
    messageId: '11111111-1111-4111-8111-111111111111', inputId: 'input-anchor',
    inputDelivery: options.anchorDelivery ?? 'confirmed', authoredText: 'Start the acceptance task.',
    model: MODEL, reasoningEffort: EFFORT, message: { text: 'Start the acceptance task.', chars: 26, truncated: false }
  });
  put(messages, 'final.json', {
    // Canonical hydration revised this row after later events, but its first position remains 4.
    seq: 11, origin: 4, time: 4, source: 'extension', kind: 'assistant_message', turnId: 'turn-one',
    messageId: '22222222-2222-4222-8222-222222222222', final: true, goalEligible: true,
    message: { text: 'Finished the first turn.', chars: 24, truncated: false }
  });
  put(messages, 'next.json', {
    // Same real recorder shape: seq is the newest revision cursor, origin is chronology.
    seq: 12, origin: 6, time: 6, source: options.nextAutomaticGoal ? 'extension' : 'app', kind: 'user_message',
    messageId: '33333333-3333-4333-8333-333333333333',
    ...(options.nextAutomaticGoal
      ? { ...(!options.nextGoalOriginMissing ? { automationOrigin: 'goal' } : {}),
          ...(options.nextGoalHasOutboxId ? { inputId: 'input-next' } : {}) }
      : { inputId: 'input-next', inputDelivery: 'confirmed' }),
    authoredText: 'Continue the saved Loop objective.', model: MODEL,
    reasoningEffort: options.nextEffort ?? EFFORT,
    message: { text: 'Continue the saved Loop objective.', chars: 34, truncated: false }
  });
  if (!options.omitNextFinal) {
    put(messages, 'next-final.json', {
      seq: 15, origin: 9, time: 9, source: 'extension', kind: 'assistant_message', turnId: 'turn-two',
      messageId: '55555555-5555-4555-8555-555555555555', final: true, goalEligible: true,
      message: { text: 'Finished the subsequent Loop turn.', chars: 34, truncated: false }
    });
  }
  if (options.duplicateAnchorInput) {
    put(messages, 'duplicate.json', {
      seq: 16, origin: 11, time: 11, source: 'app', kind: 'user_message',
      messageId: '44444444-4444-4444-8444-444444444444', inputId: 'input-anchor', inputDelivery: 'confirmed',
      authoredText: 'Start the acceptance task.', model: MODEL, reasoningEffort: EFFORT,
      message: { text: 'Start the acceptance task.', chars: 26, truncated: false }
    });
  }
  const events = [
    { seq: 2, time: 2, source: 'extension', kind: 'turn_start', turnId: 'turn-one' },
    { seq: 5, time: 5, source: 'extension', kind: 'turn_end', turnId: 'turn-one', outcome: 'completed' },
    { seq: 7, time: 7, source: 'extension', kind: 'turn_start', turnId: 'turn-two' },
    ...(!options.omitNextCore ? [{ seq: 8, time: 8, source: 'mcp', kind: 'tool_call', turnId: 'turn-two', call: {
      callId: 'call-two', tool: 'read', attributionMethod: 'request_id', attribution: 'request_id',
      requestId: 'request-two', conversationId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', outcome: 'ok', durationMs: 1,
      model: MODEL, reasoningEffort: options.nextCoreEffort ?? EFFORT
    } }] : []),
    ...(!options.omitNextFinal ? [{ seq: 10, time: 10, source: 'extension', kind: 'turn_end', turnId: 'turn-two', outcome: 'completed' }] : []),
    ...(options.includeRecovery ? [{ seq: 13, time: 13, source: 'app', kind: 'progress', turnId: 'turn-two',
      progressId: 'browser-repair:fixture',
      message: { text: 'Retried the exact failed turn to recover a provider error.', chars: 64, truncated: false } }] : []),
    // Tool attribution can finish after later recorder rows. Same-turn identity, not append seq,
    // keeps this call attached to the first turn (mirrors the real recorder chronology contract).
    { seq: 14, time: 3, source: 'mcp', kind: 'tool_call', turnId: 'turn-one', call: {
      callId: 'call-one', tool: 'read', attributionMethod: 'request_id', attribution: 'request_id',
      requestId: 'request-one', conversationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', outcome: 'ok', durationMs: 1,
      model: MODEL, reasoningEffort: options.firstCoreEffort ?? EFFORT
    } }
  ];
  writeFileSync(path.join(root, 'events.jsonl'), events.map(row => JSON.stringify(row)).join('\n') + '\n', 'utf8');
  return root;
}

function workerFixture(effort = EFFORT): string {
  const root = mkdtempSync(path.join(tmpdir(), 'cos-live-worker-'));
  put(root, 'meta.json', {
    id: 'fixture-worker-session',
    conversationId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    chatIds: ['cccccccc-cccc-4ccc-8ccc-cccccccccccc'],
    origin: { kind: 'worker', fromSessionId: 'fixture-session', agentId: 'worker-1', task: 'Verify the live worker lane.' },
    selectedModel: {
      conversationId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      model: MODEL,
      reasoningEffort: effort,
      observedAt: 20
    }
  });
  const events = [{
    seq: 1, time: 20, source: 'mcp', kind: 'tool_call', turnId: 'worker-turn', call: {
      callId: 'worker-call', tool: 'read', attributionMethod: 'request_id', attribution: 'request_id',
      requestId: 'worker-request', conversationId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      outcome: 'ok', durationMs: 1, model: MODEL, reasoningEffort: effort
    }
  }];
  writeFileSync(path.join(root, 'events.jsonl'), events.map(row => JSON.stringify(row)).join('\n') + '\n', 'utf8');
  return root;
}

function installedProofFixture(runtimeInspector: (port: number) => Promise<Record<string, unknown>>,
  sourceCommit = '9e26f26438147caa41ea9f1bd4d5908799f2adc7', hashes = {
    appExecutableSha256: 'a'.repeat(64),
    appAsarSha256: 'b'.repeat(64),
    extensionBackgroundSha256: 'c'.repeat(64),
    extensionContentSha256: 'd'.repeat(64)
  }) {
  const tools = mkdtempSync(path.join(tmpdir(), 'cos-direct-installed-proof-'));
  const installScript = path.join(tools, 'install-custom.ps1');
  writeFileSync(installScript, [
    'function Assert-InstalledQualifiedBuild {',
    '  param([string]$InstallRoot)',
    `  return [pscustomobject]@{Version='2.1.15';AppExecutableSha256='${hashes.appExecutableSha256}';AppAsarSha256='${hashes.appAsarSha256}';ExtensionBackgroundSha256='${hashes.extensionBackgroundSha256}';ExtensionContentSha256='${hashes.extensionContentSha256}';SourceProvenanceSha256=('e'*64);GitCommit='${sourceCommit}';GitTree='fd752e720a315e2f68aad04697d348e7e12509fc'}`,
    '}'
  ].join('\r\n'), 'utf8');
  const hash = createHash('sha256').update(readFileSync(installScript)).digest('hex');
  return {
    root: tools,
    options: {
      installScript,
      installRoot: tools,
      expectedInstallVerifierSha256: hash,
      expectedInstalledContentSha256: hashes.extensionContentSha256,
      expectedInstalledSourceCommit: sourceCommit,
      runtimeInspector
    }
  };
}

function run(root: string) {
  const result = spawnSync(process.execPath, [SCRIPT,
    '--session-dir', root,
    '--anchor-message', '11111111-1111-4111-8111-111111111111',
    '--next-message', '33333333-3333-4333-8333-333333333333',
    '--expected-model', MODEL,
    '--expected-effort', EFFORT,
    '--core-tool', 'read',
    '--require-resume'
  ], { encoding: 'utf8' });
  let report: any = null;
  try { report = JSON.parse(result.stdout || '{}'); } catch { /* assertion below exposes stderr */ }
  return { ...result, report };
}

async function verifyDirect(root: string, extra: Record<string, unknown> = {}) {
  const module = await import(pathToFileURL(SCRIPT).href) as any;
  return module.verifyLoopLiveAcceptance({
    sessionDir: root,
    anchorMessage: '11111111-1111-4111-8111-111111111111',
    nextMessage: '33333333-3333-4333-8333-333333333333',
    expectedModel: MODEL,
    expectedEffort: EFFORT,
    coreTool: 'read',
    requireResume: true,
    requireProviderRecovery: false,
    expectedChecklistCount: 6,
    ...extra
  });
}

function runWithInstalledProof(root: string, tamperVerifierHash = false, reject = false) {
  const tools = mkdtempSync(path.join(tmpdir(), 'cos-installed-proof-'));
  const installScript = path.join(tools, 'install-custom.ps1');
  writeFileSync(installScript, [
    'function Assert-InstalledQualifiedBuild {',
    '  param([string]$InstallRoot)',
    ...(reject ? ["  throw 'Installed companion content hash mismatch. Expected exact, found predecessor.'"] : []),
    "  return [pscustomobject]@{Version='2.1.15';AppExecutableSha256=('a'*64);AppAsarSha256=('b'*64);ExtensionBackgroundSha256=('c'*64);ExtensionContentSha256=('d'*64);SourceProvenanceSha256=('e'*64);GitCommit='9e26f26438147caa41ea9f1bd4d5908799f2adc7';GitTree='32adbd354a4e9215645d6bbe23391087233c22a9'}",
    '}'
  ].join('\r\n'), 'utf8');
  const hash = createHash('sha256').update(readFileSync(installScript)).digest('hex');
  const result = spawnSync(process.execPath, [SCRIPT,
    '--session-dir', root,
    '--anchor-message', '11111111-1111-4111-8111-111111111111',
    '--next-message', '33333333-3333-4333-8333-333333333333',
    '--expected-model', MODEL,
    '--expected-effort', EFFORT,
    '--core-tool', 'read',
    '--require-resume',
    '--install-script', installScript,
    '--install-root', tools,
    '--expected-install-verifier-sha256', tamperVerifierHash ? '0'.repeat(64) : hash,
    '--expected-installed-content-sha256', 'd'.repeat(64),
    '--expected-installed-source-commit', '9e26f26438147caa41ea9f1bd4d5908799f2adc7'
  ], { encoding: 'utf8' });
  return { ...result, report: JSON.parse(result.stdout || '{}') };
}

describe('read-only Loop live acceptance verifier', () => {
  it('uses the exact canonical install verifier for installed-byte identity without duplicating its byte checks', () => {
    const result = runWithInstalledProof(fixture());
    expect(result.status, result.stderr).toBe(0);
    expect(result.report.gates.installedByteIdentity).toMatchObject({
      pass: true,
      required: true,
      status: 'verified',
      evidence: {
        extensionContentSha256: 'd'.repeat(64),
        gitCommit: '9e26f26438147caa41ea9f1bd4d5908799f2adc7'
      }
    });
    expect(result.report.remainingLiveGates).not.toContain('installed-byte-identity');
  });

  it('quarantines an exactly qualified generation later proven to omit an acceptance-required repair', async () => {
    const blockedCommit = '63c78797f0152b718a78472077e6bf0f6e8649f6';
    const blockedHashes = {
      appExecutableSha256: 'ac5ed7cfc41c4241b0cd13a996f47d5a430ffc70470dd8fc1a1cf251cebc663c',
      appAsarSha256: 'c8b7af57a4710ed1ad37897bbbc4ddc79c136f1721d173598e6d41d62fec93e9',
      extensionBackgroundSha256: 'e92ddf4e041db4e1c90e8414df52394ca46993c1b56559879d652e91747f3b72',
      extensionContentSha256: '03578eab29dc501aaddf05789b519d697f998b7736ad9cea5d93e999121ccec2'
    };
    let installed: ReturnType<typeof installedProofFixture>;
    installed = installedProofFixture(async port => ({
      pid: 1000 + port,
      executablePath: path.join(installed.root, 'Chat On Steroids.exe'),
      executableSha256: blockedHashes.appExecutableSha256,
      startedAt: 1
    }), blockedCommit, blockedHashes);
    const report = await verifyDirect(fixture(), { ...installed.options, runtimePort: 8765 });
    expect(report.gates.installedByteIdentity).toMatchObject({ pass: true, required: true, status: 'verified' });
    expect(report.gates.qualifiedRuntimeIdentity).toMatchObject({ pass: true, required: true, status: 'verified' });
    expect(report.gates.knownQualifiedGenerationGap).toMatchObject({
      pass: false,
      required: true,
      status: 'known-required-gap',
      evidence: {
        gitCommit: blockedCommit,
        appExecutableSha256: blockedHashes.appExecutableSha256,
        appAsarSha256: blockedHashes.appAsarSha256,
        extensionBackgroundSha256: blockedHashes.extensionBackgroundSha256,
        extensionContentSha256: blockedHashes.extensionContentSha256,
        gaps: [
          'stale-diagnostic-chat-binding',
          'never-claimed-helper-cancellation',
          'bounded-unknown-tool-hold',
          'temporary-helper-provider-recovery',
          'provider-load-retry-classifier',
          'exact-conversation-window-focus',
          'always-on-activity-timestamps',
          'work-updates-readability'
        ]
      }
    });
    expect(report.pass).toBe(false);
    expect(report.releaseAccepted).toBe(false);
    expect(report.remainingLiveGates).toContain('known-qualified-generation-gap');

    const distinctPackage = installedProofFixture(async port => ({
      pid: 2000 + port,
      executablePath: path.join(distinctPackage.root, 'Chat On Steroids.exe'),
      executableSha256: 'f'.repeat(64),
      startedAt: 1
    }), blockedCommit, { ...blockedHashes, appExecutableSha256: 'f'.repeat(64) });
    const distinctReport = await verifyDirect(fixture(), { ...distinctPackage.options, runtimePort: 8765 });
    expect(distinctReport.gates.knownQualifiedGenerationGap).toMatchObject({
      pass: true,
      required: true,
      status: 'verified',
      evidence: { gitCommit: blockedCommit, appExecutableSha256: 'f'.repeat(64), gaps: [] }
    });
  });

  it('keeps the installed af4a4f18 generation behind its later source-only recovery fixes', async () => {
    const commit = 'af4a4f1873ea71f068e51cf286ba7e6a6a64e1c8';
    const hashes = {
      appExecutableSha256: '9fb3cef6448fe4e58f1d29c943466a9ecf81d458ff8367c81b7d2b9dcfb4275e',
      appAsarSha256: '71036a6cb9ed8d1cf99dca06f9c1522e10f5e4b990d42d9e08294ce82fe8adcc',
      extensionBackgroundSha256: '2a61beba35412db89f7f84f3e5eeca61e0877c1ec305cb348a2cde8a19a6051d',
      extensionContentSha256: 'ad50515929d2295e4ac09763ecea52c119582b99044af93e3f6d13d4cade7623'
    };
    let installed: ReturnType<typeof installedProofFixture>;
    installed = installedProofFixture(async port => ({
      pid: 1000 + port,
      executablePath: path.join(installed.root, 'Chat On Steroids.exe'),
      executableSha256: hashes.appExecutableSha256,
      startedAt: 1
    }), commit, hashes);
    const report = await verifyDirect(fixture(), { ...installed.options, runtimePort: 8765 });
    expect(report.gates.installedByteIdentity).toMatchObject({ pass: true, status: 'verified' });
    expect(report.gates.qualifiedRuntimeIdentity).toMatchObject({ pass: true, status: 'verified' });
    expect(report.gates.knownQualifiedGenerationGap).toMatchObject({
      pass: false, required: true, status: 'known-required-gap',
      evidence: { gitCommit: commit, gaps: [
        'recovering-tab-status', 'deletion-restore-order', 'runtime-source-visibility',
        'aborted-helper-wake-custody', 'work-updates-inline-detail'
      ] }
    });
    expect(report.releaseAccepted).toBe(false);
  });

  it('refuses installed-byte evidence from a verifier whose exact script hash is not the expected owner', () => {
    const result = runWithInstalledProof(fixture(), true);
    expect(result.status).toBe(1);
    expect(result.report.gates.installedByteIdentity).toMatchObject({
      pass: false,
      required: true,
      status: 'verifier-hash-mismatch'
    });
    expect(result.report.remainingLiveGates).toContain('installed-byte-identity');
  });

  it('preserves the canonical installed-byte rejection reason instead of replacing it with a strict-mode follow-on error', () => {
    const result = runWithInstalledProof(fixture(), false, true);
    expect(result.status).toBe(1);
    expect(result.report.gates.installedByteIdentity).toMatchObject({
      pass: false,
      required: true,
      status: 'canonical-verifier-rejected',
      evidence: { error: 'Installed companion content hash mismatch. Expected exact, found predecessor.' }
    });
  });

  it('requires exact durable receipts for Send -> Core -> final -> next Loop -> Core -> final with the saved selection retained', () => {
    const result = run(fixture());
    expect(result.status, result.stderr).toBe(0);
    expect(result.report).toMatchObject({
      pass: true,
      releaseAccepted: false,
      gates: {
        anchorNativeSend: { pass: true },
        firstUsefulCore: { pass: true },
        firstFinal: { pass: true },
        nextLoopNativeSend: { pass: true },
        subsequentLoopWork: { pass: true },
        subsequentFinal: { pass: true },
        currentSelectionRetention: { pass: true },
        noInputReplay: { pass: true },
        resumeLineage: { pass: true }
      }
    });
    expect(result.report.remainingLiveGates).toContain('browser-window-group-ownership');
  });

  it('accepts an exact native Goal ACK history row without inventing a second outbox input', () => {
    // recordAutomaticGoalInput stamps an app-owned Goal origin against the provider message
    // ID. A subsequent sparse page echo changes the row source to extension, but keeps origin.
    const result = run(fixture({ nextAutomaticGoal: true }));
    expect(result.status, result.stderr).toBe(0);
    expect(result.report.gates.nextLoopNativeSend).toMatchObject({
      pass: true, evidence: { messageId: '33333333-3333-4333-8333-333333333333',
        inputId: null, automationOrigin: 'goal', reasoningEffort: EFFORT }
    });
    expect(result.report.gates.noInputReplay.pass).toBe(true);
    expect(result.report.gates.subsequentLoopWork.pass).toBe(true);
    expect(result.report.gates.subsequentFinal.pass).toBe(true);
    expect(result.report.releaseAccepted).toBe(false);
  });

  it.each([
    ['no trusted Goal provenance', { nextAutomaticGoal: true, nextGoalOriginMissing: true }],
    ['conflicting ordinary-outbox identity', { nextAutomaticGoal: true, nextGoalHasOutboxId: true }],
    ['model effort drift', { nextAutomaticGoal: true, nextEffort: 'medium' }]
  ] as const)('refuses a Goal-claimed subsequent native Send with %s', (_name, options) => {
    const result = run(fixture(options));
    expect(result.status).toBe(1);
    expect(result.report.gates.nextLoopNativeSend.pass).toBe(false);
    expect(result.report.releaseAccepted).toBe(false);
  });

  it.each([
    ['offered input is not native Send', { anchorDelivery: 'offered' }, 'anchorNativeSend'],
    ['reasoning drift blocks the next Loop receipt', { nextEffort: 'medium' }, 'nextLoopNativeSend'],
    ['duplicate outbox identity is replay', { duplicateAnchorInput: true }, 'noInputReplay'],
    ['a second message without Core work is not a subsequent Loop turn', { omitNextCore: true }, 'subsequentLoopWork'],
    ['a subsequent Core call with effort drift is not accepted as the requested Loop execution', { nextCoreEffort: 'medium' }, 'subsequentLoopWork'],
    ['a subsequent Loop turn without an eligible final is incomplete', { omitNextFinal: true }, 'subsequentFinal'],
    ['a drifted current saved selection is not retained model/effort proof', { selectedEffort: 'medium' }, 'currentSelectionRetention'],
    ['an old native selection cannot prove effort remained High after the next Send', { selectedObservedAt: 2 }, 'currentSelectionRetention']
  ] as const)('%s', (_name, options, gate) => {
    const result = run(fixture(options));
    expect(result.status).toBe(1);
    expect(result.report.pass).toBe(false);
    expect(result.report.gates[gate].pass).toBe(false);
  });

  it('requires an explicit durable browser-repair progress receipt when provider recovery proof is requested', async () => {
    const missing = await verifyDirect(fixture(), { requireProviderRecovery: true });
    expect(missing.pass).toBe(false);
    expect(missing.gates.providerRecoveryCustody).toMatchObject({
      pass: false, required: true, status: 'missing-live-repair-receipt'
    });

    const present = await verifyDirect(fixture({ includeRecovery: true }), { requireProviderRecovery: true });
    expect(present.gates.providerRecoveryCustody).toMatchObject({
      pass: true, required: true, status: 'verified', evidence: { action: 'retried' }
    });
    expect(present.remainingLiveGates).not.toContain('provider-retry-reload-custody');
  });

  it('binds recorder evidence to the exact qualified runtime start so pre-restart rows cannot become post-install proof', async () => {
    const root = fixture();
    const tools = mkdtempSync(path.join(tmpdir(), 'cos-runtime-proof-'));
    const installScript = path.join(tools, 'install-custom.ps1');
    writeFileSync(installScript, [
      'function Assert-InstalledQualifiedBuild {',
      '  param([string]$InstallRoot)',
      "  return [pscustomobject]@{Version='2.1.15';AppExecutableSha256=('a'*64);AppAsarSha256=('b'*64);ExtensionBackgroundSha256=('c'*64);ExtensionContentSha256=('d'*64);SourceProvenanceSha256=('e'*64);GitCommit='63c78797f0152b718a78472077e6bf0f6e8649f6';GitTree='fd752e720a315e2f68aad04697d348e7e12509fc'}",
      '}'
    ].join('\r\n'), 'utf8');
    const hash = createHash('sha256').update(readFileSync(installScript)).digest('hex');
    const installed = {
      installScript,
      installRoot: tools,
      expectedInstallVerifierSha256: hash,
      expectedInstalledContentSha256: 'd'.repeat(64),
      expectedInstalledSourceCommit: '63c78797f0152b718a78472077e6bf0f6e8649f6',
      runtimePort: 8765,
      runtimeInspector: async () => ({ pid: 1234, executablePath: path.join(tools, 'Chat On Steroids.exe'),
        executableSha256: 'a'.repeat(64), startedAt: 6 })
    };
    const report = await verifyDirect(root, installed);
    expect(report.gates.qualifiedRuntimeIdentity).toMatchObject({ pass: true, required: true, status: 'verified' });
    expect(report.notBefore).toBe(6);
    expect(report.gates.anchorNativeSend.pass).toBe(false);
    expect(report.gates.nextLoopNativeSend.pass).toBe(true);
    expect(report.pass).toBe(false);
  });

  it('proves one exact worker session through prime lineage, current selection and execution-time effort', async () => {
    const root = fixture();
    const worker = workerFixture();
    const report = await verifyDirect(root, { workerSessionDir: worker });
    expect(report.gates.workerDeliveryEffort).toMatchObject({
      pass: true,
      required: true,
      status: 'verified',
      evidence: {
        sessionId: 'fixture-worker-session',
        origin: { kind: 'worker', fromSessionId: 'fixture-session', agentId: 'worker-1' },
        expectedModel: MODEL,
        expectedEffort: EFFORT,
        execution: { model: MODEL, reasoningEffort: EFFORT }
      }
    });
    expect(report.remainingLiveGates).not.toContain('worker-delivery-effort');

    const drifted = await verifyDirect(root, { workerSessionDir: workerFixture('medium') });
    expect(drifted.gates.workerDeliveryEffort).toMatchObject({
      pass: false,
      required: true,
      status: 'worker-proof-incomplete'
    });
    expect(drifted.pass).toBe(false);
  });

  it('proves Day-mode nicknames and each required profile listener against the qualified executable, including Garry', async () => {
    const installed = installedProofFixture(async port => ({
      pid: 1000 + port,
      executablePath: path.join(installed.root, 'Chat On Steroids.exe'),
      executableSha256: 'a'.repeat(64),
      startedAt: 1
    }));
    const configFile = path.join(installed.root, 'config.json');
    const profileRows = [
      ['Primary', 'local-instance', 8765, 'Profile 3', 'legacy'],
      ['Zeta', 'profile-Zeta', 8768, 'Default', 'isolated'],
      ['Alpha', 'profile-Alpha', 8767, 'Profile 4', 'isolated'],
      ['Beta', 'profile-garry', 8766, 'Profile 5', 'isolated']
    ] as const;
    const profiles = profileRows.map(([name, id, port, profileDirectory, mode]) => ({
      id, displayName: name, accountLabel: name, enabled: true,
      bridge: { host: '127.0.0.1', port }, browser: { profileId: `chrome-${id}`, profileDirectory },
      state: { mode, root: mode === 'legacy' ? installed.root : path.join(installed.root, 'instances', id) }
    }));
    put(installed.root, 'config.json', { ui: { automationProfile: 'day' }, instances: { activeInstanceId: 'local-instance', profiles } });
    for (const profile of profiles.filter(profile => profile.state.mode === 'isolated')) {
      const runtime = path.join(profile.state.root, 'runtime');
      mkdirSync(runtime, { recursive: true });
      put(runtime, 'config.json', { ui: { automationProfile: 'day', automationPaused: false } });
    }
    const requiredProfiles = profiles.map(profile => profile.displayName);
    const report = await verifyDirect(fixture(), {
      ...installed.options,
      runtimePort: 8765,
      configFile,
      requiredProfiles
    });
    expect(report.gates.profilePersistenceAndRouting).toMatchObject({
      pass: true, required: true, status: 'verified', evidence: { automationProfile: 'day', uniqueRegistryPorts: true }
    });
    expect(report.remainingLiveGates).not.toContain('garry-route');
    expect(report.remainingLiveGates).not.toContain('nickname-day-mode-persistence');

    installed.options.runtimeInspector = async port => port === 8766
      ? { pid: 42184, executablePath: path.join(installed.root, 'quick_capture.exe'), executableSha256: 'f'.repeat(64), startedAt: 1 }
      : { pid: 1000 + port, executablePath: path.join(installed.root, 'Chat On Steroids.exe'), executableSha256: 'a'.repeat(64), startedAt: 1 };
    const collision = await verifyDirect(fixture(), {
      ...installed.options,
      runtimePort: 8765,
      configFile,
      requiredProfiles
    });
    expect(collision.gates.profilePersistenceAndRouting.pass).toBe(false);
    expect(collision.gates.profilePersistenceAndRouting.evidence.profiles.find((row: any) => row.name === 'Beta')).toMatchObject({
      pass: false, bridgePort: 8766, runtime: { pass: false, samePath: false }
    });
    expect(collision.remainingLiveGates).toContain('garry-route');
  });

  it('accepts only one durable resolved controlled diagnostic incident for the same prime session', async () => {
    const root = fixture();
    const diagnosticState = path.join(root, 'diagnostic-incidents.json');
    const state = {
      version: 1,
      ownerId: 'aaaaaaaa-0000-4000-8000-000000000000',
      chat: { sessionId: 'diagnostic-session', conversationId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd' },
      overflowCount: 0,
      incidents: [{
        id: 'bbbbbbbb-0000-4000-8000-000000000000', kind: 'loop',
        sourceSessionId: 'fixture-session', sourceConversationId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        exhaustedAt: 20, firstObservedAt: 20, lastObservedAt: 21, repeatCount: 1, inputCustody: 'sent',
        wakeInputId: 'cccccccc-0000-4000-8000-000000000000', wakeMessageId: 'diagnostic-native-message',
        status: 'resolved', claimId: null, claimedAt: 22, settledAt: 30, disposition: 'recovered'
      }]
    };
    put(root, 'diagnostic-incidents.json', state);
    const report = await verifyDirect(root, { diagnosticState });
    expect(report.gates.diagnosticIncidentRecovery).toMatchObject({
      pass: true, required: true, status: 'verified', evidence: { repeatCount: 1, disposition: 'recovered', overflowCount: 0 }
    });
    expect(report.remainingLiveGates).not.toContain('diagnostic-incident-recovery');

    state.incidents[0]!.repeatCount = 2;
    put(root, 'diagnostic-incidents.json', state);
    const duplicated = await verifyDirect(root, { diagnosticState });
    expect(duplicated.gates.diagnosticIncidentRecovery).toMatchObject({ pass: false, status: 'diagnostic-proof-incomplete' });
  });

  it('validates the incumbent durable Progress plan state without treating it as visual readability proof', async () => {
    const root = fixture();
    put(root, 'plan.json', {
      updatedAt: 20,
      plan: [{ step: 'Run live acceptance', status: 'in_progress' }],
      checklist: Array.from({ length: 6 }, (_, index) => ({
        id: `gate-${index + 1}`, requirement: `Requirement ${index + 1}`, source: 'fixture',
        acceptance: `Acceptance ${index + 1}`, status: index === 0 ? 'implemented' : 'pending'
      }))
    });
    const report = await verifyDirect(root, { requireProgressState: true });
    expect(report.gates.progressState).toMatchObject({
      pass: true, required: true, status: 'verified', evidence: { checklistCount: 6, verifiedCount: 0, inProgressCount: 1 }
    });
    expect(report.remainingLiveGates).toContain('progress-readability');
  });

  it('keeps current companion recovery and status requirements as explicit live-observation gates', async () => {
    const report = await verifyDirect(fixture());
    expect(report.releaseAccepted).toBe(false);
    expect(report.remainingLiveGates).toEqual(expect.arrayContaining([
      'temporary-helper-provider-recovery',
      'provider-load-retry-classifier',
      'exact-conversation-window-focus',
      'always-on-activity-timestamps',
      'work-updates-readability'
    ]));
  });
});
