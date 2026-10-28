import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { SessionDeletionBatchResult, SessionDeletionReceipt, SessionSummary } from '../../shared/session.js';
import { readDurable, writeDurableNow } from '../durable.js';
import { logInfo, logWarn } from '../logger.js';
import { retirePermanentlyDeletedGoalSwitchNow } from '../goal.js';
import {
  assertSessionDeletionReady,
  releaseSessionDeletionFences,
  retireDeletedConversation,
  retireSessionForDeletion
} from '../bridge.js';
import { cancelDesktopInputsForSession } from './start-input.js';
import {
  deleteSession,
  getSession,
  indexedSessions,
  listDeletedSessions,
  permanentlyDeleteSession,
  restoreDeletedSession
} from './store.js';
import { forgetSession, restoreRecordedConversation } from './recorder.js';
import { assertChatsDeletionCapacity, MAX_DELETED_CHATS, setChatsDeletedNow } from './blocked-chats.js';

/** One durable commit record is enough because all delete/restore mutations share one chain. */
export const SESSION_DELETION_BATCH_STATE = 'session-deletion-batch';
export const SESSION_DELETION_RESTORE_STATE = 'session-deletion-restore';

const batchRowSchema = z.object({
  id: z.string().min(8).max(64).regex(/^[0-9a-z-]+$/i),
  title: z.string().max(240),
  conversationId: z.string().nullable(),
  /** Added compatibly to v1 so an already-committed batch can preserve Compact & Resume lineage. */
  chatIds: z.array(z.string().min(8).max(64).regex(/^[0-9a-z-]+$/i)).max(MAX_DELETED_CHATS).optional()
}).strict();

const batchIntentSchema = z.object({
  version: z.literal(1),
  id: z.string().uuid(),
  createdAt: z.number().finite().positive(),
  permanent: z.boolean(),
  rows: z.array(batchRowSchema).min(1).max(MAX_DELETED_CHATS)
}).strict();

const restoreIntentSchema = z.object({
  version: z.literal(1),
  id: z.string().min(8).max(64).regex(/^[0-9a-z-]+$/i),
  createdAt: z.number().finite().positive(),
  conversationId: z.string().nullable(),
  chatIds: z.array(z.string().min(8).max(64).regex(/^[0-9a-z-]+$/i)).max(MAX_DELETED_CHATS)
}).strict();

export type SessionDeletionBatchIntent = z.infer<typeof batchIntentSchema>;
export type SessionDeletionRestoreIntent = z.infer<typeof restoreIntentSchema>;

let deletionChain: Promise<unknown> = Promise.resolve();

function enqueueSessionDeletion<T>(operation: () => Promise<T>): Promise<T> {
  const result = deletionChain.then(operation, operation);
  deletionChain = result.catch(() => undefined);
  return result;
}

function receiptFor(
  row: SessionDeletionBatchIntent['rows'][number],
  permanent: boolean,
  deletedAt: number
): SessionDeletionReceipt {
  return {
    id: row.id,
    title: row.title,
    conversationId: row.conversationId,
    deletedAt,
    undoUntil: permanent ? deletedAt : deletedAt + 30 * 24 * 60 * 60 * 1000
  };
}

function deletionLineage(
  row: SessionDeletionBatchIntent['rows'][number],
  recoverable?: { chatIds?: string[] } | null
): string[] {
  const retained = recoverable?.chatIds?.length ? recoverable.chatIds : row.chatIds;
  return [...new Set(retained?.length ? retained : row.conversationId ? [row.conversationId] : [])];
}

async function pendingBatch(): Promise<SessionDeletionBatchIntent | null> {
  const raw = await readDurable<unknown>(SESSION_DELETION_BATCH_STATE);
  if (raw === null) return null;
  const parsed = batchIntentSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error('The durable session deletion batch is unreadable; automatic deletion recovery was stopped');
  }
  return parsed.data;
}

async function pendingRestore(): Promise<SessionDeletionRestoreIntent | null> {
  const raw = await readDurable<unknown>(SESSION_DELETION_RESTORE_STATE);
  if (raw === null) return null;
  const parsed = restoreIntentSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error('The durable session restore transaction is unreadable; automatic Trash recovery was stopped');
  }
  return parsed.data;
}

