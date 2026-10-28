/**
 * The Activity log: a bounded in-memory ring for the diagnostics panel, mirrored to one
 * bounded file so a run can still be read after the app has quit.
 *
 * Callers are responsible for not passing secrets; as a backstop, anything that looks like
 * an OpenAI key or a tunnel token is masked before it is stored, so a mistake upstream
 * cannot leak a credential into the UI or the file.
 *
 * A line written while a tool call is running inherits that call's agent, which is what
 * makes the per-agent Activity filter mean anything. Lines written outside a call —
 * startup, the tunnel, the servers — stay unattributed, because they genuinely are.
 *
 * The file exists because the 2026-09-02 compaction failure had to be reconstructed from
 * session logs and durable state alone: the five hundred lines in memory were gone with the
 * process, and they were the only record of what the bridge decided and why.
 */

import { promises as fs, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type { LogEntry } from '../shared/types.js';
import { currentAgent, currentCaller } from './mcp/call-context.js';

const MAX_ENTRIES = 500;
/** One rotation keeps the previous file, so the last two of these are always on disk. */
const MAX_LOG_FILE_BYTES = 4 * 1024 * 1024;
const MAX_LINE_BYTES = 16 * 1024;
const MAX_PENDING_BYTES = 256 * 1024;
const MAX_BATCH_BYTES = 64 * 1024;
// Upstream 040879c4/e52053c5 (#1682): retain bounded diagnostics through Windows IO failures.
const MAX_UNROTATED_BYTES = 2 * MAX_LOG_FILE_BYTES;
const RETRY_FIRST_MS = 1_000;
const RETRY_MAX_MS = 60_000;

const entries: LogEntry[] = [];
const listeners = new Set<(entry: LogEntry) => void>();
let profileId: string | null = null;
/** Structured local ownership must survive text redaction of the display label. */
let incidentProfileId: string | null = null;
let incidentProfileVerified = true;
/** A trip through another account invalidates already-admitted writes, even if the id comes back. */
let incidentProfileEpoch = 0;

interface FileMirror {
  file: string;
  bytes: number;
  pending: string[];
  pendingBytes: number;
  dropped: number;
  work: Promise<void> | null;
  /** The last write failure while lines still wait; cleared by the next successful write. */
  error: unknown;
  /** Failed attempts in a row: the retry delay, and one crash snapshot per streak. */
  failures: number;
  retry: NodeJS.Timeout | null;
  /** Appends that failed part-way: the cut line is written again in full after a note saying so. */
  cutWrites: number;
  /** Rotation failed and the file grows past its limit; said once in the file until it rotates. */
  rotationNoted: boolean;
}
let mirror: FileMirror | null = null;

// The incident folder is an index over this existing logger and screenshot ring, not a
// second transcript or recorder. Every profile writes its own fixed-size account folder.
// Verified owned incidents move byte-for-byte to a bounded immutable archive before
// a hot slot is reused. Unverified/foreign slots remain untouched; archival never resolves debt.
// Earlier production versions used 16 slots. When masked legacy custody occupies
// all 16, it is unsafe to evict, delete or guess their account ownership. Extend
// this SAME bounded ring to 32 (about 1 MiB maximum JSON) so authenticated new
// incidents can be captured without touching one byte of those originals.
export const LOCAL_INCIDENT_SLOTS = 32;
// Preserve the prior fixed 64-write in-flight bound; more disk slots do not
// create another recorder, a parallel writer, or a larger queued-memory budget.
const LOCAL_INCIDENT_PENDING_LIMIT = 64;
const LOCAL_INCIDENT_BYTES = 32 * 1024;
const LOCAL_INCIDENT_RETENTION_MS = 7 * 24 * 60 * 60_000;
const INCIDENT_COALESCE_MS = 60_000;
// An interrupted atomic write is not a durable incident. Reclaim only old,
// app-named partial files, leaving unresolved incident-*.json records intact.
const INCIDENT_TEMP_RETENTION_MS = 30 * 60_000;
type IncidentStatus = 'unresolved' | 'resolved';
type IncidentSource = 'app' | 'browser-debug' | 'worker' | 'helper' | 'model' | 'send' | 'handoff' | 'pairing';
type IncidentCapture = 'not_requested' | 'offered' | 'saved' | 'screen_permission_disabled' |
  'screenshots_disabled' | 'hidden_tab' | 'stale_document' | 'capture_unavailable' |
  'capture_cooldown' | 'capture_too_large' | 'capture_storage_failed' | 'expired';
interface LocalIncident {
  version: 1;
  id: string;
  profileId: string | null;
  source: IncidentSource;
  reason: string;
  createdAt: number;
  updatedAt: number;
  occurrences: number;
  status: IncidentStatus;
  sessionId: string | null;
  conversationId: string | null;
  turnId: string | null;
  inputId: string | null;
  commandId: string | null;
  requestId: string | null;
  capture: IncidentCapture;
  timezoneOffsetMinutes: number | null;
  /** Only stable machine-readable codes and repository frame coordinates, never exception messages. */
  errorEvidence?: { digest: string; code: string | null; frames: string[] };
  browserFacts?: { errors: number; runningTools: number; automationPaused: boolean };
  /** Shape-only native finality gap. Trace joins describe observed ids, not the unresolved call's owner. */
  nativeCompletion?: { openCalls: number; openCodeCalls: number; traceRequestIds: number; exactRequestJoins: number;
    /** Opaque immutable-origin grouping only; neither identities nor completion proof. */
    checkpointKey?: string };
  sendEvidence: 'not_observed';
  domEvidence: 'not_captured';
  screenshot?: { metadataFile: string; sha256: string; bytes: number };
  fingerprint?: string;
  recentLog: Array<{ time: number; level: LogEntry['level']; event: string | null }>;
  sourceEvidence: 'runtime-log-only';
  loadedCompanionEvidence: 'unverified';
}
interface IncidentSlotRow {
  slot: number;
  incident: LocalIncident;
  /** Exact bytes last accepted from disk (or just durably committed by this writer). */
  diskSha256: string;
}
interface IncidentFolderOwner {
  folder: string;
  /** The account bound to this directory when logging started; a later context switch cannot change custody. */
  profileId: string | null;
  rows: IncidentSlotRow[] | null;
  queue: Promise<void>;
  pending: number;
  dropped: number;
  storageError: string | null;
  tempsReconciled: boolean;
  /** Occupied slots whose owner/schema cannot be verified are never reusable. */
  unverifiedSlots: Set<number>;
  archive: IncidentArchiveIndex | null;
}
let incidentFolder: IncidentFolderOwner | null = null;
const incidentIdentity = (value: unknown): string | null => typeof value === 'string' &&
  value.length > 0 && value.length <= 200 && /^[a-z0-9_-]+$/i.test(value) ? value : null;
const incidentUuid = (value: unknown): string | null => typeof value === 'string' &&
  /^[a-f\d-]{8,64}$/i.test(value) ? value : null;
const incidentReason = (value: unknown): string => typeof value === 'string' &&
  /^[a-z\d_.:-]{1,80}$/i.test(value) ? value : 'native_error';
const incidentCapture = (value: unknown): IncidentCapture => (
  ['not_requested', 'offered', 'saved', 'screen_permission_disabled', 'screenshots_disabled',
    'hidden_tab', 'stale_document', 'capture_unavailable', 'capture_cooldown', 'capture_too_large',
    'capture_storage_failed', 'expired']
    .includes(String(value)) ? value : 'capture_unavailable') as IncidentCapture;
function acceptedIncidentScreenshot(value: LocalIncident['screenshot'] | undefined): LocalIncident['screenshot'] | undefined {
  return value && /^viewport-\d+\.json$/.test(value.metadataFile) &&
    /^[a-f0-9]{64}$/.test(value.sha256) &&
    Number.isInteger(value.bytes) && value.bytes > 0 && value.bytes <= BROWSER_DEBUG_IMAGE_BYTES
    ? { metadataFile: value.metadataFile, sha256: value.sha256, bytes: value.bytes } : undefined;
}
const incidentError = (error: unknown): string => {
  const code = (error as NodeJS.ErrnoException)?.code;
  return ['ENOSPC', 'EACCES', 'EPERM', 'EIO', 'EEXIST', 'ELOOP'].includes(code ?? '') ? code! : 'storage_io_failure';
};
function boundedBrowserCount(value: unknown): number {
  return Number.isFinite(value) ? Math.max(0, Math.min(100, Math.trunc(value as number))) : 0;
}
function acceptedNativeCompletion(value: unknown): LocalIncident['nativeCompletion'] | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const row = value as Record<string, unknown>;
  const count = (v: unknown): v is number => Number.isInteger(v) && Number(v) >= 0 && Number(v) <= 400;
  if (!count(row['openCalls']) || !count(row['openCodeCalls']) ||
      !count(row['traceRequestIds']) || !count(row['exactRequestJoins']) ||
      row['traceRequestIds'] > 16 || row['exactRequestJoins'] > row['traceRequestIds']) return undefined;
  return { openCalls: row['openCalls'], openCodeCalls: row['openCodeCalls'],
    traceRequestIds: row['traceRequestIds'], exactRequestJoins: row['exactRequestJoins'],
    ...(typeof row['checkpointKey'] === 'string' && /^[a-f0-9]{64}$/.test(row['checkpointKey'])
      ? { checkpointKey: row['checkpointKey'] } : {}) };
}
function incidentErrorEvidence(detail: unknown): LocalIncident['errorEvidence'] {
  if (typeof detail !== 'string' || !detail) return undefined;
  const safe = boundedText(redact(detail));
  const code = /\b(?:ENOSPC|EACCES|EPERM|EIO|EPIPE|ECONNRESET|ETIMEDOUT|ERR_[A-Z0-9_]{2,60})\b/.exec(safe)?.[0] ?? null;
  const frames = [...safe.matchAll(/\b((?:src[\\/](?:main|shared|renderer)[\\/][\w.\\/-]{1,160}\.(?:ts|js)|extension[\\/](?:fiber|content|background|chatgpt-dom)\.js):\d{1,6}:\d{1,5})\b/g)]
    .map(match => match[1]!.replace(/\\/g, '/'))
    .filter(frame => !frame.split('/').includes('..')).slice(0, 5);
  return { digest: createHash('sha256').update(safe).digest('hex'), code, frames };
}
function incidentLogShapes(): LocalIncident['recentLog'] {
  return entries.slice(-24).map(entry => ({ time: entry.time, level: entry.level,
    event: entry.event && /^[a-zA-Z\d_.-]{1,80}$/.test(entry.event) ? entry.event : null }));
}
const incidentSlotDigest = (body: string | Buffer): string =>
  createHash('sha256').update(body).digest('hex');
