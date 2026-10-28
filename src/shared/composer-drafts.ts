import { z } from 'zod';
import type { InputAttachment, InputImage } from './input.js';
import { MAX_CHATGPT_MESSAGE_CHARS } from './user-prompt.js';

export const MAX_COMPOSER_DRAFT_BYTES = 8 * 1024 * 1024;
export const MAX_COMPOSER_DRAFTS = 32;
const sessionId = z.string().min(8).max(64).regex(/^[a-z0-9-]+$/i);
// Same identity contract as instance-profile.ts; dots/underscores are valid.
// That module also owns native paths, so it cannot be imported by the renderer.
const profileId = z.string().min(1).max(64).regex(/^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/);
export const composerDraftSelectionSchema = z.object({
  sessionId: sessionId.nullable(), projectId: z.string().uuid().nullable()
}).strict();
const image = z.object({ name: z.string().min(1).max(110),
  dataUrl: z.string().max(512100).regex(/^data:image\/webp;base64,[A-Za-z0-9+/]+={0,2}$/) }).strict();
const attachment = z.object({ id: z.string().uuid(), name: z.string().min(1).max(255),
  size: z.number().int().nonnegative().max(512 * 1024 * 1024),
  mimeType: z.string().max(120).regex(/^[\w.+-]+\/[\w.+-]+$/),
  preview: z.string().max(32768).regex(/^data:image\/webp;base64,[A-Za-z0-9+/]+={0,2}$/).optional() }).strict();
function withinFileLimits(files: ReadonlyArray<InputImage | InputAttachment>): boolean {
  return files.filter(file => 'dataUrl' in file).length <= 4 &&
    files.reduce((total, file) => total + ('size' in file ? file.size : 0), 0) <= 512 * 1024 * 1024;
}
export const composerDraftEntrySchema = z.object({
  key: z.string().max(108).refine(value => value === 'new' ||
    (value.startsWith('project:') && z.string().uuid().safeParse(value.slice(8)).success) || /^[a-z0-9-]{8,64}$/i.test(value), 'Invalid draft target'),
  generation: z.string().uuid(), text: z.string().max(MAX_CHATGPT_MESSAGE_CHARS),
  files: z.array(z.union([image, attachment])).max(20), updatedAt: z.number().int().nonnegative(),
  pending: z.object({ inputId: z.string().uuid(), generation: z.string().uuid(), text: z.string().max(MAX_CHATGPT_MESSAGE_CHARS),
    files: z.array(z.union([image, attachment])).max(20),
    sessionId: sessionId.nullable(), projectId: z.string().uuid().nullable() }).strict().optional()
}).strict().refine(entry => withinFileLimits(entry.files) && (!entry.pending || withinFileLimits(entry.pending.files)),
  'Draft attachments exceed the normal message limits');
const content = z.object({ selection: composerDraftSelectionSchema.nullable(),
  entries: z.array(composerDraftEntrySchema).max(MAX_COMPOSER_DRAFTS)
    .refine(entries => new Set(entries.map(entry => entry.key)).size === entries.length, 'Duplicate draft target') }).strict();
export const composerDraftSnapshotSchema = content.extend({ version: z.literal(1), profileId,
  revision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER) }).strict();
export const composerDraftSaveSchema = z.object({ profileId, expectedRevision: z.number().int().nonnegative(), snapshot: content }).strict();

export type ComposerDraftSelection = z.infer<typeof composerDraftSelectionSchema>;
export type ComposerDraftEntry = z.infer<typeof composerDraftEntrySchema>;
export type ComposerDraftSnapshot = z.infer<typeof composerDraftSnapshotSchema>;
export type ComposerDraftSave = z.infer<typeof composerDraftSaveSchema>;
export interface ComposerDraftSaveResult { saved: boolean; snapshot: ComposerDraftSnapshot; }
export interface ComposerDraftLoadResult {
  snapshot: ComposerDraftSnapshot;
  /** Exact admission evidence; omission from a snapshot is never such evidence. */
  reconciled: Array<{ inputId: string; generation: string }>;
  warnings: Array<{ key: string; reason: 'attachment_unavailable' | 'admission_unresolved' }>;
}
export function composerDraftKey(selection: ComposerDraftSelection): string {
  return selection.sessionId ?? (selection.projectId ? `project:${selection.projectId}` : 'new');
}
/** Canonical comparison never includes native filesystem paths or mutable File objects. */
export function composerFilesIdentity(files: ReadonlyArray<InputImage | InputAttachment>): string {
  // Input admission stores images and staged references separately. Compare the
  // same partition order even if the composer originally interleaved the two.
  const partitioned = [...files.filter(file => 'dataUrl' in file), ...files.filter(file => 'id' in file)];
  return JSON.stringify(partitioned.map(file => 'dataUrl' in file
    ? { name: file.name, dataUrl: file.dataUrl }
    : { id: file.id, name: file.name, size: file.size, mimeType: file.mimeType, preview: file.preview ?? null }));
}
export function assertComposerDraftSize(value: unknown): void {
  if (new TextEncoder().encode(JSON.stringify(value)).byteLength > MAX_COMPOSER_DRAFT_BYTES)
    throw new Error('Saved drafts exceed 8 MiB. Your current draft is still available; remove an older saved draft before retrying.');
}