/**
 * Retires every execution owner for one active session, then moves its history to the local
 * recovery area. The deletion fence is durable before the history move, so an open ChatGPT tab
 * cannot recreate the row after a crash. Permanent deletion removes only the local recovery copy.
 */
export async function deleteRecordedSession(id: string, permanent: boolean): Promise<SessionDeletionReceipt> {
  const summary = await getSession(id);
  if (!summary) throw new Error('Session not found');
  cancelDesktopInputsForSession(id);
  await retireSessionForDeletion(id);
  const detached = forgetSession(id);
  try {
    await deleteSession(id);
    if (permanent) {
      // Retire every historical Goal/Loop identity while the recovery copy still carries the
      // complete A→B→… lineage. If the process exits afterward, no removed Trash folder is needed
      // to reconstruct which automatic switches belonged to this permanently deleted record.
      for (const conversationId of summary.chatIds) await retirePermanentlyDeletedGoalSwitchNow(conversationId);
    }
    if (permanent && !await permanentlyDeleteSession(id)) {
      throw new Error('The session moved to Trash but its permanent deletion could not be confirmed');
    }
  } catch (error) {
    // If the move itself failed, the active folder still exists. Release only deletion's
    // fence (preserving any manual Block) and reattach the recorder. Broker/input work stays
    // retired: a failed Delete must never resume token-spending work behind the user's back.
    if (await getSession(id)) {
      await releaseSessionDeletionFences(summary.chatIds).catch(() => undefined);
      for (const conversationId of detached) await restoreRecordedConversation(conversationId);
    }
    throw error;
  }
  const deletedAt = Date.now();
  const receipt: SessionDeletionReceipt = {
    id,
    title: summary.title,
    conversationId: summary.conversationId,
    deletedAt,
    undoUntil: permanent ? deletedAt : deletedAt + 30 * 24 * 60 * 60 * 1000
  };
  logInfo(
    `${permanent ? 'permanently deleted' : 'moved to recoverable deletion'} session ${id}; ` +
    `${detached.length} live conversation mapping(s) detached and all local execution authority retired`
  );
  return receipt;
}

async function preflightBatch(ids: readonly string[]): Promise<SessionDeletionBatchIntent['rows']> {
  const selected: SessionDeletionBatchIntent['rows'] = [];
  for (const id of ids) {
    const summary = await getSession(id);
    if (!summary) throw new Error(`Session not found: ${id}. No selected conversations were deleted.`);
    selected.push({ id, title: summary.title, conversationId: summary.conversationId, chatIds: [...summary.chatIds] });
  }

  // Old builds could create more than one active local row for the same exact ChatGPT
  // conversation. Deleting only the clicked row made the surviving duplicate look as though
  // the deleted chat had reappeared. Expand the already-confirmed conversation selection to
  // every exact active duplicate before committing the durable batch; unrelated and
  // unattributed rows remain untouched.
  const selectedIds = new Set(selected.map((row) => row.id));
  const conversations = new Set(selected.flatMap((row) => deletionLineage(row)));
  const duplicates = conversations.size === 0
    ? []
    : (await indexedSessions())
        .filter((summary) => !selectedIds.has(summary.id) && !!summary.conversationId && conversations.has(summary.conversationId))
        .sort((left, right) => left.id.localeCompare(right.id))
        .map((summary) => ({ id: summary.id, title: summary.title, conversationId: summary.conversationId, chatIds: [...summary.chatIds] }));
  const rows = [...selected, ...duplicates];
  if (duplicates.length) {
    logInfo(`session deletion expanded ${selected.length} selected row(s) to include ${duplicates.length} exact active duplicate(s)`);
  }
  // Capacity is a pre-commit fact. Once SESSION_DELETION_BATCH_STATE lands, recovery owns that
  // exact set and cannot ask the user to shrink it, so reject the whole selection before writing
  // an intent that the deletion-fence registry could never admit.
  assertChatsDeletionCapacity(rows.flatMap((row) => deletionLineage(row)));
  for (const row of rows) {
    // This is deliberately read-only. Once the batch intent lands, deletion is committed and
    // recovery must finish it rather than discovering a known Compact & Resume conflict midway.
    await assertSessionDeletionReady(row.id);
  }
  return rows;
}