function parseLocalIncident(body: string, profileId: string | null): LocalIncident | null {
  const raw = JSON.parse(body) as LocalIncident;
  if (raw?.version !== 1 || !/^[a-f0-9]{8}-[a-f0-9-]{27,36}$/i.test(raw.id) || !Number.isFinite(raw.createdAt) ||
          !['unresolved', 'resolved'].includes(raw.status) || !['app', 'browser-debug', 'worker', 'helper',
            'model', 'send', 'handoff', 'pairing'].includes(raw.source) ||
          (raw.profileId !== null && incidentIdentity(raw.profileId) === null) ||
          incidentIdentity(raw.profileId) !== profileId) return null;
  return {
        version: 1, id: raw.id, profileId: incidentIdentity(raw.profileId), source: raw.source,
        reason: incidentReason(raw.reason), createdAt: raw.createdAt,
        updatedAt: Number.isFinite(raw.updatedAt) ? raw.updatedAt : raw.createdAt,
        occurrences: Number.isInteger(raw.occurrences) ? Math.min(10000, Math.max(1, raw.occurrences)) : 1,
        status: raw.status,
        sessionId: incidentIdentity(raw.sessionId), conversationId: incidentUuid(raw.conversationId),
        turnId: incidentIdentity(raw.turnId), inputId: incidentUuid(raw.inputId),
        commandId: incidentIdentity(raw.commandId), requestId: incidentIdentity(raw.requestId),
        capture: incidentCapture(raw.capture),
        timezoneOffsetMinutes: typeof raw.timezoneOffsetMinutes === 'number' &&
          Number.isInteger(raw.timezoneOffsetMinutes) &&
          Math.abs(raw.timezoneOffsetMinutes) <= 14 * 60 ? raw.timezoneOffsetMinutes : null,
        sendEvidence: 'not_observed', domEvidence: 'not_captured',
        ...(raw.errorEvidence && /^[a-f0-9]{64}$/.test(raw.errorEvidence.digest)
          ? { errorEvidence: { digest: raw.errorEvidence.digest,
            code: typeof raw.errorEvidence.code === 'string' &&
              /^(?:ENOSPC|EACCES|EPERM|EIO|EPIPE|ECONNRESET|ETIMEDOUT|ERR_[A-Z0-9_]{2,60})$/.test(raw.errorEvidence.code)
              ? raw.errorEvidence.code : null,
            frames: Array.isArray(raw.errorEvidence.frames) ? raw.errorEvidence.frames.slice(0, 5)
              .filter(frame => typeof frame === 'string' && frame.length <= 200 &&
                /^(?:src\/(?:main|shared|renderer)\/|extension\/)[\w./-]+\.(?:ts|js):\d{1,6}:\d{1,5}$/.test(frame) &&
                !frame.split('/').includes('..')) : [] } } : {}),
        ...(raw.browserFacts ? { browserFacts: {
          errors: boundedBrowserCount(raw.browserFacts.errors),
          runningTools: boundedBrowserCount(raw.browserFacts.runningTools),
          automationPaused: raw.browserFacts.automationPaused === true } } : {}),
        ...(acceptedNativeCompletion(raw.nativeCompletion)
          ? { nativeCompletion: acceptedNativeCompletion(raw.nativeCompletion) } : {}),
        recentLog: Array.isArray(raw.recentLog) ? raw.recentLog.slice(-24).filter(item =>
          Number.isFinite(item.time) && ['info', 'warn', 'error'].includes(item.level))
          .map(item => ({ time: item.time, level: item.level,
            event: typeof item.event === 'string' && /^[a-zA-Z\d_.-]{1,80}$/.test(item.event) ? item.event : null })) : [],
        sourceEvidence: 'runtime-log-only', loadedCompanionEvidence: 'unverified',
        ...(typeof raw.fingerprint === 'string' && /^[a-f0-9]{64}$/.test(raw.fingerprint) ? { fingerprint: raw.fingerprint } : {}),
        ...(acceptedIncidentScreenshot(raw.screenshot) ? { screenshot: acceptedIncidentScreenshot(raw.screenshot) } : {})
      };
}
async function readIncidentSlots(owner: IncidentFolderOwner, refresh = false): Promise<IncidentSlotRow[]> {
  if (!incidentProfileVerified || owner.profileId !== incidentProfileId) {
    owner.storageError = 'incident_profile_unverified';
    return [];
  }
  // A locally replaced symlink/junction must not turn a read-only Core incident
  // inspection into a read from another account's or user's arbitrary folder.
  try {
    const directory = await fs.lstat(owner.folder);
    if (!directory.isDirectory() || directory.isSymbolicLink()) {
      owner.rows = null;
      owner.storageError = 'storage_io_failure';
      return [];
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') {
      if (owner.rows?.length) owner.storageError = 'storage_io_failure';
      owner.rows = null;
      return [];
    }
    owner.storageError = incidentError(error);
    return [];
  }
  if (owner.rows && !refresh) return owner.rows;
  // An explicit Core read is an existing safe boundary to observe custody work
  // done outside this process. No old sidecar is deleted or adopted by a refresh.
  owner.unverifiedSlots.clear();
  if (owner.storageError === 'incident_slot_unverified' ||
      owner.storageError === 'incident_profile_unverified') owner.storageError = null;
  const rows: IncidentSlotRow[] = [];
  for (let slot = 0; slot < LOCAL_INCIDENT_SLOTS; slot++) {
    const file = path.join(owner.folder, `incident-${slot}.json`);
    try {
      const info = await fs.lstat(file);
      // Do not make an unreadable/rejected record look like a free slot. Its
      // original identity cannot be reconstructed from a redacted legacy label.
      owner.unverifiedSlots.add(slot);
      if (!info.isFile() || info.isSymbolicLink() || info.size > LOCAL_INCIDENT_BYTES) {
        owner.storageError = 'incident_slot_unverified';
        continue;
      }
      const body = await fs.readFile(file, 'utf8');
      const incident = parseLocalIncident(body, owner.profileId);
      if (!incident) { owner.storageError = 'incident_slot_unverified'; continue; }
      rows.push({ slot, diskSha256: incidentSlotDigest(body), incident });
      owner.unverifiedSlots.delete(slot);
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') {
        owner.unverifiedSlots.add(slot);
        owner.storageError = error instanceof SyntaxError ? 'incident_slot_unverified' : incidentError(error);
      }
    }
  }
  return owner.rows = rows;
}
async function expireSettledIncidentSlots(owner: IncidentFolderOwner,
  rows: IncidentSlotRow[]): Promise<void> {
  const now = Date.now();
  for (let n = rows.length - 1; n >= 0; n--) {
    const row = rows[n]!;
    if (row.incident.status !== 'resolved' || now < row.incident.updatedAt ||
        now - row.incident.updatedAt < LOCAL_INCIDENT_RETENTION_MS) continue;
    const file = path.join(owner.folder, `incident-${row.slot}.json`);
    try {
      // The original id is not proof of unchanged ownership: a substituted
      // unresolved incident could reuse the same id and must survive expiry.
      if (!(await incidentSlotStillOwned(owner, row.slot, row))) {
        owner.rows = null;
        owner.storageError = 'incident_slot_unverified';
        continue;
      }
      await fs.unlink(file);
      rows.splice(n, 1);
    } catch (error) {
      owner.storageError = incidentError(error);
    }
  }
}
async function reclaimInterruptedIncidentWrites(owner: IncidentFolderOwner): Promise<void> {
  // The legacy fixed .tmp name could block every future incident in a slot.
  // New writes use a unique path, and an initial bounded sweep removes only
  // old partial files that match those two app-owned naming contracts.
  const before = Date.now() - INCIDENT_TEMP_RETENTION_MS;
  const files = (await fs.readdir(owner.folder)).filter(name =>
    /^incident-(?:[0-9]|[12][0-9]|3[01])\.json\.tmp$/.test(name) ||
    /^incident-(?:[0-9]|[12][0-9]|3[01])\.json\.[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}\.tmp$/.test(name));
  for (const name of files.slice(0, LOCAL_INCIDENT_SLOTS * 4)) {
    const file = path.join(owner.folder, name);
    try {
      const info = await fs.lstat(file);
      if (!info.isFile() || info.isSymbolicLink() || info.size > LOCAL_INCIDENT_BYTES ||
          !Number.isFinite(info.mtimeMs) || info.mtimeMs > before) continue;
      await fs.unlink(file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') owner.storageError = incidentError(error);
    }
  }
}
/** Cached rows are hints for slot selection, never authority to replace disk evidence. */
async function incidentSlotStillOwned(owner: IncidentFolderOwner, slot: number,
  expected: IncidentSlotRow | undefined): Promise<boolean> {
  const file = path.join(owner.folder, `incident-${slot}.json`);
  try {
    const info = await fs.lstat(file);
    if (!expected || !info.isFile() || info.isSymbolicLink() || info.size > LOCAL_INCIDENT_BYTES) return false;
    // Compare the complete original serialized evidence. Matching id/timestamp
    // alone could bless a changed status, screenshot, error or profile payload.
    return incidentSlotDigest(await fs.readFile(file)) === expected.diskSha256;
  } catch (error) {
    return (error as NodeJS.ErrnoException)?.code === 'ENOENT' && !expected;
  }
}

interface IncidentArchiveIndex { files: Array<{ name: string; bytes: number }>; bytes: number }
const INCIDENT_ARCHIVE_FILES = 4096;
const INCIDENT_ARCHIVE_BYTES = 128 * 1024 * 1024;
const INCIDENT_ARCHIVE_NAME = /^incident-([a-f\d]{8}-[a-f\d-]{27,36})-([a-f\d]{64})\.json$/i;
const archiveFailure = (code: 'EIO' | 'ENOSPC' = 'EIO'): Error =>
  Object.assign(new Error('Incident archive unavailable; original evidence retained'), { code });
async function incidentArchiveDirectory(owner: IncidentFolderOwner, create = false): Promise<string | null> {
  const parent = await fs.lstat(owner.folder);
  if (!parent.isDirectory() || parent.isSymbolicLink()) throw archiveFailure();
  const folder = path.join(owner.folder, 'archive');
  if (create) await fs.mkdir(folder, { recursive: true });
  try {
    const info = await fs.lstat(folder);
    if (!info.isDirectory() || info.isSymbolicLink()) throw archiveFailure();
    return folder;
  } catch (error) {
    if (!create && (error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}
async function incidentArchiveIndex(owner: IncidentFolderOwner, refresh = false): Promise<IncidentArchiveIndex> {
  if (owner.archive && !refresh) return owner.archive;
  const index: IncidentArchiveIndex = { files: [], bytes: 0 };
  const folder = await incidentArchiveDirectory(owner);
  if (folder) {
    let scanned = 0;
    for await (const item of await fs.opendir(folder)) {
      if (++scanned > INCIDENT_ARCHIVE_FILES + LOCAL_INCIDENT_PENDING_LIMIT) throw archiveFailure('ENOSPC');
      if (!INCIDENT_ARCHIVE_NAME.test(item.name)) continue;
      const info = await fs.lstat(path.join(folder, item.name));
      if (!info.isFile() || info.isSymbolicLink() || info.size > LOCAL_INCIDENT_BYTES) throw archiveFailure();
      index.files.push({ name: item.name, bytes: info.size });
      index.bytes += info.size;
      if (index.files.length > INCIDENT_ARCHIVE_FILES || index.bytes > INCIDENT_ARCHIVE_BYTES) throw archiveFailure('ENOSPC');
    }
  }
  return owner.archive = index;
}
async function syncIncidentDirectory(folder: string): Promise<void> {
  // Windows does not expose POSIX directory fsync through this API.
  if (process.platform === 'win32') return;
  const directory = await fs.open(folder, 'r');
  try { await directory.sync(); } finally { await directory.close(); }
}
async function readArchivedIncident(owner: IncidentFolderOwner, id: string,
  index: IncidentArchiveIndex, expectedDigest?: string): Promise<LocalIncident | null> {
  const matches = index.files.filter(file => {
    const match = INCIDENT_ARCHIVE_NAME.exec(file.name);
    return match?.[1] === id && (!expectedDigest || match[2] === expectedDigest);
  });
  if (!matches.length) return null;
  if (matches.length !== 1) throw archiveFailure();
  const folder = await incidentArchiveDirectory(owner);
  if (!folder) throw archiveFailure();
  const name = matches[0]!.name, file = path.join(folder, name);
  const info = await fs.lstat(file);
  if (!info.isFile() || info.isSymbolicLink() || info.size > LOCAL_INCIDENT_BYTES) throw archiveFailure();
  const body = await fs.readFile(file);
  if (incidentSlotDigest(body) !== INCIDENT_ARCHIVE_NAME.exec(name)?.[2]) throw archiveFailure();
  const incident = parseLocalIncident(body.toString('utf8'), owner.profileId);
  if (!incident || incident.id !== id) throw archiveFailure();
  return incident;
}
/** Archive exact verified bytes before a hot slot can be reused. Never resolves a failure,
 * adopts foreign/legacy custody, or provides Send/retry authority. Hash-addressed filenames
 * are the durable lookup index; no mutable second incident database is introduced. */
async function archiveIncidentSlot(owner: IncidentFolderOwner, row: IncidentSlotRow,
  stillOwned: () => boolean): Promise<boolean> {
  if (!stillOwned() || !(await incidentSlotStillOwned(owner, row.slot, row))) return false;
  const body = await fs.readFile(path.join(owner.folder, 'incident-' + row.slot + '.json'));
  if (!stillOwned() || incidentSlotDigest(body) !== row.diskSha256 ||
      parseLocalIncident(body.toString('utf8'), owner.profileId)?.id !== row.incident.id) return false;
  const folder = await incidentArchiveDirectory(owner, true);
  if (!folder || !stillOwned()) return false;
  await syncIncidentDirectory(owner.folder);
  const index = await incidentArchiveIndex(owner);
  const name = 'incident-' + row.incident.id + '-' + row.diskSha256 + '.json';
  const target = path.join(folder, name);
  const existing = index.files.find(file => file.name === name);
  if (existing) {
    if (!(await readArchivedIncident(owner, row.incident.id, index, row.diskSha256))) throw archiveFailure();
    if (!stillOwned()) return false;
    // A previous link may have survived a failed directory flush. Discovery/readback
    // does not certify its crash durability; every retry must complete this barrier.
    await syncIncidentDirectory(folder);
    if (!(await readArchivedIncident(owner, row.incident.id, index, row.diskSha256))) throw archiveFailure();
    return stillOwned() && await incidentSlotStillOwned(owner, row.slot, row);
  }
  if (index.files.length >= INCIDENT_ARCHIVE_FILES || index.bytes + body.length > INCIDENT_ARCHIVE_BYTES) {
    throw archiveFailure('ENOSPC');
  }
  const temp = target + '.' + randomUUID() + '.tmp';
  try {
    if (!stillOwned()) return false;
    const handle = await fs.open(temp, 'wx');
    try { await handle.writeFile(body); await handle.sync(); } finally { await handle.close(); }
    if (!stillOwned() || !(await incidentSlotStillOwned(owner, row.slot, row))) return false;
    await incidentArchiveDirectory(owner);
    // Publish without replacement: an external/concurrent file appearing at this path
    // cannot be overwritten between the existence check and publication. The temporary
    // file is already flushed; the hard link names those same immutable bytes atomically.
    try {
      if (!stillOwned()) return false;
      await fs.link(temp, target);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const info = await fs.lstat(target);
      if (!info.isFile() || info.isSymbolicLink() || info.size !== body.length ||
          incidentSlotDigest(await fs.readFile(target)) !== row.diskSha256) throw archiveFailure();
    }
    await syncIncidentDirectory(folder);
    const info = await fs.lstat(target);
    if (!info.isFile() || info.isSymbolicLink() || info.size !== body.length ||
        incidentSlotDigest(await fs.readFile(target)) !== row.diskSha256) throw archiveFailure();
    owner.archive = null;
    const committed = await incidentArchiveIndex(owner);
    if (stillOwned() && Number.isInteger(Math.log2(committed.files.length))) {
      logEvent('incident.archive.verified', `Local incident archive verified: entries=${committed.files.length} bytes=${committed.bytes}; original status retained.`);
    }
    return stillOwned() && await incidentSlotStillOwned(owner, row.slot, row);
  } finally {
    await fs.unlink(temp).catch(() => undefined);
  }
}

/** The incident ring can correctly refuse every new write when all physical
 * slots are protected. Keep a sparse, fixed-shape breadcrumb in the EXISTING
 * rotating app.log: the volatile dropped count alone disappears at restart.
 * No profile, incident text, path, token, screenshot or request id is logged;
 * neither this warning nor a lost incident certifies a native final/ACK. */
function droppedIncident(owner: IncidentFolderOwner,
  cause: 'ring_full' | 'index_unverified' | 'pending_full' | 'write_failed'): void {
  owner.dropped++;
  // One line at drops 1,2,4,8,..., not one per failure or a new storage owner.
  if (incidentFolder !== owner || !incidentProfileVerified || owner.profileId !== incidentProfileId ||
      !Number.isInteger(Math.log2(owner.dropped))) return;
  logWarn(`local incident capture unavailable cause=${cause} dropped=${owner.dropped}`);
}
export async function noteLocalIncident(input: {
  source: IncidentSource; reason: string; status?: IncidentStatus; sessionId?: string;
  conversationId?: string; turnId?: string; inputId?: string; commandId?: string;
  requestId?: string; capture?: IncidentCapture; screenshot?: LocalIncident['screenshot'];
  detail?: string; fingerprint?: string;
  browserFacts?: { errors: number; runningTools: number; automationPaused: boolean };
  nativeCompletion?: LocalIncident['nativeCompletion'];
}): Promise<boolean> {
  const owner = incidentFolder;
  if (!owner) return false;
  if (!incidentProfileVerified || owner.profileId !== incidentProfileId) {
    owner.storageError = 'incident_profile_unverified';
    owner.dropped++;
    return false;
  }
  // A fixed disk ring is not an in-memory bound. Refuse excess diagnostic work
  // before retaining its closure when a slow/full disk stalls the current write.
  if (owner.pending >= LOCAL_INCIDENT_PENDING_LIMIT) {
    droppedIncident(owner, 'pending_full'); return false;
  }
  // A queued negative belongs before an exact clear if it was admitted before
  // that clear, even when slow storage writes it afterward. Bind the timestamp
  // only to this validated native origin; changed/legacy/foreign inputs retain
  // write-time uncertainty rather than borrowing an older admission.
  const nativeNegativeAdmission = (() => {
    try {
      if (input.source === 'browser-debug' && input.status !== 'resolved' &&
          /^native_terminal_(?:open_call|open_code|inventory_incomplete)$/.test(input.reason)) {
        const completion = acceptedNativeCompletion(input.nativeCompletion);
        if (completion?.checkpointKey) return {
          at: Date.now(), reason: input.reason, sessionId: incidentIdentity(input.sessionId),
          conversationId: incidentUuid(input.conversationId), turnId: incidentIdentity(input.turnId), completion
        };
      }
    } catch { /* Invalid inputs still fail inside the incumbent queued writer. */ }
    return null;
  })();
  owner.pending++;
  const admissionEpoch = incidentProfileEpoch;
  let accepted = false;
  const profileStillOwned = () => incidentFolder === owner && incidentProfileVerified &&
    incidentProfileEpoch === admissionEpoch && owner.profileId === incidentProfileId;
  const lostProfile = () => {
    owner.storageError = 'incident_profile_unverified';
    owner.dropped++;
  };
  const run = async () => {
    try {
      // The operation may have been queued under the prior account before a
      // context switch. Admission checks alone do not bind its eventual write.
      if (!profileStillOwned()) { lostProfile(); return; }
      await fs.mkdir(owner.folder, { recursive: true });
      const directory = await fs.lstat(owner.folder);
      if (!directory.isDirectory() || directory.isSymbolicLink()) throw new Error('unsafe_directory');
      if (!owner.tempsReconciled) {
        // Reclaiming crash debris is best effort. A temporary directory-listing
        // failure must not suppress the new, independently writable incident.
        try { await reclaimInterruptedIncidentWrites(owner); }
        catch (error) { owner.storageError = incidentError(error); }
        owner.tempsReconciled = true;
      }
      const rows = await readIncidentSlots(owner);
      await expireSettledIncidentSlots(owner, rows);
      if (!owner.rows) { droppedIncident(owner, 'index_unverified'); return; }
      const reason = incidentReason(input.reason);
      const nativeCompletion = acceptedNativeCompletion(input.nativeCompletion);
      const sessionId = incidentIdentity(input.sessionId), conversationId = incidentUuid(input.conversationId);
      const turnId = incidentIdentity(input.turnId);
      const now = nativeNegativeAdmission && input.source === 'browser-debug' && input.status !== 'resolved' &&
        reason === nativeNegativeAdmission.reason && sessionId === nativeNegativeAdmission.sessionId &&
        conversationId === nativeNegativeAdmission.conversationId && turnId === nativeNegativeAdmission.turnId &&
        JSON.stringify(nativeCompletion) === JSON.stringify(nativeNegativeAdmission.completion)
        ? nativeNegativeAdmission.at : Date.now();
      const errorEvidence = incidentErrorEvidence(input.detail);
      const browserFacts = input.browserFacts ? {
        errors: boundedBrowserCount(input.browserFacts.errors),
        runningTools: boundedBrowserCount(input.browserFacts.runningTools),
        automationPaused: input.browserFacts.automationPaused === true
      } : undefined;
      // A malformed supplied key must not degrade a resolution into legacy scope.
      // Disk reads still retain shape-only negative counts when a key is invalid.
      if (input.nativeCompletion?.checkpointKey !== undefined &&
          (typeof input.nativeCompletion.checkpointKey !== 'string' ||
            !/^[a-f0-9]{64}$/.test(input.nativeCompletion.checkpointKey) ||
            nativeCompletion?.checkpointKey !== input.nativeCompletion.checkpointKey)) return;
      const screenshot = acceptedIncidentScreenshot(input.screenshot);
      const fingerprint = input.fingerprint && /^[a-f0-9]{64}$/.test(input.fingerprint)
        ? input.fingerprint : undefined;
      const nativeReason = (value: string): boolean => value === 'native_terminal_open_call' ||
        value === 'native_terminal_open_code' || value === 'native_terminal_inventory_incomplete';
      const sameIncidentScope = (item: IncidentSlotRow): boolean => item.incident.source === input.source &&
        (item.incident.reason === reason || (nativeCompletion?.checkpointKey !== undefined &&
          item.incident.nativeCompletion?.checkpointKey === nativeCompletion.checkpointKey &&
          nativeReason(reason) && nativeReason(item.incident.reason))) &&
        item.incident.sessionId === sessionId && item.incident.conversationId === conversationId &&
        item.incident.turnId === turnId;
      const previous = rows.find(item => sameIncidentScope(item) &&
        item.incident.nativeCompletion?.checkpointKey === nativeCompletion?.checkpointKey &&
        (fingerprint || item.incident.fingerprint
          ? fingerprint !== undefined && item.incident.fingerprint === fingerprint
          : item.incident.status === 'unresolved' ||
            (now - item.incident.updatedAt >= 0 && now - item.incident.updatedAt <= INCIDENT_COALESCE_MS)));
      // A resolution cannot invent a resolved origin or consume another origin's
      // negative hold. Unkeyed legacy→legacy behavior remains unchanged.
      if (input.status === 'resolved' && !previous && (nativeCompletion?.checkpointKey !== undefined ||
          rows.some(item => sameIncidentScope(item) && item.incident.nativeCompletion?.checkpointKey !== undefined))) return;
      const staleSlot = (slot: number): void => {
        // Another owner or an external repair changed a cached slot. Invalidate the
        // snapshot so the next write can use a genuinely vacant slot; preserve the
        // on-disk evidence, whatever its profile or status, exactly as observed.
        owner.unverifiedSlots.add(slot);
        owner.rows = null;
        owner.storageError = 'incident_slot_unverified';
        owner.dropped++;
      };
      if (previous && reason !== 'plugin_refresh_schema_mismatch' && input.fingerprint && previous.incident.fingerprint === input.fingerprint &&
          (input.status === undefined || input.status === previous.incident.status ||
            (previous.incident.status === 'resolved' && input.status === 'unresolved')) &&
          !input.capture && !screenshot) {
        if (!(await incidentSlotStillOwned(owner, previous.slot, previous))) { staleSlot(previous.slot); return; }
        if (!profileStillOwned()) { lostProfile(); return; }
        accepted = true;
        return;
      }
      const reusable = !previous ? Array.from({ length: LOCAL_INCIDENT_SLOTS }, (_, slot) => slot).find(slot =>
        !owner.unverifiedSlots.has(slot) && !rows.some(item => item.slot === slot)) ?? rows.filter(item => item.incident.status === 'resolved' &&
        now - item.incident.updatedAt > LOCAL_INCIDENT_RETENTION_MS)
        .sort((a, b) => a.incident.updatedAt - b.incident.updatedAt)[0]?.slot : null;
      let slot = previous?.slot ?? reusable;
      let archivedRow: IncidentSlotRow | undefined;
      if (slot === null || slot === undefined) {
        // Bridge startup restores fail-closed native-completion waits from this hot
        // index. Preserve every unresolved nativeCompletion record, regardless of
        // source/reason, so archival cannot silently withdraw a restart fence.
        archivedRow = rows.filter(row => row.incident.status !== 'unresolved' || !row.incident.nativeCompletion)
          .sort((a, b) => a.incident.updatedAt - b.incident.updatedAt || a.slot - b.slot)[0];
        if (!archivedRow) { droppedIncident(owner, 'ring_full'); return; }
        if (!(await archiveIncidentSlot(owner, archivedRow, profileStillOwned))) {
          if (!profileStillOwned()) lostProfile(); else staleSlot(archivedRow.slot);
          return;
        }
        slot = archivedRow.slot;
      }
      const incident: LocalIncident = previous ? {
        ...previous.incident, updatedAt: now, occurrences: Math.min(10000, previous.incident.occurrences + 1),
        status: input.status ?? previous.incident.status,
        capture: input.capture ? incidentCapture(input.capture) : previous.incident.capture,
        ...(screenshot ? { screenshot } : {}),
        ...(errorEvidence ? { errorEvidence } : {}),
        ...(browserFacts ? { browserFacts } : {}),
        ...(nativeCompletion ? { nativeCompletion } : {}), recentLog: incidentLogShapes()
      } : {
        version: 1, id: randomUUID(), profileId: owner.profileId, source: input.source, reason,
        createdAt: now, updatedAt: now, occurrences: 1, status: input.status ?? 'unresolved',
        sessionId, conversationId, turnId,
        inputId: incidentUuid(input.inputId), commandId: incidentIdentity(input.commandId),
        requestId: incidentIdentity(input.requestId), capture: input.capture ? incidentCapture(input.capture) : 'not_requested',
        timezoneOffsetMinutes: new Date(now).getTimezoneOffset(),
        sendEvidence: 'not_observed', domEvidence: 'not_captured',
        ...(screenshot ? { screenshot } : {}), recentLog: incidentLogShapes(),
        ...(errorEvidence ? { errorEvidence } : {}),
        ...(browserFacts ? { browserFacts } : {}),
        ...(nativeCompletion ? { nativeCompletion } : {}),
        ...(fingerprint ? { fingerprint } : {}),
        sourceEvidence: 'runtime-log-only', loadedCompanionEvidence: 'unverified'
      };
      // Never store raw detail or an absolute stack path. Only a digest, standard
      // error code and bounded repository frame coordinates survive normalization.
      const body = JSON.stringify(incident);
      if (Buffer.byteLength(body, 'utf8') > LOCAL_INCIDENT_BYTES) { owner.dropped++; return; }
      const target = path.join(owner.folder, `incident-${slot}.json`);
      const temp = `${target}.${randomUUID()}.tmp`;
      try {
        await fs.writeFile(temp, body, { flag: 'wx' });
        if (!profileStillOwned()) { lostProfile(); return; }
        // Recheck immediately before rename. A freshly occupied slot, a foreign
        // incident, or an updated original cannot be replaced from a stale cache.
        // The temporary attempt stays private and is removed by the existing finally.
        if (!(await incidentSlotStillOwned(owner, slot, previous ?? archivedRow))) { staleSlot(slot); return; }
        if (archivedRow && !(await readArchivedIncident(owner, archivedRow.incident.id,
          await incidentArchiveIndex(owner), archivedRow.diskSha256))) throw archiveFailure();
        if (!profileStillOwned()) { lostProfile(); return; }
        await fs.rename(temp, target);
      } finally {
        // writeFile may create the file and then fail (for example ENOSPC).
        // This unique path belongs to this attempt even if the write rejected.
        await fs.unlink(temp).catch(() => undefined);
      }
      if (previous) {
        previous.incident = incident;
        previous.diskSha256 = incidentSlotDigest(body);
      }
      else {
        const at = rows.findIndex(item => item.slot === slot);
        if (at >= 0) rows.splice(at, 1);
        rows.push({ slot, incident, diskSha256: incidentSlotDigest(body) });
      }
      owner.storageError = owner.unverifiedSlots.size ? 'incident_slot_unverified' : null;
      accepted = true;
    } catch (error) {
      owner.storageError = incidentError(error);
      droppedIncident(owner, 'write_failed');
    }
  };
  const queued = owner.queue.then(run, run);
  owner.queue = queued.finally(() => { owner.pending--; });
  await owner.queue;
  return accepted;
}
export async function flushLocalIncidents(): Promise<void> { await incidentFolder?.queue; }
async function verifiedIncidentScreenshot(value: LocalIncident): Promise<LocalIncident> {
  const copy: LocalIncident = { ...value };
  if (copy.capture !== 'saved' || !copy.screenshot || !mirror) return copy;
  const base = path.join(path.dirname(mirror.file), 'browser-debug');
  const metaFile = path.join(base, copy.screenshot.metadataFile);
  try {
    const directory = await fs.lstat(base);
    if (!directory.isDirectory() || directory.isSymbolicLink()) throw new Error('stale');
    const metaStat = await fs.lstat(metaFile);
    if (!metaStat.isFile() || metaStat.isSymbolicLink() || metaStat.size > 4096) throw new Error('stale');
    const metadata = JSON.parse(await fs.readFile(metaFile, 'utf8')) as Record<string, unknown>;
    if (metadata['sha256'] !== copy.screenshot.sha256 || metadata['bytes'] !== copy.screenshot.bytes ||
        (metadata['profileId'] ?? null) !== copy.profileId ||
        metadata['sessionId'] !== copy.sessionId || metadata['conversationId'] !== copy.conversationId ||
        (metadata['turnId'] ?? null) !== copy.turnId ||
        typeof metadata['imageFile'] !== 'string' || !/^viewport-\d+\.jpg$/.test(metadata['imageFile']))
      throw new Error('stale');
    const image = path.join(base, metadata['imageFile']);
    const imageStat = await fs.lstat(image);
    if (!imageStat.isFile() || imageStat.isSymbolicLink() || imageStat.size !== copy.screenshot.bytes ||
        imageStat.size > BROWSER_DEBUG_IMAGE_BYTES ||
        createHash('sha256').update(await fs.readFile(image)).digest('hex') !== copy.screenshot.sha256)
      throw new Error('stale');
    return copy;
  } catch { copy.capture = 'expired'; delete copy.screenshot; return copy; }
}
export async function listLocalIncidents(id?: string): Promise<{
  folder: string | null; logFile: string | null;
  status: 'ready' | 'not_initialized' | 'storage_unavailable';
  storageError: string | null; dropped: number; unverifiedSlots: number; freeSlots: number;
  incidents: LocalIncident[];
  archive?: { folder: string; count: number; bytes: number; maxFiles: number; maxBytes: number };
}> {
  const owner = incidentFolder;
  if (!owner) return { folder: null, logFile: null, status: 'not_initialized',
    storageError: null, dropped: 0, unverifiedSlots: 0, freeSlots: 0, incidents: [] };
  const readEpoch = incidentProfileEpoch;
  const stillOwned = () => incidentFolder === owner && incidentProfileVerified &&
    incidentProfileEpoch === readEpoch && owner.profileId === incidentProfileId;
  const unavailable = () => ({
    folder: null, logFile: null, status: 'storage_unavailable' as const,
    storageError: 'incident_profile_unverified', dropped: owner.dropped,
    unverifiedSlots: 0, freeSlots: 0, incidents: [] as LocalIncident[]
  });
  if (!stillOwned()) return unavailable();
  const run = async () => {
    let rows = await readIncidentSlots(owner, true);
    await expireSettledIncidentSlots(owner, rows);
    if (!owner.rows) rows = await readIncidentSlots(owner, true);
    let archive: IncidentArchiveIndex | null = null;
    let archived: LocalIncident | null = null;
    try {
      archive = await incidentArchiveIndex(owner, true);
      if (id && !rows.some(row => row.incident.id === id)) archived = await readArchivedIncident(owner, id, archive);
    } catch (error) { owner.storageError = incidentError(error); }
    return { rows: [...rows], archive, archived };
  };
  const pending = owner.queue.then(run, run);
  owner.queue = pending.then(() => undefined, () => undefined);
  const { rows, archive, archived } = await pending;
  if (!stillOwned()) return unavailable();
  const selected = rows.filter(item => !id || item.incident.id === id).map(item => item.incident);
  if (archived) selected.push(archived);
  const incidents = await Promise.all(selected.map(verifiedIncidentScreenshot));
  if (!stillOwned()) return unavailable();
  // Vacant filenames are not usable capacity when profile custody or the
  // directory/disk itself is unavailable. An unverified *slot* only reserves
  // that slot; other verified vacancies remain available for bounded capture.
  const canCapture = owner.rows !== null && incidentProfileVerified &&
    owner.profileId === incidentProfileId &&
    (owner.storageError === null || owner.storageError === 'incident_slot_unverified');
  // Reveal only the bounded count, never foreign profile identifiers, filenames,
  // record bodies, or a claimed reason for unverified custody.
  return { folder: owner.folder, logFile: mirror?.file ?? null, status: owner.storageError ? 'storage_unavailable' : 'ready',
    storageError: owner.storageError, dropped: owner.dropped,
    unverifiedSlots: owner.unverifiedSlots.size,
    freeSlots: canCapture
      ? Math.max(0, LOCAL_INCIDENT_SLOTS - owner.unverifiedSlots.size - rows.length) : 0,
    incidents,
    ...(archive ? { archive: { folder: path.join(owner.folder, 'archive'), count: archive.files.length,
      bytes: archive.bytes, maxFiles: INCIDENT_ARCHIVE_FILES, maxBytes: INCIDENT_ARCHIVE_BYTES } } : {}) };
}

/** Exact previously captured pixels, reverified at the read boundary. Never captures a tab. */
export async function readLocalIncidentImage(id: string): Promise<{
  status: IncidentCapture | 'not_found'; data: string | null;
}> {
  const owner = incidentFolder;
  const readEpoch = incidentProfileEpoch;
  const stillOwned = () => owner !== null && owner === incidentFolder &&
    incidentProfileVerified && incidentProfileEpoch === readEpoch &&
    owner.profileId === incidentProfileId;
  if (!stillOwned()) return { status: 'not_found', data: null };
  const index = await listLocalIncidents(id);
  if (!stillOwned()) return { status: 'not_found', data: null };
  const incident = index.incidents[0];
  if (!incident) return { status: 'not_found', data: null };
  if (incident.capture !== 'saved' || !incident.screenshot || !mirror)
    return { status: incident.capture, data: null };
  try {
    const directory = path.join(path.dirname(mirror.file), 'browser-debug');
    const directoryInfo = await fs.lstat(directory);
    if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink()) return { status: 'expired', data: null };
    const sidecar = path.join(directory, incident.screenshot.metadataFile);
    const sidecarInfo = await fs.lstat(sidecar);
    if (!sidecarInfo.isFile() || sidecarInfo.isSymbolicLink() || sidecarInfo.size > 4096)
      return { status: 'expired', data: null };
    const metadata = JSON.parse(await fs.readFile(sidecar, 'utf8')) as Record<string, unknown>;
    if (metadata['sha256'] !== incident.screenshot.sha256 || metadata['bytes'] !== incident.screenshot.bytes ||
        (metadata['profileId'] ?? null) !== incident.profileId ||
        metadata['sessionId'] !== incident.sessionId || metadata['conversationId'] !== incident.conversationId ||
        (metadata['turnId'] ?? null) !== incident.turnId ||
        typeof metadata['imageFile'] !== 'string' || !/^viewport-\d+\.jpg$/.test(metadata['imageFile']))
      return { status: 'expired', data: null };
    const file = path.join(directory, metadata['imageFile']);
    const stat = await fs.lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== incident.screenshot.bytes ||
        stat.size > BROWSER_DEBUG_IMAGE_BYTES) return { status: 'expired', data: null };
    const image = await fs.readFile(file);
    if (!stillOwned()) return { status: 'not_found', data: null };
    if (createHash('sha256').update(image).digest('hex') !== incident.screenshot.sha256)
      return { status: 'expired', data: null };
    return { status: 'saved', data: image.toString('base64') };
  } catch { return { status: 'expired', data: null }; }
}

/**
 * One Core diagnostic response can await the index and its saved image separately.
 * Both must belong to the SAME account/logger generation at the final response
 * boundary. Independent per-read guards alone can return an old account index
 * alongside a correctly refused new-account image after a profile switch.
 */
export async function readLocalIncidentWithImage(id: string): Promise<{
  report: Awaited<ReturnType<typeof listLocalIncidents>>;
  image: Awaited<ReturnType<typeof readLocalIncidentImage>>;
}> {
  const owner = incidentFolder, readEpoch = incidentProfileEpoch;
  const stillOwned = () => owner !== null && incidentFolder === owner &&
    incidentProfileVerified && incidentProfileEpoch === readEpoch &&
    owner.profileId === incidentProfileId;
  const unavailable = () => ({
    report: { folder: null, logFile: null, status: 'storage_unavailable' as const,
      storageError: 'incident_profile_unverified', dropped: 0, unverifiedSlots: 0,
      freeSlots: 0, incidents: [] as LocalIncident[] },
    image: { status: 'not_found' as const, data: null }
  });
  if (!owner) {
    // The existing Core contract reports an unopened logger as not_initialized,
    // not as a profile-custody failure. It has no account data to publish.
    const report = await listLocalIncidents(id);
    return incidentFolder === null && report.status === 'not_initialized'
      ? { report, image: { status: 'not_found', data: null } }
      : unavailable();
  }
  if (!stillOwned()) return unavailable();
  const report = await listLocalIncidents(id);
  if (!stillOwned()) return unavailable();
  const image = await readLocalIncidentImage(id);
  if (!stillOwned()) return unavailable();
  return { report, image };
}

// Diagnostic images are local, disposable evidence, never a Send/recovery receipt. Keep
// one bounded ring next to the existing profile log rather than another recording service.
interface DebugCaptureOffer {
  sessionId: string; conversationId: string; turnId: string | null; reason: string; expiresAt: number;
  /** This capture stays with its original account and logger lifetime through every await. */
  owner: IncidentFolderOwner; state: FileMirror; profileEpoch: number;
}
const debugOffers = new Map<string, DebugCaptureOffer>();
const debugOfferStillOwned = (row: DebugCaptureOffer): boolean =>
  incidentProfileVerified && incidentFolder === row.owner && mirror === row.state &&
  incidentProfileEpoch === row.profileEpoch && incidentProfileId === row.owner.profileId;
const debugOfferLogShape = (row: DebugCaptureOffer) => ({
  sessionId: row.sessionId, conversationId: row.conversationId, turnId: row.turnId,
  reason: row.reason, expiresAt: row.expiresAt
});
// The image cooldown prevents repeated pixels, while distinct failed turns still need
// their own bounded incident records. Keep a small recent-error set in this same owner.
const debugCooldowns = new Map<string, { until: number; events: string[] }>();
let debugSlot = 0;
let debugWrites = 0;
export const BROWSER_DEBUG_IMAGE_SLOTS = 32;
export const BROWSER_DEBUG_IMAGE_BYTES = 128 * 1024;

export function offerBrowserDebugCapture(input: {
  sessionId: string; conversationId: string; turnId?: string; reason: string; errors: number;
  runningTools: number; automationPaused: boolean; screenEnabled: boolean;
}): { id: string; conversationId: string; expiresAt: number } | null {
  const now = Date.now();
  if (!mirror || !incidentFolder || !incidentProfileVerified ||
      incidentFolder.profileId !== incidentProfileId ||
      !/^[a-f0-9-]{8,64}$/i.test(input.conversationId) ||
      !/^[a-zA-Z0-9_-]{1,200}$/.test(input.sessionId)) return null;
  for (const [id, row] of debugOffers) if (row.expiresAt <= now || !debugOfferStillOwned(row))
    debugOffers.delete(id);
  const reason = ['stream_gone', 'watchdog_stalled', 'conversation_limit', 'thinking_failed', 'model_cooldown']
    .includes(input.reason) ? input.reason : 'native_error';
  const turnId = incidentIdentity(input.turnId);
  const cooldownKey = `${input.sessionId}:${input.conversationId}`;
  const eventKey = `${reason}:${turnId ?? ''}`;
  const cooldown = debugCooldowns.get(cooldownKey);
  const imageOnCooldown = !!cooldown && cooldown.until > now;
  if (imageOnCooldown) {
    if (cooldown.events.includes(eventKey)) return null;
    cooldown.events.push(eventKey);
    if (cooldown.events.length > LOCAL_INCIDENT_SLOTS) cooldown.events.shift();
  } else {
    debugCooldowns.delete(cooldownKey);
    debugCooldowns.set(cooldownKey, { until: now + 60_000, events: [eventKey] });
  }
  while (debugCooldowns.size > 128) debugCooldowns.delete(debugCooldowns.keys().next().value!);
  const capture = !input.screenEnabled ? 'screen_permission_disabled' :
    imageOnCooldown ? 'capture_cooldown' : debugOffers.size >= 32 ? 'capture_unavailable' : 'offered';
  logEvent('browser-debug', JSON.stringify({ sessionId: input.sessionId, conversationId: input.conversationId,
    turnId, reason, errors: Math.max(0, Math.min(100, input.errors | 0)),
    runningTools: Math.max(0, Math.min(100, input.runningTools | 0)),
    automationPaused: input.automationPaused === true,
    screenshot: capture }));
  void noteLocalIncident({ source: 'browser-debug', reason, sessionId: input.sessionId,
    conversationId: input.conversationId, turnId: turnId ?? undefined, capture,
    browserFacts: { errors: input.errors, runningTools: input.runningTools,
      automationPaused: input.automationPaused } });
  if (imageOnCooldown || !input.screenEnabled || debugOffers.size >= 32) return null;
  const id = randomUUID(), expiresAt = now + 30_000;
  debugOffers.set(id, { sessionId: input.sessionId, conversationId: input.conversationId,
    turnId, reason, expiresAt, owner: incidentFolder, state: mirror, profileEpoch: incidentProfileEpoch });
  return { id, conversationId: input.conversationId, expiresAt };
}

export function browserDebugCaptureOwner(id: string): { sessionId: string; conversationId: string } | null {
  const row = debugOffers.get(id);
  return row && debugOfferStillOwned(row) && row.expiresAt > Date.now()
    ? { sessionId: row.sessionId, conversationId: row.conversationId } : null;
}

export async function completeBrowserDebugCapture(id: string, image: unknown, status: unknown,
  allowed: () => boolean | Promise<boolean> = () => true): Promise<boolean> {
  const row = debugOffers.get(id);
  if (!row || !debugOfferStillOwned(row) || row.expiresAt <= Date.now() || !await allowed()) return false;
  if (debugOffers.get(id) !== row || !debugOfferStillOwned(row) || row.expiresAt <= Date.now()) return false;
  const state = row.state;
  debugOffers.delete(id); // One attempted capture only, no screenshot/delivery replay.
  const skipped = ['screenshots_disabled', 'hidden_tab', 'stale_document', 'capture_unavailable', 'capture_too_large'].includes(String(status))
    ? String(status) : 'capture_unavailable';
  if (status !== 'captured' || typeof image !== 'string' || image.length > 1_600_000 ||
      !/^data:image\/jpeg;base64,[A-Za-z0-9+/=]+$/.test(image) || debugWrites >= 2) {
    logEvent('browser-debug', JSON.stringify({ ...debugOfferLogShape(row), screenshot: skipped }));
    void noteLocalIncident({ source: 'browser-debug', reason: row.reason, sessionId: row.sessionId,
      conversationId: row.conversationId, turnId: row.turnId ?? undefined, capture: incidentCapture(skipped) });
    return true;
  }
  debugWrites += 1;
  let temp: string | null = null;
  let ownsTemp = false;
  try {
    const sharp = (await import('sharp')).default;
    const bytes = Buffer.from(image.slice('data:image/jpeg;base64,'.length), 'base64');
    const decoder = sharp(bytes, { limitInputPixels: 16_000_000 });
    if ((await decoder.metadata()).format !== 'jpeg') throw new Error('invalid_format');
    const thumbnail = await decoder.resize({ width: 1024, height: 768, fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 40 }).toBuffer();
    if (thumbnail.length > BROWSER_DEBUG_IMAGE_BYTES) throw new Error('image_byte_limit');
    if (!debugOfferStillOwned(row) || !await allowed() || !debugOfferStillOwned(row) ||
        row.expiresAt <= Date.now()) return false;
    const directory = path.join(path.dirname(state.file), 'browser-debug');
    await fs.mkdir(directory, { recursive: true });
    const directoryStat = await fs.lstat(directory);
    if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) throw new Error('unsafe_directory');
    const base = path.join(directory, `viewport-${debugSlot++ % BROWSER_DEBUG_IMAGE_SLOTS}`);
    const file = `${base}.jpg`, metadataFile = `${base}.json`;
    for (const target of [file, metadataFile]) {
      const previous = await fs.lstat(target).catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return null;
        throw error;
      });
      if (previous && (!previous.isFile() || previous.isSymbolicLink())) throw new Error('unsafe_target');
    }
    // Fixed scratch names keep crash leftovers bounded too. An occupied scratch file
    // refuses this slot rather than deleting unknown work or creating another UUID file.
    temp = `${base}.jpg.tmp`;
    await fs.writeFile(temp, thumbnail, { flag: 'wx' });
    ownsTemp = true;
    if (!debugOfferStillOwned(row) || !await allowed() || !debugOfferStillOwned(row) ||
        row.expiresAt <= Date.now()) return false;
    await fs.rename(temp, file);
    temp = null;
    if (!debugOfferStillOwned(row)) return false;
    // A crash can leave the prior sidecar beside new pixels; readers must match the hash,
    // never use a reused ring filename as capture identity or a completion receipt.
    temp = `${base}.json.tmp`;
    ownsTemp = false;
    await fs.writeFile(temp, JSON.stringify({ version: 1, captureId: id, profileId: row.owner.profileId,
      sessionId: row.sessionId, conversationId: row.conversationId, turnId: row.turnId, storedAt: Date.now(),
      imageFile: path.basename(file), bytes: thumbnail.length,
      sha256: createHash('sha256').update(thumbnail).digest('hex'),
      privacy: 'Local visible ChatGPT pixels; may contain private text. Diagnostic only.' }), { flag: 'wx' });
    ownsTemp = true;
    if (!debugOfferStillOwned(row)) return false;
    await fs.rename(temp, metadataFile);
    temp = null;
    if (!debugOfferStillOwned(row)) return false;
    logEvent('browser-debug', JSON.stringify({ ...debugOfferLogShape(row), screenshot: 'saved', file, metadataFile, bytes: thumbnail.length,
      privacy: 'Local visible ChatGPT pixels; may contain private text. Not an execution or completion receipt.' }));
    void noteLocalIncident({ source: 'browser-debug', reason: row.reason,
      sessionId: row.sessionId, conversationId: row.conversationId, turnId: row.turnId ?? undefined, capture: 'saved',
      screenshot: { metadataFile: path.basename(metadataFile), bytes: thumbnail.length,
        sha256: createHash('sha256').update(thumbnail).digest('hex') } });
    return true;
  } catch (error) {
    if (!debugOfferStillOwned(row)) return false;
    const code = error instanceof Error ? error.message : '';
    const reason = ['invalid_format', 'image_byte_limit', 'unsafe_directory', 'unsafe_target'].includes(code)
      ? code : ['ENOSPC', 'EACCES', 'EPERM', 'EIO'].includes((error as NodeJS.ErrnoException)?.code ?? '')
        ? (error as NodeJS.ErrnoException).code : 'image_decode_or_io_failure';
    logEvent('browser-debug', JSON.stringify({ ...debugOfferLogShape(row), screenshot: 'capture_storage_failed', reason }));
    void noteLocalIncident({ source: 'browser-debug', reason: row.reason,
      sessionId: row.sessionId, conversationId: row.conversationId, turnId: row.turnId ?? undefined,
      capture: 'capture_storage_failed' });
    return true; // Diagnostic IO failure cannot fail the original chat observation.
  } finally {
    if (temp && ownsTemp) await fs.unlink(temp).catch(() => undefined);
    debugWrites -= 1;
  }
}

