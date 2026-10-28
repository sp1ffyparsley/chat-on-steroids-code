import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  operatorInputCancellationIds,
  operatorInputDirectory,
  operatorControlResponsePath,
  pruneOperatorControlResponses,
  operatorInputRequestIds,
  operatorInputRetryIds,
  operatorConnectionControlRequest,
  operatorSettingsControlRequest,
  operatorSessionInspectionRequest,
  processOperatorSessionInspection,
  processOperatorConnectionControl,
  processOperatorSettingsControl,
  operatorProfileCreationRequest,
  operatorProfileCreationAdditionalData,
  operatorProfileCreationSecondInstanceArgs,
  operatorProfileBrowserBindingRequest,
  operatorProfileRenameRequest,
  operatorSharedAccountSettingsRequest,
  processOperatorInputCancellations,
  processOperatorInputRequests,
  processOperatorInputRetries,
  processOperatorProfileCreation,
  processOperatorProfileBrowserBinding,
  processOperatorProfileRename
} from '../src/main/operator-input.js';

function input(id: string) {
  return {
    id, sessionId: null, projectId: null, text: 'Run the real workflow', objective: 'Keep improving it',
    automation: 'loop' as const, loopAfterTurn: true, mode: 'after-turn' as const,
    dueAt: 123, model: '5.6', reasoningEffort: 'high' as const
  };
}

