import { afterEach, describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  flushLogBeforeExit, flushLogFile, formatLogAsJson, getLog, initLogFile, logEvent, logInfo,
  onLog, resetLoggerForTests, setLogProfileContext, snapshotLogOnCrash, logWarn
} from '../src/main/logger.js';
import { offerBrowserDebugCapture, completeBrowserDebugCapture, browserDebugCaptureOwner,
  BROWSER_DEBUG_IMAGE_BYTES, BROWSER_DEBUG_IMAGE_SLOTS } from '../src/main/logger.js';
import { listLocalIncidents, readLocalIncidentImage, flushLocalIncidents, noteLocalIncident, LOCAL_INCIDENT_SLOTS } from '../src/main/logger.js';
import { runShutdownSequence } from '../src/main/shutdown.js';
import { emptyEvidence, runInCallContext } from '../src/main/mcp/call-context.js';

const cleanup: string[] = [];
afterEach(async () => {
  await flushLogFile().catch(() => undefined);
  await flushLocalIncidents().catch(() => undefined);
  vi.restoreAllMocks();
  resetLoggerForTests();
  for (const dir of cleanup.splice(0)) await fs.rm(dir, { recursive: true, force: true });
});
async function logFile(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'clf-logger-'));
  cleanup.push(dir);
  const file = path.join(dir, 'app.log');
  initLogFile(file);
  return file;
}