/**
 * Finishes one already-committed batch from whatever filesystem point a crash left behind.
 * Progress is inferred from active-vs-Trash state, so no second progress ledger can disagree
 * with the actual same-volume rename that commits each session's history move.
 */
async function executeBatch(intent: SessionDeletionBatchIntent): Promise<SessionDeletionBatchResult> {
  const trash = new Map((await listDeletedSessions()).map((row) => [row.id, row]));
  const receipts: SessionDeletionReceipt[] = [];

  for (const row of intent.rows) {
    const active = await getSession(row.id);
    if (active) {
      const receipt = await deleteRecordedSession(row.id, intent.permanent);
      receipts.push(receipt);
      if (intent.permanent) trash.delete(row.id);
      else trash.set(row.id, {
        id: row.id,
        title: row.title,
        conversationId: row.conversationId,
        chatIds: [...active.chatIds],
        readable: true,
        deletedAt: null,
        expiresAt: null
      });
      continue;
    }

    const recoverable = trash.get(row.id);
    const lineage = deletionLineage(row, recoverable);
    if (intent.permanent) {
      // A crash can occur after the active folder moved but before its Trash copy was removed,
      // or after both steps but before the batch intent was cleared. Both states are replay-safe.
      await setChatsDeletedNow(lineage, true);
      if (row.conversationId) await retireDeletedConversation(row.conversationId, row.id);
      for (const conversationId of lineage) await retirePermanentlyDeletedGoalSwitchNow(conversationId);
      if (recoverable && !await permanentlyDeleteSession(row.id)) {
        throw new Error(`Committed deletion batch ${intent.id} could not permanently remove session ${row.id}`);
      }
      trash.delete(row.id);
      receipts.push(receiptFor(row, true, intent.createdAt));
      continue;
    }

    if (!recoverable) {
      throw new Error(`Committed deletion batch ${intent.id} cannot find session ${row.id} in active history or Trash`);
    }
    // The normal path persisted this fence before moving the folder. Reasserting it is
    // idempotent and also repairs a legacy/interrupted recovery copy before the batch clears.
    await setChatsDeletedNow(lineage, true);
    if (row.conversationId) await retireDeletedConversation(row.conversationId, row.id);
    receipts.push(receiptFor(row, false, intent.createdAt));
  }

  // The batch is complete only when every selected id reached its target state. If this write
  // fails, the intent deliberately remains and the next reconciliation is idempotent.
  await writeDurableNow(SESSION_DELETION_BATCH_STATE, null);
  return { requested: intent.rows.length, permanent: intent.permanent, deleted: receipts, failed: [] };
}

async function reconcilePendingInsideChain(): Promise<SessionDeletionBatchResult | null> {
  const intent = await pendingBatch();
  if (!intent) return null;
  logInfo(`resuming committed session deletion batch ${intent.id} (${intent.rows.length} selected)`);
  try {
    const result = await executeBatch(intent);
    logInfo(`completed recovered session deletion batch ${intent.id}`);
    return result;
  } catch (error) {
    logWarn(`session deletion batch ${intent.id} remains pending: ${error instanceof Error ? error.message : String(error)}`);
    throw error;
  }
}

function restoreIntentMatches(summary: SessionSummary, intent: SessionDeletionRestoreIntent): boolean {
  if (summary.id !== intent.id || summary.conversationId !== intent.conversationId) return false;
  const actual = new Set(summary.chatIds);
  const expected = new Set(intent.chatIds);
  return actual.size === expected.size && [...actual].every((conversationId) => expected.has(conversationId));
}

/** Finishes the one committed Trash -> active move without inventing another history owner. */
async function completeRestoreIntent(intent: SessionDeletionRestoreIntent): Promise<SessionSummary> {
  let summary = await getSession(intent.id);
  if (!summary) {
    summary = await restoreDeletedSession(intent.id);
    if (!summary) throw new Error(`Committed restore cannot find deleted session ${intent.id}`);
  }
  // A same-id active directory can only satisfy this transaction when it is the exact recovery
  // copy the intent named. Refuse a mismatched row rather than releasing another session's fences.
  if (!restoreIntentMatches(summary, intent)) {
    throw new Error(`Committed restore ${intent.id} no longer matches the retained session lineage`);
  }
  if (intent.conversationId) await restoreRecordedConversation(intent.conversationId);
  // Reattach the recorder before reopening any provider identity. If that projection cannot be
  // rebuilt yet, the durable deletion fence remains authoritative and this same intent retries.
  await releaseSessionDeletionFences(intent.chatIds);
  await writeDurableNow(SESSION_DELETION_RESTORE_STATE, null);
  return summary;
}