describe('account-scoped operator input', () => {
  it('transports an exclusive nickname rename and delegates to the existing exact-profile owner', async () => {
    const id = 'profile-f481290d-e54c-42a6-be5d-c8a19b35f0aa';
    const argv = ['app.exe', `--cos-rename-profile=${id}`, '--cos-profile-nickname= Delta ', '--background'];
    expect(operatorProfileRenameRequest(argv)).toEqual({ id, nickname: 'Delta' });
    expect(operatorProfileCreationRequest(argv)).toBeNull();
    expect(operatorProfileBrowserBindingRequest(argv)).toBeNull();
    const data = operatorProfileCreationAdditionalData(argv);
    expect(data).toEqual({ cosProfileRename: { version: 1, request: { id, nickname: 'Delta' }, background: true } });
    const canonical = [`--cos-rename-profile=${id}`, '--cos-profile-nickname=Delta', '--background'];
    expect(operatorProfileCreationSecondInstanceArgs(['app.exe', '--enable-features=ChromiumOwned'], data)).toEqual(canonical);
    const rename = vi.fn(async () => ({ profiles: [] }));
    await expect(processOperatorProfileRename(canonical, rename)).resolves.toBe(id);
    expect(rename).toHaveBeenCalledExactlyOnceWith(id, 'Delta');
    await expect(processOperatorProfileRename(['app.exe'], rename)).resolves.toBeNull();
    rename.mockRejectedValueOnce(new Error('Account is running in another window.'));
    await expect(processOperatorProfileRename(canonical, rename)).rejects.toThrow(/running/);
  });

  it('refuses malformed, duplicate, split, isolated and mixed nickname controls before their owner', async () => {
    const id = 'profile-f481290d-e54c-42a6-be5d-c8a19b35f0aa';
    const base = [`--cos-rename-profile=${id}`, '--cos-profile-nickname=Delta'];
    const rename = vi.fn();
    for (const args of [
      [base[0]!], [base[1]!], ['--cos-rename-profile', base[1]!], [base[0]!, '--cos-profile-nickname'],
      [base[0]!, '--cos-profile-nickname='], [base[0]!, '--cos-profile-nickname=   '],
      [base[0]!, `--cos-profile-nickname=${'x'.repeat(49)}`], [base[0]!, '--cos-profile-nickname=Ti/mothy'],
      [base[0]!, '--cos-profile-nickname=Ti\\mothy'], [base[0]!, '--cos-profile-nickname=Ti\nmothy'],
      [base[0]!, '--cos-profile-nickname=Ti\u2028mothy'], [base[0]!, '--cos-profile-nickname=Ti\u2029mothy'],
      [base[0]!, '--cos-profile-nickname=Delta', 'tail'], ['--cos-rename-profile-unknown=never-log', base[1]!],
      ...['local-instance', id.toUpperCase(), `${id} `, id.replace('-42a6-', '-52a6-'), '../bad']
        .map(value => [`--cos-rename-profile=${value}`, base[1]!]),
      ...[base[0]!, base[1]!, '--background', '--cos-create-profile=New', '--cos-profile-browser=Profile 6',
        `--cos-set-profile-browser=${id}`, `--cos-instance-runtime=${id}`, '--pause-automation', '--resume-automation',
        '--safe-close-for-update=local-instance', '--cos-settings-action=read', '--cos-connection-action=status',
        '--cos-shared-accounts=inspect', '--cos-enqueue-input=never-log', '--api-key=never-log', '--root=C:\\', '--connect']
        .map(extra => [...base, '--background', extra])
    ]) {
      const argv = ['app.exe', ...args];
      expect(() => operatorProfileRenameRequest(argv)).toThrow();
      await expect(processOperatorProfileRename(argv, rename)).rejects.toThrow();
      try { operatorProfileCreationAdditionalData(argv); } catch (error) { expect(String(error)).not.toContain('never-log'); }
    }
    expect(rename).not.toHaveBeenCalled();
  });

  it('rejects nickname envelope tampering and missing transport without interpreting raw argv', () => {
    const id = 'profile-f481290d-e54c-42a6-be5d-c8a19b35f0aa';
    const argv = [`--cos-rename-profile=${id}`, '--cos-profile-nickname=Delta'];
    const valid = operatorProfileCreationAdditionalData(argv)!;
    if (!('cosProfileRename' in valid)) throw new Error('Expected nickname envelope');
    for (const data of [undefined, null, {}, [], { wrongOwner: valid.cosProfileRename },
      { ...valid, apiKey: 'never-log' }, { ...valid, cosProfileCreation: {} },
      { cosProfileRename: { ...valid.cosProfileRename, version: 2 } },
      { cosProfileRename: { ...valid.cosProfileRename, background: 'true' } },
      ...[{ id: 'local-instance', nickname: 'Delta' }, { id, nickname: '' }, { id, nickname: 'x'.repeat(49) },
        { id, nickname: 'bad\nname' }, { id, nickname: 'Delta', browserProfileDirectory: 'Profile 9' },
        { id, nickname: 'Delta', root: 'never-log' }, { id, nickname: 'Delta', isolated: true }]
        .map(request => ({ cosProfileRename: { ...valid.cosProfileRename, request } }))
    ]) {
      expect(() => operatorProfileCreationSecondInstanceArgs(argv, data)).toThrow();
      try { operatorProfileCreationSecondInstanceArgs(argv, data); } catch (error) { expect(String(error)).not.toContain('never-log'); }
    }
  });

  it('transports only bounded read-only session inspection through exact second-instance receipts', () => {
    const id = 'profile-7a25c7a4-3452-4c79-8e67-f968852d90b4', receipt = randomUUID();
    for (const operation of [['list', '--cos-sessions-limit=20'], ['controls', '--cos-sessions-session=2026-10-13-839d5152']]) {
      const args = [`--cos-sessions-action=${operation[0]}`, `--cos-sessions-profile=${id}`,
        `--cos-sessions-receipt=${receipt}`, operation[1]!, `--cos-instance-runtime=${id}`, '--background'];
      expect(operatorSessionInspectionRequest(args)).toMatchObject({ instanceId: id, receipt, isolated: true });
      expect(operatorProfileCreationSecondInstanceArgs(['app.exe', '--enable-features=Native'],
        operatorProfileCreationAdditionalData(args))).toEqual(args);
      for (const extra of ['--resume-automation', '--cos-settings-action=read', '--cos-connection-action=status',
        '--cos-enqueue-input=private', '--cos-sessions-action=list', '--cos-sessions-limit=61', 'positional'])
        expect(() => operatorSessionInspectionRequest([...args, extra])).toThrow();
      expect(() => operatorProfileCreationSecondInstanceArgs(args, {})).toThrow();
    }
    const base = ['--cos-sessions-profile=local-instance', `--cos-sessions-receipt=${receipt}`];
    for (const suffix of [['--cos-sessions-action=resume'], ['--cos-sessions-action=controls'],
      ['--cos-sessions-action=list', '--cos-sessions-session=2026-10-13-839d5152'],
      ['--cos-sessions-action=list', '--cos-sessions-limit=0'], ['--cos-sessions-action=list', '--cos-sessions-limit=1.5'],
      ['--cos-sessions-action=controls', '--cos-sessions-session=../../secret'],
      ['--cos-sessions-action=list', '--cos-sessions-receipt=bad']])
      expect(() => operatorSessionInspectionRequest([...base, ...suffix])).toThrow();
  });
  it.each(['valid', 'unknown-code', 'null-entry', 'accessor', 'summary-code', 'summary-overflow',
    'summary-accessor', 'summary-count-accessor', 'summary-incomplete', 'summary-duplicate'] as const)(
    'delegates live session controls and bounded catalog reads without private text (%s)', async variant => {
    let getterReads = 0;
    const refusalCounter: any = { code: variant === 'unknown-code' ? 'private unknown code' : 'workingTurnMismatch',
      calls: 2, privatePayload: 'private raw metadata' };
    if (variant === 'accessor') Object.defineProperty(refusalCounter, 'code', {
      get() { getterReads++; throw new Error('private accessor must not run'); } });
    const providerUI: any = variant === 'null-entry' ? null : {
      observedAt: 1000, shell: 'alternate', discovery: 'compatible', currentTurnMatched: false,
      selectorMatches: variant === 'unknown-code' ? null : 400, mapped: variant === 'unknown-code' ? null : 0,
      rejects: { fiberMissing: 0, callRequestIdPresent: 3, callRequestIdMissing: 0,
        callIdentityScopeUnproved: 2, privatePayload: 'private provider metadata',
        callReceiptMissing: 401, callReceiptConflict: -1, callNativePending: 0.5 },
      privatePayload: 'private provider source'
    };
    if (providerUI) {
      const summary: any = { calls: 4, reasons: [{ code: 'turnExchangeMismatch', calls: 4 }], privatePayload: 'private current source' };
      if (variant === 'summary-code') summary.reasons[0].code = 'private unknown current code';
      if (variant === 'summary-overflow') summary.reasons[0].calls = 5;
      if (variant === 'summary-incomplete') delete summary.calls;
      if (variant === 'summary-duplicate') summary.reasons.push({ ...summary.reasons[0] });
      if (variant === 'summary-accessor') Object.defineProperty(summary, 'reasons', {
        get() { getterReads++; throw new Error('private current-reason accessor must not run'); } });
      if (variant === 'summary-count-accessor') Object.defineProperty(summary, 'calls', {
        get() { getterReads++; throw new Error('private current-count accessor must not run'); } });
      providerUI.identityRefusalSummary = summary;
    }
    if (variant === 'accessor') Object.defineProperty(providerUI, 'selectorMatches', {
      get() { getterReads++; throw new Error('private provider accessor must not run'); } });
    const config = await import('../src/main/config.js'), bridge = await import('../src/main/bridge.js');
    const store = await import('../src/main/session/store.js'), durable = await import('../src/main/durable.js');
    const root = await mkdtemp(path.join(os.tmpdir(), 'cos-session-inspection-'));
    durable.initDurableStore(root);
    const sessionId = '2026-10-13-839d5152', conversationId = '6ace00f5-aaaa-bbbb-cccc-dddddddddddd';
    const runtime = vi.spyOn(config, 'getActiveInstanceRuntime').mockReturnValue({ profile: {
      id: 'local-instance', state: { mode: 'legacy', root } } } as ReturnType<typeof config.getActiveInstanceRuntime>);
    const settings = vi.spyOn(config, 'getConfig').mockReturnValue({ ui: { automationPaused: true } } as ReturnType<typeof config.getConfig>);
    const summary = { id: sessionId, conversationId, title: 'private prompt title', updatedAt: 1, origin: { kind: 'desktop' } };
    const get = vi.spyOn(store, 'getSession').mockResolvedValue(summary as Awaited<ReturnType<typeof store.getSession>>);
    const page = vi.spyOn(store, 'listSessionPage').mockResolvedValue({ sessions: [summary], total: 71,
      nextCursor: { id: sessionId, updatedAt: 1 } } as Awaited<ReturnType<typeof store.listSessionPage>>);
    const controls = vi.spyOn(bridge, 'sessionControlsFor').mockResolvedValue({ sessionId, conversationId, activeTurnId: null,
      automation: 'loop', objective: 'private saved objective', finishHeld: false, blocked: '', plan: null,
      goalDraft: { stage: 'failed', stageStartedAt: 1, model: 'private model', text: 'private helper answer', error: 'private bearer' }, goalWait: { reason: 'attention', detail: 'private draft' },
      nativeEvidence: { reason: 'open-code', fresh: true, sourceObserved: true, finalObserved: false, openCalls: 3, openCodeCalls: 1,
        settledCandidate: false, physicalIdle: true, physicalHold: null, observerBusy: true,
        inventoryIncomplete: true, inventoryCurrentTurnMatched: false, providerUI,
        accountActivity: { runningTools: 0, settlingTools: 1, managedProcesses: 2, mcpRequests: 0, recordingWrites: 1,
          privatePayload: 'private account command' },
        completion: { reason: 'original-native-identity-missing', retainedCalls: 3, retainedCodeCalls: 1,
          missingOriginalNativeIds: 4, missingOriginalRequestIds: 3, privateReceipt: 'private native receipt',
          requestIdentity: { status: 'unverified', selectedFieldsPresent: null, selectedFieldsMissing: null,
            selectedIdentitiesWithheld: null, scopeRefusals: null, privatePayload: 'private native metadata',
            failureReasons: variant === 'null-entry' ? [null] as any : [refusalCounter] },
          observation: { observedAt: 1000, ageMs: 200, freshness: 'fresh', privatePayload: 'private browser state' } as any,
          durable: { reason: 'original-identity-missing', checkedCalls: 0, missingCorrelations: 0,
            conflictingCorrelations: 0, missingTerminalResults: null, ambiguousTerminalResults: null,
            pendingRecordedProcesses: null, privateHash: 'private journal identity' } },
        privateIdentity: 'private native question' },
      activeWork: { primeSessionId: sessionId, sessionIds: [sessionId], activeWorkMs: 0, activeWorkMeasurement: 'unknown' },
      diagnosticIncidents: [], diagnosticChat: null, job: { sessionId, token: 'private handoff token', stage: 'failed', busy: false, cancellable: true,
        automatic: true, sourceSend: { state: 'attempted-unresolved', messageId: null }, destinationSend: { state: 'attempted-unresolved', conversationId: null, messageId: null },
        error: 'private API key', waitReason: 'private draft', startedAt: 1, handoffId: null, requestedModel: null } } as Awaited<ReturnType<typeof bridge.sessionControlsFor>>);
    const mutations = [vi.spyOn(bridge, 'setSessionAutomation'), vi.spyOn(bridge, 'stopSessionTurn'),
      vi.spyOn(bridge, 'compactSession'), vi.spyOn(config, 'updateConfig')];
    try {
      for (const action of ['list', 'controls']) {
        const receipt = randomUUID(), args = [`--cos-sessions-action=${action}`, '--cos-sessions-profile=local-instance',
          `--cos-sessions-receipt=${receipt}`, action === 'list' ? '--cos-sessions-limit=2' : `--cos-sessions-session=${sessionId}`];
        await expect(processOperatorSessionInspection(args, root)).resolves.toMatchObject({ state: 'completed' });
        const response = JSON.parse(await readFile(operatorControlResponsePath(root, receipt, 'sessions'), 'utf8'));
        expect(response.observedAt).toBeGreaterThan(0);
        expect(JSON.stringify(response)).not.toContain('private');
        if (action === 'controls') expect(response.snapshot).toMatchObject({ activeTurnId: null,
          automation: 'loop', automationPaused: true, objectiveChars: 23, goalWait: { reason: 'attention' },
          nativeEvidence: { reason: 'open-code', fresh: true, sourceObserved: true, finalObserved: false, openCalls: 3,
            openCodeCalls: 1, settledCandidate: false, physicalIdle: true, physicalHold: null, observerBusy: true,
            inventoryIncomplete: true, inventoryCurrentTurnMatched: false,
            providerUI: ['null-entry', 'accessor'].includes(variant) ? null : {
              observedAt: 1000, shell: 'alternate', discovery: 'compatible', currentTurnMatched: false,
              selectorMatches: variant === 'unknown-code' ? null : 400, mapped: variant === 'unknown-code' ? null : 0,
              rejects: { fiberMissing: 0, callRequestIdPresent: 3,
                callRequestIdMissing: 0, callIdentityScopeUnproved: 2 },
              identityRefusalSummary: ['valid', 'unknown-code'].includes(variant)
                ? { calls: 4, reasons: [{ code: 'turnExchangeMismatch', calls: 4 }] } : null
            },
            accountActivity: { runningTools: 0, settlingTools: 1, managedProcesses: 2, mcpRequests: 0, recordingWrites: 1 },
            completion: { reason: 'original-native-identity-missing', retainedCalls: 3, retainedCodeCalls: 1,
              missingOriginalNativeIds: 4, missingOriginalRequestIds: 3,
              requestIdentity: { status: 'unverified', selectedFieldsPresent: null, selectedFieldsMissing: null,
                selectedIdentitiesWithheld: null, scopeRefusals: null,
                failureReasons: !['unknown-code', 'null-entry', 'accessor'].includes(variant)
                  ? [{ code: 'workingTurnMismatch', calls: 2 }] : null },
              observation: { observedAt: 1000, ageMs: 200, freshness: 'fresh' },
              durable: { reason: 'original-identity-missing', checkedCalls: 0, missingCorrelations: 0,
                conflictingCorrelations: 0, missingTerminalResults: null, ambiguousTerminalResults: null,
                pendingRecordedProcesses: null } } },
          job: { stage: 'failed', busy: false, cancellable: true } });
        else expect(response.snapshot).toMatchObject({ total: 71, hasMore: true, sessions: [{ sessionId, conversationId }] });
        if (action === 'controls') expect(response.snapshot.nativeEvidence.providerUI?.rejects).toEqual(
          ['null-entry', 'accessor'].includes(variant) ? undefined : {
            fiberMissing: 0, callRequestIdPresent: 3, callRequestIdMissing: 0, callIdentityScopeUnproved: 2
          });
      }
      expect(page).toHaveBeenCalledWith({ limit: 2 }); expect(controls).toHaveBeenCalledWith(sessionId);
      expect(getterReads).toBe(0);
      for (const mutation of mutations) expect(mutation).not.toHaveBeenCalled();
      expect(JSON.stringify(await durable.readDurableStrict('sessions-control'))).not.toContain('private');
    } finally { for (const mock of [runtime, settings, get, page, controls, ...mutations]) mock.mockRestore(); }
  });
  it('refuses wrong-account, missing isolated routing and foreign userData before any session owner or receipt write', async () => {
    const config = await import('../src/main/config.js'), store = await import('../src/main/session/store.js');
    const durable = await import('../src/main/durable.js');
    const root = await mkdtemp(path.join(os.tmpdir(), 'cos-session-owner-'));
    durable.initDurableStore(root);
    const runtime = vi.spyOn(config, 'getActiveInstanceRuntime').mockReturnValue({ profile: {
      id: 'local-instance', state: { mode: 'legacy', root } } } as ReturnType<typeof config.getActiveInstanceRuntime>);
    const page = vi.spyOn(store, 'listSessionPage');
    try {
      const args = ['--cos-sessions-action=list', '--cos-sessions-profile=local-instance', `--cos-sessions-receipt=${randomUUID()}`];
      await expect(processOperatorSessionInspection(args.map(arg => arg === '--cos-sessions-profile=local-instance'
        ? '--cos-sessions-profile=other-account' : arg), root)).rejects.toThrow(/account/);
      await expect(processOperatorSessionInspection(args, path.join(root, 'foreign'))).rejects.toThrow(/runtime/);
      const id = 'profile-7a25c7a4-3452-4c79-8e67-f968852d90b4';
      runtime.mockReturnValue({ profile: { id, state: { mode: 'isolated', root } } } as ReturnType<typeof config.getActiveInstanceRuntime>);
      await expect(processOperatorSessionInspection(args.map(arg => arg === '--cos-sessions-profile=local-instance'
        ? `--cos-sessions-profile=${id}` : arg), path.join(root, 'runtime'))).rejects.toThrow(/routing/);
      expect(page).not.toHaveBeenCalled(); expect(await durable.readDurableStrict('sessions-control')).toBeNull();
    } finally { runtime.mockRestore(); page.mockRestore(); }
  });
  it('returns exact redacted failure responses for unknown sessions and never reuses a receipt for a different target', async () => {
    const config = await import('../src/main/config.js'), store = await import('../src/main/session/store.js');
    const durable = await import('../src/main/durable.js');
    const root = await mkdtemp(path.join(os.tmpdir(), 'cos-session-refused-'));
    durable.initDurableStore(root);
    const runtime = vi.spyOn(config, 'getActiveInstanceRuntime').mockReturnValue({ profile: {
      id: 'local-instance', state: { mode: 'legacy', root } } } as ReturnType<typeof config.getActiveInstanceRuntime>);
    const get = vi.spyOn(store, 'getSession').mockResolvedValue(null);
    const receipt = randomUUID(), args = ['--cos-sessions-action=controls', '--cos-sessions-profile=local-instance',
      `--cos-sessions-receipt=${receipt}`, '--cos-sessions-session=2026-10-13-missing'];
    try {
      await expect(processOperatorSessionInspection(args, root)).resolves.toMatchObject({ receipt, state: 'failed' });
      expect(JSON.parse(await readFile(operatorControlResponsePath(root, receipt, 'sessions'), 'utf8')))
        .toMatchObject({ receipt, action: 'controls', sessionId: '2026-10-13-missing', state: 'failed' });
      await processOperatorSessionInspection(args, root); expect(get).toHaveBeenCalledOnce();
      await expect(processOperatorSessionInspection(args.map(arg => arg.endsWith('2026-10-13-missing')
        ? '--cos-sessions-session=2026-10-13-other' : arg), root)).rejects.toThrow(/another operation/);
    } finally { runtime.mockRestore(); get.mockRestore(); }
  });
  it('rechecks actual conversation ownership after controls await and preserves owner errors without leaking them', async () => {
    const config = await import('../src/main/config.js'), store = await import('../src/main/session/store.js');
    const bridge = await import('../src/main/bridge.js'), durable = await import('../src/main/durable.js');
    const root = await mkdtemp(path.join(os.tmpdir(), 'cos-session-rebind-'));
    durable.initDurableStore(root);
    const sessionId = '2026-10-13-839d5152', conversationId = '6ace00f5-aaaa-bbbb-cccc-dddddddddddd';
    const runtime = vi.spyOn(config, 'getActiveInstanceRuntime').mockReturnValue({ profile: {
      id: 'local-instance', state: { mode: 'legacy', root } } } as ReturnType<typeof config.getActiveInstanceRuntime>);
    const get = vi.spyOn(store, 'getSession').mockResolvedValue({ id: sessionId, conversationId } as Awaited<ReturnType<typeof store.getSession>>);
    const controls = vi.spyOn(bridge, 'sessionControlsFor');
    try {
      for (const mode of ['rebind', 'error']) {
        get.mockResolvedValueOnce({ id: sessionId, conversationId } as Awaited<ReturnType<typeof store.getSession>>);
        if (mode === 'rebind') {
          controls.mockResolvedValueOnce({ sessionId, conversationId } as Awaited<ReturnType<typeof bridge.sessionControlsFor>>);
          get.mockResolvedValueOnce({ id: sessionId, conversationId: 'new-conversation' } as Awaited<ReturnType<typeof store.getSession>>);
        } else controls.mockRejectedValueOnce(new Error('private helper answer / bearer / API key'));
        const receipt = randomUUID();
        await expect(processOperatorSessionInspection(['--cos-sessions-action=controls', '--cos-sessions-profile=local-instance',
          `--cos-sessions-receipt=${receipt}`, `--cos-sessions-session=${sessionId}`], root)).resolves.toMatchObject({ state: 'failed' });
        const response = JSON.parse(await readFile(operatorControlResponsePath(root, receipt, 'sessions'), 'utf8'));
        expect(response.state).toBe('failed'); expect(response.snapshot).toBeUndefined(); expect(JSON.stringify(response)).not.toContain('private');
      }
    } finally { runtime.mockRestore(); get.mockRestore(); controls.mockRestore(); }
  });
  it('bounds inspection receipts and cleans only retired exact responses without altering authored inputs', async () => {
    const { mkdir, utimes } = await import('node:fs/promises');
    const config = await import('../src/main/config.js'), store = await import('../src/main/session/store.js');
    const durable = await import('../src/main/durable.js');
    const root = await mkdtemp(path.join(os.tmpdir(), 'cos-session-retention-'));
    durable.initDurableStore(root);
    const runtime = vi.spyOn(config, 'getActiveInstanceRuntime').mockReturnValue({ profile: {
      id: 'local-instance', state: { mode: 'legacy', root } } } as ReturnType<typeof config.getActiveInstanceRuntime>);
    const page = vi.spyOn(store, 'listSessionPage').mockResolvedValue({ sessions: [], total: 0, nextCursor: null });
    try {
      const rows = Array.from({ length: 16 }, () => ({ receipt: randomUUID(), instanceId: 'local-instance',
        action: 'list', limit: 20, state: 'completed' }));
      await durable.writeDurableNow('sessions-control', rows);
      await mkdir(operatorInputDirectory(root), { recursive: true });
      const retired = operatorControlResponsePath(root, rows[0]!.receipt, 'sessions');
      const authored = path.join(operatorInputDirectory(root), `${randomUUID()}.json`);
      const recent = operatorControlResponsePath(root, rows[1]!.receipt, 'sessions');
      const expired = operatorControlResponsePath(root, randomUUID(), 'sessions');
      for (const file of [retired, authored, recent, expired]) await writeFile(file, 'original bytes');
      const ancient = new Date(Date.now() - 10 * 60_000); await utimes(expired, ancient, ancient);
      const receipt = randomUUID(), args = ['--cos-sessions-action=list', '--cos-sessions-profile=local-instance', `--cos-sessions-receipt=${receipt}`];
      await expect(processOperatorSessionInspection(args, root)).resolves.toMatchObject({ state: 'completed' });
      for (const file of [retired, expired]) await expect(readFile(file)).rejects.toMatchObject({ code: 'ENOENT' });
      for (const file of [authored, recent]) expect(await readFile(file, 'utf8')).toBe('original bytes');
      const kept = await durable.readDurableStrict<typeof rows>('sessions-control'); expect(kept).toHaveLength(16);
      await expect(processOperatorSessionInspection([...args, '--cos-sessions-limit=1'], root)).rejects.toThrow(/another operation/);
      await durable.writeDurableNow('sessions-control', [{ ...rows[0], instanceId: 'foreign-account' }]);
      await expect(processOperatorSessionInspection(args, root)).rejects.toThrow(/history is malformed/);
      await durable.writeDurableNow('sessions-control', [{ ...rows[0], snapshot: { prompt: 'private' } }]);
      await expect(processOperatorSessionInspection(args, root)).rejects.toThrow(/history is malformed/);
    } finally { runtime.mockRestore(); page.mockRestore(); }
  });
  it('refuses shared-account controls mixed with any settings or connection action before an owner runs', async () => {
    const id = 'profile-7a25c7a4-3452-4c79-8e67-f968852d90b4';
    const receipt = randomUUID(), controller = vi.fn();
    const shared = ['enable', 'disable', 'inspect'].map(action => [`--cos-shared-accounts=${action}`]);
    const local = [
      ...['status', 'setup', 'configure', 'connect', 'disconnect'].map(action => [
        `--cos-connection-action=${action}`, `--cos-connection-profile=${id}`,
        `--cos-connection-receipt=${receipt}`, ...(action === 'configure' ? ['--cos-connection-kind=cloudflared'] : [])]),
      ...['read', 'update'].map(action => [`--cos-settings-action=${action}`, `--cos-settings-profile=${id}`,
        `--cos-settings-receipt=${receipt}`])
    ];
    for (const sharedArgs of shared) for (const localArgs of local) for (const args of [
      [...sharedArgs, ...localArgs], [...localArgs, ...sharedArgs]
    ]) {
      const argv = ['app.exe', ...args, '--background'];
      expect(() => operatorSharedAccountSettingsRequest(argv)).toThrow();
      expect(() => operatorProfileCreationAdditionalData(argv)).toThrow();
      if (localArgs[0]!.startsWith('--cos-connection-'))
        await expect(processOperatorConnectionControl(argv, controller)).rejects.toThrow();
      else await expect(processOperatorSettingsControl(argv, path.resolve('.'))).rejects.toThrow();
    }
    expect(controller).not.toHaveBeenCalled();
  });
  it('rejects mixed structured shared/local envelopes while preserving separate exact-profile controls', () => {
    const id = 'profile-7a25c7a4-3452-4c79-8e67-f968852d90b4';
    const shared = operatorProfileCreationAdditionalData(['--cos-shared-accounts=inspect', '--background'])!;
    for (const action of ['status', 'setup', 'connect', 'disconnect']) {
      const argv = [`--cos-connection-action=${action}`, `--cos-connection-profile=${id}`,
        `--cos-connection-receipt=${randomUUID()}`, `--cos-instance-runtime=${id}`, '--background'];
      const payload = operatorProfileCreationAdditionalData(argv)!;
      expect(operatorProfileCreationSecondInstanceArgs(['app.exe', '--enable-features=Native'], payload)).toEqual(argv);
      for (const mixed of [{ ...shared, ...payload }, { ...payload, ...shared }])
        expect(() => operatorProfileCreationSecondInstanceArgs(argv, mixed)).toThrow(/malformed/);
    }
    for (const action of ['read', 'update']) {
      const argv = [`--cos-settings-action=${action}`, `--cos-settings-profile=${id}`,
        `--cos-settings-receipt=${randomUUID()}`, `--cos-instance-runtime=${id}`, '--background'];
      const payload = operatorProfileCreationAdditionalData(argv)!;
      expect(operatorProfileCreationSecondInstanceArgs(['app.exe', '--enable-features=Native'], payload)).toEqual(argv);
      for (const mixed of [{ ...shared, ...payload }, { ...payload, ...shared }])
        expect(() => operatorProfileCreationSecondInstanceArgs(argv, mixed)).toThrow(/malformed/);
    }
    expect(operatorSharedAccountSettingsRequest(['--cos-shared-accounts=inspect', `--cos-instance-runtime=${id}`]))
      .toEqual({ action: 'inspect', drives: [], dryRun: false });
  });
  it('transports settings read/update by exact account and opaque receipt without command payloads', () => {
    const id = 'profile-7a25c7a4-3452-4c79-8e67-f968852d90b4', receipt = randomUUID();
    for (const action of ['read', 'update']) {
      const args = [`--cos-settings-action=${action}`, `--cos-settings-profile=${id}`,
        `--cos-settings-receipt=${receipt}`, `--cos-instance-runtime=${id}`, '--background'];
      const payload = operatorProfileCreationAdditionalData(args);
      expect(operatorSettingsControlRequest(args)).toEqual({ instanceId: id, action, receipt, isolated: true });
      expect(operatorProfileCreationSecondInstanceArgs(['app.exe', '--enable-features=Native'], payload)).toEqual(args);
      for (const extra of ['--cos-connection-action=status', '--cos-settings-kind=manual', '--resume-automation',
        '--cos-settings-patch=secret', '--cos-create-profile=Epsilon', 'positional'])
        expect(() => operatorSettingsControlRequest([...args, extra])).toThrow();
      expect(() => operatorProfileCreationSecondInstanceArgs(args, {})).toThrow();
    }
  });
  it('retains a bounded exact connection receipt without replaying completed or interrupted actions', async () => {
    const { initDurableStore, readDurableStrict, writeDurableNow } = await import('../src/main/durable.js');
    const root = await mkdtemp(path.join(os.tmpdir(), 'cos-connection-receipt-'));
    initDurableStore(root);
    const receipt = randomUUID();
    const args = ['--cos-connection-action=configure', '--cos-connection-profile=local-instance',
      '--cos-connection-kind=cloudflared', `--cos-connection-receipt=${receipt}`];
    const controller = vi.fn(async () => ({ instanceId: 'local-instance', kind: 'cloudflared', state: 'disconnected', url: 'https://private/pathToken' }));
    await expect(processOperatorConnectionControl(args, controller, root)).resolves.toMatchObject({ receipt, state: 'completed' });
    expect(await readFile(operatorControlResponsePath(root, receipt, 'connection'), 'utf8')).toContain('pathToken');
    expect(JSON.stringify(await readDurableStrict('connection-control'))).not.toContain('pathToken');
    await processOperatorConnectionControl(args, controller, root);
    expect(controller).toHaveBeenCalledOnce();
    await expect(processOperatorConnectionControl(args.map(arg => arg === '--cos-connection-kind=cloudflared' ? '--cos-connection-kind=manual' : arg), controller, root)).rejects.toThrow(/another operation/);
    const rows = await readDurableStrict<Array<{ state: string }>>('connection-control');
    rows![0]!.state = 'started';
    await writeDurableNow('connection-control', rows);
    await expect(processOperatorConnectionControl(args, controller, root)).resolves.toMatchObject({ state: 'started' });
    expect(controller).toHaveBeenCalledOnce();
  });
  it('expires only old exact UUID private responses while preserving recent responses and authored inputs', async () => {
    const { mkdir, utimes, symlink } = await import('node:fs/promises');
    const root = await mkdtemp(path.join(os.tmpdir(), 'cos-response-expiry-'));
    const inbox = operatorInputDirectory(root);
    await mkdir(inbox, { recursive: true });
    const oldSettings = operatorControlResponsePath(root, randomUUID(), 'settings');
    const oldConnection = operatorControlResponsePath(root, randomUUID(), 'connection');
    const recent = operatorControlResponsePath(root, randomUUID(), 'settings');
    const authored = path.join(inbox, `${randomUUID()}.settings.json`);
    const unrelated = path.join(inbox, 'not-a-uuid.settings.response.json');
    const outside = path.join(root, 'outside-private.json');
    const linked = operatorControlResponsePath(root, randomUUID(), 'connection');
    const ancient = new Date(Date.now() - 10 * 60_000);
    for (const file of [oldSettings, oldConnection, recent, authored, unrelated, outside]) await writeFile(file, 'payload');
    for (const file of [oldSettings, oldConnection, authored, unrelated, outside]) await utimes(file, ancient, ancient);
    // Windows may deny symlink creation without Developer Mode; file preservation is still tested.
    let hasLink = false;
    try { await symlink(outside, linked); hasLink = true; } catch (error) {
      if (!['EPERM', 'EACCES'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
    }
    await pruneOperatorControlResponses(root);
    for (const file of [oldSettings, oldConnection]) await expect(readFile(file)).rejects.toMatchObject({ code: 'ENOENT' });
    for (const file of [recent, authored, unrelated, outside, ...(hasLink ? [linked] : [])]) expect(await readFile(file, 'utf8')).toBe('payload');
    await pruneOperatorControlResponses(root);
    await pruneOperatorControlResponses(path.join(root, 'missing'));
  });
  it('scrubs legacy durable payloads and prunes retired private connection responses without replay', async () => {
    const { initDurableStore, readDurableStrict, writeDurableNow } = await import('../src/main/durable.js');
    const root = await mkdtemp(path.join(os.tmpdir(), 'cos-control-redaction-'));
    initDurableStore(root);
    const rows = Array.from({ length: 64 }, () => ({ receipt: randomUUID(), instanceId: 'local-instance', action: 'setup',
      state: 'completed', status: { url: 'https://private/pathToken' }, diagnostic: 'secret prompt' }));
    await writeDurableNow('connection-control', rows);
    const { mkdir } = await import('node:fs/promises');
    await mkdir(operatorInputDirectory(root), { recursive: true });
    const retired = operatorControlResponsePath(root, rows[0]!.receipt, 'connection');
    await writeFile(retired, 'private prompt');
    const receipt = randomUUID(), controller = vi.fn(async () => ({ state: 'connected' }));
    await processOperatorConnectionControl(['--cos-connection-action=status', '--cos-connection-profile=local-instance',
      `--cos-connection-receipt=${receipt}`], controller, root);
    await expect(readFile(retired)).rejects.toMatchObject({ code: 'ENOENT' });
    const audit = JSON.stringify(await readDurableStrict('connection-control'));
    expect(audit).not.toContain('pathToken'); expect(audit).not.toContain('secret prompt');
    expect((await readDurableStrict<unknown[]>('connection-control'))!.length).toBe(64);
  });
  it('keeps settings snapshots and known failure detail transient rather than in durable audits', async () => {
    const config = await import('../src/main/config.js');
    const settings = await import('../src/main/settings-control.js');
    const connection = await import('../src/main/connection-control.js');
    const durable = await import('../src/main/durable.js');
    const root = await mkdtemp(path.join(os.tmpdir(), 'cos-settings-private-'));
    durable.initDurableStore(root);
    const runtime = vi.spyOn(config, 'getActiveInstanceRuntime').mockReturnValue({ profile: { id: 'local-instance' } } as ReturnType<typeof config.getActiveInstanceRuntime>);
    const snapshot = vi.spyOn(config, 'getConfig').mockReturnValue({ prompt: 'private prompt' } as unknown as ReturnType<typeof config.getConfig>);
    const paths = vi.spyOn(config, 'getActiveInstanceOwnerPaths').mockReturnValue({ stateRoot: root } as ReturnType<typeof config.getActiveInstanceOwnerPaths>);
    const status = vi.spyOn(connection, 'getConnectionControlStatus').mockReturnValue({ instanceId: 'local-instance' } as ReturnType<typeof connection.getConnectionControlStatus>);
    try {
      settings.configureSettingsControl({ schema: z.object({ prompt: z.string() }), save: async () => {} });
      const old = randomUUID();
      await durable.writeDurableNow('settings-control', [{ receipt: old, instanceId: 'local-instance', action: 'read', state: 'completed',
        snapshot: { prompt: 'legacy secret prompt', pathToken: 'secret' } }]);
      const receipt = randomUUID();
      const args = ['--cos-settings-action=read', '--cos-settings-profile=local-instance', `--cos-settings-receipt=${receipt}`];
      await expect(processOperatorSettingsControl(args, root)).resolves.toMatchObject({ state: 'completed' });
      const audit = JSON.stringify(await durable.readDurableStrict('settings-control'));
      expect(audit).not.toContain('prompt'); expect(audit).not.toContain('pathToken');
      expect(JSON.parse(await readFile(operatorControlResponsePath(root, receipt, 'settings'), 'utf8')).snapshot.settings.prompt).toBe('private prompt');
      const failedReceipt = randomUUID();
      const update = vi.spyOn(settings, 'updateAgentSettings').mockRejectedValueOnce(new settings.SettingsControlError('Use --profile primary-owner; known private diagnostic.'));
      try {
        await writeFile(path.join(operatorInputDirectory(root), `${failedReceipt}.settings.json`), JSON.stringify({ instanceId: 'local-instance',
          revision: 'a'.repeat(64), patch: { prompt: 'updated private prompt' } }));
        await expect(processOperatorSettingsControl(['--cos-settings-action=update', '--cos-settings-profile=local-instance',
          `--cos-settings-receipt=${failedReceipt}`], root)).resolves.toMatchObject({ state: 'failed' });
        expect(JSON.parse(await readFile(operatorControlResponsePath(root, failedReceipt, 'settings'), 'utf8')).diagnostic).toContain('--profile primary-owner');
        expect(JSON.stringify(await durable.readDurableStrict('settings-control'))).not.toContain('known private diagnostic');
      } finally { update.mockRestore(); }
    } finally { runtime.mockRestore(); snapshot.mockRestore(); paths.mockRestore(); status.mockRestore(); }
  });
  it('transports exact-profile connection controls through Chromium argv mutation', () => {
    const id = 'profile-7a25c7a4-3452-4c79-8e67-f968852d90b4', receipt = randomUUID();
    const argv = [`--cos-connection-action=configure`, `--cos-connection-profile=${id}`,
      `--cos-connection-receipt=${receipt}`, '--cos-connection-kind=cloudflared', `--cos-instance-runtime=${id}`, '--background'];
    const payload = operatorProfileCreationAdditionalData(argv);
    expect(operatorConnectionControlRequest(argv)).toEqual({ request: { instanceId: id, action: 'configure', kind: 'cloudflared' }, receipt, isolated: true });
    expect(operatorProfileCreationSecondInstanceArgs(['app.exe', '--enable-features=Native'], payload)).toEqual(argv);
    for (const extra of ['--resume-automation', '--cos-create-profile=Epsilon', '--api-key=secret', '--cos-connection-kind=manual',
      '--cos-instance-runtime=wrong-profile', '--cos-enqueue-input=secret', 'positional'])
      expect(() => operatorConnectionControlRequest([...argv, extra])).toThrow();
    expect(() => operatorProfileCreationSecondInstanceArgs(argv, undefined)).toThrow();
    expect(() => operatorProfileCreationSecondInstanceArgs(argv, { ...payload, extra: 'secret' })).toThrow();
  });
  it('rejects malformed connection actions without leaking their values', () => {
    const base = ['--cos-connection-profile=local-instance', `--cos-connection-receipt=${randomUUID()}`];
    for (const suffix of [['--cos-connection-action=unknown-secret'], ['--cos-connection-action=configure'],
      ['--cos-connection-action=connect', '--cos-connection-kind=manual'], ['--cos-connection-action=status', '--cos-connection-receipt=invalid'],
      ['--cos-connection-action=status', '--cos-instance-runtime=local-instance']]) {
      expect(() => operatorConnectionControlRequest([...base, ...suffix])).toThrow();
      try { operatorConnectionControlRequest([...base, ...suffix]); } catch (error) { expect(String(error)).not.toContain('unknown-secret'); }
    }
  });
  it('transports explicit shared-account setup without mixing browser or delivery controls', () => {
    const argv = ['app.exe', '--cos-shared-accounts=enable', '--cos-share-drive=C:\\', '--cos-share-drive=H:\\',
      '--cos-shared-accounts-dry-run', '--background'];
    const payload = operatorProfileCreationAdditionalData(argv);
    expect(payload).toEqual({ cosSharedAccounts: { version: 1,
      request: { action: 'enable', drives: ['C:\\', 'H:\\'], dryRun: true }, background: true } });
    expect(operatorProfileCreationSecondInstanceArgs(['app.exe', '--enable-features=NativeOnly'], payload))
      .toEqual(argv.slice(1));
  });

  it('shared-account setup refuses mixed, split, duplicate and malformed control arguments', () => {
    const id = 'profile-7a25c7a4-3452-4c79-8e67-f968852d90b4';
    for (const args of [
      ['--cos-shared-accounts'], ['--cos-shared-accounts=invalid'],
      ['--cos-shared-accounts=enable', '--cos-shared-accounts=inspect'],
      ['--cos-shared-accounts=enable', '--cos-share-drive=C:\\', '--cos-share-drive=c:\\'],
      ['--cos-shared-accounts=enable', '--cos-share-drive=C:/'],
      ['--cos-shared-accounts=enable', '--cos-share-drive=C:\\workspace'],
      ['--cos-shared-accounts=enable', '--cos-share-drive=C:'],
      ['--cos-shared-accounts=enable', '--cos-share-drive', 'C:\\'],
      ['--cos-shared-accounts=enable', '--pause-automation'],
      ['--cos-shared-accounts=enable', '--cos-create-profile=Other', '--cos-profile-browser=Profile 8'],
      ['--cos-shared-accounts=enable', '--api-key=never-log'],
      ['--cos-shared-accounts=enable', `--cos-instance-runtime=${id}`],
      ['--cos-shared-accounts=disable', `--cos-instance-runtime=${id}`],
      ['--cos-shared-accounts=inspect', '--cos-instance-runtime=other'],
      ['--cos-shared-accounts=inspect', '--cos-share-drive=C:\\'],
      ['--cos-shared-accounts=enable', '--cos-shared-accounts-dry-run', '--cos-shared-accounts-dry-run'],
      ['--cos-shared-accounts=enable', '--background', '--background']
    ]) {
      expect(() => operatorSharedAccountSettingsRequest(['app.exe', ...args])).toThrow();
    }
    expect(operatorSharedAccountSettingsRequest(['app.exe', '--cos-shared-accounts=inspect',
      `--cos-instance-runtime=${id}`, '--background'])).toEqual({ action: 'inspect', drives: [], dryRun: false });
    expect(operatorSharedAccountSettingsRequest(['app.exe', '--background'])).toBeNull();
  });

  it('shared-account second launch consumes invalid transport without fallback or leaking values', () => {
    const argv = ['app.exe', '--cos-shared-accounts=enable', '--cos-share-drive=C:\\'];
    const valid = operatorProfileCreationAdditionalData(argv)!;
    if (!('cosSharedAccounts' in valid)) throw new Error('Expected shared account transport');
    for (const data of [undefined, null, {}, { ...valid, apiKey: 'never-log' },
      { cosSharedAccounts: { ...valid.cosSharedAccounts, version: 2 } },
      { cosSharedAccounts: { ...valid.cosSharedAccounts, request: { ...valid.cosSharedAccounts.request, model: 'never-log' } } },
      { cosSharedAccounts: { ...valid.cosSharedAccounts, request: { ...valid.cosSharedAccounts.request, drives: ['C:\\private'] } } }
    ]) {
      expect(() => operatorProfileCreationSecondInstanceArgs(argv, data)).toThrow();
      try { operatorProfileCreationSecondInstanceArgs(argv, data); } catch (error) {
        expect(String(error)).not.toContain('never-log');
      }
    }
  });

  it('rejects Windows-split browser directories and every positional tail before invoking an owner', async () => {
    const creator = vi.fn(async () => ({ createdProfileId: 'profile-example' }));
    for (const argv of [
      ['app.exe', '8', '--cos-create-profile=Gamma', '--cos-profile-browser=Profile 8'],
      ['app.exe', 'unexpected', '--cos-create-profile=Gamma', '--cos-profile-browser=Profile 8'],
      ['app.exe', '--cos-create-profile=Gamma', '--cos-profile-browser=Profile', '8', '--background'],
      ['app.exe', '--cos-create-profile=Gamma', 'unexpected', '--cos-profile-browser=Profile 8'],
      ['app.exe', '--cos-create-profile=Gamma', '--cos-profile-browser=Profile 8', 'unexpected']
    ]) {
      expect(() => operatorProfileCreationRequest(argv)).toThrow(/positional|quote/i);
      await expect(processOperatorProfileCreation(argv, creator)).rejects.toThrow();
    }
    expect(creator).not.toHaveBeenCalled();
    expect(operatorProfileCreationRequest(['app.exe', path.resolve('.'), '--cos-create-profile=Gamma',
      '--cos-profile-browser=Profile 8'])).toEqual({ nickname: 'Gamma', browserProfileDirectory: 'Profile 8' });
  });

  it('transports one canonical profile browser-binding request and delegates only to its existing owner', async () => {
    const id = 'profile-7a25c7a4-3452-4c79-8e67-f968852d90b4';
    const original = ['app.exe', `--cos-set-profile-browser=${id}`, '--cos-profile-browser=Profile 8', '--background'];
    expect(operatorProfileBrowserBindingRequest(original)).toEqual({ id, browserProfileDirectory: 'Profile 8' });
    const payload = operatorProfileCreationAdditionalData(original);
    expect(payload).toEqual({ cosProfileBrowserBinding: { version: 1,
      request: { id, browserProfileDirectory: 'Profile 8' }, background: true } });
    const mutated = ['app.exe', '--original-process-start-time=13399056000000000', '--background',
      '--cos-profile-browser=Profile 8', '--enable-features=ChromiumOwned', `--cos-set-profile-browser=${id}`];
    expect(() => operatorProfileBrowserBindingRequest(mutated)).toThrow(/other controls/);
    expect(operatorProfileCreationSecondInstanceArgs(mutated, payload)).toEqual(original.slice(1));
    const setter = vi.fn(async () => ({ profiles: [] }));
    await expect(processOperatorProfileBrowserBinding(original, setter)).resolves.toBe(id);
    expect(setter).toHaveBeenCalledExactlyOnceWith(id, 'Profile 8');
    await expect(processOperatorProfileBrowserBinding(['app.exe'], setter)).resolves.toBeNull();
  });

  it('transports validated registration independently of Chromium reordered/injected argv', () => {
    const original = ['app.exe', '--cos-create-profile=Gamma', '--cos-profile-browser=Profile 8', '--background'];
    const payload = operatorProfileCreationAdditionalData(original);
    expect(payload).toEqual({ cosProfileCreation: { version: 1,
      request: { nickname: 'Gamma', browserProfileDirectory: 'Profile 8' }, background: true } });
    const mutated = ['app.exe', '--original-process-start-time=13399056000000000', '--background',
      '--cos-profile-browser=Profile 8', '--enable-features=ChromiumOwned', '--cos-create-profile=Gamma'];
    expect(() => operatorProfileCreationRequest(mutated)).toThrow(/other controls/);
    expect(operatorProfileCreationSecondInstanceArgs(mutated, payload)).toEqual([
      '--cos-create-profile=Gamma', '--cos-profile-browser=Profile 8', '--background'
    ]);
    expect(operatorProfileCreationAdditionalData(['app.exe', '--background'])).toBeUndefined();
    expect(operatorProfileCreationSecondInstanceArgs(['app.exe', '--background'], {})).toBeNull();
    expect(() => operatorProfileCreationAdditionalData([...original, '--api-key=never-log'])).toThrow();
  });

  it('refuses missing, malformed or unknown registration payload fields without exposing their values', () => {
    const argv = ['app.exe', '--cos-create-profile=Gamma', '--cos-profile-browser=Profile 8'];
    const valid = operatorProfileCreationAdditionalData(argv)!;
    if (!('cosProfileCreation' in valid)) throw new Error('Expected a creation envelope');
    for (const payload of [undefined, null, {}, [], { wrongOwner: valid.cosProfileCreation },
      { ...valid, apiKey: 'never-log' }, { cosProfileCreation: { ...valid.cosProfileCreation, version: 2 } },
      { cosProfileCreation: { ...valid.cosProfileCreation, background: 'true' } },
      { cosProfileCreation: { ...valid.cosProfileCreation, request: { nickname: 'x'.repeat(49), browserProfileDirectory: 'Profile 8' } } },
      { cosProfileCreation: { ...valid.cosProfileCreation, request: { nickname: 'Gamma', browserProfileDirectory: 'x'.repeat(129) } } },
      { cosProfileCreation: { ...valid.cosProfileCreation, request: { ...valid.cosProfileCreation.request, root: 'never-log' } } },
      { cosProfileCreation: { ...valid.cosProfileCreation, request: { nickname: 'bad\nname', browserProfileDirectory: 'Profile 8' } } },
      { cosProfileCreation: { ...valid.cosProfileCreation, request: { nickname: 'Gamma', browserProfileDirectory: 'C:\\private' } } }
    ]) {
      expect(() => operatorProfileCreationSecondInstanceArgs(argv, payload)).toThrow();
      try { operatorProfileCreationSecondInstanceArgs(argv, payload); }
      catch (error) { expect(String(error)).not.toContain('never-log'); }
    }
  });
  it('refuses malformed, conflicting or unapproved browser-binding controls without calling its owner', async () => {
    const id = 'profile-7a25c7a4-3452-4c79-8e67-f968852d90b4';
    const setter = vi.fn();
    const base = [`--cos-set-profile-browser=${id}`, '--cos-profile-browser=Profile 8'];
    for (const args of [
      [`--cos-set-profile-browser=${id}`], ['--cos-set-profile-browser', '--cos-profile-browser=Profile 8'],
      ...['local-instance', 'profile-example', id.toUpperCase(), `${id} `, id.replace('-4c79-', '-5c79-'),
        id.replace('-8e67-', '-7e67-'), '../bad'].map(value => [`--cos-set-profile-browser=${value}`, '--cos-profile-browser=Profile 8']),
      [...base, `--cos-set-profile-browser=${id}`], [...base, '--cos-profile-browser=Profile 8'],
      [...base, '--cos-create-profile=Gamma'], [...base, '--background', '--background'],
      ['--cos-set-profile-browser-unknown=never-log', '--cos-profile-browser=Profile 8'],
      ['--cos-set-profile-unknown=never-log', '--cos-profile-browser=Profile 8'],
      [`--cos-set-profile-browser=${id}`, '--cos-profile-browser=Profile', '8'],
      [`--cos-set-profile-browser=${id}`, '--cos-profile-browser=C:\\private'],
      [`--cos-set-profile-browser=${id}`, '--cos-profile-browser=..'],
      ...['--api-key=never-log', '--root=C:\\', '--tunnel-id=never-log', '--connect', '--launch',
        '--pause-automation', '--resume-automation', '--updated', '--cos-instance-runtime=profile-other',
        '--safe-close-for-update=local-instance', '--cos-enqueue-input=never-log',
        '--cos-cancel-queued-input=never-log', '--cos-retry-queued-input=never-log']
        .map(value => [...base, value])
    ]) {
      const argv = ['app.exe', ...args];
      expect(() => operatorProfileBrowserBindingRequest(argv)).toThrow();
      await expect(processOperatorProfileBrowserBinding(argv, setter)).rejects.toThrow();
      try { operatorProfileCreationAdditionalData(argv); }
      catch (error) { expect(String(error)).not.toContain('never-log'); }
    }
    expect(setter).not.toHaveBeenCalled();
  });

  it('refuses tampered browser-binding envelopes and never falls through to unrelated controls', () => {
    const id = 'profile-7a25c7a4-3452-4c79-8e67-f968852d90b4';
    const argv = ['app.exe', `--cos-set-profile-browser=${id}`, '--cos-profile-browser=Profile 8'];
    const valid = operatorProfileCreationAdditionalData(argv)!;
    if (!('cosProfileBrowserBinding' in valid)) throw new Error('Expected a browser-binding envelope');
    for (const payload of [undefined, null, {}, [], { wrongOwner: valid.cosProfileBrowserBinding },
      { ...valid, apiKey: 'never-log' }, { ...valid, cosProfileCreation: { version: 1,
        request: { nickname: 'Gamma', browserProfileDirectory: 'Profile 8' }, background: false } },
      { cosProfileBrowserBinding: { ...valid.cosProfileBrowserBinding, version: 2 } },
      { cosProfileBrowserBinding: { ...valid.cosProfileBrowserBinding, background: 'true' } },
      ...[{ id: 'local-instance', browserProfileDirectory: 'Profile 8' },
        { id, browserProfileDirectory: 'x'.repeat(129) }, { id, browserProfileDirectory: 'bad\nname' },
        { id, browserProfileDirectory: '../bad' }, { id, browserProfileDirectory: 'Profile 8', root: 'never-log' }]
        .map(request => ({ cosProfileBrowserBinding: { ...valid.cosProfileBrowserBinding, request } }))
    ]) {
      expect(() => operatorProfileCreationSecondInstanceArgs([...argv, '--pause-automation'], payload)).toThrow();
      try { operatorProfileCreationSecondInstanceArgs(argv, payload); }
      catch (error) { expect(String(error)).not.toContain('never-log'); }
    }
  });

  it('parses only one bounded non-secret account name and browser directory pair', () => {
    expect(operatorProfileCreationRequest(['app.exe', '--background'])).toBeNull();
    expect(operatorProfileCreationRequest(['app.exe', '--background',
      '--cos-profile-browser= Profile 8 ', '--cos-create-profile= Gamma ']))
      .toEqual({ nickname: 'Gamma', browserProfileDirectory: 'Profile 8' });
    for (const args of [
      ['--cos-create-profile=Gamma'], ['--cos-profile-browser=Profile 8'],
      ['--cos-create-profile', '--cos-profile-browser=Profile 8'],
      ['--cos-create-profile=Gamma', '--cos-profile-browser'],
      ['--cos-create-profile=Gamma', '--cos-create-profile=Gamma', '--cos-profile-browser=Profile 8'],
      ['--cos-create-profile=Gamma', '--cos-profile-browser=Profile 8', '--cos-profile-browser=Profile 8'],
      ['--cos-create-profile=   ', '--cos-profile-browser=Profile 8'],
      [`--cos-create-profile=${'x'.repeat(49)}`, '--cos-profile-browser=Profile 8'],
      ['--cos-create-profile=Gamma\t', '--cos-profile-browser=Profile 8'],
      ['--cos-create-profile=Ja\u2028sury', '--cos-profile-browser=Profile 8'],
      ['--cos-create-profile=Ja\u2029sury', '--cos-profile-browser=Profile 8'],
      ['--cos-create-profile=Gamma', '--cos-profile-browser=C:\\User Data\\Profile 8'],
      ['--cos-create-profile=Gamma', '--cos-profile-browser=..'],
      ['--cos-create-profile=Gamma', '--cos-profile-browser=Profile\u0001 8'],
      ['--cos-create-profiles=Gamma', '--cos-profile-browser=Profile 8'],
      ['--cos-create-profile=Gamma', '--cos-profile-browser-directory=Profile 8'],
      ['--cos-create-account=Gamma'], ['--cos-profile-root=C:\\']
    ]) expect(() => operatorProfileCreationRequest(['app.exe', ...args])).toThrow();
  });

  it.each([
    '--pause-automation', '--resume-automation', '--pause-session-automation=session-example',
    '--set-helper-reasoning=high', '--helper-settings-profile=local-instance',
    '--set-chat-default-model=gpt-6-thinking', '--retire-recorded-chats', '--updated',
    '--safe-close-for-update=local-instance', '--cos-enqueue-input=invalid',
    '--cos-cancel-queued-input=invalid', '--cos-retry-queued-input=invalid',
    '--cos-core-refresh-rearm=invalid', '--cos-instance-runtime=profile-elsewhere',
    '--enable-signout-emergency-alerts', '--disable-signout-emergency-alerts',
    '--cos-create-profile-key=secret', '--cos-profile-browser-key=secret', '--api-key=secret',
    '--tunnel-id=opaque', '--root=C:\\', '--connect', '--launch'
  ])('refuses provisioning mixed with %s without calling any owner', async argument => {
    const creator = vi.fn(async () => ({ createdProfileId: 'profile-example' }));
    const args = ['app.exe', '--cos-create-profile=Gamma', '--cos-profile-browser=Profile 8', argument];
    expect(() => operatorProfileCreationRequest(args)).toThrow();
    await expect(processOperatorProfileCreation(args, creator)).rejects.toThrow();
    expect(creator).not.toHaveBeenCalled();
  });

  it('routes valid provisioning directly to the incumbent profile creator, not an input bundle', async () => {
    const creator = vi.fn(async () => ({ createdProfileId: 'profile-Gamma' }));
    await expect(processOperatorProfileCreation(['app.exe'], creator)).resolves.toBeNull();
    await expect(processOperatorProfileCreation(['app.exe', '--background',
      '--cos-create-profile=Gamma', '--cos-profile-browser=Profile 8'], creator))
      .resolves.toBe('profile-Gamma');
    expect(creator.mock.calls).toEqual([['Gamma', 'Profile 8']]);
  });

  it('accepts only bounded opaque request ids', () => {
    const id = randomUUID();
    expect(operatorInputRequestIds(['app', `--cos-enqueue-input=${id}`, `--cos-enqueue-input=${id}`, '--cos-enqueue-input=../bad'])).toEqual([id]);
    expect(operatorInputCancellationIds(['app', `--cos-cancel-queued-input=${id}`,
      `--cos-cancel-queued-input=${id}`, '--cos-cancel-queued-input=../bad'])).toEqual([id]);
  });

  it('accepts one retry target and receipt after Electron reorders and interleaves argv', () => {
    const id = randomUUID(), receipt = randomUUID();
    expect(operatorInputRetryIds(['app.exe', '--background'])).toEqual([]);
    expect(operatorInputRetryIds([
      'app.exe', `--cos-retry-queued-input-receipt=${receipt}`, '--electron-native-argument',
      `--cos-retry-queued-input=${id}`, '--background'
    ])).toEqual([id]);
  });

  it('rejects missing, duplicate, malformed, or multiple retry operations', () => {
    const id = randomUUID(), receipt = randomUUID();
    expect(() => operatorInputRetryIds(['app', `--cos-retry-queued-input=${id}`]))
      .toThrow('exactly one UUID and one operation receipt');
    expect(() => operatorInputRetryIds(['app', `--cos-retry-queued-input-receipt=${receipt}`]))
      .toThrow('exactly one UUID and one operation receipt');
    expect(() => operatorInputRetryIds(['app', '--cos-retry-queued-input',
      `--cos-retry-queued-input-receipt=${receipt}`]))
      .toThrow('--cos-retry-queued-input requires one valid UUID');
    expect(() => operatorInputRetryIds(['app', `--cos-retry-queued-input=${id}`,
      '--cos-retry-queued-input-receipt']))
      .toThrow('--cos-retry-queued-input-receipt requires one valid UUID');
    expect(() => operatorInputRetryIds(['app', '--cos-retry-queued-input=../bad',
      `--cos-retry-queued-input-receipt=${receipt}`]))
      .toThrow('--cos-retry-queued-input requires one valid UUID');
    expect(() => operatorInputRetryIds(['app', `--cos-retry-queued-input=${id}`,
      '--cos-retry-queued-input-receipt=../bad']))
      .toThrow('--cos-retry-queued-input-receipt requires one valid UUID');
    expect(() => operatorInputRetryIds(['app', `--cos-retry-queued-input=${id}`,
      `--cos-retry-queued-input=${id}`, `--cos-retry-queued-input-receipt=${receipt}`]))
      .toThrow('exactly one UUID and one operation receipt');
    expect(() => operatorInputRetryIds(['app', `--cos-retry-queued-input=${id}`,
      `--cos-retry-queued-input-receipt=${receipt}`, `--cos-retry-queued-input-receipt=${receipt}`]))
      .toThrow('exactly one UUID and one operation receipt');
    expect(() => operatorInputRetryIds(['app',
      `--cos-retry-queued-input=${id}`, `--cos-retry-queued-input-receipt=${receipt}`,
      `--cos-retry-queued-input=${randomUUID()}`, `--cos-retry-queued-input-receipt=${randomUUID()}`
    ])).toThrow('exactly one UUID and one operation receipt');
  });

  it('admits one bundle through the native sender and consumes its claim', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'cos-operator-'));
    const id = randomUUID(), directory = operatorInputDirectory(root);
    await import('node:fs/promises').then(({ mkdir }) => mkdir(directory, { recursive: true }));
    await writeFile(path.join(directory, `${id}.json`), JSON.stringify({ version: 1, id, input: input(id) }));
    const sender = vi.fn(async value => ({ ...value, state: 'queued' as const, owner: null, createdAt: 123, conversationId: null }));
    await expect(processOperatorInputRequests([`--cos-enqueue-input=${id}`], root, sender)).resolves.toEqual({ requested: 1, accepted: 1 });
    expect(sender).toHaveBeenCalledWith(expect.objectContaining({ ...input(id),
      operatorRequestKey: expect.stringMatching(/^[0-9a-f]{64}$/) }));
    await expect(readFile(path.join(directory, `${id}.json`))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(readFile(path.join(directory, `${id}.processing`))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('retains version-3 recipe admission as an exact replay fence', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'cos-operator-workflow-'));
    const filesystem = await import('node:fs/promises');
    try {
      const id = randomUUID(), directory = operatorInputDirectory(root);
      await filesystem.mkdir(directory, { recursive: true });
      const bundle = { version: 3, id, input: { ...input(id), mode: 'auto', automation: 'off', objective: '',
        finiteOneOff: true, workflow: { runId: randomUUID(), recipeSha256: 'a'.repeat(64), step: 'test',
          order: 0, total: 1, maxParallel: 1, dependsOn: [], checks: [{ kind: 'acceptance' }] } } };
      await writeFile(path.join(directory, `${id}.json`), JSON.stringify(bundle));
      const sender = vi.fn(async value => ({ ...value, state: 'queued' as const, owner: null, createdAt: 1, conversationId: null }));
      expect(await processOperatorInputRequests([`--cos-enqueue-input=${id}`], root, sender)).toEqual({ requested: 1, accepted: 1 });
      expect(JSON.parse(await readFile(path.join(directory, `${id}.admitted`), 'utf8'))).toEqual(bundle);
      await writeFile(path.join(directory, `${id}.json`), JSON.stringify(bundle));
      await expect(processOperatorInputRequests([`--cos-enqueue-input=${id}`], root, sender)).rejects.toThrow(/already has an admission receipt/);
      expect(sender).toHaveBeenCalledTimes(1);
    } finally { await filesystem.rm(root, { recursive: true, force: true }); }
  });

  it('preflights every bundle before admitting any member of the launch batch', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'cos-operator-'));
    const directory = operatorInputDirectory(root);
    const first = randomUUID(), invalid = randomUUID();
    await import('node:fs/promises').then(({ mkdir }) => mkdir(directory, { recursive: true }));
    await writeFile(path.join(directory, `${first}.json`), JSON.stringify({ version: 1, id: first, input: input(first) }));
    await writeFile(path.join(directory, `${invalid}.json`), JSON.stringify({
      version: 1, id: invalid, input: { ...input(invalid), text: '' }
    }));
    const sender = vi.fn(async value => ({ ...value, state: 'queued' as const, owner: null, createdAt: 123, conversationId: null }));

    await expect(processOperatorInputRequests([
      `--cos-enqueue-input=${first}`, `--cos-enqueue-input=${invalid}`
    ], root, sender)).rejects.toMatchObject({
      code: 'OPERATOR_INPUT_BATCH_PREFLIGHT_FAILED',
      stage: 'preflight',
      inputId: invalid,
      requested: 2
    });

    expect(sender).not.toHaveBeenCalled();
    expect(JSON.parse(await readFile(path.join(directory, `${first}.json`), 'utf8')).id).toBe(first);
    expect(JSON.parse(await readFile(path.join(directory, `${invalid}.json`), 'utf8')).id).toBe(invalid);
  });

  it('preserves a new-chat nickname through account-scoped admission', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'cos-operator-'));
    const id = randomUUID(), directory = operatorInputDirectory(root);
    await import('node:fs/promises').then(({ mkdir }) => mkdir(directory, { recursive: true }));
    const authored = { ...input(id), nickname: 'MMA Cage Removal' };
    await writeFile(path.join(directory, `${id}.json`), JSON.stringify({ version: 1, id, input: authored }));
    const sender = vi.fn(async value => ({ ...value, state: 'queued' as const, owner: null, createdAt: 123, conversationId: null }));
    await expect(processOperatorInputRequests([`--cos-enqueue-input=${id}`], root, sender))
      .resolves.toEqual({ requested: 1, accepted: 1 });
    expect(sender).toHaveBeenCalledWith(expect.objectContaining({ ...authored,
      operatorRequestKey: expect.stringMatching(/^[0-9a-f]{64}$/) }));
  });

  it('resolves one exact existing main-chat target inside the owning account runtime', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'cos-operator-'));
    const id = randomUUID(), directory = operatorInputDirectory(root);
    await import('node:fs/promises').then(({ mkdir }) => mkdir(directory, { recursive: true }));
    await writeFile(path.join(directory, `${id}.json`), JSON.stringify({
      version: 2,
      id,
      target: { title: 'Exact recorded title' },
      input: input(id)
    }));
    const sender = vi.fn(async value => ({ ...value, state: 'queued' as const, owner: null, createdAt: 123, conversationId: 'conversation-current' }));
    const resolver = vi.fn(async () => 'session-existing-main');
    await expect(processOperatorInputRequests([`--cos-enqueue-input=${id}`], root, sender, resolver))
      .resolves.toEqual({ requested: 1, accepted: 1 });
    expect(resolver).toHaveBeenCalledWith({ title: 'Exact recorded title' });
    expect(sender).toHaveBeenCalledWith(expect.objectContaining({ ...input(id),
      sessionId: 'session-existing-main', operatorRequestKey: expect.stringMatching(/^[0-9a-f]{64}$/) }));
  });

  it('restores a targeted bundle when its selector is missing or ambiguous', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'cos-operator-'));
    const id = randomUUID(), directory = operatorInputDirectory(root);
    await import('node:fs/promises').then(({ mkdir }) => mkdir(directory, { recursive: true }));
    await writeFile(path.join(directory, `${id}.json`), JSON.stringify({
      version: 2,
      id,
      target: { title: 'Duplicated title' },
      input: input(id)
    }));
    const sender = vi.fn();
    const resolver = vi.fn(async () => { throw new Error('found 2'); });
    await expect(processOperatorInputRequests([`--cos-enqueue-input=${id}`], root, sender, resolver))
      .rejects.toThrow('found 2');
    expect(sender).not.toHaveBeenCalled();
    expect(JSON.parse(await readFile(path.join(directory, `${id}.json`), 'utf8')).id).toBe(id);
  });

  it('preserves a real long-form Loop objective through account-scoped admission', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'cos-operator-'));
    const id = randomUUID(), directory = operatorInputDirectory(root);
    await import('node:fs/promises').then(({ mkdir }) => mkdir(directory, { recursive: true }));
    const authored = { ...input(id), objective: 'L'.repeat(20_064) };
    await writeFile(path.join(directory, `${id}.json`), JSON.stringify({ version: 1, id, input: authored }));
    const sender = vi.fn(async value => ({ ...value, state: 'queued' as const, owner: null, createdAt: 123, conversationId: null }));
    await expect(processOperatorInputRequests([`--cos-enqueue-input=${id}`], root, sender)).resolves.toEqual({ requested: 1, accepted: 1 });
    expect(sender).toHaveBeenCalledWith(expect.objectContaining({ ...authored,
      operatorRequestKey: expect.stringMatching(/^[0-9a-f]{64}$/) }));
  });

  it('derives target identity after resolution and carries exact retry evidence', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'cos-operator-'));
    const directory = operatorInputDirectory(root);
    await import('node:fs/promises').then(({ mkdir }) => mkdir(directory, { recursive: true }));
    const first = randomUUID(), second = randomUUID(), failed = randomUUID();
    await writeFile(path.join(directory, `${first}.json`), JSON.stringify({
      version: 2, id: first, target: { title: 'Resolved title' }, input: input(first)
    }));
    await writeFile(path.join(directory, `${second}.json`), JSON.stringify({
      version: 2, id: second, target: { conversationId: randomUUID() }, retryOf: [failed], input: input(second)
    }));
    const captured: Array<Record<string, unknown>> = [];
    const sender = vi.fn(async value => {
      captured.push(value);
      return { ...value, state: 'queued' as const, owner: null, createdAt: 123, conversationId: null };
    });
    const resolver = vi.fn(async () => 'same-resolved-session');
    await expect(processOperatorInputRequests([
      `--cos-enqueue-input=${first}`, `--cos-enqueue-input=${second}`
    ], root, sender, resolver)).resolves.toEqual({ requested: 2, accepted: 2 });
    expect(captured[0]?.operatorRequestKey).toBe(captured[1]?.operatorRequestKey);
    expect(captured[1]?.operatorRetryOf).toEqual([failed]);
  });

  it('routes strict cancellation ids through the injected app owner', async () => {
    const first = randomUUID(), second = randomUUID();
    const canceller = vi.fn(async (id: string) => id === first);
    await expect(processOperatorInputCancellations([
      `--cos-cancel-queued-input=${first}`, `--cos-cancel-queued-input=${second}`
    ], canceller)).resolves.toEqual({ requested: 2, cancelled: 1 });
    expect(canceller.mock.calls).toEqual([[first], [second]]);
  });

  it('routes an attention-fenced retry through the canonical strict browser owner', async () => {
    const first = randomUUID(), firstReceipt = randomUUID();
    const retrier = vi.fn(async (id: string, requireAttentionFence: boolean, receipt: string) =>
      id === first && requireAttentionFence && receipt === firstReceipt
        ? ({ ...input(id), state: 'queued' as const, owner: null, createdAt: 123,
            conversationId: null, deliveryAttentionAt: undefined, operatorRetryReceipt: receipt })
        : null);
    await expect(processOperatorInputRetries([
      `--cos-retry-queued-input-receipt=${firstReceipt}`, '--background',
      `--cos-retry-queued-input=${first}`
    ], retrier)).resolves.toEqual({ requested: 1, rearmed: 1, refused: [] });
    expect(retrier.mock.calls).toEqual([[first, true, firstReceipt]]);
  });

  it('restores the exact bundle when admission fails', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'cos-operator-'));
    const id = randomUUID(), directory = operatorInputDirectory(root);
    await import('node:fs/promises').then(({ mkdir }) => mkdir(directory, { recursive: true }));
    await writeFile(path.join(directory, `${id}.json`), JSON.stringify({ version: 1, id, input: input(id) }));
    const sender = vi.fn(async () => { throw new Error('connector unavailable'); });
    await expect(processOperatorInputRequests([`--cos-enqueue-input=${id}`], root, sender)).rejects.toThrow('connector unavailable');
    expect(JSON.parse(await readFile(path.join(directory, `${id}.json`), 'utf8')).id).toBe(id);
  });
});


