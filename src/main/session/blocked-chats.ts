/**
 * The user's stop button for a ChatGPT turn that ChatGPT itself will no longer stop.
 *
 * A wedged ChatGPT page can leave a turn running with no working Stop control: the model
 * keeps issuing connector calls, the user can neither see the turn's messages nor cancel it,
 * and every one of those calls arrives here as an ordinary, correctly attributed request. The
 * app cannot end that server-side turn — nothing it can reach owns it. What it does own is
 * whether the turn gets to touch this machine, and refusing every tool it calls is enough:
 * a model with no working tools and an explicit instruction to stop answers and ends the turn.
 *
 * The blocked thing is a **conversation**, not a request id, even though a request id is what
 * the refusal is actually matched on. `correlation.ts` already proves `requestId ->
 * conversationId` exactly, and one ChatGPT turn issues all of its connector calls under one
 * request id, so a conversation is the only key that stays true for the whole rogue turn and
 * for the next one after it. Enumerating request ids would ban the turn the user was looking
 * at and nothing the same chat did a second later.
 *
 * The block is therefore exact-identity only, and deliberately so: it refuses a call whose
 * proven owner is blocked and never a call whose owner is merely unknown. Guessing here would
 * refuse an innocent chat's file read to punish a different chat's turn, which is the trade this
 * whole codebase refuses to make everywhere else.
 *
 * What that costs, and where it was originally got wrong: "the user blocks a chat whose request
 * id is already proven" is true of the turn the user was looking at and of nothing after it. A
 * new turn brings a new request id, and a wedged page — the whole reason this exists — is the
 * page least able to report one promptly. Enforcement that only read already-proven identity
 * therefore let a blocked chat keep running tools that the recorder, which does wait for late
 * evidence, then filed under that same blocked chat. Waiting for the exact request-id mate is
 * not guessing, so the enforcement gate in kernel.ts waits exactly as long as attribution does.
 *
 * Manual blocks and deletion fences are durable and independent. A restart is not a reason to
 * hand a rogue or deleted turn its tools back; the turn can outlive the app. Undo releases only
 * the deletion reason, while permanent local deletion deliberately leaves that reason fenced.
 */

import { readDurable, writeDurableNow, writeDurableSoon } from '../durable.js';

/**
 * Hand-curated manual blocks stay small. Deleted identities need a much larger bound because
 * permanent local deletion must retain its no-recreate fence. Reaching either ceiling is a real
 * error the user sees, never a silent eviction that could restore authority behind their back.
 */
const MAX_BLOCKED_CHATS = 200;
export const MAX_DELETED_CHATS = 50_000;
const BLOCKED_STATE = 'blocked-chats';
const BLOCKED_STATE_VERSION = 2;

/**
 * Conversation id -> the independent reasons it has no local authority.
 *
 * A manual Block is reversible from the visible row. A deletion fence is owned by the
 * session lifecycle and survives the row and even permanent local history removal. Keeping
 * the two bits independent means Undo cannot accidentally release a chat the user had
 * already blocked before deleting it.
 */
interface BlockReasons {
  userBlockedAt: number | null;
  deletedAt: number | null;
}
const blocked = new Map<string, BlockReasons>();
let restored = false;

interface PersistedBlocks {
  version: number;
  entries: Array<{
    conversationId: string;
    /** Version 1 compatibility. */
    blockedAt?: number;
    userBlockedAt?: number | null;
    deletedAt?: number | null;
  }>;
}

/**
 * The one thing a blocked chat's model is told, on every tool it tries.
 *
 * Written as an instruction rather than a diagnosis because the model is the only party that
 * can end the turn: it names the state, forbids the retry loop a bare failure invites, and
 * asks for the one action that finishes — a final answer. `CHAT_BLOCKED:` matches the prefix
 * convention the other kernel refusals use.
 */
export const BLOCKED_CHAT_REFUSAL =
  'CHAT_BLOCKED: the user blocked this conversation from using local tools, and no tool was run. ' +
  'This session went rogue. Stop right now: abandon the task, make no further tool calls of any ' +
  'kind, and reply to the user immediately with your final answer. The user explicitly asked for this.';

