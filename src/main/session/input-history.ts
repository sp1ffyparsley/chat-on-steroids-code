import type { InputEntry } from './input.js';
import { browserInputModel } from '../../shared/input.js';
import { getSession, observeSessionModel, readAsset, readEvents, upsertMessageEvent, writeAsset } from './store.js';
import { validateInputImages } from './input-images.js';
import sharp from 'sharp';
import type { ReasoningEffort, SessionEvent } from '../../shared/session.js';
import { createHash } from 'node:crypto';
import { logInfo } from '../logger.js';

/** A confirmed native receipt may arrive after a committed Resume, but only
 * from an actual member of the durable session's provider-chat lineage. A
 * foreign page's UUID or input row cannot mint a new human correction. */
async function recordedConversationBelongsToSession(sessionId: string, conversationId?: string | null): Promise<boolean> {
  const session = await getSession(sessionId);
  return Boolean(session && (!conversationId || session.conversationId === conversationId ||
    session.chatIds.includes(conversationId)));
}

/** The canonical writer snapshots a real owned native ACK before bounded
 * outbox pruning. This proves instruction origin, never work completion. */
export function canonicalInputProvenanceMatches(
  event: Extract<SessionEvent, { kind: 'user_message' }>, sessionId: string, chatIds: readonly string[]
): boolean {
  const proof = event.inputProvenance;
  return !!proof && proof.version === 1 && ['human', 'automation'].includes(proof.authorship) &&
    proof.sessionId === sessionId && chatIds.includes(proof.conversationId) &&
    !!event.inputId && proof.inputId === event.inputId && !!event.messageId &&
    proof.nativeMessageId === event.messageId && !event.messageId.startsWith('input:') &&
    event.inputDelivery === 'confirmed' && !event.unverifiedAuthorshipClaim &&
    ['app', 'extension'].includes(event.source) && Number.isFinite(proof.deliveredAt) && proof.deliveredAt >= 0 &&
    typeof event.authoredText === 'string' &&
    proof.authoredSha256 === createHash('sha256').update(event.authoredText).digest('hex') &&
    /^[a-f0-9]{64}$/.test(proof.preparedSha256) && proof.preparedSha256 === event.preparedDeliverySha256;
}

/** Project a tool handout or proven delivery into history, never the enqueue intent. */
export async function recordDeliveredInput(entry: Readonly<InputEntry>): Promise<boolean> {
  const sessionId = entry.sessionId ?? entry.deliveredSessionId;
  const offered = entry.state === 'tool' && !!entry.owner && Number.isFinite(entry.offeredAt);
  const confirmed = ['sent', 'cancelled'].includes(entry.state) && !!entry.messageId && Number.isFinite(entry.deliveredAt);
  if ((!offered && !confirmed) || !sessionId || entry.purpose === 'decision') return false;
  const messageId = offered ? `input:${entry.id}` : entry.messageId!;
  const time = offered ? entry.offeredAt! : entry.deliveredAt!;
  if (!await recordedConversationBelongsToSession(sessionId, entry.conversationId)) return false;
  const images = [...entry.images ?? [], ...entry.toolImages ?? []];
  const text = entry.deliveryText ?? entry.text;
  const preparedSha256 = createHash('sha256').update(text).digest('hex');
  const inputProvenance = confirmed && entry.owner && entry.conversationId &&
    !messageId.startsWith('input:') ? {
      version: 1 as const,
      authorship: !entry.sourceHelperId && !entry.finishOwner && !entry.recovery &&
        entry.purpose !== 'rotation' && entry.lifetime !== 'temporary-planner'
        ? 'human' as const : 'automation' as const,
      sessionId, conversationId: entry.conversationId, inputId: entry.id,
      nativeMessageId: messageId, deliveredAt: time,
      authoredSha256: createHash('sha256').update(entry.text).digest('hex'), preparedSha256
    } : undefined;
  await validateInputImages(images);
  const assets = [];
  for (const image of images) {
    assets.push(await writeAsset(sessionId, Buffer.from(image.dataUrl.split(',')[1]!, 'base64'), 'image/webp'));
  }
  // Image decoding and asset writes can yield to a concurrent Resume. Keep a
  // rejected foreign receipt out of the journal even if assets were staged.
  if (!await recordedConversationBelongsToSession(sessionId, entry.conversationId)) return false;
  // Only an explicit native picker request proves model selection. Finish tasks
  // inherit the page model, so their old queued settings cannot become evidence.
  const selection = browserInputModel(entry);
  const projected = await upsertMessageEvent(sessionId, {
    time, source: 'app', kind: 'user_message',
    // Browser delivery uses its exact native key, so a later page echo updates this row.
    // Tool delivery has no native user row and keeps the stable input id as its key.
    messageId, inputId: entry.id, inputDelivery: offered ? 'offered' : 'confirmed', authoredText: entry.text,
    // One native input UUID cannot acquire a new body from a late async history
    // projection. Hash the complete frozen payload, not just the shorter human
    // authored text (which intentionally excludes the selected Skill envelope).
    preparedDeliverySha256: preparedSha256,
    ...(inputProvenance ? { inputProvenance } : {}),
    ...(entry.purpose === 'rotation' ? { automationOrigin: 'rotation' as const }
      : confirmed && entry.sourceHelperId && (entry.sourceHelperAcceptedAt ?? 0) > 0
        ? { automationOrigin: 'goal' as const } : {}),
    ...(entry.attachments?.length && entry.attachmentDelivery !== 'tool' ? { attachments: entry.attachments } : {}),
    // Injection does not change the running model. Only the native send path verifies
    // picker selection before delivery; a later sparse browser echo keeps this evidence.
    ...(!messageId.startsWith('input:') && selection.model
      ? { model: selection.model, ...(selection.reasoningEffort ? { reasoningEffort: selection.reasoningEffort } : {}) }
      : {}),
    message: { text, chars: text.length, truncated: false },
    ...(assets.length ? { assets } : {})
  });
  if (inputProvenance && projected.changed)
    logInfo(`input ${entry.id}: ${inputProvenance.authorship} native provenance committed to canonical history; execution acceptance unchanged`);
  // The exact native message must first pass canonical authorship validation.
  // A rejected duplicate UUID (Goal versus human, or another Input) cannot
  // manufacture a fresh model-picker observation before the history write
  // refuses it. Current-chat and observedAt ordering are still enforced by
  // observeSessionModel, including after a concurrent Resume.
  if (!messageId.startsWith('input:') && selection.model && entry.conversationId) {
    await observeSessionModel(sessionId, entry.conversationId, selection.model, entry.deliveredAt!, selection.reasoningEffort ?? undefined);
  }
  return true;
}