/**
 * Mirrors every line from here on to `file`, rotating it once to `file.1` when it fills.
 *
 * Normal writes are ordered asynchronous batches. Teardown explicitly flushes; fatal
 * failure uses a separate bounded synchronous snapshot, never racing the live file writer.
 */
export function initLogFile(file: string, folder = path.join(path.dirname(file), 'local-incidents')): void {
  // Isolated instance profiles intentionally place the log below a fresh namespaced tree.
  // The logger is still the sole file owner, so it creates its own parent rather than making
  // startup duplicate knowledge of the path layout. A failure is synchronous and fail-closed:
  // do not report a usable profile while its canonical diagnostics path cannot be established.
  mkdirSync(path.dirname(file), { recursive: true });
  let bytes = 0;
  try {
    bytes = statSync(file).size;
  } catch { /* A first run has no log yet. */ }
  if (mirror?.retry) clearTimeout(mirror.retry);
  mirror = { file, bytes, pending: [], pendingBytes: 0, dropped: 0, work: null, error: null, failures: 0, retry: null, cutWrites: 0, rotationNoted: false };
  incidentFolder = { folder, profileId: incidentProfileId, rows: null, queue: Promise.resolve(), pending: 0, dropped: 0, storageError: null,
    tempsReconciled: false, unverifiedSlots: new Set(), archive: null };
  // The existing synchronous fatal snapshot survives a power loss. Import only
  // its hash on next startup; private stack/body text stays in its original
  // bounded .crash file and cannot become a new prompt or diagnostic instruction.
  try {
    const crash = `${file}.crash`, info = statSync(crash);
    if (info.isFile() && info.size > 0 && info.size <= MAX_PENDING_BYTES) {
      const fingerprint = createHash('sha256').update(readFileSync(crash)).digest('hex');
      void noteLocalIncident({ source: 'app', reason: 'previous_crash', fingerprint });
    }
  } catch { /* No previous crash or startup IO evidence; no false incident. */ }
}