describe('bounded asynchronous diagnostic mirror', () => {
  const debugInput = { sessionId: '2026-10-14-test', conversationId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
    reason: 'stream_gone', errors: 1, runningTools: 0, automationPaused: true, screenEnabled: true };

  it('restores real profile-owned incidents after a cold logger reset without exposing log credentials', async () => {
    const profile = 'profile-f481290d-e54c-42a6-be5d-c8a19b35f0aa';
    setLogProfileContext(profile);
    const file = await logFile();
    const secret = 'sk-private-owner-roundtrip123456789';
    const nativeRequest = `wfr_${'x'.repeat(60)}`;
    logEvent('profile.lifecycle.started', `owner ${profile} credential ${secret} request ${nativeRequest}`);
    expect(await noteLocalIncident({ source: 'browser-debug', reason: 'native_terminal_open_call',
      sessionId: debugInput.sessionId, conversationId: debugInput.conversationId,
      detail: `private tool body ${secret} ${nativeRequest}`,
      nativeCompletion: { openCalls: 2, openCodeCalls: 0, traceRequestIds: 0, exactRequestJoins: 0 } })).toBe(true);
    await flushLogFile();
    const exported = formatLogAsJson();
    const mirrored = await fs.readFile(file, 'utf8');
    await flushLocalIncidents();
    resetLoggerForTests();
    setLogProfileContext(profile);
    initLogFile(file);
    const restored = await listLocalIncidents();
    expect(restored.status).toBe('ready');
    expect(restored.incidents).toHaveLength(1);
    expect(restored.incidents[0]).toMatchObject({ profileId: profile, reason: 'native_terminal_open_call',
      nativeCompletion: { openCalls: 2, openCodeCalls: 0, traceRequestIds: 0, exactRequestJoins: 0 },
      sendEvidence: 'not_observed', domEvidence: 'not_captured' });
    const saved = await fs.readFile(path.join(restored.folder!, 'incident-0.json'), 'utf8');
    expect(JSON.parse(saved).profileId).toBe(profile);
    for (const text of [exported, mirrored]) {
      expect(text).not.toContain(profile);
      expect(text).not.toContain(secret);
      expect(text).not.toContain(nativeRequest);
      expect(text).toContain('***');
    }
    expect(mirrored).toContain('[profile:***]');
    expect(saved).not.toContain(secret);
    expect(saved).not.toContain('private tool body');
  });

  it.each(['profile-8bc4db29-9172-4c9a-876d-6d52d81866a7', '***', null, { injected: 'private-owner' }])(
    'preserves an occupied incident slot with unverified profile ownership %j and writes only a free slot', async storedProfile => {
      const profile = 'profile-f481290d-e54c-42a6-be5d-c8a19b35f0aa';
      setLogProfileContext(profile);
      const file = await logFile();
      await noteLocalIncident({ source: 'app', reason: 'retained_older_evidence' });
      const folder = path.join(path.dirname(file), 'local-incidents');
      const slot = path.join(folder, 'incident-0.json');
      const previous = JSON.parse(await fs.readFile(slot, 'utf8'));
      previous.profileId = storedProfile;
      const retained = JSON.stringify(previous);
      await fs.writeFile(slot, retained);
      await flushLogFile();
      resetLoggerForTests();
      setLogProfileContext(profile);
      initLogFile(file);
      const rejected = await listLocalIncidents();
      expect(rejected).toMatchObject({ status: 'storage_unavailable', storageError: 'incident_slot_unverified',
        unverifiedSlots: 1, incidents: [] });
      expect(await noteLocalIncident({ source: 'app', reason: 'new_current_profile_evidence' })).toBe(true);
      expect(await fs.readFile(slot, 'utf8')).toBe(retained);
      const current = await listLocalIncidents();
      expect(current).toMatchObject({ status: 'storage_unavailable', storageError: 'incident_slot_unverified' });
      expect(current.incidents).toEqual([expect.objectContaining({ profileId: profile, reason: 'new_current_profile_evidence' })]);
      expect(JSON.stringify(current)).not.toContain('retained_older_evidence');
      expect(JSON.stringify(current)).not.toContain('private-owner');
      expect(JSON.parse(await fs.readFile(path.join(folder, 'incident-1.json'), 'utf8')).profileId).toBe(profile);
    }
  );

  it('refuses a profile-context switch while the incident folder still belongs to the original account', async () => {
    const first = 'profile-f481290d-e54c-42a6-be5d-c8a19b35f0aa';
    const other = 'profile-8bc4db29-9172-4c9a-876d-6d52d81866a7';
    setLogProfileContext(first);
    const file = await logFile();
    expect(await noteLocalIncident({ source: 'app', reason: 'owned_initial' })).toBe(true);
    const folder = path.join(path.dirname(file), 'local-incidents');
    const original = await fs.readFile(path.join(folder, 'incident-0.json'), 'utf8');

    setLogProfileContext(other);
    expect(await noteLocalIncident({ source: 'app', reason: 'foreign_context' })).toBe(false);
    expect((await fs.readdir(folder)).sort()).toEqual(['incident-0.json']);
    expect(await fs.readFile(path.join(folder, 'incident-0.json'), 'utf8')).toBe(original);
    setLogProfileContext(first);
    expect((await listLocalIncidents()).incidents.map(row => row.reason)).toEqual(['owned_initial']);
    expect(await noteLocalIncident({ source: 'app', reason: 'after_context_restored' })).toBe(true);
    expect((await listLocalIncidents()).incidents.map(row => row.reason)).toEqual([
      'owned_initial', 'after_context_restored'
    ]);
  });

  it.each(['switch', 'roundtrip', 'reinitialize'])(
    'does not reveal an old incident read or its directory after a %s during disk IO', async transition => {
      const owner = 'profile-f481290d-e54c-42a6-be5d-c8a19b35f0aa';
      const different = 'profile-8bc4db29-9172-4c9a-876d-6d52d81866a7';
      setLogProfileContext(owner);
      const file = await logFile();
      expect(await noteLocalIncident({ source: 'app', reason: 'private_original_incident' })).toBe(true);
      const incidentFile = path.join(path.dirname(file), 'local-incidents', 'incident-0.json');
      let start!: () => void, resume!: () => void;
      const started = new Promise<void>(resolve => { start = resolve; });
      const gate = new Promise<void>(resolve => { resume = resolve; });
      const readOriginal = fs.readFile.bind(fs);
      const spy = vi.spyOn(fs, 'readFile').mockImplementationOnce(async (...args) => {
        start(); await gate; return readOriginal(...args);
      });
      const pending = listLocalIncidents();
      await started;
      try {
        if (transition === 'reinitialize') initLogFile(path.join(path.dirname(file), 'replacement.log'));
        else {
          setLogProfileContext(different);
          if (transition === 'roundtrip') setLogProfileContext(owner);
        }
        resume();
        expect(await pending).toMatchObject({ folder: null, logFile: null,
          status: 'storage_unavailable', storageError: 'incident_profile_unverified',
          freeSlots: 0, unverifiedSlots: 0, incidents: [] });
      } finally {
        spy.mockRestore();
        setLogProfileContext(owner);
      }
      expect(JSON.parse(await fs.readFile(incidentFile, 'utf8')).reason).toBe('private_original_incident');
      expect((await listLocalIncidents()).incidents.map(item => item.reason)).toEqual([
        'private_original_incident'
      ]);
    }
  );

  it('does not acknowledge a cached fingerprint after a foreign record replaced its owned slot', async () => {
    const first = 'profile-f481290d-e54c-42a6-be5d-c8a19b35f0aa';
    setLogProfileContext(first);
    const file = await logFile();
    const fingerprint = 'a'.repeat(64);
    expect(await noteLocalIncident({ source: 'app', reason: 'original_failure', fingerprint })).toBe(true);
    const folder = path.join(path.dirname(file), 'local-incidents');
    const slot = path.join(folder, 'incident-0.json');
    const foreign = { ...JSON.parse(await fs.readFile(slot, 'utf8')),
      profileId: 'profile-8bc4db29-9172-4c9a-876d-6d52d81866a7', reason: 'foreign_failure' };
    const preserved = JSON.stringify(foreign);
    await fs.writeFile(slot, preserved);

    expect(await noteLocalIncident({ source: 'app', reason: 'original_failure', fingerprint })).toBe(false);
    expect(await fs.readFile(slot, 'utf8')).toBe(preserved);
    const read = await listLocalIncidents();
    expect(read).toMatchObject({ status: 'storage_unavailable', storageError: 'incident_slot_unverified' });
    expect(read.incidents.map(row => row.reason)).not.toContain('foreign_failure');
    expect(await noteLocalIncident({ source: 'app', reason: 'after_foreign_replace' })).toBe(true);
    expect((await listLocalIncidents()).incidents.map(row => row.reason)).toEqual(['after_foreign_replace']);
    expect(await fs.readFile(slot, 'utf8')).toBe(preserved);
  });

  it('never overwrites a formerly empty cached slot filled by another writer', async () => {
    const first = 'profile-f481290d-e54c-42a6-be5d-c8a19b35f0aa';
    setLogProfileContext(first);
    const file = await logFile();
    expect(await noteLocalIncident({ source: 'app', reason: 'first_saved' })).toBe(true);
    const folder = path.join(path.dirname(file), 'local-incidents');
    const original = JSON.parse(await fs.readFile(path.join(folder, 'incident-0.json'), 'utf8'));
    const slot = path.join(folder, 'incident-1.json');
    const protectedRow = JSON.stringify({ ...original, id: 'bbbbbbbb-bbbb-4ccc-8ddd-eeeeeeeeeeee',
      profileId: 'profile-8bc4db29-9172-4c9a-876d-6d52d81866a7', reason: 'foreign_after_scan' });
    await fs.writeFile(slot, protectedRow);

    expect(await noteLocalIncident({ source: 'app', reason: 'second_saved' })).toBe(false);
    expect(await fs.readFile(slot, 'utf8')).toBe(protectedRow);
    expect(await noteLocalIncident({ source: 'app', reason: 'third_saved' })).toBe(true);
    expect((await listLocalIncidents()).incidents.map(row => row.reason)).toEqual(['first_saved', 'third_saved']);
    expect(JSON.parse(await fs.readFile(path.join(folder, 'incident-2.json'), 'utf8')).profileId).toBe(first);
  });

  it('does not finish a queued old-profile incident after the active account switches during disk IO', async () => {
    const first = 'profile-f481290d-e54c-42a6-be5d-c8a19b35f0aa';
    setLogProfileContext(first);
    const file = await logFile();
    let writing!: () => void, release!: () => void;
    const started = new Promise<void>(resolve => { writing = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    const realWrite = fs.writeFile.bind(fs);
    const delay = vi.spyOn(fs, 'writeFile').mockImplementationOnce(async (...args) => {
      writing();
      await gate;
      return realWrite(...args);
    });
    const pending = noteLocalIncident({ source: 'app', reason: 'old_owner_pending' });
    await started;
    setLogProfileContext('profile-8bc4db29-9172-4c9a-876d-6d52d81866a7');
    try {
      release();
      expect(await pending).toBe(false);
      expect(await fs.readdir(path.join(path.dirname(file), 'local-incidents'))).toEqual([]);
    } finally {
      delay.mockRestore();
      setLogProfileContext(first);
    }
    expect(await noteLocalIncident({ source: 'app', reason: 'current_owner_new' })).toBe(true);
    expect((await listLocalIncidents()).incidents.map(row => row.reason)).toEqual(['current_owner_new']);
  });

  it('invalidates an in-flight incident even if a foreign profile briefly replaces and restores the same id', async () => {
    const owner = 'profile-f481290d-e54c-42a6-be5d-c8a19b35f0aa';
    setLogProfileContext(owner);
    const file = await logFile();
    let writing!: () => void, release!: () => void;
    const started = new Promise<void>(resolve => { writing = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    const realWrite = fs.writeFile.bind(fs);
    const delay = vi.spyOn(fs, 'writeFile').mockImplementationOnce(async (...args) => {
      writing(); await gate; return realWrite(...args);
    });
    const pending = noteLocalIncident({ source: 'app', reason: 'before_account_roundtrip' });
    await started;
    setLogProfileContext('profile-8bc4db29-9172-4c9a-876d-6d52d81866a7');
    setLogProfileContext(owner);
    try {
      release();
      expect(await pending).toBe(false);
    } finally { delay.mockRestore(); }
    expect(await fs.readdir(path.join(path.dirname(file), 'local-incidents'))).toEqual([]);
    expect(await noteLocalIncident({ source: 'app', reason: 'new_owner_after_roundtrip' })).toBe(true);
    expect((await listLocalIncidents()).incidents.map(row => row.reason)).toEqual(['new_owner_after_roundtrip']);
  });

  it('does not commit an old pending write after the incident owner is reinitialized under the same profile', async () => {
    const owner = 'profile-f481290d-e54c-42a6-be5d-c8a19b35f0aa';
    setLogProfileContext(owner);
    const file = await logFile();
    let writing!: () => void, release!: () => void;
    const started = new Promise<void>(resolve => { writing = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    const realWrite = fs.writeFile.bind(fs);
    const delay = vi.spyOn(fs, 'writeFile').mockImplementationOnce(async (...args) => {
      writing(); await gate; return realWrite(...args);
    });
    const pending = noteLocalIncident({ source: 'app', reason: 'retired_writer' });
    await started;
    initLogFile(file);
    try {
      release();
      expect(await pending).toBe(false);
    } finally { delay.mockRestore(); }
    expect((await listLocalIncidents()).incidents).toEqual([]);
    expect(await noteLocalIncident({ source: 'app', reason: 'replacement_writer' })).toBe(true);
    expect((await listLocalIncidents()).incidents.map(row => row.reason)).toEqual(['replacement_writer']);
  });

  it('refuses a cached same-id incident changed without a timestamp or identity change', async () => {
    setLogProfileContext('profile-f481290d-e54c-42a6-be5d-c8a19b35f0aa');
    const file = await logFile();
    const fingerprint = 'b'.repeat(64);
    expect(await noteLocalIncident({ source: 'app', reason: 'same_id_changed_body', fingerprint })).toBe(true);
    const slot = path.join(path.dirname(file), 'local-incidents', 'incident-0.json');
    const row = JSON.parse(await fs.readFile(slot, 'utf8'));
    const replacement = JSON.stringify({ ...row, status: 'resolved', occurrences: 901 });
    await fs.writeFile(slot, replacement);
    expect(await noteLocalIncident({ source: 'app', reason: 'same_id_changed_body', fingerprint })).toBe(false);
    expect(await fs.readFile(slot, 'utf8')).toBe(replacement);
    expect((await listLocalIncidents()).incidents).toEqual([
      expect.objectContaining({ reason: 'same_id_changed_body', status: 'resolved', occurrences: 901 })
    ]);
  });

  it('preserves a substituted unresolved incident that reused the id of an expired resolved slot', async () => {
    const owner = 'profile-f481290d-e54c-42a6-be5d-c8a19b35f0aa';
    setLogProfileContext(owner);
    const file = await logFile();
    const startedAt = Date.now();
    expect(await noteLocalIncident({ source: 'app', reason: 'previously_resolved', status: 'resolved' })).toBe(true);
    const slot = path.join(path.dirname(file), 'local-incidents', 'incident-0.json');
    const resolved = JSON.parse(await fs.readFile(slot, 'utf8'));
    const masked = JSON.stringify({ ...resolved, profileId: '***', status: 'unresolved' });
    await fs.writeFile(slot, masked);
    vi.spyOn(Date, 'now').mockReturnValue(startedAt + 8 * 24 * 60 * 60_000);
    const read = await listLocalIncidents();
    expect(read).toMatchObject({ status: 'storage_unavailable', storageError: 'incident_slot_unverified',
      unverifiedSlots: 1, freeSlots: LOCAL_INCIDENT_SLOTS - 1, incidents: [] });
    expect(await fs.readFile(slot, 'utf8')).toBe(masked);
  });

  it('recovers free incident capacity on an explicit read after externally restored custody', async () => {
    const owner = 'profile-f481290d-e54c-42a6-be5d-c8a19b35f0aa';
    setLogProfileContext(owner);
    const file = await logFile();
    expect(await noteLocalIncident({ source: 'app', reason: 'initial_masked_record' })).toBe(true);
    const slot = path.join(path.dirname(file), 'local-incidents', 'incident-0.json');
    const row = JSON.parse(await fs.readFile(slot, 'utf8'));
    await fs.writeFile(slot, JSON.stringify({ ...row, profileId: '***' }));
    const first = await listLocalIncidents();
    expect(first).toMatchObject({ status: 'storage_unavailable', storageError: 'incident_slot_unverified',
      unverifiedSlots: 1, freeSlots: LOCAL_INCIDENT_SLOTS - 1, incidents: [] });
    // This is an isolated fixture standing in for an explicit external custody decision:
    // production diagnostics only observe the verified absence; they never remove masked rows.
    await fs.unlink(slot);
    const recovered = await listLocalIncidents();
    expect(recovered).toMatchObject({ status: 'ready', storageError: null,
      unverifiedSlots: 0, freeSlots: LOCAL_INCIDENT_SLOTS, incidents: [] });
    expect(await noteLocalIncident({ source: 'app', reason: 'usable_after_custody_review' })).toBe(true);
    expect((await listLocalIncidents()).incidents.map(row => row.reason)).toEqual(['usable_after_custody_review']);
    expect(JSON.parse(await fs.readFile(slot, 'utf8')).profileId).toBe(owner);
  });

  it('refuses a full masked-ownership incident ring without overwriting retained evidence', async () => {
    const profile = 'profile-f481290d-e54c-42a6-be5d-c8a19b35f0aa';
    setLogProfileContext(profile);
    const file = await logFile();
    await noteLocalIncident({ source: 'app', reason: 'retained_older_evidence' });
    const folder = path.join(path.dirname(file), 'local-incidents');
    const row = JSON.parse(await fs.readFile(path.join(folder, 'incident-0.json'), 'utf8'));
    const retained: string[] = [];
    for (let slot = 0; slot < LOCAL_INCIDENT_SLOTS; slot++) {
      const body = JSON.stringify({ ...row, profileId: '***', reason: `retained_older_${slot}` });
      retained.push(body);
      await fs.writeFile(path.join(folder, `incident-${slot}.json`), body);
    }
    await flushLogFile();
    resetLoggerForTests();
    setLogProfileContext(profile);
    initLogFile(file);
    expect(await noteLocalIncident({ source: 'app', reason: 'new_current_profile_evidence' })).toBe(false);
    expect(await listLocalIncidents()).toMatchObject({ status: 'storage_unavailable',
      storageError: 'incident_slot_unverified', unverifiedSlots: LOCAL_INCIDENT_SLOTS,
      dropped: 1, incidents: [] });
    for (let slot = 0; slot < LOCAL_INCIDENT_SLOTS; slot++)
      expect(await fs.readFile(path.join(folder, `incident-${slot}.json`), 'utf8')).toBe(retained[slot]);
  });

  it('durably reports bounded privacy-safe incident capture loss when every slot has protected ownership', async () => {
    const profile = 'profile-f481290d-e54c-42a6-be5d-c8a19b35f0aa';
    setLogProfileContext(profile);
    const file = await logFile();
    expect(await noteLocalIncident({ source: 'app', reason: 'original_protected_incident' })).toBe(true);
    const folder = path.join(path.dirname(file), 'local-incidents');
    const original = JSON.parse(await fs.readFile(path.join(folder, 'incident-0.json'), 'utf8'));
    const retained: string[] = [];
    for (let slot = 0; slot < LOCAL_INCIDENT_SLOTS; slot++) {
      const body = JSON.stringify({ ...original, profileId: '***', reason: `protected_${slot}` });
      retained.push(body);
      await fs.writeFile(path.join(folder, `incident-${slot}.json`), body);
    }
    await flushLocalIncidents();
    resetLoggerForTests();
    setLogProfileContext(profile);
    initLogFile(file);
    const secret = 'sk-user-input-must-never-appear-in-dropped-diagnostic123456789';
    for (let i = 1; i <= 9; i++)
      expect(await noteLocalIncident({ source: 'app', reason: 'native_result_custody_unverified',
        detail: `private tool output: ${secret}`,
        requestId: 'wfr_private_full_ring_attempt' })).toBe(false);
    expect((await listLocalIncidents())).toMatchObject({
      status: 'storage_unavailable', storageError: 'incident_slot_unverified',
      dropped: 9, unverifiedSlots: LOCAL_INCIDENT_SLOTS, freeSlots: 0, incidents: []
    });
    const loss = getLog().filter(row => row.message.includes('local incident capture unavailable'));
    expect(loss.map(row => row.message)).toEqual([
      'local incident capture unavailable cause=ring_full dropped=1',
      'local incident capture unavailable cause=ring_full dropped=2',
      'local incident capture unavailable cause=ring_full dropped=4',
      'local incident capture unavailable cause=ring_full dropped=8'
    ]);
    // The ordinary logger already attempts to capture real helper errors.
    // Those failed captures must produce sparse diagnostics WITHOUT their own
    // warning recursively becoming another failed incident.
    for (let i = 10; i <= 16; i++)
      logEvent('helper.error', `helper failed with full fixture ${i}`, 'error');
    await flushLocalIncidents();
    expect((await listLocalIncidents()).dropped).toBe(16);
    const afterAutomatic = getLog().filter(row =>
      row.message.includes('local incident capture unavailable')).map(row => row.message);
    expect(afterAutomatic).toEqual([...loss.map(row => row.message),
      'local incident capture unavailable cause=ring_full dropped=16']);
    await flushLogFile();
    const persistent = await fs.readFile(file, 'utf8');
    expect(persistent).toContain('local incident capture unavailable cause=ring_full dropped=16');
    for (const secretPart of [secret, 'wfr_private_full_ring_attempt', 'native_result_custody_unverified'])
      expect(persistent).not.toContain(secretPart);
    for (let slot = 0; slot < LOCAL_INCIDENT_SLOTS; slot++)
      expect(await fs.readFile(path.join(folder, `incident-${slot}.json`), 'utf8')).toBe(retained[slot]);
    // Existing log mirror is durable, but the in-memory drop count belongs
    // only to this process lifetime. Restart must not erase protected slots.
    resetLoggerForTests();
    setLogProfileContext(profile);
    initLogFile(file);
    expect(await noteLocalIncident({ source: 'app', reason: 'after_cold_restart',
      detail: secret })).toBe(false);
    expect((await listLocalIncidents()).unverifiedSlots).toBe(LOCAL_INCIDENT_SLOTS);
    for (let slot = 0; slot < LOCAL_INCIDENT_SLOTS; slot++)
      expect(await fs.readFile(path.join(folder, `incident-${slot}.json`), 'utf8')).toBe(retained[slot]);
  });

  it('recovers bounded capacity beyond sixteen protected original incident slots without adopting or rewriting any masked account history', async () => {
    const profile = 'profile-f481290d-e54c-42a6-be5d-c8a19b35f0aa';
    setLogProfileContext(profile);
    const file = await logFile();
    expect(await noteLocalIncident({ source: 'app', reason: 'protected_original' })).toBe(true);
    const folder = path.join(path.dirname(file), 'local-incidents');
    const original = JSON.parse(await fs.readFile(path.join(folder, 'incident-0.json'), 'utf8'));
    const protectedBytes: string[] = [];
    // Current real incident state contains 16 occupied physical files, nine
    // with masked provenance. No masked record may be assigned to this profile.
    for (let slot = 0; slot < 16; slot++) {
      const saved = JSON.stringify({ ...original, profileId: '***', reason: `retained_masked_${slot}` });
      protectedBytes.push(saved);
      await fs.writeFile(path.join(folder, `incident-${slot}.json`), saved);
    }
    await flushLocalIncidents();
    resetLoggerForTests();
    setLogProfileContext(profile);
    initLogFile(file);
    expect(await listLocalIncidents()).toMatchObject({
      status: 'storage_unavailable', storageError: 'incident_slot_unverified',
      unverifiedSlots: 16, freeSlots: 16, dropped: 0, incidents: []
    });
    const safe = { source: 'app' as const, reason: 'new_native_final_missing', sessionId: '2026-10-17-cos24',
      detail: 'private result must never leave local incident diagnostics' };
    expect(await noteLocalIncident(safe)).toBe(true);
    let fresh = await listLocalIncidents();
    expect(fresh).toMatchObject({ status: 'storage_unavailable', unverifiedSlots: 16, freeSlots: 15,
      dropped: 0, incidents: [expect.objectContaining({
        reason: safe.reason, profileId: profile, sessionId: safe.sessionId
      })] });
    const newlyOwned = path.join(folder, 'incident-16.json');
    const first = await fs.readFile(newlyOwned, 'utf8');
    expect(JSON.parse(first).profileId).toBe(profile);
    expect(first).not.toContain('private result');
    for (let slot = 0; slot < 16; slot++)
      expect(await fs.readFile(path.join(folder, `incident-${slot}.json`), 'utf8')).toBe(protectedBytes[slot]);
    // Cold restart must preserve the new exact owner and coalesce its same
    // incident instead of creating another record or erasing the masked files.
    await flushLocalIncidents();
    resetLoggerForTests();
    setLogProfileContext(profile);
    initLogFile(file);
    expect(await noteLocalIncident(safe)).toBe(true);
    fresh = await listLocalIncidents();
    expect(fresh.incidents).toEqual([expect.objectContaining({ reason: safe.reason, occurrences: 2 })]);
    expect(fresh.unverifiedSlots).toBe(16);
    expect(fresh.freeSlots).toBe(15);
    for (let slot = 0; slot < 16; slot++)
      expect(await fs.readFile(path.join(folder, `incident-${slot}.json`), 'utf8')).toBe(protectedBytes[slot]);
  });

  it.each(['sk-private-profile-context123456789', 'x'.repeat(64), '***'])(
    'refuses an unverified profile context without persisting or exposing it', async context => {
      setLogProfileContext('profile-f481290d-e54c-42a6-be5d-c8a19b35f0aa');
      const file = await logFile();
      await noteLocalIncident({ source: 'app', reason: 'retained_current_profile' });
      const slot = path.join(path.dirname(file), 'local-incidents', 'incident-0.json');
      const retained = await fs.readFile(slot, 'utf8');
      await flushLogFile();
      resetLoggerForTests();
      setLogProfileContext(context);
      initLogFile(file);
      logInfo(`invalid context ${context}`);
      expect(await noteLocalIncident({ source: 'app', reason: 'must_not_assign_unknown_owner' })).toBe(false);
      expect(await listLocalIncidents()).toMatchObject({ status: 'storage_unavailable',
        storageError: 'incident_profile_unverified', freeSlots: 0, incidents: [] });
      expect(offerBrowserDebugCapture(debugInput)).toBeNull();
      expect(await fs.readFile(slot, 'utf8')).toBe(retained);
      if (context !== '***') expect(formatLogAsJson()).not.toContain(context);
    }
  );

  it('automatically retains a real browser error with preceding redacted log shapes for Core diagnosis', async () => {
    const file = await logFile();
    const privateToken = 'sk-secretincident123456789';
    logInfo(`auth ${privateToken}`);
    expect(offerBrowserDebugCapture({ ...debugInput, screenEnabled: false })).toBeNull();
    await flushLocalIncidents();
    const read = await listLocalIncidents();
    expect(read.folder).toBe(path.join(path.dirname(file), 'local-incidents'));
    expect(read.status).toBe('ready');
    expect(read.incidents).toHaveLength(1);
    expect(read.incidents[0]).toMatchObject({ source: 'browser-debug', reason: 'stream_gone',
      sessionId: debugInput.sessionId, conversationId: debugInput.conversationId,
      capture: 'screen_permission_disabled', status: 'unresolved' });
    expect(read.incidents[0]!.recentLog).toEqual(expect.arrayContaining([
      expect.objectContaining({ level: 'info' })
    ]));
    const raw = await fs.readFile(path.join(read.folder!, 'incident-0.json'), 'utf8');
    expect(raw).not.toContain(privateToken);
    expect(raw).not.toContain('auth sk-');
    expect(Buffer.byteLength(raw)).toBeLessThanOrEqual(32 * 1024);
  });

  it('archives verified unresolved evidence before admitting a thirty-third incident and restores lookup after restart', async () => {
    const profile = 'profile-f481290d-e54c-42a6-be5d-c8a19b35f0aa';
    setLogProfileContext(profile);
    const file = await logFile();
    for (let i = 0; i < LOCAL_INCIDENT_SLOTS; i++) {
      expect(await noteLocalIncident({ source: 'app', reason: `archive_case_${i}` })).toBe(true);
    }
    const folder = path.join(path.dirname(file), 'local-incidents');
    const original = await fs.readFile(path.join(folder, 'incident-0.json'), 'utf8');
    const originalId = JSON.parse(original).id as string;
    expect(await noteLocalIncident({ source: 'app', reason: 'after_full_ring' })).toBe(true);
    const current = await listLocalIncidents();
    expect(current).toMatchObject({ dropped: 0, archive: { count: 1 } });
    expect(current.incidents).toHaveLength(LOCAL_INCIDENT_SLOTS);
    expect(current.incidents.map(row => row.reason)).toContain('after_full_ring');
    const names = await fs.readdir(path.join(folder, 'archive'));
    expect(names).toHaveLength(1);
    expect(await fs.readFile(path.join(folder, 'archive', names[0]!), 'utf8')).toBe(original);
    await flushLogFile();
    resetLoggerForTests();
    setLogProfileContext(profile);
    initLogFile(file);
    const restored = await listLocalIncidents(originalId);
    expect(restored).toMatchObject({ archive: { count: 1 }, incidents: [
      expect.objectContaining({ id: originalId, reason: 'archive_case_0', status: 'unresolved' })
    ] });
  });

  it('leaves every hot incident intact when archival durability fails, then accepts a later diagnostic retry', async () => {
    const file = await logFile();
    for (let i = 0; i < LOCAL_INCIDENT_SLOTS; i++) {
      expect(await noteLocalIncident({ source: 'app', reason: `preserve_before_archive_${i}` })).toBe(true);
    }
    const folder = path.join(path.dirname(file), 'local-incidents');
    const before = await Promise.all(Array.from({ length: LOCAL_INCIDENT_SLOTS }, (_, i) =>
      fs.readFile(path.join(folder, `incident-${i}.json`), 'utf8')));
    const originalOpen = fs.open.bind(fs);
    const failure = vi.spyOn(fs, 'open').mockImplementation((...args: Parameters<typeof fs.open>) => {
      if (String(args[0]).includes(`${path.sep}archive${path.sep}`)) {
        return Promise.reject(Object.assign(new Error('disk full'), { code: 'ENOSPC' }));
      }
      return originalOpen(...args);
    });
    expect(await noteLocalIncident({ source: 'app', reason: 'archive_storage_unavailable' })).toBe(false);
    expect(await Promise.all(Array.from({ length: LOCAL_INCIDENT_SLOTS }, (_, i) =>
      fs.readFile(path.join(folder, `incident-${i}.json`), 'utf8')))).toEqual(before);
    failure.mockRestore();
    expect(await noteLocalIncident({ source: 'app', reason: 'after_archive_storage_recovers' })).toBe(true);
    expect((await listLocalIncidents()).incidents.map(row => row.reason)).toContain('after_archive_storage_recovers');
  });

  it('refuses a conflicting archive that appears during publication without overwriting it or the hot evidence', async () => {
    const file = await logFile();
    for (let i = 0; i < LOCAL_INCIDENT_SLOTS; i++) {
      await noteLocalIncident({ source: 'app', reason: `archive_collision_${i}` });
    }
    const folder = path.join(path.dirname(file), 'local-incidents');
    const before = await fs.readFile(path.join(folder, 'incident-0.json'), 'utf8');
    const link = fs.link.bind(fs);
    let collision = '';
    vi.spyOn(fs, 'link').mockImplementation(async (...args: Parameters<typeof fs.link>) => {
      collision = String(args[1]);
      await fs.writeFile(collision, 'unverified original archive bytes', { flag: 'wx' });
      return link(...args);
    });
    expect(await noteLocalIncident({ source: 'app', reason: 'must_not_replace_collision' })).toBe(false);
    expect(await fs.readFile(collision, 'utf8')).toBe('unverified original archive bytes');
    expect(await fs.readFile(path.join(folder, 'incident-0.json'), 'utf8')).toBe(before);
    expect((await listLocalIncidents()).incidents.map(row => row.reason)).not.toContain('must_not_replace_collision');
  });

  it.each(['slot-change', 'account-change'])(
    'rechecks %s after archival IO before replacing any original hot incident', async change => {
      const profile = 'profile-f481290d-e54c-42a6-be5d-c8a19b35f0aa';
      setLogProfileContext(profile);
      const file = await logFile();
      for (let i = 0; i < LOCAL_INCIDENT_SLOTS; i++) {
        await noteLocalIncident({ source: 'app', reason: `archive_race_${i}` });
      }
      const folder = path.join(path.dirname(file), 'local-incidents');
      const hot = path.join(folder, 'incident-0.json');
      const before = await fs.readFile(hot, 'utf8');
      let entered!: () => void, release!: () => void;
      const paused = new Promise<void>(resolve => { entered = resolve; });
      const resumed = new Promise<void>(resolve => { release = resolve; });
      const link = fs.link.bind(fs);
      vi.spyOn(fs, 'link').mockImplementation(async (...args: Parameters<typeof fs.link>) => {
        await link(...args);
        entered();
        await resumed;
      });
      const pending = noteLocalIncident({ source: 'app', reason: 'must_not_cross_archive_race' });
      await paused;
      const changed = change === 'slot-change'
        ? JSON.stringify({ ...JSON.parse(before), reason: 'later_original_evidence' }) : before;
      if (change === 'slot-change') await fs.writeFile(hot, changed);
      else setLogProfileContext('profile-8bc4db29-9172-4c9a-876d-6d52d81866a7');
      release();
      expect(await pending).toBe(false);
      expect(await fs.readFile(hot, 'utf8')).toBe(changed);
      const names = await fs.readdir(path.join(folder, 'archive'));
      expect(names).toHaveLength(1);
      expect(await fs.readFile(path.join(folder, 'archive', names[0]!), 'utf8')).toBe(before);
      if (change === 'account-change') {
        expect(await listLocalIncidents()).toMatchObject({ folder: null, incidents: [] });
      }
    }
  );

  it('keeps corrupt or foreign archived records out of diagnostic readback', async () => {
    const profile = 'profile-f481290d-e54c-42a6-be5d-c8a19b35f0aa';
    setLogProfileContext(profile);
    const file = await logFile();
    for (let i = 0; i <= LOCAL_INCIDENT_SLOTS; i++) {
      await noteLocalIncident({ source: 'app', reason: `archive_readback_${i}` });
    }
    const folder = path.join(path.dirname(file), 'local-incidents', 'archive');
    const names = await fs.readdir(folder), archived = path.join(folder, names[0]!);
    const original = JSON.parse(await fs.readFile(archived, 'utf8'));
    await fs.writeFile(archived, JSON.stringify({ ...original,
      profileId: 'profile-8bc4db29-9172-4c9a-876d-6d52d81866a7', reason: 'foreign_private_evidence' }));
    const read = await listLocalIncidents(original.id);
    expect(read).toMatchObject({ status: 'storage_unavailable', incidents: [] });
    expect(JSON.stringify(read)).not.toContain('foreign_private_evidence');
    expect((await fs.readFile(archived, 'utf8'))).toContain('foreign_private_evidence');
  });

  it('rechecks the archived bytes after preparing the replacement and preserves the original if they changed', async () => {
    const file = await logFile();
    for (let i = 0; i < LOCAL_INCIDENT_SLOTS; i++) {
      await noteLocalIncident({ source: 'app', reason: `final_archive_check_${i}` });
    }
    const folder = path.join(path.dirname(file), 'local-incidents');
    const before = await fs.readFile(path.join(folder, 'incident-0.json'), 'utf8');
    const write = fs.writeFile.bind(fs);
    vi.spyOn(fs, 'writeFile').mockImplementation(async (...args: Parameters<typeof fs.writeFile>) => {
      await write(...args);
      if (String(args[0]).includes('incident-0.json.') && String(args[0]).endsWith('.tmp')) {
        const names = await fs.readdir(path.join(folder, 'archive'));
        await write(path.join(folder, 'archive', names[0]!), 'changed after initial archive verification');
      }
    });
    expect(await noteLocalIncident({ source: 'app', reason: 'must_keep_original_after_archive_change' })).toBe(false);
    expect(await fs.readFile(path.join(folder, 'incident-0.json'), 'utf8')).toBe(before);
  });

  it('bounds archive indexing and preserves all original hot records when the archive file budget is exhausted', async () => {
    const file = await logFile();
    for (let i = 0; i < LOCAL_INCIDENT_SLOTS; i++) {
      await noteLocalIncident({ source: 'app', reason: `archive_budget_${i}` });
    }
    const folder = path.join(path.dirname(file), 'local-incidents');
    const before = await fs.readFile(path.join(folder, 'incident-0.json'), 'utf8');
    const info = await fs.lstat(path.join(folder, 'incident-0.json'));
    const stat = fs.lstat.bind(fs), openDirectory = fs.opendir.bind(fs);
    const fakeDirectory = { async *[Symbol.asyncIterator]() {
      for (let i = 0; i < 4097; i++) yield {
        name: `incident-${i.toString(16).padStart(8, '0')}-bbbb-4ccc-8ddd-eeeeeeeeeeee-${'a'.repeat(64)}.json`
      };
    } };
    vi.spyOn(fs, 'opendir').mockImplementation((...args: Parameters<typeof fs.opendir>) =>
      String(args[0]).endsWith(`${path.sep}archive`)
        ? Promise.resolve(fakeDirectory as unknown as Awaited<ReturnType<typeof fs.opendir>>)
        : openDirectory(...args));
    vi.spyOn(fs, 'lstat').mockImplementation((...args: Parameters<typeof fs.lstat>) =>
      String(args[0]).includes(`${path.sep}archive${path.sep}incident-`)
        ? Promise.resolve(info) : stat(...args));
    expect(await noteLocalIncident({ source: 'app', reason: 'must_preserve_at_archive_limit' })).toBe(false);
    expect(await fs.readFile(path.join(folder, 'incident-0.json'), 'utf8')).toBe(before);
    expect((await listLocalIncidents()).storageError).toBe('ENOSPC');
  });

  it('retries POSIX archive directory durability even when readback discovers an already published identical archive', async () => {
    const file = await logFile();
    for (let i = 0; i < LOCAL_INCIDENT_SLOTS; i++) {
      await noteLocalIncident({ source: 'app', reason: `archive_directory_retry_${i}` });
    }
    const folder = path.join(path.dirname(file), 'local-incidents');
    const before = await fs.readFile(path.join(folder, 'incident-0.json'), 'utf8');
    const descriptor = Object.getOwnPropertyDescriptor(process, 'platform')!;
    const open = fs.open.bind(fs);
    let failDirectorySync = true, archiveSyncAttempts = 0;
    Object.defineProperty(process, 'platform', { ...descriptor, value: 'linux' });
    try {
      vi.spyOn(fs, 'open').mockImplementation((...args: Parameters<typeof fs.open>) => {
        const target = String(args[0]);
        if (args[1] === 'r' && (target === folder || target === path.join(folder, 'archive'))) {
          return Promise.resolve({
            sync: async () => {
              if (target !== folder) {
                archiveSyncAttempts++;
                if (failDirectorySync) throw Object.assign(new Error('directory sync failed'), { code: 'EIO' });
              }
            }, close: async () => undefined
          } as unknown as Awaited<ReturnType<typeof fs.open>>);
        }
        return open(...args);
      });
      expect(await noteLocalIncident({ source: 'app', reason: 'first_archive_directory_failure' })).toBe(false);
      expect(archiveSyncAttempts).toBe(1);
      expect(await fs.readFile(path.join(folder, 'incident-0.json'), 'utf8')).toBe(before);
      expect((await listLocalIncidents()).archive?.count).toBe(1);
      expect(await noteLocalIncident({ source: 'app', reason: 'retry_still_requires_archive_sync' })).toBe(false);
      expect(archiveSyncAttempts).toBe(2);
      expect(await fs.readFile(path.join(folder, 'incident-0.json'), 'utf8')).toBe(before);
      failDirectorySync = false;
      expect(await noteLocalIncident({ source: 'app', reason: 'after_archive_directory_sync_recovers' })).toBe(true);
      expect(archiveSyncAttempts).toBe(3);
    } finally { Object.defineProperty(process, 'platform', descriptor); }
  });

  it.each([
    ['browser-debug', 'native_terminal_open_call'],
    ['app', 'goal_repair_receipt_native_hold']
  ] as const)('keeps unresolved %s native-completion restart fences active while archiving ordinary evidence', async (source, reason) => {
    const file = await logFile();
    await noteLocalIncident({ source, reason,
      sessionId: 'retained-current-session', conversationId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
      requestId: 'original-request-retained-across-restart', turnId: 'g-original-native-turn',
      inputId: '11111111-2222-4333-8444-555555555555',
      nativeCompletion: { openCalls: 1, openCodeCalls: 0, traceRequestIds: 1, exactRequestJoins: 0 } });
    const folder = path.join(path.dirname(file), 'local-incidents');
    const fence = await fs.readFile(path.join(folder, 'incident-0.json'), 'utf8');
    for (let i = 1; i < LOCAL_INCIDENT_SLOTS; i++) {
      await noteLocalIncident({ source: 'app', reason: `non_fence_${i}` });
    }
    expect(await noteLocalIncident({ source: 'app', reason: 'new_evidence_with_restart_fence' })).toBe(true);
    expect(await fs.readFile(path.join(folder, 'incident-0.json'), 'utf8')).toBe(fence);
    await flushLogFile();
    resetLoggerForTests();
    initLogFile(file);
    const restored = await listLocalIncidents();
    expect(restored.incidents).toEqual(expect.arrayContaining([
      expect.objectContaining({ reason, status: 'unresolved',
        sessionId: 'retained-current-session', conversationId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
        requestId: 'original-request-retained-across-restart', turnId: 'g-original-native-turn',
        inputId: '11111111-2222-4333-8444-555555555555',
        nativeCompletion: { openCalls: 1, openCodeCalls: 0, traceRequestIds: 1, exactRequestJoins: 0 } })
    ]));
    expect(restored.archive?.count).toBe(1);
    if (source === 'browser-debug') {
      const evidence = await import('../src/main/core-browser-evidence.js');
      evidence.resetCoreBrowserEvidenceForTests();
      try {
        const row = restored.incidents.find(incident => incident.reason === reason)!;
        expect(evidence.retainUnverifiedNativeCompletionFromIncident({
          conversationId: row.conversationId!, observedAt: Math.min(row.updatedAt, Date.now()),
          reason: 'native_terminal_open_call', openCalls: row.nativeCompletion!.openCalls,
          openCodeCalls: row.nativeCompletion!.openCodeCalls
        })).toBe(true);
        expect(evidence.nativeCompletionDiagnostic(row.conversationId!)).toMatchObject({
          reason: 'original-source-missing', retainedCalls: 1,
          missingOriginalNativeIds: 1, missingOriginalRequestIds: 1
        });
        // Existing recovery keeps an unknown-result fence, never reconstructed Send,
        // final or request identity. Exact original IDs remain in the saved evidence.
        expect(evidence.coreBrowserEvidence(row.conversationId!)?.pendingCompletion).toMatchObject({
          sourceUserMessageId: null, openRequestIds: null, allCoreRequestIds: null
        });
      } finally { evidence.resetCoreBrowserEvidenceForTests(); }
    }
  });

  it('preserves every active restart fence and reports capacity loss if no incident can safely leave the hot index', async () => {
    const file = await logFile();
    for (let i = 0; i < LOCAL_INCIDENT_SLOTS; i++) {
      await noteLocalIncident({ source: 'browser-debug', reason: 'native_terminal_open_call',
        sessionId: `protected-native-session-${i}`,
        nativeCompletion: { openCalls: 1, openCodeCalls: 0, traceRequestIds: 0, exactRequestJoins: 0 } });
    }
    const folder = path.join(path.dirname(file), 'local-incidents');
    const before = await Promise.all(Array.from({ length: LOCAL_INCIDENT_SLOTS }, (_, i) =>
      fs.readFile(path.join(folder, `incident-${i}.json`), 'utf8')));
    expect(await noteLocalIncident({ source: 'app', reason: 'must_not_remove_any_restart_fence' })).toBe(false);
    expect(await Promise.all(Array.from({ length: LOCAL_INCIDENT_SLOTS }, (_, i) =>
      fs.readFile(path.join(folder, `incident-${i}.json`), 'utf8')))).toEqual(before);
    expect((await listLocalIncidents()).dropped).toBe(1);
  });

  it('coalesces hot incidents, refuses private bodies and bounds active storage while archiving older evidence', async () => {
    await logFile();
    for (let i = 0; i < LOCAL_INCIDENT_SLOTS + 2; i++) {
      await noteLocalIncident({ source: 'app', reason: `native_error_${i}`, detail: 'Private user composer body: do not retain',
        sessionId: `2026-10-15-${i}`, status: 'unresolved' });
    }
    await noteLocalIncident({ source: 'app', reason: 'native_error_31', detail: 'another private body', status: 'unresolved',
      sessionId: '2026-10-15-31' });
    const read = await listLocalIncidents();
    expect(read.incidents).toHaveLength(LOCAL_INCIDENT_SLOTS);
    expect(read.incidents.find(row => row.reason === 'native_error_31')).toMatchObject({ occurrences: 2 });
    expect(read.incidents.map(row => row.reason)).toContain(`native_error_${LOCAL_INCIDENT_SLOTS}`);
    expect(JSON.stringify(read)).not.toContain('Private user composer');
    expect(read.dropped).toBe(0);
    expect(read.archive?.count).toBe(2);
  });

  it('does not let a duplicate crash fingerprint suppress the verified recovery outcome', async () => {
    const file = await logFile();
    const fingerprint = 'a'.repeat(64);
    await noteLocalIncident({ source: 'app', reason: 'previous_crash', fingerprint });
    await noteLocalIncident({ source: 'app', reason: 'previous_crash', fingerprint, status: 'resolved' });
    const first = await listLocalIncidents();
    expect(first.incidents).toHaveLength(1);
    expect(first.incidents[0]?.status).toBe('resolved');
    initLogFile(file);
    const restored = await listLocalIncidents();
    expect(restored.incidents).toHaveLength(1);
    expect(restored.incidents[0]?.status).toBe('resolved');
  });

  it('expires only settled owned entries and preserves unresolved custody over the retention window', async () => {
    await logFile();
    const startedAt = Date.now();
    await noteLocalIncident({ source: 'app', reason: 'settled_before', status: 'resolved' });
    await noteLocalIncident({ source: 'app', reason: 'still_unresolved', status: 'unresolved' });
    vi.spyOn(Date, 'now').mockReturnValue(startedAt + 8 * 24 * 60 * 60_000);
    const list = await listLocalIncidents();
    expect(list.incidents.map(item => item.reason)).toEqual(['still_unresolved']);
    expect(list.incidents[0]?.status).toBe('unresolved');
  });

  it('reports disk-full safely without claiming saved evidence or weakening the original error', async () => {
    const file = await logFile();
    vi.spyOn(fs, 'writeFile').mockRejectedValueOnce(Object.assign(new Error('sensitive filesystem path'), { code: 'ENOSPC' }));
    await noteLocalIncident({ source: 'app', reason: 'native_io_error', status: 'unresolved' });
    const read = await listLocalIncidents();
    expect(read.incidents).toHaveLength(0);
    expect(read.status).toBe('storage_unavailable');
    expect(read.storageError).toBe('ENOSPC');
    expect(read.freeSlots).toBe(0);
    expect(JSON.stringify(read)).not.toContain('sensitive filesystem path');
    expect(await fs.readdir(path.dirname(file))).toContain('local-incidents');
  });

  it('records the next incident after a prior crash left a temporary incident slot', async () => {
    const file = await logFile();
    const folder = path.join(path.dirname(file), 'local-incidents');
    await fs.mkdir(folder, { recursive: true });
    await fs.writeFile(path.join(folder, 'incident-0.json.tmp'), 'incomplete prior incident');

    expect(await noteLocalIncident({ source: 'app', reason: 'after_crash', status: 'unresolved' })).toBe(true);
    const read = await listLocalIncidents();
    expect(read.status).toBe('ready');
    expect(read.incidents).toEqual([expect.objectContaining({ reason: 'after_crash', status: 'unresolved' })]);
  });

  it('removes an owned partial write after disk-full and preserves the next real incident', async () => {
    const file = await logFile();
    const folder = path.join(path.dirname(file), 'local-incidents');
    const realWrite = fs.writeFile.bind(fs);
    let injected = false;
    const writeSpy = vi.spyOn(fs, 'writeFile').mockImplementation(async (...args) => {
      if (!injected && String(args[0]).includes('incident-0.json')) {
        injected = true;
        await realWrite(args[0], 'partial', args[2]);
        throw Object.assign(new Error('PRIVATE disk path'), { code: 'ENOSPC' });
      }
      return realWrite(...args);
    });
    expect(await noteLocalIncident({ source: 'app', reason: 'disk_full', status: 'unresolved' })).toBe(false);
    expect((await listLocalIncidents()).storageError).toBe('ENOSPC');
    writeSpy.mockRestore();

    expect((await fs.readdir(folder)).filter(name => name.endsWith('.tmp'))).toEqual([]);
    expect(await noteLocalIncident({ source: 'app', reason: 'after_disk_full', status: 'unresolved' })).toBe(true);
    const read = await listLocalIncidents();
    expect(read.status).toBe('ready');
    expect(read.incidents.map(row => row.reason)).toEqual(['after_disk_full']);
    expect(JSON.stringify(read)).not.toContain('PRIVATE disk path');
  });

  it('reclaims only aged app-owned temporary incident files on restart', async () => {
    const file = await logFile();
    const folder = path.join(path.dirname(file), 'local-incidents');
    await fs.mkdir(folder, { recursive: true });
    const legacy = path.join(folder, 'incident-0.json.tmp');
    const interrupted = path.join(folder, 'incident-1.json.aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee.tmp');
    const recent = path.join(folder, 'incident-2.json.bbbbbbbb-cccc-4ddd-8eee-ffffffffffff.tmp');
    const unrelated = path.join(folder, 'keep-this-file.tmp');
    for (const name of [legacy, interrupted, recent, unrelated]) await fs.writeFile(name, 'partial');
    const oldTime = new Date(Date.now() - 31 * 60_000);
    await fs.utimes(legacy, oldTime, oldTime);
    await fs.utimes(interrupted, oldTime, oldTime);
    await fs.utimes(unrelated, oldTime, oldTime);

    expect(await noteLocalIncident({ source: 'app', reason: 'after_restart' })).toBe(true);
    const names = await fs.readdir(folder);
    expect(names).not.toContain(path.basename(legacy));
    expect(names).not.toContain(path.basename(interrupted));
    expect(names).toContain(path.basename(recent));
    expect(names).toContain(path.basename(unrelated));
    expect((await listLocalIncidents()).incidents.map(row => row.reason)).toEqual(['after_restart']);
  });

  it('keeps recording an incident when optional orphan cleanup cannot list the folder', async () => {
    await logFile();
    const realReaddir = fs.readdir.bind(fs);
    let denied = false;
    const listing = vi.spyOn(fs, 'readdir').mockImplementation(async (...args) => {
      if (!denied && String(args[0]).endsWith('local-incidents')) {
        denied = true;
        throw Object.assign(new Error('PRIVATE folder name'), { code: 'EACCES' });
      }
      return realReaddir(...args);
    });
    try {
      expect(await noteLocalIncident({ source: 'app', reason: 'cleanup_denied' })).toBe(true);
      const current = await listLocalIncidents();
      expect(current.status).toBe('ready');
      expect(current.incidents.map(row => row.reason)).toEqual(['cleanup_denied']);
      expect(JSON.stringify(current)).not.toContain('PRIVATE folder name');
    } finally { listing.mockRestore(); }
  });

  it('keeps the exit barrier open until an already accepted incident write has settled', async () => {
    await logFile();
    let release!: () => void, started!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const writing = new Promise<void>(resolve => { started = resolve; });
    const realWrite = fs.writeFile.bind(fs);
    vi.spyOn(fs, 'writeFile').mockImplementationOnce(async (...args) => {
      started();
      await gate;
      return realWrite(...args);
    });
    const accepted = noteLocalIncident({ source: 'app', reason: 'exit_custody', status: 'unresolved' });
    await writing;
    const barrier = flushLogBeforeExit(1000);
    try {
      const early = await Promise.race([
        barrier.then(() => 'exited'),
        new Promise<string>(resolve => { setTimeout(() => resolve('waiting'), 20); })
      ]);
      expect(early).toBe('waiting');
    } finally { release(); await accepted; await barrier; }
    expect((await listLocalIncidents()).incidents[0]?.reason).toBe('exit_custody');
  });

  it('refuses an excess pending incident immediately instead of growing an unbounded promise queue', async () => {
    await logFile();
    let release!: () => void, started!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const writing = new Promise<void>(resolve => { started = resolve; });
    const realWrite = fs.writeFile.bind(fs);
    vi.spyOn(fs, 'writeFile').mockImplementationOnce(async (...args) => {
      started();
      await gate;
      return realWrite(...args);
    });
    const pending = Array.from({ length: LOCAL_INCIDENT_SLOTS * 8 }, (_, n) =>
      noteLocalIncident({ source: 'app', reason: `queued_failure_${n}`, status: 'unresolved' }));
    await writing;
    try {
      const last = await Promise.race([
        pending.at(-1)!.then(value => value ? 'accepted' : 'refused'),
        new Promise<string>(resolve => { setTimeout(() => resolve('waiting'), 20); })
      ]);
      expect(last).toBe('refused');
    } finally { release(); await Promise.all(pending); }
    const read = await listLocalIncidents();
    expect(read.incidents.length).toBeLessThanOrEqual(LOCAL_INCIDENT_SLOTS);
    expect(read.dropped).toBeGreaterThan(0);
  });

  it('records failure metadata without screen permission and never retains arbitrary reason text', async () => {
    await logFile();
    expect(offerBrowserDebugCapture({ ...debugInput, screenEnabled: false, reason: 'private composer text' })).toBeNull();
    expect(getLog().at(-1)?.message).toContain('screen_permission_disabled');
    expect(getLog().at(-1)?.message).not.toContain('private composer text');
  });

  it('keeps actual error codes and source frames but never stores private exception bodies or injected sidecar fields', async () => {
    const file = await logFile();
    logEvent('bridge.tool.failure', 'ERR_CONNECTION_CLOSED: private conversation body sk-secret123456789\n at handle (src/main/bridge.ts:102:14)', 'error');
    await flushLocalIncidents();
    const folder = path.join(path.dirname(file), 'local-incidents');
    const saved = JSON.parse(await fs.readFile(path.join(folder, 'incident-0.json'), 'utf8'));
    expect(saved.errorEvidence).toMatchObject({
      digest: expect.stringMatching(/^[a-f0-9]{64}$/), code: 'ERR_CONNECTION_CLOSED',
      frames: ['src/main/bridge.ts:102:14']
    });
    expect(JSON.stringify(saved)).not.toContain('private conversation body');
    expect(JSON.stringify(saved)).not.toContain('secret123456789');
    saved.injected = { toolBody: 'PRIVATE_MALICIOUS_SIDECAR_CONTENT' };
    saved.errorEvidence.frames.push('C:/Users/private/secret.txt:99:2');
    await fs.writeFile(path.join(folder, 'incident-0.json'), JSON.stringify(saved));
    initLogFile(file);
    const read = await listLocalIncidents();
    expect(JSON.stringify(read)).not.toContain('PRIVATE_MALICIOUS_SIDECAR_CONTENT');
    expect(read.incidents[0]?.errorEvidence?.frames).toEqual(['src/main/bridge.ts:102:14']);
  });

  it('retains only bounded native-completion counters when reading a replaced incident sidecar', async () => {
    const file = await logFile();
    await noteLocalIncident({ source: 'browser-debug', reason: 'native_terminal_open_call',
      sessionId: '2026-10-15-native-gap', conversationId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
      nativeCompletion: { openCalls: 1, openCodeCalls: 0, traceRequestIds: 0, exactRequestJoins: 0 } });
    const initial = (await listLocalIncidents()).incidents[0]!;
    expect(initial.nativeCompletion).toEqual({
      openCalls: 1, openCodeCalls: 0, traceRequestIds: 0, exactRequestJoins: 0
    });
    const sidecar = path.join(path.dirname(file), 'local-incidents', 'incident-0.json');
    const raw = JSON.parse(await fs.readFile(sidecar, 'utf8'));
    raw.nativeCompletion = { ...raw.nativeCompletion,
      privateMessage: 'DO_NOT_STORE_PRIVATE_CONTENT', exactRequestJoins: 12 };
    await fs.writeFile(sidecar, JSON.stringify(raw));
    initLogFile(file);
    expect((await listLocalIncidents()).incidents[0]?.nativeCompletion).toBeUndefined();
    raw.nativeCompletion = { openCalls: 2, openCodeCalls: 0, traceRequestIds: 2,
      exactRequestJoins: 1, privateMessage: 'DO_NOT_STORE_PRIVATE_CONTENT' };
    await fs.writeFile(sidecar, JSON.stringify(raw));
    initLogFile(file);
    const normalized = (await listLocalIncidents()).incidents[0]!;
    expect(normalized.nativeCompletion).toEqual({
      openCalls: 2, openCodeCalls: 0, traceRequestIds: 2, exactRequestJoins: 1
    });
    expect(JSON.stringify(normalized)).not.toContain('DO_NOT_STORE_PRIVATE_CONTENT');
  });

  describe('native completion checkpoint incident grouping', () => {
    const base = { source: 'browser-debug' as const, reason: 'native_terminal_open_call',
      sessionId: '2026-10-27-native-origin', conversationId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee' };
    const counts = { openCalls: 2, openCodeCalls: 0, traceRequestIds: 0, exactRequestJoins: 0 };
    const firstKey = 'a'.repeat(64), secondKey = 'b'.repeat(64);

    it('coalesces only the same immutable origin and resolves only its matching key across restart', async () => {
      const file = await logFile();
      await noteLocalIncident({ ...base, nativeCompletion: { ...counts, checkpointKey: firstKey } });
      await noteLocalIncident({ ...base, nativeCompletion: { ...counts, checkpointKey: secondKey } });
      await noteLocalIncident({ ...base, nativeCompletion: { ...counts, checkpointKey: firstKey } });
      expect((await listLocalIncidents()).incidents).toHaveLength(2);
      initLogFile(file);
      expect(await noteLocalIncident({ ...base, status: 'resolved',
        nativeCompletion: { ...counts, checkpointKey: firstKey } })).toBe(true);
      const rows = (await listLocalIncidents()).incidents;
      expect(rows.find(row => row.nativeCompletion?.checkpointKey === firstKey)).toMatchObject({ status: 'resolved', occurrences: 3 });
      expect(rows.find(row => row.nativeCompletion?.checkpointKey === secondKey)).toMatchObject({ status: 'unresolved', occurrences: 1 });
    });

    it('keeps keyed and legacy holds separate and rejects unknown-key resolution without changing legacy callers', async () => {
      await logFile();
      await noteLocalIncident({ ...base, nativeCompletion: counts });
      await noteLocalIncident({ ...base, nativeCompletion: { ...counts, checkpointKey: firstKey } });
      expect(await noteLocalIncident({ ...base, status: 'resolved',
        nativeCompletion: { ...counts, checkpointKey: secondKey } })).toBe(false);
      expect(await noteLocalIncident({ ...base, status: 'resolved', nativeCompletion: counts })).toBe(true);
      expect((await listLocalIncidents()).incidents).toEqual([
        expect.objectContaining({ status: 'resolved', nativeCompletion: counts }),
        expect.objectContaining({ status: 'unresolved', nativeCompletion: { ...counts, checkpointKey: firstKey } })
      ]);
      expect(await noteLocalIncident({ ...base, status: 'resolved',
        nativeCompletion: { ...counts, checkpointKey: firstKey } })).toBe(true);
      expect((await listLocalIncidents()).incidents.find(row => !row.nativeCompletion?.checkpointKey)?.status).toBe('resolved');
    });

    it('refuses unkeyed resolution when the only retained origin is keyed', async () => {
      await logFile();
      await noteLocalIncident({ ...base, nativeCompletion: { ...counts, checkpointKey: firstKey } });
      expect(await noteLocalIncident({ ...base, status: 'resolved' })).toBe(false);
      expect(await noteLocalIncident({ ...base, status: 'resolved', nativeCompletion: counts })).toBe(false);
      expect((await listLocalIncidents()).incidents).toEqual([
        expect.objectContaining({ status: 'unresolved', nativeCompletion: { ...counts, checkpointKey: firstKey } })
      ]);
    });

    it('never downgrades an invalid keyed count payload into legacy resolution', async () => {
      await logFile();
      await noteLocalIncident({ ...base, nativeCompletion: counts });
      expect(await noteLocalIncident({ ...base, status: 'resolved',
        nativeCompletion: { ...counts, openCalls: 401, checkpointKey: firstKey } })).toBe(false);
      expect((await listLocalIncidents()).incidents).toEqual([
        expect.objectContaining({ status: 'unresolved', nativeCompletion: counts })
      ]);
    });

    it('coalesces and resolves only the three supported native reason variants of the same keyed origin', async () => {
      await logFile();
      const keyed = { ...counts, checkpointKey: firstKey };
      await noteLocalIncident({ ...base, nativeCompletion: keyed });
      await noteLocalIncident({ ...base, reason: 'native_terminal_inventory_incomplete', nativeCompletion: keyed });
      expect((await listLocalIncidents()).incidents).toEqual([
        expect.objectContaining({ status: 'unresolved', occurrences: 2, nativeCompletion: keyed })
      ]);
      // Exact origin grouping does not turn arbitrary reasons or unknown sources
      // into this native hold, even when they reuse the same opaque digest.
      await noteLocalIncident({ ...base, reason: 'native_terminal_other', nativeCompletion: keyed });
      await noteLocalIncident({ ...base, reason: 'native_terminal_inventory_incomplete', nativeCompletion: counts });
      await noteLocalIncident({ ...base, reason: 'native_terminal_inventory_incomplete',
        nativeCompletion: { ...counts, checkpointKey: secondKey } });
      expect((await listLocalIncidents()).incidents).toHaveLength(4);
      expect(await noteLocalIncident({ ...base, reason: 'native_terminal_open_code', status: 'resolved', nativeCompletion: keyed })).toBe(true);
      const rows = (await listLocalIncidents()).incidents;
      expect(rows).toHaveLength(4);
      expect(rows.filter(row => row.status === 'resolved')).toEqual([
        expect.objectContaining({ reason: base.reason, nativeCompletion: keyed, occurrences: 3 })
      ]);
      expect(rows.filter(row => row.status === 'unresolved')).toHaveLength(3);
    });

    it.each(['A'.repeat(64), 'a'.repeat(63), 'g'.repeat(64), 'private-source-message'])('rejects malformed grouping key %s without resolving retained counts', async checkpointKey => {
      await logFile();
      await noteLocalIncident({ ...base, nativeCompletion: counts });
      expect(await noteLocalIncident({ ...base, status: 'resolved',
        nativeCompletion: { ...counts, checkpointKey } })).toBe(false);
      const rows = (await listLocalIncidents()).incidents;
      expect(rows).toHaveLength(1);
      expect(rows[0]?.status).toBe('unresolved');
      expect(rows[0]?.nativeCompletion).toEqual(counts);
    });

    it('strips malformed keys and raw identity fields from replaced disk records but preserves negative counts', async () => {
      const file = await logFile();
      await noteLocalIncident({ ...base, nativeCompletion: { ...counts, checkpointKey: firstKey } });
      const target = path.join(path.dirname(file), 'local-incidents', 'incident-0.json');
      const raw = JSON.parse(await fs.readFile(target, 'utf8'));
      raw.nativeCompletion.checkpointKey = 'private-source-message';
      raw.nativeCompletion.sourceUserMessageId = 'PRIVATE_NATIVE_SOURCE_DO_NOT_EXPORT';
      raw.nativeCompletion.documentId = 'PRIVATE_NATIVE_DOCUMENT_DO_NOT_EXPORT';
      await fs.writeFile(target, JSON.stringify(raw));
      initLogFile(file);
      const restored = (await listLocalIncidents()).incidents[0]!;
      expect(restored.nativeCompletion).toEqual(counts);
      expect(JSON.stringify(restored)).not.toContain('PRIVATE_NATIVE');
      expect(JSON.stringify(restored)).not.toContain('private-source-message');
    });
  });

  it('merges a delayed repeat of the same unresolved failure without consuming another slot', async () => {
    await logFile();
    const start = Date.now();
    await noteLocalIncident({ source: 'worker', reason: 'helper_collect_failed',
      sessionId: 'cos24-worker', status: 'unresolved' });
    vi.spyOn(Date, 'now').mockReturnValue(start + 2 * 60 * 60_000);
    await noteLocalIncident({ source: 'worker', reason: 'helper_collect_failed',
      sessionId: 'cos24-worker', status: 'unresolved' });
    const read = await listLocalIncidents();
    expect(read.incidents).toHaveLength(1);
    expect(read.incidents[0]?.occurrences).toBe(2);
  });

  it('preserves only the exact current Core-call custody and separates unrelated app errors', async () => {
    await logFile();
    runInCallContext({
      startedAt: Date.now(), transportKey: null, agent: null, outcome: null,
      caller: { transportKey: null, requestId: 'wfr_native_abcd',
        conversationId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', sessionId: '2026-10-15-exact' },
      evidence: emptyEvidence()
    }, () => logEvent('tool.failure.bound', 'ERR_CONNRESET: root cause', 'error'));
    logEvent('tool.failure.unbound', 'ERR_CONNRESET: separately observed', 'error');
    logEvent('tool.failure.unbound', 'ERR_CONNRESET: separately observed', 'error');
    logEvent('', 'unrelated first error with arbitrary private message', 'error');
    logEvent('', 'unrelated second error with arbitrary private message', 'error');
    const read = await listLocalIncidents();
    expect(read.incidents).toHaveLength(4);
    const bound = read.incidents.find(item => item.reason === 'tool.failure.bound')!;
    expect(bound).toMatchObject({ sessionId: '2026-10-15-exact', requestId: 'wfr_native_abcd',
      conversationId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee' });
    const unbound = read.incidents.find(item => item.reason === 'tool.failure.unbound')!;
    expect(unbound).toMatchObject({ requestId: null, sessionId: null, occurrences: 2 });
    expect(read.incidents.filter(item => item.reason.startsWith('app_error'))).toHaveLength(2);
    expect(JSON.stringify(read)).not.toContain('arbitrary private message');
  });

  it('does not traverse a substituted incident-directory junction during Core reads', async () => {
    const file = await logFile();
    const target = await fs.mkdtemp(path.join(os.tmpdir(), 'clf-incident-outside-'));
    cleanup.push(target);
    await fs.writeFile(path.join(target, 'incident-0.json'), JSON.stringify({
      version: 1, id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', profileId: null,
      source: 'app', reason: 'forged', createdAt: Date.now(),
      updatedAt: Date.now(), status: 'unresolved'
    }));
    await fs.symlink(target, path.join(path.dirname(file), 'local-incidents'),
      process.platform === 'win32' ? 'junction' : 'dir');
    const read = await listLocalIncidents();
    expect(read.status).toBe('storage_unavailable');
    expect(read.freeSlots).toBe(0);
    expect(read.incidents).toEqual([]);
    expect(JSON.stringify(read)).not.toContain('forged');
  });

  it('automatically indexes actionable sign-in and exact connector-schema warnings without copying private bodies', async () => {
    await logFile();
    logWarn('Sign in to this account required; private redirect Authorization: Bearer secretcredential123');
    logWarn('Core plugin schema mismatch; private body sk-token-for-my-app');
    const read = await listLocalIncidents();
    expect(read.incidents).toHaveLength(2);
    expect(read.incidents.some(item => item.source === 'pairing')).toBe(true);
    expect(JSON.stringify(read)).not.toContain('secretcredential123');
    expect(JSON.stringify(read)).not.toContain('token-for-my-app');
  });

  it('distinguishes different connector schema mismatches and coalesces only the exact repeated failure', async () => {
    await logFile();
    const first = 'plugin refresh schema mismatch surface=core expectedSchema=aaaaaaaaaaaa providerSchema=bbbbbbbbbbbb private body sk-private-test123456789';
    const second = 'plugin refresh schema mismatch surface=core expectedSchema=aaaaaaaaaaaa providerSchema=cccccccccccc private body sk-private-test123456789';
    logWarn(first);
    logWarn(second);
    logWarn(first);
    const incidents = (await listLocalIncidents()).incidents;
    expect(incidents).toHaveLength(2);
    expect(incidents.every(row => row.source === 'pairing' && row.reason === 'plugin_refresh_schema_mismatch')).toBe(true);
    expect(incidents.map(row => row.occurrences).sort()).toEqual([1, 2]);
    expect(new Set(incidents.map(row => row.fingerprint)).size).toBe(2);
    expect(JSON.stringify(incidents)).not.toContain('private body');
    expect(JSON.stringify(incidents)).not.toContain('private-test123456789');
  });

  it('retains a second exact failed turn during image cooldown and binds the first capture outcome to its own turn', async () => {
    await logFile();
    const first = offerBrowserDebugCapture({ ...debugInput, turnId: 'stream-first-turn' });
    expect(first).not.toBeNull();
    expect(offerBrowserDebugCapture({ ...debugInput, turnId: 'stream-first-turn' })).toBeNull();
    expect(offerBrowserDebugCapture({ ...debugInput, turnId: 'stream-second-turn' })).toBeNull();
    await flushLocalIncidents();
    const before = (await listLocalIncidents()).incidents;
    expect(before).toHaveLength(2);
    expect(before.find(row => row.turnId === 'stream-first-turn')).toMatchObject({
      reason: 'stream_gone', capture: 'offered', occurrences: 1
    });
    expect(before.find(row => row.turnId === 'stream-second-turn')).toMatchObject({
      reason: 'stream_gone', capture: 'capture_cooldown', occurrences: 1
    });
    expect(await completeBrowserDebugCapture(first!.id, undefined, 'hidden_tab')).toBe(true);
    await flushLocalIncidents();
    const after = (await listLocalIncidents()).incidents;
    expect(after.find(row => row.turnId === 'stream-first-turn')?.capture).toBe('hidden_tab');
    expect(after.find(row => row.turnId === 'stream-second-turn')?.capture).toBe('capture_cooldown');
    expect(after.map(row => row.sendEvidence)).toEqual(['not_observed', 'not_observed']);
  });

  it('refuses to read captured pixels whose sidecar is reassigned to a different failed turn', async () => {
    const file = await logFile();
    const sharp = (await import('sharp')).default;
    const jpg = await sharp({ create: { width: 8, height: 8, channels: 3, background: '#123456' } }).jpeg().toBuffer();
    const offer = offerBrowserDebugCapture({ ...debugInput, turnId: 'failed-original' })!;
    expect(await completeBrowserDebugCapture(offer.id, `data:image/jpeg;base64,${jpg.toString('base64')}`, 'captured')).toBe(true);
    await flushLocalIncidents();
    const first = (await listLocalIncidents()).incidents[0]!;
    expect(first).toMatchObject({ turnId: 'failed-original', capture: 'saved' });
    expect((await readLocalIncidentImage(first.id)).status).toBe('saved');
    const sidecarFile = path.join(path.dirname(file), 'browser-debug', first.screenshot!.metadataFile);
    const sidecar = JSON.parse(await fs.readFile(sidecarFile, 'utf8')) as { turnId: string };
    expect(sidecar.turnId).toBe('failed-original');
    sidecar.turnId = 'different-turn';
    await fs.writeFile(sidecarFile, JSON.stringify(sidecar));
    expect((await listLocalIncidents(first.id)).incidents[0]?.capture).toBe('expired');
    expect(await readLocalIncidentImage(first.id)).toEqual({ status: 'expired', data: null });
  });

  it('refuses a hash-matching screenshot sidecar reassigned to another profile', async () => {
    const originalProfile = 'profile-f481290d-e54c-42a6-be5d-c8a19b35f0aa';
    setLogProfileContext(originalProfile);
    const file = await logFile();
    const sharp = (await import('sharp')).default;
    const jpg = await sharp({ create: { width: 8, height: 8, channels: 3, background: '#123456' } }).jpeg().toBuffer();
    const offer = offerBrowserDebugCapture({ ...debugInput, turnId: 'same_pixels_foreign_owner' })!;
    expect(await completeBrowserDebugCapture(offer.id, `data:image/jpeg;base64,${jpg.toString('base64')}`, 'captured')).toBe(true);
    await flushLocalIncidents();
    const incident = (await listLocalIncidents()).incidents[0]!;
    expect(incident).toMatchObject({ profileId: originalProfile, capture: 'saved' });
    const filename = path.join(path.dirname(file), 'browser-debug', incident.screenshot!.metadataFile);
    const sidecar = JSON.parse(await fs.readFile(filename, 'utf8'));
    expect(sidecar.profileId).toBe(originalProfile);
    const foreignSidecar = JSON.stringify({
      ...sidecar, profileId: 'profile-8bc4db29-9172-4c9a-876d-6d52d81866a7'
    });
    await fs.writeFile(filename, foreignSidecar);
    expect((await listLocalIncidents(incident.id)).incidents[0]?.capture).toBe('expired');
    expect(await readLocalIncidentImage(incident.id)).toEqual({ status: 'expired', data: null });
    expect(await fs.readFile(filename, 'utf8')).toBe(foreignSidecar);
  });

  it('refuses to publish an incident image after its profile switches during image IO', async () => {
    const owner = 'profile-f481290d-e54c-42a6-be5d-c8a19b35f0aa';
    setLogProfileContext(owner);
    await logFile();
    const sharp = (await import('sharp')).default;
    const jpg = await sharp({ create: { width: 8, height: 8, channels: 3, background: '#123456' } }).jpeg().toBuffer();
    const offer = offerBrowserDebugCapture({ ...debugInput, turnId: 'private_image_owner' })!;
    expect(await completeBrowserDebugCapture(offer.id, `data:image/jpeg;base64,${jpg.toString('base64')}`, 'captured')).toBe(true);
    await flushLocalIncidents();
    const incident = (await listLocalIncidents()).incidents[0]!;
    let start!: () => void, resume!: () => void;
    const started = new Promise<void>(resolve => { start = resolve; });
    const gate = new Promise<void>(resolve => { resume = resolve; });
    const originalRead = fs.readFile.bind(fs);
    let imageReads = 0;
    const spy = vi.spyOn(fs, 'readFile').mockImplementation(async (...args) => {
      if (String(args[0]).endsWith('.jpg') && ++imageReads === 2) { start(); await gate; }
      return originalRead(...args);
    });
    const pending = readLocalIncidentImage(incident.id);
    await started;
    try {
      setLogProfileContext('profile-8bc4db29-9172-4c9a-876d-6d52d81866a7');
      resume();
      expect(await pending).toEqual({ status: 'not_found', data: null });
    } finally {
      spy.mockRestore();
      setLogProfileContext(owner);
    }
    expect((await readLocalIncidentImage(incident.id)).status).toBe('saved');
  });

  it('coalesces repeated failures, expires capture offers and consumes skips only once', async () => {
    await logFile();
    const offer = offerBrowserDebugCapture(debugInput)!;
    expect(offerBrowserDebugCapture(debugInput)).toBeNull();
    expect(browserDebugCaptureOwner(offer.id)?.sessionId).toBe(debugInput.sessionId);
    expect(await completeBrowserDebugCapture(offer.id, undefined, 'hidden_tab')).toBe(true);
    expect(await completeBrowserDebugCapture(offer.id, undefined, 'hidden_tab')).toBe(false);
    vi.spyOn(Date, 'now').mockReturnValue(offer.expiresAt + 60_001);
    const later = offerBrowserDebugCapture(debugInput)!;
    vi.spyOn(Date, 'now').mockReturnValue(later.expiresAt + 1);
    expect(browserDebugCaptureOwner(later.id)).toBeNull();
    expect(await completeBrowserDebugCapture(later.id, undefined, 'hidden_tab')).toBe(false);
  });

  it.each(['different-profile', 'profile-roundtrip'])(
    'rejects a delayed screenshot offer after %s without writing pixels', async transition => {
      const first = 'profile-f481290d-e54c-42a6-be5d-c8a19b35f0aa';
      setLogProfileContext(first);
      const file = await logFile();
      const sharp = (await import('sharp')).default;
      const jpg = await sharp({ create: { width: 8, height: 8, channels: 3, background: '#123456' } }).jpeg().toBuffer();
      const offer = offerBrowserDebugCapture({ ...debugInput, turnId: 'old_capture_offer' })!;
      setLogProfileContext('profile-8bc4db29-9172-4c9a-876d-6d52d81866a7');
      if (transition === 'profile-roundtrip') setLogProfileContext(first);
      try {
        expect(browserDebugCaptureOwner(offer.id)).toBeNull();
        expect(await completeBrowserDebugCapture(offer.id, `data:image/jpeg;base64,${jpg.toString('base64')}`, 'captured'))
          .toBe(false);
        expect(await fs.readdir(path.dirname(file))).not.toContain('browser-debug');
      } finally {
        setLogProfileContext(first);
      }
    }
  );

  it('blocks image persistence when the offered profile changes during decoding', async () => {
    const first = 'profile-f481290d-e54c-42a6-be5d-c8a19b35f0aa';
    setLogProfileContext(first);
    const file = await logFile();
    const sharp = (await import('sharp')).default;
    const jpg = await sharp({ create: { width: 8, height: 8, channels: 3, background: '#123456' } }).jpeg().toBuffer();
    const offer = offerBrowserDebugCapture({ ...debugInput, turnId: 'slow_original_capture' })!;
    let waiting!: () => void, resume!: () => void, checks = 0;
    const arrived = new Promise<void>(resolve => { waiting = resolve; });
    const gate = new Promise<void>(resolve => { resume = resolve; });
    const allowed = async () => {
      if (++checks === 2) { waiting(); await gate; }
      return true;
    };
    const pending = completeBrowserDebugCapture(offer.id, `data:image/jpeg;base64,${jpg.toString('base64')}`, 'captured', allowed);
    await arrived;
    try {
      setLogProfileContext('profile-8bc4db29-9172-4c9a-876d-6d52d81866a7');
      setLogProfileContext(first);
      resume();
      expect(await pending).toBe(false);
      expect(await fs.readdir(path.dirname(file))).not.toContain('browser-debug');
    } finally {
      setLogProfileContext(first);
    }
  });

  it('stores genuine bounded JPEG evidence, rotates only its fixed ring and rechecks revocation', async () => {
    const file = await logFile();
    const sharp = (await import('sharp')).default;
    const jpg = await sharp({ create: { width: 16, height: 16, channels: 3, background: '#123456' } }).jpeg().toBuffer();
    const image = `data:image/jpeg;base64,${jpg.toString('base64')}`;
    for (let n = 0; n < BROWSER_DEBUG_IMAGE_SLOTS + 1; n++) {
      const offer = offerBrowserDebugCapture({ ...debugInput, conversationId: `aaaaaaaa-bbbb-4ccc-8ddd-${String(n).padStart(12, '0')}` })!;
      expect(await completeBrowserDebugCapture(offer.id, image, 'captured')).toBe(true);
    }
    const files = await fs.readdir(path.join(path.dirname(file), 'browser-debug'));
    expect(files).toHaveLength(BROWSER_DEBUG_IMAGE_SLOTS * 2);
    for (const name of files.filter(name => name.endsWith('.jpg'))) {
      expect(name).toMatch(/^viewport-\d+\.jpg$/);
      expect((await fs.stat(path.join(path.dirname(file), 'browser-debug', name))).size).toBeLessThanOrEqual(BROWSER_DEBUG_IMAGE_BYTES);
      const metadata = JSON.parse(await fs.readFile(path.join(path.dirname(file), 'browser-debug', name.replace('.jpg', '.json')), 'utf8'));
      expect(metadata.imageFile).toBe(name);
      expect(metadata.sha256).toMatch(/^[a-f0-9]{64}$/);
    }
    const denied = offerBrowserDebugCapture(debugInput)!;
    let checks = 0;
    expect(await completeBrowserDebugCapture(denied.id, image, 'captured', () => ++checks < 2)).toBe(false);
    expect(getLog().filter(e => e.message.includes('"screenshot":"saved"'))).toHaveLength(BROWSER_DEBUG_IMAGE_SLOTS + 1);
  });

  it('refuses redirecting image storage through a symbolic link', async () => {
    const file = await logFile();
    const external = await fs.mkdtemp(path.join(os.tmpdir(), 'clf-debug-outside-'));
    cleanup.push(external);
    await fs.symlink(external, path.join(path.dirname(file), 'browser-debug'), process.platform === 'win32' ? 'junction' : 'dir');
    const sharp = (await import('sharp')).default;
    const jpg = await sharp({ create: { width: 1, height: 1, channels: 3, background: '#fff' } }).jpeg().toBuffer();
    const offer = offerBrowserDebugCapture(debugInput)!;
    await completeBrowserDebugCapture(offer.id, `data:image/jpeg;base64,${jpg.toString('base64')}`, 'captured');
    expect(await fs.readdir(external)).toEqual([]);
    expect(getLog().at(-1)?.message).toContain('capture_storage_failed');
  });

  it('bounds outstanding offers and never treats malformed pixels or skipped captures as saved evidence', async () => {
    const file = await logFile();
    const offers = Array.from({ length: 33 }, (_, n) => offerBrowserDebugCapture({ ...debugInput,
      conversationId: `bbbbbbbb-bbbb-4ccc-8ddd-${String(n).padStart(12, '0')}` }));
    expect(offers.filter(Boolean)).toHaveLength(32);
    await completeBrowserDebugCapture(offers[0]!.id, 'data:image/jpeg;base64,QUJD', 'captured');
    await completeBrowserDebugCapture(offers[1]!.id, 'data:image/jpeg;base64,QUJD', 'hidden_tab');
    expect(getLog().some(row => row.message.includes('"screenshot":"saved"'))).toBe(false);
    expect(await fs.readdir(path.dirname(file))).not.toContain('browser-debug');
  });
  it('creates a fresh isolated namespace before the first log write', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'clf-logger-isolated-'));
    cleanup.push(dir);
    const file = path.join(dir, 'instances', 'work', 'namespaces', 'logs', 'primary', 'app.log');
    initLogFile(file);
    logInfo('isolated profile started');
    await flushLogFile();
    expect(await fs.readFile(file, 'utf8')).toContain('isolated profile started');
  });

  it('returns immediately during slow IO, preserving file order and listeners', async () => {
    const file = await logFile();
    let release!: () => void;
    let entered!: () => void;
    const blocked = new Promise<void>(resolve => { entered = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    const realAppend = fs.appendFile.bind(fs);
    const append = vi.spyOn(fs, 'appendFile').mockImplementationOnce(async (...args) => {
      entered();
      await gate;
      return realAppend(...args);
    });
    const messages: string[] = [];
    onLog(entry => messages.push(entry.message));
    logInfo('first');
    await blocked;
    logInfo('second');
    logInfo('third');
    expect(messages).toEqual(['first', 'second', 'third']);
    expect(append).toHaveBeenCalledTimes(1);
    release();
    await flushLogFile();
    const text = await fs.readFile(file, 'utf8');
    expect(text.indexOf('first')).toBeLessThan(text.indexOf('second'));
    expect(text.indexOf('second')).toBeLessThan(text.indexOf('third'));
    expect(append).toHaveBeenCalledTimes(2);
  });

  it('rotates serially and keeps both files bounded', async () => {
    const file = await logFile();
    await fs.writeFile(file, 'x'.repeat(4 * 1024 * 1024));
    initLogFile(file);
    logInfo('after rotation');
    await flushLogFile();
    expect((await fs.stat(`${file}.1`)).size).toBe(4 * 1024 * 1024);
    expect(await fs.readFile(file, 'utf8')).toContain('after rotation');
  });

  it('bounds queued bytes and individual ring entries and records overload', async () => {
    const file = await logFile();
    // All calls happen in one turn, before the writer can consume its first batch.
    for (let i = 0; i < 600; i++) logInfo(`${i}: ${'🙂 '.repeat(20_000)}`);
    expect(getLog()).toHaveLength(500);
    expect(getLog().every(entry => Buffer.byteLength(entry.message) <= 16 * 1024)).toBe(true);
    await flushLogFile();
    const text = await fs.readFile(file, 'utf8');
    expect(Buffer.byteLength(text)).toBeLessThan(257 * 1024);
    expect(text).toContain('log line(s) omitted');
    expect(text).toContain('[log text truncated]');
  });

  it('redacts the normal and synchronous fatal snapshots without touching the writer', async () => {
    const file = await logFile();
    logInfo('credential sk-secret123456789');
    snapshotLogOnCrash('uncaught: sk-secret123456789');
    await flushLogFile();
    for (const target of [file, `${file}.crash`]) {
      const text = await fs.readFile(target, 'utf8');
      expect(text).not.toContain('secret123456789');
      expect(text).toContain('sk-***');
    }
  });

  it('records profile-aware lifecycle events while redacting secret connector URLs and headers', async () => {
    const file = await logFile();
    setLogProfileContext('profile-work');
    const pathToken = 'abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGH';
    logEvent(
      'profile.lifecycle.draining',
      `connector https://example.invalid/mcp/core/${pathToken}?token=short-secret&api_key=another-secret Authorization: Bearer bearer-secret-value`
    );
    await flushLogFile();

    const entry = getLog().at(-1);
    expect(entry).toMatchObject({ profileId: 'profile-work', event: 'profile.lifecycle.draining' });
    const exported = formatLogAsJson();
    const mirrored = await fs.readFile(file, 'utf8');
    for (const output of [exported, mirrored]) {
      expect(output).toContain('profile-work');
      expect(output).toContain('profile.lifecycle.draining');
      expect(output).not.toContain(pathToken);
      expect(output).not.toContain('short-secret');
      expect(output).not.toContain('another-secret');
      expect(output).not.toContain('bearer-secret-value');
      expect(output).toContain('token=***');
      expect(output).toContain('api_key=***');
      expect(output).toContain('Authorization: ***');
    }
  });

  it('isolates file errors, saves forensic context, and keeps writing once the disk recovers (#1682)', async () => {
    const file = await logFile();
    vi.spyOn(fs, 'appendFile').mockRejectedValueOnce(new Error('disk failure'));
    expect(() => logInfo('before failure')).not.toThrow();
    await vi.waitFor(async () => expect(await fs.readFile(`${file}.crash`, 'utf8')).toContain('disk failure'));
    expect(await fs.readFile(`${file}.crash`, 'utf8')).toContain('before failure');
    expect(() => logInfo('UI still works')).not.toThrow();
    // Nothing reached the file, so the batch is written once the next attempt succeeds, in order.
    await flushLogFile();
    const text = await fs.readFile(file, 'utf8');
    expect(text.indexOf('before failure')).toBeGreaterThanOrEqual(0);
    expect(text.indexOf('UI still works')).toBeGreaterThan(text.indexOf('before failure'));
    expect(text.split('before failure').length).toBe(2);
  });

  it('retries a failed write by itself after a short delay, without a flush (#1682)', async () => {
    const file = await logFile();
    vi.spyOn(fs, 'appendFile').mockRejectedValueOnce(new Error('busy'));
    logInfo('written by the retry');
    await vi.waitFor(async () => expect(await fs.readFile(file, 'utf8').catch(() => '')).toContain('written by the retry'), { timeout: 3000, interval: 50 });
  });

  it('keeps every line when rotation cannot rename the full log, and rotates once it can (#1682)', async () => {
    const file = await logFile();
    await fs.writeFile(file, 'x'.repeat(4 * 1024 * 1024));
    // A real rename failure on every platform: a directory sits where the old log would go.
    await fs.mkdir(`${file}.1`);
    initLogFile(file);
    logInfo('while the old log is in the way');
    await flushLogFile();
    // The file grows past its limit for now instead of losing the line or going silent, and says why once.
    expect(await fs.readFile(file, 'utf8')).toContain('while the old log is in the way');
    expect((await fs.readFile(file, 'utf8')).split('log rotation failed').length).toBe(2);
    logInfo('still writing');
    await flushLogFile();
    expect(await fs.readFile(file, 'utf8')).toContain('still writing');
    expect((await fs.readFile(file, 'utf8')).split('log rotation failed').length).toBe(2);
    await fs.rmdir(`${file}.1`);
    logInfo('rotated at last');
    await flushLogFile();
    expect(await fs.readFile(`${file}.1`, 'utf8')).toContain('still writing');
    expect(await fs.readFile(file, 'utf8')).toContain('rotated at last');
  });

  it('holds lines in order while a log far past its limit cannot rotate, then writes them once (#1682)', async () => {
    const file = await logFile();
    await fs.writeFile(file, 'x'.repeat(8 * 1024 * 1024));
    await fs.mkdir(`${file}.1`);
    initLogFile(file);
    logInfo('first held'); logInfo('second held');
    await expect(flushLogFile()).rejects.toThrow();
    expect((await fs.stat(file)).size).toBe(8 * 1024 * 1024);
    await fs.rmdir(`${file}.1`);
    logInfo('third');
    await flushLogFile();
    const text = await fs.readFile(file, 'utf8');
    expect(text.indexOf('first held')).toBeLessThan(text.indexOf('second held'));
    expect(text.indexOf('second held')).toBeLessThan(text.indexOf('third'));
    expect(text.split('first held').length).toBe(2);
  });

  it('writes a line an append cut off again in full, after a note, and repeats no complete line (#1682)', async () => {
    const file = await logFile();
    const realAppend = fs.appendFile.bind(fs);
    logInfo('reached the file before the cut');
    await flushLogFile();
    vi.spyOn(fs, 'appendFile').mockImplementationOnce(async (target: any, data: any) => {
      const text = String(data);
      // The first line of the batch lands whole, the second only in part.
      await realAppend(target, text.slice(0, text.indexOf('\n') + 1 + 20));
      throw new Error('short write');
    });
    logInfo('first in the batch'); logInfo('cut off part-way'); logInfo('never started');
    await vi.waitFor(async () => expect(await fs.readFile(`${file}.crash`, 'utf8').catch(() => '')).toContain('short write'));
    await flushLogFile();
    const text = await fs.readFile(file, 'utf8');
    for (const line of ['reached the file before the cut', 'first in the batch', 'cut off part-way', 'never started']) {
      expect(text.split(line).length, line).toBe(2);
    }
    expect(text).toContain('failed part-way: the cut-off line above follows again in full');
    expect(text.indexOf('first in the batch')).toBeLessThan(text.indexOf('failed part-way'));
    expect(text.indexOf('failed part-way')).toBeLessThan(text.indexOf('cut off part-way'));
    expect(text.indexOf('cut off part-way')).toBeLessThan(text.indexOf('never started'));
    // Each line starts on its own line, the note included.
    expect(text.split('\n').filter(l => l.includes('warn') && l.includes('failed part-way'))[0]).toMatch(/^\d{4}-/);
  });

  it('does not replay a fully appended batch when the append promise rejects afterward', async () => {
    const file = await logFile();
    const append = fs.appendFile.bind(fs);
    vi.spyOn(fs, 'appendFile').mockImplementationOnce(async (...args) => {
      await append(...args);
      throw new Error('completion notification failed');
    });
    logInfo('already durable once');
    await flushLogFile();
    logInfo('following durable line');
    await flushLogFile();
    const text = await fs.readFile(file, 'utf8');
    expect(text.split('already durable once')).toHaveLength(2);
    expect(text).toContain('following durable line');
  });

  it('requeues a cut UTF-8 line by byte boundaries without duplicating complete lines', async () => {
    const file = await logFile();
    const append = fs.appendFile.bind(fs);
    vi.spyOn(fs, 'appendFile').mockImplementationOnce(async (target: any, data: any) => {
      const bytes = Buffer.from(String(data), 'utf8');
      const cut = bytes.indexOf(Buffer.from('🙂')) + 2;
      await append(target, bytes.subarray(0, cut));
      throw new Error('partial multibyte append');
    });
    logInfo('complete before unicode');
    logInfo('cut 🙂 line restored');
    logInfo('after unicode');
    await vi.waitFor(async () => expect(await fs.readFile(`${file}.crash`, 'utf8').catch(() => ''))
      .toContain('partial multibyte append'));
    await flushLogFile();
    const text = await fs.readFile(file, 'utf8');
    for (const value of ['complete before unicode', 'cut 🙂 line restored', 'after unicode']) {
      expect(text.split(value), value).toHaveLength(2);
    }
    expect(text).toContain('failed part-way');
  });

  it('includes the final shutdown line before completing the exit barrier', async () => {
    const file = await logFile();
    let finalFlush: Promise<void> | undefined;
    await runShutdownSequence([], {
      info: logInfo, warn: logInfo, error: logInfo,
      exit: () => { finalFlush = flushLogBeforeExit(); }
    });
    await finalFlush;
    expect(await fs.readFile(file, 'utf8')).toContain('shutdown sequence complete');
  });

  it('bounds exit waiting and snapshots recent lines when the asynchronous writer is stuck', async () => {
    const file = await logFile();
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const realAppend = fs.appendFile.bind(fs);
    vi.spyOn(fs, 'appendFile').mockImplementationOnce(async (...args) => {
      await gate;
      return realAppend(...args);
    });
    logInfo('last forensic line');
    try {
      await flushLogBeforeExit(10);
      const crash = await fs.readFile(`${file}.crash`, 'utf8');
      expect(crash).toContain('last forensic line');
      expect(crash).toContain('deadline exceeded');
      expect(Buffer.byteLength(crash)).toBeLessThanOrEqual(256 * 1024);
    } finally { release(); }
    await flushLogFile();
  });
});