function snapshot(): PersistedBlocks {
  return {
    version: BLOCKED_STATE_VERSION,
    entries: [...blocked].map(([conversationId, reasons]) => ({ conversationId, ...reasons }))
  };
}

function validConversationId(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-z-]{8,64}$/i.test(value);
}

/**
 * Loads the blocked set before the MCP endpoint can accept a call.
 *
 * A block that arrives one call late is a block the rogue turn got one more tool out of, so
 * this runs alongside the correlation restore rather than lazily on first use.
 */
export async function restoreBlockedChats(): Promise<void> {
  if (restored) return;
  restored = true;
  const saved = await readDurable<PersistedBlocks>(BLOCKED_STATE);
  if (!saved || (saved.version !== 1 && saved.version !== BLOCKED_STATE_VERSION) || !Array.isArray(saved.entries)) return;
  for (const entry of saved.entries.slice(0, MAX_BLOCKED_CHATS + MAX_DELETED_CHATS)) {
    if (!entry || typeof entry !== 'object') continue;
    const { conversationId, blockedAt, userBlockedAt, deletedAt } = entry as {
      conversationId?: unknown;
      blockedAt?: unknown;
      userBlockedAt?: unknown;
      deletedAt?: unknown;
    };
    if (!validConversationId(conversationId)) continue;
    const legacy = saved.version === 1
      ? typeof blockedAt === 'number' && Number.isFinite(blockedAt) ? blockedAt : Date.now()
      : null;
    const user = legacy ?? (typeof userBlockedAt === 'number' && Number.isFinite(userBlockedAt) ? userBlockedAt : null);
    const deleted = typeof deletedAt === 'number' && Number.isFinite(deletedAt) ? deletedAt : null;
    if (user !== null || deleted !== null) blocked.set(conversationId, { userBlockedAt: user, deletedAt: deleted });
  }
}

/**
 * Whether any block exists at all.
 *
 * The kernel's cheap way to ask whether it is worth resolving a call's identity before deciding
 * — see the block gate in kernel.ts. An install with no blocked chat pays one map read per call
 * and never waits on the browser for this.
 */
export function anyChatBlocked(): boolean {
  return blocked.size > 0;
}

/** Exact lookup. An unproven caller has no conversation and is therefore never blocked. */
export function isChatBlocked(conversationId: string | null | undefined): boolean {
  return conversationId !== null && conversationId !== undefined && blocked.has(conversationId);
}

/** Every blocked conversation, so one renderer paint can mark all of its rows at once. */
export function blockedChatIds(): string[] {
  return [...blocked.keys()];
}

/** The user's existing durable block time, for retiring its browser page after a quiet grace. */
export function chatBlockedAt(conversationId: string): number | null {
  const reasons = blocked.get(conversationId);
  if (!reasons) return null;
  if (reasons.userBlockedAt === null) return reasons.deletedAt;
  if (reasons.deletedAt === null) return reasons.userBlockedAt;
  return Math.min(reasons.userBlockedAt, reasons.deletedAt);
}

/** A deleted ChatGPT identity must neither be re-recorded nor regain local tools. */
export function isChatDeleted(conversationId: string | null | undefined): boolean {
  return conversationId !== null && conversationId !== undefined &&
    (blocked.get(conversationId)?.deletedAt ?? null) !== null;
}

/**
 * Blocks or releases one conversation. Idempotent in both directions: the user pressing the
 * button twice must not move a block's timestamp or resurrect a released one.
 */
export function setChatBlocked(conversationId: string, next: boolean): void {
  setChatsBlocked([conversationId], next);
}

/**
 * Applies one explicit user Block/Release decision to a selected set as one registry mutation.
 * Every identity and the manual-block capacity are checked before any row changes, so a bad or
 * over-capacity batch cannot leave half of the selection blocked.
 */
