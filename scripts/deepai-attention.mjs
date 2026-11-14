import { createHash } from 'node:crypto';

// Read-only projection of DeepAI Code 0.3.36. Runtime requests have no runId;
// ownership comes from nodes, provider-turn attempts, and linked turn items.
export const ATTENTION_LIMITS = Object.freeze({
  requests: 32, id: 160, title: 160, reason: 512, inputRecords: 20000,
});
const APPROVAL_KINDS = new Set(['command', 'file-read', 'file-change', 'mcp-elicitation', 'permission']);
const ITEM_TYPES = new Set(['approval_request', 'user_input_request', 'secret_request']);
const PENDING_ITEMS = new Set(['pending', 'waiting']);
const CLOSED_ITEMS = new Set(['completed', 'failed', 'cancelled', 'interrupted', 'rolled_back']);
const BAD_OWNER = Symbol('conflicting owner');
const digest = value => createHash('sha256').update(value).digest('hex');
const list = value => Array.isArray(value) ? value : [];
const validId = value => typeof value === 'string' && value.length > 0 && value.length <= 4096;
const id = value => !validId(value) ? null : value.length <= ATTENTION_LIMITS.id && /^[a-zA-Z0-9:._-]+$/.test(value) ? value : 'sha256:' + digest(value);
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;

