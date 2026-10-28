/** Unsent composer state, scoped to the incumbent account/durable root. Never a sender. */
import { getActiveInstanceRuntime } from './config.js';
import { durableStoreReady, readDurableStrict, writeDurableNow } from './durable.js';
import { validateInputAttachments } from './session/input-attachments.js';
import { logInfo, logWarn } from './logger.js';
import type { InputAttachment } from '../shared/input.js';
import { assertComposerDraftSize, composerDraftSaveSchema, composerDraftSnapshotSchema, composerFilesIdentity,
  MAX_COMPOSER_DRAFT_BYTES, type ComposerDraftLoadResult, type ComposerDraftSave, type ComposerDraftSaveResult,
  type ComposerDraftSnapshot } from '../shared/composer-drafts.js';

type Admission = { id: string; text: string; sessionId?: string | null; projectId?: string | null;
  images?: Array<{ name: string; dataUrl: string }>; attachments?: InputAttachment[] };
interface DraftStoreDependencies {
  profileId(): string;
  read(): Promise<unknown>;
  write(snapshot: ComposerDraftSnapshot): Promise<void>;
  inputs(): Promise<readonly Admission[]>;
  validateAttachments(files: InputAttachment[]): Promise<void>;
}

/** CAS and generation checks fence late renderer saves, reloads and concurrent windows. */
export function createComposerDraftStore(deps: DraftStoreDependencies) {
  let queue: Promise<unknown> = Promise.resolve();
  function serial<T>(operation: () => Promise<T>): Promise<T> {
    const next = queue.then(operation);
    queue = next.catch(() => undefined);
    return next;
  }
  async function read(): Promise<ComposerDraftSnapshot> {
    const active = deps.profileId();
    const value = await deps.read();
    if (active !== deps.profileId()) throw new Error('Draft account changed during restore; no drafts were replaced.');
    if (value === null) return { version: 1, profileId: active, revision: 0, selection: null, entries: [] };
    assertComposerDraftSize(value);
    const parsed = composerDraftSnapshotSchema.safeParse(value);
    if (!parsed.success || parsed.data.profileId !== active) {
      logWarn('composer drafts restore refused: invalid state or account mismatch');
      throw new Error('Saved drafts could not be restored for this account. Existing draft data was preserved.');
    }
    return parsed.data;
  }
  async function load(): Promise<ComposerDraftLoadResult> {
    return serial(async () => {
      let snapshot = await read();
      const warnings: ComposerDraftLoadResult['warnings'] = [];
      const reconciled: ComposerDraftLoadResult['reconciled'] = [];
      // Read the existing durable ledger as evidence only; do not call listInputs(), whose
      // projection can materialize stages or retire rows. A missing receipt never grants replay.
      const inputs = snapshot.entries.some(entry => entry.pending) ? await deps.inputs() : [];
      if (!Array.isArray(inputs) || inputs.some(row => !row || typeof row.id !== 'string' || typeof row.text !== 'string') ||
          new Set(inputs.map(row => row.id)).size !== inputs.length)
        throw new Error('Input receipts could not be reconciled. Saved drafts were preserved.');
      const retained = [];
      for (const entry of snapshot.entries) {
        const pending = entry.pending;
        const admitted = pending && inputs.find(row => row.id === pending.inputId);
        if (admitted && admitted.text === pending!.text.trim() &&
            (admitted.sessionId ?? null) === pending!.sessionId && (admitted.projectId ?? null) === pending!.projectId &&
            composerFilesIdentity([...(admitted.images ?? []), ...(admitted.attachments ?? [])]) === composerFilesIdentity(pending!.files)) {
          reconciled.push({ inputId: pending!.inputId, generation: pending!.generation });
          if (entry.generation !== pending!.generation && (entry.text || entry.files.length)) {
            const { pending: _pending, ...unsent } = entry;
            const files = unsent.files.filter((file): file is InputAttachment => 'id' in file);
            try { if (files.length) await deps.validateAttachments(files); }
            catch { warnings.push({ key: entry.key, reason: 'attachment_unavailable' }); }
            retained.push(unsent);
          }
          continue;
        }
        if (pending) warnings.push({ key: entry.key, reason: 'admission_unresolved' });
        const files = entry.files.filter((file): file is InputAttachment => 'id' in file);
        try { if (files.length) await deps.validateAttachments(files); }
        catch { warnings.push({ key: entry.key, reason: 'attachment_unavailable' }); }
        retained.push(entry);
      }
      if (JSON.stringify(retained) !== JSON.stringify(snapshot.entries)) {
        if (snapshot.revision >= Number.MAX_SAFE_INTEGER || snapshot.profileId !== deps.profileId())
          throw new Error('Draft account or revision changed during reconciliation; saved drafts were preserved.');
        snapshot = { ...snapshot, revision: snapshot.revision + 1, entries: retained };
        await deps.write(snapshot);
      }
      logInfo(`composer drafts restored entries=${snapshot.entries.length} warnings=${warnings.length}`);
      return { snapshot, warnings, reconciled };
    });
  }
  async function save(value: ComposerDraftSave): Promise<ComposerDraftSaveResult> {
    return serial(async () => {
      assertComposerDraftSize(value);
      const parsed = composerDraftSaveSchema.safeParse(value);
      if (!parsed.success) throw new Error('Draft could not be saved: unsupported content or draft limits exceeded. Your current text was retained.');
      const request = parsed.data, current = await read();
      if (request.profileId !== current.profileId) throw new Error('Draft account changed; no saved drafts were replaced.');
      if (request.expectedRevision !== current.revision) return { saved: false, snapshot: current };
      if (current.revision >= Number.MAX_SAFE_INTEGER) throw new Error('Saved draft revision limit reached; existing drafts were preserved.');
      // Shape-valid IDs alone do not establish account membership. The existing
      // staging owner validates metadata and the original file under its prune lock.
      // An unchanged server-owned reference may already be unavailable at restore.
      // Retaining that exact same-key evidence must not block unrelated text drafts.
      const previous = new Map(current.entries.map(entry => [entry.key, entry]));
      try {
        for (const entry of request.snapshot.entries) {
          const incumbent = previous.get(entry.key);
          const files = entry.files.filter((file): file is InputAttachment => 'id' in file)
            .filter(file => !incumbent?.files.some(old => 'id' in old && composerFilesIdentity([old]) === composerFilesIdentity([file])));
          if (files.length) await deps.validateAttachments(files);
          const pendingFiles = entry.pending?.files.filter((file): file is InputAttachment => 'id' in file) ?? [];
          if (pendingFiles.length && JSON.stringify(entry.pending) !== JSON.stringify(incumbent?.pending)) await deps.validateAttachments(pendingFiles);
        }
      } catch {
        logWarn('composer drafts save refused: staged attachment validation failed');
        throw new Error('A saved attachment is missing or changed. Reattach it before saving; your current draft was retained.');
      }
      const next: ComposerDraftSnapshot = { version: 1, profileId: current.profileId,
        revision: current.revision + 1, ...request.snapshot };
      assertComposerDraftSize(next);
      if (next.profileId !== deps.profileId()) throw new Error('Draft account changed during save; no drafts were replaced.');
      await deps.write(next);
      return { saved: true, snapshot: next };
    });
  }
  async function retainedAttachments(): Promise<Set<string>> {
    return serial(async () => new Set((await read()).entries.flatMap(entry => [...entry.files, ...(entry.pending?.files ?? [])]
      .filter((file): file is InputAttachment => 'id' in file).map(file => file.id))));
  }
  return { load, save, retainedAttachments };
}

const store = createComposerDraftStore({
  profileId: () => {
    if (!durableStoreReady()) throw new Error('Draft storage is not ready. Your current draft was retained.');
    return getActiveInstanceRuntime().profile.id;
  },
  read: () => readDurableStrict('composer-drafts', MAX_COMPOSER_DRAFT_BYTES),
  write: value => writeDurableNow('composer-drafts', value),
  inputs: async () => (await readDurableStrict<Admission[]>('session-input')) ?? [],
  validateAttachments: validateInputAttachments
});
export const loadComposerDrafts = store.load;
export const saveComposerDrafts = store.save;
export const retainedComposerAttachmentIds = store.retainedAttachments;