async function reconcilePendingRestoreInsideChain(): Promise<SessionSummary | null> {
  const intent = await pendingRestore();
  if (!intent) return null;
  logInfo(`resuming committed session restore ${intent.id}`);
  try {
    const restored = await completeRestoreIntent(intent);
    logInfo(`completed recovered session restore ${intent.id}`);
    return restored;
  } catch (error) {
    logWarn(`session restore ${intent.id} remains pending: ${error instanceof Error ? error.message : String(error)}`);
    throw error;
  }
}

/** Completes a crash-interrupted committed batch before browser/input execution resumes. */
export function reconcilePendingSessionDeletionBatch(): Promise<SessionDeletionBatchResult | null> {
  return enqueueSessionDeletion(reconcilePendingInsideChain);
}

/** Completes an Undo that crashed after Trash moved back to active but before its fences cleared. */
export function reconcilePendingSessionRestore(): Promise<SessionSummary | null> {
  return enqueueSessionDeletion(reconcilePendingRestoreInsideChain);
}

/**
 * Serializes an ordinary Trash/restore mutation behind any earlier committed bulk transaction.
 * If the bulk executor failed without a process restart, its durable intent still owns local
 * history until it can finish; a later user action must not mutate around that pending set.
 */
export function serializeSessionDeletion<T>(operation: () => Promise<T>): Promise<T> {
  return enqueueSessionDeletion(async () => {
    await reconcilePendingInsideChain();
    await reconcilePendingRestoreInsideChain();
    return operation();
  });
}

/**
 * Restores one Trash row through the same serialized deletion owner.
 *
 * The intent lands before the atomic folder rename. That makes every later boundary replay-safe:
 * before rename, recovery performs it; after rename, recovery recognizes the exact active row;
 * after fence release, release is idempotent and only the intent still needs clearing.
 */
export function restoreDeletedRecordedSession(id: string): Promise<SessionSummary> {
  return enqueueSessionDeletion(async () => {
    await reconcilePendingInsideChain();
    const recovered = await reconcilePendingRestoreInsideChain();
    if (recovered?.id === id) return recovered;
    const row = (await listDeletedSessions()).find((candidate) => candidate.id === id);
    if (!row) throw new Error('This deleted session is no longer available to restore');
    if (!row.readable) throw new Error('This deleted session has no recoverable metadata or history');
    const intent = restoreIntentSchema.parse({
      version: 1,
      id: row.id,
      createdAt: Date.now(),
      conversationId: row.conversationId,
      chatIds: row.chatIds
    });
    await writeDurableNow(SESSION_DELETION_RESTORE_STATE, intent);
    try {
      return await completeRestoreIntent(intent);
    } catch (error) {
      throw new Error(
        `The restore is committed but not complete; it will resume safely before browser automation starts again. ${error instanceof Error ? error.message : String(error)}`
      );
    }
  });
}

/**
 * Commits the whole selected set before the first destructive side effect. A malformed/missing
 * member or known non-deletable continuation therefore rejects the entire selection untouched.
 * After the intent is durable, a process exit can leave a prefix physically moved, but restart
 * recovery must finish the exact same set before the batch is considered complete.
 */
export function deleteRecordedSessionBatch(ids: readonly string[], permanent: boolean): Promise<SessionDeletionBatchResult> {
  return enqueueSessionDeletion(async () => {
    // A previous crash owns deletion until its already-authorized set reaches a terminal state.
    await reconcilePendingInsideChain();
    await reconcilePendingRestoreInsideChain();
    const rows = await preflightBatch(ids);
    const intent = batchIntentSchema.parse({
      version: 1,
      id: randomUUID(),
      createdAt: Date.now(),
      permanent,
      rows
    });
    await writeDurableNow(SESSION_DELETION_BATCH_STATE, intent);
    try {
      return await executeBatch(intent);
    } catch (error) {
      throw new Error(
        `The deletion batch is committed but not complete; it will resume safely before browser automation starts again. ${error instanceof Error ? error.message : String(error)}`
      );
    }
  });
}