export function setChatsBlocked(conversationIds: readonly string[], next: boolean): void {
  const ids = [...new Set(conversationIds)];
  if (!ids.length) throw new Error('Choose at least one ChatGPT conversation');
  for (const conversationId of ids) {
    if (!validConversationId(conversationId)) throw new Error('Not a ChatGPT conversation id');
  }

  if (next) {
    const manualCount = [...blocked.values()].filter((entry) => entry.userBlockedAt !== null).length;
    const additions = ids.filter((conversationId) => (blocked.get(conversationId)?.userBlockedAt ?? null) === null).length;
    if (manualCount + additions > MAX_BLOCKED_CHATS) {
      throw new Error(`Too many blocked chats (${MAX_BLOCKED_CHATS}). Release one before blocking another.`);
    }
  }

  const blockedAt = Date.now();
  let changed = false;
  for (const conversationId of ids) {
    const current = blocked.get(conversationId) ?? { userBlockedAt: null, deletedAt: null };
    if (next === (current.userBlockedAt !== null)) continue;
    changed = true;
    if (next) {
      blocked.set(conversationId, { ...current, userBlockedAt: blockedAt });
    } else {
      const updated = { ...current, userBlockedAt: null };
      if (updated.deletedAt === null) blocked.delete(conversationId);
      else blocked.set(conversationId, updated);
    }
  }
  if (changed) writeDurableSoon(BLOCKED_STATE, snapshot());
}

/**
 * Publishes or releases one or more deletion fences behind one immediate durability barrier.
 *
 * A Compact & Resume session can own several historical ChatGPT conversation ids. They are one
 * local deletion unit: moving that session folder out of the active catalog must not leave an old
 * source page able to recreate a shadow session while its successor is in Trash. Validate and
 * capacity-check the complete lineage before changing any row, then persist it as one snapshot.
 */
export function assertChatsDeletionCapacity(conversationIds: readonly string[]): string[] {
  const ids = [...new Set(conversationIds)];
  for (const conversationId of ids) {
    if (!validConversationId(conversationId)) throw new Error('Not a ChatGPT conversation id');
  }
  const deletedCount = [...blocked.values()].filter((entry) => entry.deletedAt !== null).length;
  const additions = ids.filter((conversationId) => (blocked.get(conversationId)?.deletedAt ?? null) === null).length;
  if (deletedCount + additions > MAX_DELETED_CHATS) {
    throw new Error(`Deleted-chat safety fence limit reached (${MAX_DELETED_CHATS}); no additional conversation was deleted.`);
  }
  return ids;
}

export async function setChatsDeletedNow(conversationIds: readonly string[], next: boolean): Promise<void> {
  const ids = next
    ? assertChatsDeletionCapacity(conversationIds)
    : [...new Set(conversationIds)];
  if (!ids.length) return;
  if (!next) for (const conversationId of ids) {
    if (!validConversationId(conversationId)) throw new Error('Not a ChatGPT conversation id');
  }
  const before = new Map(ids.map((conversationId) => [conversationId, blocked.get(conversationId)] as const));
  const deletedAt = next ? Date.now() : null;
  let changed = false;
  for (const conversationId of ids) {
    const current = blocked.get(conversationId) ?? { userBlockedAt: null, deletedAt: null };
    if (next === (current.deletedAt !== null)) continue;
    changed = true;
    const updated = { ...current, deletedAt };
    if (updated.userBlockedAt === null && updated.deletedAt === null) blocked.delete(conversationId);
    else blocked.set(conversationId, updated);
  }
  if (!changed) return;
  try {
    await writeDurableNow(BLOCKED_STATE, snapshot());
  } catch (error) {
    for (const conversationId of ids) {
      const previous = before.get(conversationId);
      if (previous) blocked.set(conversationId, previous);
      else blocked.delete(conversationId);
    }
    throw error;
  }
}

/** Single-conversation compatibility surface for non-session deletion owners. */
export async function setChatDeletedNow(conversationId: string, next: boolean): Promise<void> {
  await setChatsDeletedNow([conversationId], next);
}

export function resetBlockedChatsForTests(): void {
  blocked.clear();
  restored = false;
}