function boundedText(text: string): string {
  const prefix = text.slice(0, MAX_LINE_BYTES);
  if (prefix.length === text.length && Buffer.byteLength(prefix, 'utf8') <= MAX_LINE_BYTES) return text;
  return Buffer.from(prefix, 'utf8').subarray(0, MAX_LINE_BYTES - 64).toString('utf8') + ' [log text truncated]';
}

function formatEntry(entry: LogEntry): string {
  const owner = entry.profileId ? `[profile:${entry.profileId}] ` : '';
  const event = entry.event ? `[${entry.event}] ` : '';
  return `${new Date(entry.time).toISOString()}  ${entry.level.padEnd(5)}  ${owner}${event}${entry.agent ? `[${entry.agent}] ` : ''}${entry.message}\n`;
}

async function fileSize(file: string): Promise<number | null> {
  try { return (await fs.stat(file)).size; } catch { return null; }
}

/** The notes at the head of a batch reached the file: what they report is said. */
function wroteNotes(state: FileMirror, notes: boolean, lines: boolean, rotationNote: boolean): void {
  if (notes) { state.cutWrites = 0; if (!lines) state.dropped = 0; }
  if (rotationNote) state.rotationNoted = true;
}

/** Puts a batch that never reached the file back at the front, in order (#1682). */
function requeue(state: FileMirror, lines: string[], bytes: number): void {
  state.pending.unshift(...lines);
  state.pendingBytes += bytes;
}