it('round-trips exact external route config and refuses duplicate, malformed and foreign-action arguments', () => {
  const profile = 'profile-7a25c7a4-3452-4c79-8e67-f968852d90b4';
  const argv = ['app.exe', '--cos-connection-action=configure', `--cos-connection-profile=${profile}`,
    `--cos-connection-receipt=${randomUUID()}`, '--cos-connection-kind=manual',
    '--cos-connection-origin=https://Delta.example.com', '--cos-connection-port=9770', `--cos-instance-runtime=${profile}`, '--background'];
  const payload = operatorProfileCreationAdditionalData(argv);
  expect(operatorProfileCreationSecondInstanceArgs(['app.exe'], payload)).toEqual(argv.slice(1));
  for (const patch of [{ manualPort: -1 }, { manualPort: '9770' }, { manualPort: 80 },
    { manualPublicOrigin: 'https://user:secret@example.com' }, { manualPublicOrigin: ['https://Delta.example.com'] },
    { action: 'connect' }, { extra: 'unrecognized' }]) {
    const data = payload as { cosConnectionControl: { request: Record<string, unknown> } };
    expect(() => operatorProfileCreationSecondInstanceArgs(['app.exe'], { ...data,
      cosConnectionControl: { ...data.cosConnectionControl, request: { ...data.cosConnectionControl.request, ...patch } } })).toThrow();
  }
  for (const extra of ['--cos-connection-port=9771', '--cos-connection-origin=https://Epsilon.example.com'])
    expect(() => operatorConnectionControlRequest([...argv, extra])).toThrow();
  for (const change of ['--cos-connection-port=NaN', '--cos-connection-port=', '--cos-connection-port=80'])
    expect(() => operatorConnectionControlRequest(argv.map(arg => arg.startsWith('--cos-connection-port=') ? change : arg))).toThrow();
  expect(() => operatorConnectionControlRequest(argv.map(arg => arg === '--cos-connection-action=configure' ? '--cos-connection-action=connect' : arg))).toThrow();
});