function text(value, fallback, limit) {
  if (typeof value !== 'string') return fallback;
  const clean = value.slice(0, 8192).replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u206f]/g, ' ').replace(/\s+/g, ' ').trim();
  // Presentation strings only. Credential-like content is replaced wholesale.
  // Answers, inputs, outputs, options, native refs and session metadata are never copied.
  if (!clean || /(?:password|passphrase|credential|secret|api[\s_-]*key|access[\s_-]*token|refresh[\s_-]*token|authorization|bearer\s|cookie|private[\s_-]*key|verification[\s_-]*code|\bOTP\b|sk-[a-zA-Z0-9_-]{8,}|gh[pousr]_[a-zA-Z0-9]+|github_pat_|xox[baprs]-|eyJ[a-zA-Z0-9_-]{10,}\.|https?:\/\/\S*[?@#])/i.test(clean)) return fallback;
  if (clean.length <= limit) return clean;
  return clean.slice(0, limit - 1).replace(/[\uD800-\uDBFF]$/, '') + '…';
}

function result(runId, available, reason, all) {
  const ordered = all.slice().sort((a, b) => compare(a.type, b.type) || compare(a.id, b.id));
  const base = { version: 1, runId: id(runId), available, reason, pendingCount: ordered.length };
  return {
    ...base,
    requests: ordered.slice(0, ATTENTION_LIMITS.requests),
    truncated: ordered.length > ATTENTION_LIMITS.requests,
    fingerprint: digest(JSON.stringify({ ...base, requests: ordered })),
  };
}

function add(map, key, owners) {
  if (!validId(key)) return;
  let values = map.get(key);
  if (!values) map.set(key, values = new Set());
  for (const owner of owners) if (owner === BAD_OWNER || validId(owner)) values.add(owner);
}
const union = (...sets) => new Set(sets.flatMap(set => [...(set || [])]));
const own = (owners, runId) => owners.size === 1 && owners.has(runId);
const closed = item => CLOSED_ITEMS.has(item.status) || item.completedAt != null || item.questionAnswer != null;

function summary(rawId, kind, item, runtime) {
  const type = kind === 'user_input' ? 'question' : kind === 'auth_refresh' ? 'authentication' : 'approval';
  const question = list(item?.questions)[0];
  const defaults = type === 'authentication'
    ? ['Sign-in required in DeepAI Code', 'Open the helper chat in DeepAI Code to complete authentication. Credentials are not shared with the coordinator.']
    : type === 'question'
      ? ['Answer required in DeepAI Code', 'Open the helper chat in DeepAI Code to answer its pending question.']
      : ['Approval required in DeepAI Code', 'Review the pending ' + kind + ' request in the helper chat in DeepAI Code.'];
  return {
    id: id(rawId), requestId: id(rawId), itemId: id(item?.id),
    type, kind, status: 'pending', source: runtime ? 'runtime_request' : 'turn_item',
    title: type === 'authentication' ? defaults[0] : text(item?.title || question?.header, defaults[0], ATTENTION_LIMITS.title),
    // Approval prompts can contain raw commands; use a fixed reason instead.
    reason: type === 'question' ? text(question?.question, defaults[1], ATTENTION_LIMITS.reason) : defaults[1],
    userOnly: type === 'authentication',
    ...(type === 'question' ? { questionCount: list(item?.questions).length } : {}),
  };
}

/**
 * Returns bounded pending attention for one exact native run. No I/O or decisions.
 * available:false means the projection cannot establish this run's attention;
 * callers must preserve prior attention instead of treating that as a clear.
 * fingerprint covers only sanitized semantic summaries, not timestamps/secrets.
 */
export function getNativeAttention(projection, runId) {
  if (!validId(runId)) return result(null, false, 'invalid_run_id', []);
  const fields = ['runs', 'nodes', 'attempts', 'providerTurns', 'runtimeRequests', 'turnItems', 'visibleTurnItems'];
  if (fields.some(field => list(projection?.[field]).length > ATTENTION_LIMITS.inputRecords)) return result(runId, false, 'projection_too_large', []);
  const threadId = projection?.thread?.id;
  const runs = list(projection?.runs);
  const targetRuns = runs.filter(run => run?.id === runId);
  if (!validId(threadId) || !targetRuns.length || targetRuns.some(run => run.threadId !== threadId)) return result(runId, false, 'run_not_found', []);
  // A bounded WS view can omit these arrays entirely. Presence of the target
  // run alone must never turn unknown attention into an authoritative clear.
  const completeGraph = ['runs', 'nodes', 'attempts', 'providerTurns', 'runtimeRequests', 'turnItems']
    .every(field => Array.isArray(projection[field]));
  let unresolvedOwnership = false;

  const nodeOwners = new Map(), attemptOwners = new Map(), turnOwners = new Map(), requestOwners = new Map();
  for (const run of runs) add(nodeOwners, run?.rootNodeId, [run?.threadId === threadId ? run.id : BAD_OWNER]);
  for (const node of list(projection.nodes)) add(nodeOwners, node?.id, node?.threadId === threadId ? [node.runId] : [BAD_OWNER]);
  for (const attempt of list(projection.attempts)) {
    add(attemptOwners, attempt?.id, [attempt?.runId]);
    add(nodeOwners, attempt?.rootNodeId, [attempt?.runId]);
  }
  for (const node of list(projection.nodes)) {
    if (node?.threadId === threadId && node.runId == null) add(nodeOwners, node.id, nodeOwners.get(node.rootNodeId) || []);
    add(requestOwners, node?.runtimeRequestId, nodeOwners.get(node?.id) || []);
  }
  for (const turn of list(projection.providerTurns)) add(turnOwners, turn?.id, union(nodeOwners.get(turn?.nodeId), attemptOwners.get(turn?.runAttemptId)));

  const items = [
    ...list(projection.turnItems),
    ...list(projection.visibleTurnItems).map(row => row?.item),
  ].filter(item => item && ITEM_TYPES.has(item.type));
  const claimsForItem = item => union(
    new Set(item.threadId === threadId ? [item.runId].filter(validId) : [BAD_OWNER]),
    nodeOwners.get(item.nodeId), turnOwners.get(item.providerTurnId),
  );
  const groups = new Map(), secrets = new Map();
  const group = key => {
    if (!groups.has(key)) groups.set(key, { rows: [], items: [] });
    return groups.get(key);
  };
  for (const request of list(projection.runtimeRequests)) if (request && validId(request.id)) group(request.id).rows.push(request);
  for (const item of items) {
    if (item.type === 'secret_request') {
      if (validId(item.id)) {
        if (!secrets.has(item.id)) secrets.set(item.id, []);
        secrets.get(item.id).push(item);
      }
    } else if (validId(item.requestId)) group(item.requestId).items.push(item);
  }

  const summaries = [];
  for (const [requestId, entry] of groups) {
    if (entry.rows.some(row => row.status !== 'pending' || row.resolvedAt != null || row.decision != null || row.answers != null)) continue;
    if (entry.items.some(closed)) continue;
    const pendingItems = entry.items.filter(item => PENDING_ITEMS.has(item.status));
    if (!entry.rows.length && !pendingItems.length) continue;
    const owners = union(requestOwners.get(requestId));
    for (const row of entry.rows) for (const owner of union(nodeOwners.get(row.nodeId), turnOwners.get(row.providerTurnId))) owners.add(owner);
    for (const item of entry.items) for (const owner of claimsForItem(item)) owners.add(owner);
    const kinds = new Set([
      ...entry.rows.map(row => row.kind),
      ...entry.items.map(item => item.type === 'user_input_request' ? 'user_input' : item.requestKind),
    ]);
    // Pi emits runtime kind=command for confirms while its linked card can
    // correctly identify file-change/read. Those are the same approval family.
    const cardKinds = new Set(entry.items.map(item => item.type === 'user_input_request' ? 'user_input' : item.requestKind));
    const compatibleApproval = [...kinds].every(kind => APPROVAL_KINDS.has(kind)) && cardKinds.size === 1;
    if (kinds.size !== 1 && !compatibleApproval) { if (owners.has(runId)) unresolvedOwnership = true; continue; }
    const kind = compatibleApproval ? [...cardKinds][0] : [...kinds][0];
    if (!APPROVAL_KINDS.has(kind) && kind !== 'user_input' && kind !== 'auth_refresh') continue;
    if (!own(owners, runId)) {
      if (owners.size === 0 || owners.has(BAD_OWNER) || owners.has(runId)) unresolvedOwnership = true;
      continue;
    }
    const choices = (pendingItems.length ? pendingItems : [undefined]).map(item => ({
      at: Number.isFinite(Date.parse(item?.updatedAt)) ? Date.parse(item.updatedAt) : 0,
      value: summary(requestId, kind, item, entry.rows.length > 0),
    })).sort((a, b) => b.at - a.at || compare(JSON.stringify(a.value), JSON.stringify(b.value)));
    summaries.push(choices[0].value);
  }
  for (const [itemId, cards] of secrets) {
    if (cards.some(card => closed(card) || card.secretStatus !== 'pending')) continue;
    if (!cards.some(card => PENDING_ITEMS.has(card.status))) continue;
    const owners = union(...cards.map(claimsForItem));
    if (!own(owners, runId)) {
      if (owners.size === 0 || owners.has(BAD_OWNER) || owners.has(runId)) unresolvedOwnership = true;
      continue;
    }
    summaries.push({
      id: id(itemId), requestId: null, itemId: id(itemId),
      type: 'secret', kind: 'secret_request', status: 'pending', source: 'turn_item',
      title: 'Secret required in DeepAI Code',
      reason: 'Open the helper chat in DeepAI Code to provide the secret. Its value is not shared with the coordinator.',
      userOnly: true,
    });
  }
  const reason = !completeGraph ? 'incomplete_graph' : unresolvedOwnership ? 'request_ownership_unresolved' : null;
  return result(runId, reason === null, reason, summaries);
}