/**
 * Writes queued lines in order. A failed write never loses or repeats a line and never stops the
 * log for good (#1682): what did not reach the file goes back to the front of the queue (a line an
 * append cut off is written again in full, after a note saying so), and the writer tries again
 * with a growing delay. A log that cannot rotate (Windows: another program holds it, or something
 * sits where the old log goes) keeps growing to twice its size; past that, lines wait for rotation.
 */
function startWriter(state: FileMirror): void {
  if (state.work || state.retry || (!state.pending.length && !state.dropped && !state.cutWrites)) return;
  state.work = Promise.resolve().then(async () => {
    while (state.pending.length || state.dropped || state.cutWrites) {
      const lines: string[] = [];
      let bytes = 0;
      while (state.pending.length) {
        const line = state.pending[0]!;
        const size = Buffer.byteLength(line, 'utf8');
        if (bytes && bytes + size > MAX_BATCH_BYTES) break;
        state.pending.shift();
        state.pendingBytes -= size;
        lines.push(line);
        bytes += size;
      }
      const notes: string[] = [];
      if (state.cutWrites) notes.push(`\n${new Date().toISOString()}  warn   ${state.cutWrites} log write(s) failed part-way: the cut-off line above follows again in full.\n`);
      if (!lines.length && state.dropped) notes.push(`${new Date().toISOString()}  warn   ${state.dropped} log line(s) omitted: file writer backlog exceeded its byte limit.\n`);
      let text = notes.join('') + lines.join('');
      let size = Buffer.byteLength(text, 'utf8');
      let rotationNote = false;
      try {
        if (state.bytes && state.bytes + size > MAX_LOG_FILE_BYTES) {
          try {
            await fs.rename(state.file, `${state.file}.1`);
            state.bytes = 0;
            state.rotationNoted = false;
          } catch (error) {
            // The old log stays where it is: write on into it for now, or wait once it is far too big.
            if (state.bytes + size > MAX_UNROTATED_BYTES) throw error;
            if (!state.rotationNoted) {
              text = `${new Date().toISOString()}  warn   log rotation failed (${boundedText(redact(String(error))).slice(0, 300)}); writing on into this file.\n${text}`;
              size = Buffer.byteLength(text, 'utf8');
              rotationNote = true;
            }
          }
        }
        const before = state.bytes;
        try {
          await fs.appendFile(state.file, text, 'utf8');
        } catch (error) {
          // A rejected append may still have written some or all of the batch. Measure, never guess.
          const now = await fileSize(state.file);
          const written = now === null ? 0 : Math.max(0, now - before);
          if (written >= size) { state.bytes = now!; }
          else {
            if (written > 0) {
              state.bytes = now!;
              const prefix = size - bytes;
              if (written >= prefix) wroteNotes(state, notes.length > 0, lines.length > 0, rotationNote);
              // Whole lines in the file are done; the cut one and the rest go back to the queue.
              let offset = prefix;
              while (lines.length && offset + Buffer.byteLength(lines[0]!, 'utf8') <= written) {
                const done = Buffer.byteLength(lines.shift()!, 'utf8');
                offset += done;
                bytes -= done;
              }
              state.cutWrites += 1;
            }
            throw error;
          }
        }
        wroteNotes(state, notes.length > 0, lines.length > 0, rotationNote);
        if (state.bytes === before) state.bytes += size;
        state.error = null;
        state.failures = 0;
      } catch (error) {
        requeue(state, lines, bytes);
        state.error = error;
        state.failures += 1;
        // One synchronous snapshot per failure streak; the retries after it stay quiet.
        if (state.failures === 1) writeCrashSnapshot(state, `log file writer failed: ${String(error)}`);
        const delay = Math.min(RETRY_MAX_MS, RETRY_FIRST_MS * 2 ** (state.failures - 1));
        state.retry = setTimeout(() => { state.retry = null; startWriter(state); }, delay);
        state.retry.unref?.();
        return;
      }
    }
  }).finally(() => {
    state.work = null;
    startWriter(state);
  });
}