it('round-trips an exact Core tunnel correction and refuses receipt reuse for another tunnel', async () => {
  const { initDurableStore, readDurableStrict } = await import('../src/main/durable.js');
  const root = await mkdtemp(path.join(os.tmpdir(), 'cos-core-tunnel-receipt-'));
  initDurableStore(root);
  const tunnelId = 'tunnel_0123456789abcdef0123456789abcdef';
  const args = ['--cos-connection-action=configure', '--cos-connection-profile=local-instance',
    '--cos-connection-kind=openai', `--cos-connection-tunnel-id=${tunnelId}`,
    `--cos-connection-receipt=${randomUUID()}`];
  const payload = operatorProfileCreationAdditionalData(args);
  expect(operatorConnectionControlRequest(operatorProfileCreationSecondInstanceArgs(['app.exe'], payload)!))
    .toEqual(operatorConnectionControlRequest(args));
  expect(() => operatorConnectionControlRequest([...args, `--cos-connection-tunnel-id=${tunnelId}`])).toThrow();
  expect(() => operatorConnectionControlRequest(args.map(arg => arg === '--cos-connection-kind=openai' ? '--cos-connection-kind=manual' : arg))).toThrow();
  const controller = vi.fn(async () => ({ state: 'connected' }));
  await processOperatorConnectionControl(args, controller, root);
  await processOperatorConnectionControl(args, controller, root);
  expect(await readDurableStrict('connection-control')).toMatchObject([{ tunnelId, state: 'completed' }]);
  await expect(processOperatorConnectionControl(args.map(arg => arg.startsWith('--cos-connection-tunnel-id=')
    ? '--cos-connection-tunnel-id=tunnel_fedcba9876543210fedcba9876543210' : arg), controller, root)).rejects.toThrow(/another operation/);
  expect(controller).toHaveBeenCalledOnce();
});