/**
 * Project one provider-confirmed Goal/Loop browser Send into canonical history.
 *
 * Browser Goal delivery intentionally does not mint a second outbox row. Its exact native
 * message id is therefore the durable join between the provider receipt and local history.
 * Later page echoes revise this same row and the store preserves `automationOrigin`, so a
 * decision helper cannot mistake the app's own continuation for new human scope.
 */
export async function recordAutomaticGoalInput(
  sessionId: string,
  conversationId: string,
  messageId: string,
  text = '',
  time = Date.now(),
  sendSelection?: { model: string; reasoningEffort: ReasoningEffort },
  generatedInputId?: string
): Promise<boolean> {
  if (!conversationId || !await recordedConversationBelongsToSession(sessionId, conversationId)) return false;
  // The durable Goal receipt may be re-confirmed after its original draft was
  // released. Do not rewrite full frozen instructions with a guessed blank.
  // A first ID-only observation is intentionally marked body-incomplete until
  // the browser supplies the actual provider text under the same native UUID.
  const sparse = text.length === 0;
  await upsertMessageEvent(sessionId, {
    source: 'app',
    time,
    kind: 'user_message',
    messageId,
    automationOrigin: 'goal',
    // A real native Goal ACK with the full generated payload freezes what the
    // app prepared for this exact Send. Keep it separate from a later provider
    // observation of what the model actually received. A sparse ID-only ACK
    // does not know those bytes and must never fabricate this witness.
    ...(sparse ? {} : { authoredText: text, preparedDeliverySha256: createHash('sha256').update(text).digest('hex') }),
    // Only the real Goal native ACK may call this recorder path. A nonempty
    // payload proves which generated bytes were submitted under this UUID,
    // not that provider/model receipt of those bytes is independently known.
    // Sparse ID-only recovery stays body-unverified.
    ...(!sparse ? { inputDelivery: 'confirmed' as const } : {}),
    // Only the native-ACK owner supplies this exact generated child identity.
    // A direct Goal receipt cannot acquire a human/foreign outbox row by UUID.
    ...(generatedInputId ? { inputId: generatedInputId, inputDelivery: 'confirmed' as const } : {}),
    ...(sendSelection ? { model: sendSelection.model, reasoningEffort: sendSelection.reasoningEffort } : {}),
    message: { text, chars: text.length, truncated: sparse }
  }, sparse ? { sparseGoalReceipt: true } : {});
  return true;
}

/** Recorded membership, not a supplied filename, grants the renderer image access. */
export async function recordedInputImage(sessionId: string, assetId: string): Promise<string | null> {
  const events = await readEvents(sessionId, { kinds: ['user_message', 'tool_call'] });
  const referenced = events.flatMap(event => event.kind === 'user_message' ? event.assets ?? [] :
    event.kind === 'tool_call' ? event.call.assets ?? [] : [])
    .find(asset => asset.id === assetId && ['image/png', 'image/jpeg', 'image/webp'].includes(asset.mimeType));
  if (!referenced) return null;
  const data = await readAsset(sessionId, assetId, 16 * 1024 * 1024);
  if (!data) return null;
  try {
    const image = sharp(data, { limitInputPixels: 36000000 });
    const metadata = await image.metadata();
    if (!metadata.width || !metadata.height || `image/${metadata.format}` !== referenced.mimeType) return null;
    // Decode fully before any bytes reach the renderer; metadata alone accepts broken images.
    await image.stats();
    return `data:${referenced.mimeType};base64,${data.toString('base64')}`;
  } catch { return null; }
}