function mirrorToFile(entry: LogEntry): void {
  const state = mirror;
  if (!state) return;
  const line = formatEntry(entry);
  const bytes = Buffer.byteLength(line, 'utf8');
  if (state.pendingBytes + bytes > MAX_PENDING_BYTES) {
    state.dropped = Math.min(Number.MAX_SAFE_INTEGER, state.dropped + 1);
  } else {
    state.pending.push(line);
    state.pendingBytes += bytes;
  }
  startWriter(state);
}

/** Includes lines accepted while an earlier batch was being written. */
export async function flushLogFile(): Promise<void> {
  const state = mirror;
  if (!state) return;
  // A waiting retry is tried now: a flush wants the lines on disk, not after the backoff.
  if (state.retry) { clearTimeout(state.retry); state.retry = null; }
  startWriter(state);
  while (state.work) await state.work;
  if (state.error && (state.pending.length || state.cutWrites)) throw state.error;
}

function writeCrashSnapshot(state: FileMirror, reason: string): void {
  const lines = [formatEntry({ time: Date.now(), level: 'error', message: boundedText(redact(reason)) })];
  let bytes = Buffer.byteLength(lines[0]!, 'utf8');
  for (let i = entries.length - 1; i >= 0; i--) {
    const line = formatEntry(entries[i]!);
    const size = Buffer.byteLength(line, 'utf8');
    if (bytes + size > MAX_PENDING_BYTES) break;
    lines.splice(1, 0, line);
    bytes += size;
  }
  try {
    writeFileSync(`${state.file}.crash`, lines.join(''), 'utf8');
  } catch { /* The reporting channel cannot report its own storage failure. */ }
}