it('keeps external route receipt identity while setup bearers remain only in the private transient response', async () => {
  const { initDurableStore, readDurableStrict } = await import('../src/main/durable.js');
  const root = await mkdtemp(path.join(os.tmpdir(), 'cos-external-private-response-'));
  initDurableStore(root);
  const receipt = randomUUID();
  const args = ['--cos-connection-action=configure', '--cos-connection-profile=local-instance',
    '--cos-connection-kind=manual', '--cos-connection-origin=https://Delta.example.com', '--cos-connection-port=9770',
    `--cos-connection-receipt=${receipt}`];
  const controller = vi.fn(async () => ({ url: 'https://Delta.example.com/mcp/core/private-test-bearer' }));
  await processOperatorConnectionControl(args, controller, root);
  const audit = await readDurableStrict('connection-control');
  expect(audit).toMatchObject([{ manualPublicOrigin: 'https://Delta.example.com', manualPort: 9770, state: 'completed' }]);
  expect(JSON.stringify(audit)).not.toContain('private-test-bearer');
  expect(await readFile(operatorControlResponsePath(root, receipt, 'connection'), 'utf8')).toContain('private-test-bearer');
  await processOperatorConnectionControl(args, controller, root);
  for (const change of ['--cos-connection-origin=https://Epsilon.example.com', '--cos-connection-port=9771'])
    await expect(processOperatorConnectionControl(args.map(arg => arg.startsWith(change.split('=')[0] + '=') ? change : arg), controller, root)).rejects.toThrow(/another operation/);
  expect(controller).toHaveBeenCalledOnce();
});
