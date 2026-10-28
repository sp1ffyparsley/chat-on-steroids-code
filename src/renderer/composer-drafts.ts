import type { InputAttachment, InputImage } from '../shared/input.js';
import { composerFilesIdentity, type ComposerDraftEntry, type ComposerDraftLoadResult, type ComposerDraftSave,
  type ComposerDraftSaveResult, type ComposerDraftSelection, type ComposerDraftSnapshot } from '../shared/composer-drafts.js';

interface DraftStorage {
  load(): Promise<ComposerDraftLoadResult>;
  save(request: ComposerDraftSave): Promise<ComposerDraftSaveResult>;
  status(message: string): void;
}

/** Owns unsent state only. A reload restores content; it never sends or claims work.
 * Dirty-key merging and CAS preserve typing across late load/save responses. Main
 * reconciles pending admission IDs against its existing durable Input ledger.
 */
export function createComposerDrafts(storage: DraftStorage) {
  let profileId: string | null = null, revision = 0, loaded = false;
  let changes = 0;
  let selection: ComposerDraftSelection | null = null, selectionVersion = 0, savedSelectionVersion = 0;
  let entries = new Map<string, ComposerDraftEntry>();
  let base = new Map<string, ComposerDraftEntry>();
  const dirty = new Map<string, ComposerDraftEntry | null>();
  const resolvedPending = new Set<string>();
  const conflicts = new Set<string>();
  const warnings = new Map<string, string>();
  let timer: ReturnType<typeof setTimeout> | undefined, work: Promise<boolean> | undefined;
  function merge(snapshot: ComposerDraftSnapshot): void {
    revision = snapshot.revision;
    base = new Map(snapshot.entries.map(entry => [entry.key, entry]));
    entries = new Map(snapshot.entries.map(entry => [entry.key, entry]));
    for (const [key, local] of dirty) {
      let entry = local;
      const remotePending = base.get(key)?.pending;
      // Typing/clearing before the first read must not discard unknown custody
      // discovered by that read. Only exact local/Main evidence can release it.
      if (remotePending && !resolvedPending.has(remotePending.inputId) && !entry?.pending) {
        entry = { ...(entry ?? { key, text: '', files: [], generation: crypto.randomUUID(), updatedAt: Date.now() }), pending: remotePending };
        dirty.set(key, entry);
      }
      if (entry) entries.set(key, entry); else entries.delete(key);
    }
    if (selectionVersion === savedSelectionVersion) selection = snapshot.selection;
  }
  function schedule(): void {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => { timer = undefined; void flush(); }, 250);
  }
  function record(key: string, text: string, files: Array<InputImage | InputAttachment>): ComposerDraftEntry | undefined {
    const previous = entries.get(key);
    if (previous?.text === text && composerFilesIdentity(previous.files) === composerFilesIdentity(files)) return previous;
    if (!text && !files.length) { remove(key); return undefined; }
    changes++;
    const entry: ComposerDraftEntry = { key, text, files: files.map(file => 'dataUrl' in file ? { name: file.name, dataUrl: file.dataUrl } :
      { id: file.id, name: file.name, size: file.size, mimeType: file.mimeType, ...(file.preview ? { preview: file.preview } : {}) }),
      generation: crypto.randomUUID(), updatedAt: Date.now(),
      ...(previous?.pending ? { pending: previous.pending } : {}) };
    entries.set(key, entry); dirty.set(key, entry); warnings.delete(key); schedule(); return entry;
  }
  function remove(key: string): void {
    const entry = entries.get(key);
    if (entry?.pending) {
      changes++;
      const cleared = { ...entry, text: '', files: [], generation: crypto.randomUUID(), updatedAt: Date.now() };
      entries.set(key, cleared); dirty.set(key, cleared); schedule(); return;
    }
    discard(key);
  }
  function discard(key: string): void {
    if (!entries.has(key) && !dirty.has(key)) return;
    changes++;
    entries.delete(key); dirty.set(key, null); warnings.delete(key); schedule();
  }
  async function load(expectedProfileId: string): Promise<ComposerDraftLoadResult | null> {
    if (loaded) return { snapshot: snapshot(), warnings: [], reconciled: [] };
    try {
      const result = await storage.load();
      if (result.snapshot.profileId !== expectedProfileId) throw new Error('Draft account changed during restore.');
      profileId = expectedProfileId; merge(result.snapshot); loaded = true;
      for (const warning of result.warnings) if (!dirty.has(warning.key)) warnings.set(warning.key,
        warning.reason === 'attachment_unavailable' ? 'A saved attachment is unavailable. Reattach it before sending; the saved text was retained.' :
          'Delivery of this saved draft needs reconciliation. Check Work before editing and sending again.');
      if (dirty.size || selectionVersion !== savedSelectionVersion) schedule();
      storage.status('');
      return { snapshot: snapshot(), warnings: result.warnings, reconciled: result.reconciled ?? [] };
    } catch { storage.status('Draft recovery is unavailable. Your current text is retained in this window; saved drafts were not replaced.'); return null; }
  }
  function snapshot(): ComposerDraftSnapshot {
    return { version: 1, profileId: profileId ?? '', revision, selection, entries: [...entries.values()] };
  }
  async function flush(): Promise<boolean> {
    if (timer) { clearTimeout(timer); timer = undefined; }
    if (work) { const prior = await work; return prior && (dirty.size || selectionVersion !== savedSelectionVersion ? flush() : true); }
    if (!loaded || !profileId) return false;
    if (conflicts.size) { storage.status('This draft also changed in another window. Your current text is retained here; the saved copy was preserved.'); return false; }
    const run = async (): Promise<boolean> => {
      try {
        for (let attempt = 0; attempt < 4; attempt++) {
          if (!dirty.size && selectionVersion === savedSelectionVersion) return true;
          const captured = new Map(dirty), selectedVersion = selectionVersion;
          const response = await storage.save({ profileId: profileId!, expectedRevision: revision,
            snapshot: { entries: [...entries.values()], selection } });
          if (response.snapshot.profileId !== profileId) throw new Error('Draft account changed during save');
          if (!response.saved) {
            const remote = new Map(response.snapshot.entries.map(entry => [entry.key, entry]));
            for (const key of captured.keys()) if (JSON.stringify(remote.get(key)) !== JSON.stringify(base.get(key))) conflicts.add(key);
            if (conflicts.size) throw new Error('This draft changed in another window; current typing and saved copy were retained');
          }
          if (response.saved) {
            for (const [key, entry] of captured) if (dirty.get(key) === entry) dirty.delete(key);
            savedSelectionVersion = selectedVersion;
          }
          merge(response.snapshot);
          if (response.saved && !dirty.size && selectionVersion === savedSelectionVersion) { storage.status(''); return true; }
        }
        throw new Error('Draft changed in another window');
      } catch { storage.status('Draft could not be saved. Your current text is retained in this window; check storage and retry.'); return false; }
    };
    work = run();
    try { return await work; } finally { work = undefined; }
  }
  function select(value: ComposerDraftSelection): void {
    if (selection?.sessionId === value.sessionId && selection.projectId === value.projectId) return;
    selection = value; selectionVersion++; schedule();
  }
  async function beginAdmission(key: string, generation: string, pending: Omit<NonNullable<ComposerDraftEntry['pending']>, 'generation' | 'files'>): Promise<boolean> {
    const entry = entries.get(key);
    if (!entry || entry.generation !== generation || entry.pending) return false;
    const next = { ...entry, pending: { ...pending, generation, files: entry.files.map(file => ({ ...file })) } }; entries.set(key, next); dirty.set(key, next);
    if (!await flush()) {
      // No send was attempted. Let a later explicit send retry storage without
      // inventing uncertainty about an operation that never crossed IPC.
      const current = entries.get(key);
      if (current?.pending?.inputId === pending.inputId) abandon(key, generation, pending.inputId);
      return false;
    }
    const unchanged = entries.get(key)?.generation === generation && entries.get(key)?.pending?.inputId === pending.inputId;
    if (!unchanged) abandon(key, generation, pending.inputId);
    return unchanged;
  }
  /** Only the caller before invoking sendInput can prove this ID was never attempted. */
  function abandon(key: string, generation: string, inputId: string): void {
    const current = entries.get(key);
    if (current?.pending?.generation !== generation || current.pending.inputId !== inputId) return;
    resolvePending(inputId);
    const { pending: _pending, ...unsent } = current;
    entries.set(key, unsent); dirty.set(key, unsent); schedule();
  }
  function canMove(from: string, to: string): boolean {
    return from === to || !entries.has(to);
  }
  function move(from: string, to: string): boolean {
    const entry = entries.get(from);
    if (!canMove(from, to)) { storage.status('Both saved drafts were retained because the destination already has a draft.'); return false; }
    if (!entry || from === to) return true;
    const next = { ...entry, key: to };
    changes++;
    entries.set(to, next); dirty.set(to, next); discard(from); schedule();
    return true;
  }
  function accepted(key: string, generation: string, inputId: string): string | undefined {
    // New-chat binding may move this exact generation before the IPC ACK arrives.
    const entry = [entries.get(key), ...entries.values()].find(value => value?.pending?.generation === generation && value.pending.inputId === inputId);
    if (!entry) return undefined;
    resolvePending(inputId);
    if (entry.generation === generation || (!entry.text && !entry.files.length)) { discard(entry.key); return entry.key; }
    const { pending: _pending, ...unsent } = entry;
    entries.set(entry.key, unsent); dirty.set(entry.key, unsent); warnings.delete(entry.key); schedule();
    return undefined;
  }
  async function reconcile(): Promise<boolean> {
    if (!profileId) return false;
    await flush();
    try {
      const result = await storage.load();
      if (result.snapshot.profileId !== profileId) throw new Error('Draft account changed');
      for (const receipt of result.reconciled ?? []) resolvePending(receipt.inputId);
      for (const [key, local] of dirty) if (local?.pending && (result.reconciled ?? []).some(receipt =>
          receipt.inputId === local.pending!.inputId && receipt.generation === local.pending!.generation)) {
        const { pending: _pending, ...unsent } = local; dirty.set(key, unsent); conflicts.delete(key);
      }
      merge(result.snapshot); warnings.clear();
      for (const warning of result.warnings) warnings.set(warning.key, warning.reason === 'attachment_unavailable' ?
        'A saved attachment is unavailable. Reattach it before sending; the saved text was retained.' :
        'Delivery of this saved draft needs reconciliation. Check Work before editing and sending again.');
      if (dirty.size) schedule();
      storage.status(conflicts.size ? 'This draft also changed in another window. Your current text is retained here; the saved copy was preserved.' : ''); return true;
    } catch { storage.status('Saved delivery could not be reconciled. The draft and original delivery identity were retained.'); return false; }
  }
  function resolvePending(inputId: string): void {
    resolvedPending.add(inputId);
    if (resolvedPending.size > 128) resolvedPending.delete(resolvedPending.values().next().value!);
  }
  return { load, flush, record, remove, move, canMove, select, beginAdmission, abandon, accepted, reconcile, get: (key: string) => entries.get(key),
    snapshot, version: () => changes, warning: (key: string) => warnings.get(key) ?? (entries.get(key)?.pending ?
      'Delivery of this saved draft needs reconciliation. Check Work before editing and sending again.' : '') };
}