/** Fatal diagnostics only; does not install an exception handler or suppress a crash. */
export function snapshotLogOnCrash(reason: string): void {
  if (mirror) writeCrashSnapshot(mirror, reason);
}

/** Final exit barrier, including the shutdown sequence's last line. */
export async function flushLogBeforeExit(timeoutMs = 2_000): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      Promise.all([flushLogFile(), flushLocalIncidents()]),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('log flush deadline exceeded')), timeoutMs);
        timer.unref?.();
      })
    ]);
  } catch (error) {
    snapshotLogOnCrash(`final log flush failed: ${String(error)}`);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Test seam; callers must finish outstanding file writes first. */
export function resetLoggerForTests(): void {
  if (mirror?.retry) clearTimeout(mirror.retry);
  debugOffers.clear(); debugCooldowns.clear(); debugSlot = 0; debugWrites = 0;
  mirror = null;
  incidentFolder = null;
  profileId = null;
  incidentProfileId = null;
  incidentProfileVerified = true;
  incidentProfileEpoch = 0;
  entries.length = 0;
  listeners.clear();
}

/** Masks anything shaped like a credential, wherever it appears in a message. */
export function redact(message: string): string {
  return message
    .replace(/\bsk-[A-Za-z0-9_-]{8,}/g, 'sk-***')
    .replace(/\b(ey[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,})/g, '***jwt***')
    .replace(/\b[A-Za-z0-9_-]{40,}\b/g, (match) =>
      // Long opaque strings are tokens far more often than they are prose.
      /^[A-Za-z0-9_-]+$/.test(match) ? '***' : match
    )
    .replace(/([?&](?:token|access_token|api[_-]?key|key|secret|code)=)[^&\s]+/gi, '$1***')
    .replace(/\b(authorization:\s*)(?:bearer\s+)?\S+/gi, '$1***');
}

/** Binds all following entries to the process-lifetime instance owner. */
export function setLogProfileContext(id: string | null): void {
  const value = id?.trim() ?? '';
  const redacted = redact(value);
  const identity = incidentIdentity(value);
  // Native account ids are identifiers, not opaque credentials. No other
  // redaction-ambiguous input can become an unredacted structured secret or
  // silently borrow the unscoped/null owner. Legacy short ids remain valid.
  const nativeProfile = /^profile-[a-f\d]{8}-(?:[a-f\d]{4}-){3}[a-f\d]{12}$/i.test(value);
  const verified = !value || (identity !== null && (nativeProfile || redacted === value));
  const nextId = verified ? identity : null;
  if (incidentProfileId !== nextId || incidentProfileVerified !== verified) incidentProfileEpoch++;
  incidentProfileVerified = verified;
  incidentProfileId = nextId;
  profileId = value ? boundedText(redacted).slice(0, 160) : null;
}

/**
 * Opt-in console echo for troubleshooting a start-up that never reaches the UI.
 * Off unless CLF_DEBUG=1, so logs are not exposed by default, and it prints the
 * redacted text so enabling it can never surface a credential.
 */
const ECHO_TO_CONSOLE = process.env['CLF_DEBUG'] === '1';

export function log(level: LogEntry['level'], message: string, event?: string): void {
  const agent = currentAgent();
  const entry: LogEntry = {
    time: Date.now(),
    level,
    message: boundedText(redact(message)),
    ...(profileId ? { profileId } : {}),
    ...(event ? { event: boundedText(redact(event)).slice(0, 80) } : {}),
    ...(agent ? { agent: boundedText(redact(agent)).slice(0, 200) } : {})
  };
  entries.push(entry);
  if (entries.length > MAX_ENTRIES) entries.shift();
  mirrorToFile(entry);
  // The existing logger is the first reader of real errors. No extra interval or
  // page polling is required, and the private message text is never copied into
  // the incident file. Browser-debug has exact structured custody above.
  if (mirror && (level === 'error' || (level === 'warn' &&
      /\b(crash|stalled|interrupted|sign.?out|sign[\s_-]+in|login[\s_-]+required|authentication|quota|provider.*fail|helper.*fail|worker.*fail|model.*fail|send.*refus|pairing.*fail|schema[\s_-]+mismatch|plugin.*refresh.*fail|handoff.*fail|connection.*lost)\b/i.test(entry.message)))) {
    const kind = /helper/i.test(entry.message) ? 'helper' : /worker/i.test(entry.message) ? 'worker' :
      /model|quota/i.test(entry.message) ? 'model' :
        /pairing|connector|schema[\s_-]+mismatch|plugin.*refresh/i.test(entry.message) ? 'pairing' :
        /handoff/i.test(entry.message) ? 'handoff' : /send/i.test(entry.message) ? 'send' : 'app';
    const schemaMismatch = /\bplugin refresh schema mismatch\b/i.test(entry.message);
    const reason = schemaMismatch ? 'plugin_refresh_schema_mismatch' :
      (entry.event && /^[a-z\d_.:-]{1,80}$/i.test(entry.event)) ? entry.event.toLowerCase() :
      `${level === 'error' ? 'app_error' : 'app_warning'}:${createHash('sha256').update(entry.message).digest('hex').slice(0, 12)}`;
    // AsyncLocalStorage carries the current tool's proved native request/session, or
    // null outside a tool. Never assign an unidentified HTTP ingress call to a chat.
    const caller = currentCaller();
    void noteLocalIncident({ source: kind, reason, status: 'unresolved', detail: entry.message,
      ...(schemaMismatch ? { fingerprint: createHash('sha256').update(entry.message).digest('hex') } : {}),
      ...(caller.requestId ? { requestId: caller.requestId } : {}),
      ...(caller.conversationId ? { conversationId: caller.conversationId } : {}),
      ...(caller.sessionId ? { sessionId: caller.sessionId } : {}) });
  }
  if (ECHO_TO_CONSOLE) process.stderr.write(`[${level}] ${entry.message}\n`);
  for (const listener of listeners) {
    try {
      listener(entry);
    } catch {
      // Writing a log line must never be able to break the code that wrote it. Listeners run
      // synchronously on the caller's stack, and the one that matters here reaches the
      // renderer — which can already be gone while teardown is still logging its own progress.
      // A throw from there used to propagate into the shutdown step doing the logging and kill
      // it outright; that is how a force-close timer stopped forcing anything and left the app
      // draining a half-closed socket forever. There is nowhere useful to report this: the log
      // is the reporting channel.
    }
  }
}

export const logInfo = (message: string): void => log('info', message);
export const logWarn = (message: string): void => log('warn', message);
export const logError = (message: string): void => log('error', message);
export const logEvent = (event: string, message: string, level: LogEntry['level'] = 'info'): void => log(level, message, event);

export function getLog(): LogEntry[] {
  return [...entries];
}

export function onLog(listener: (entry: LogEntry) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function formatLogForClipboard(): string {
  return entries
    .map((e) => `${new Date(e.time).toISOString()}  ${e.level.padEnd(5)}  ${e.message}`)
    .join('\n');
}

/** Machine-readable diagnostics export. Messages are already redacted on insertion. */
export function formatLogAsJson(): string {
  return JSON.stringify(
    entries.map((e) => ({
      time: new Date(e.time).toISOString(),
      level: e.level,
      profileId: e.profileId,
      event: e.event,
      agent: e.agent,
      message: e.message
    })),
    null,
    2
  );
}
