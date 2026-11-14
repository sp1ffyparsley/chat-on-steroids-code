import test from 'node:test';
import assert from 'node:assert/strict';
import { ATTENTION_LIMITS, getNativeAttention } from './deepai-attention.mjs';

// Synthetic values in the actual 0.3.36 schema: runtime requests have nodeId,
// providerTurnId and no runId. Never load the user's request/auth data in tests.
const runId = 'run:own', threadId = 'thread:own';
function fixture() {
  return {
    thread: { id: threadId },
    runs: [{ id: runId, threadId, rootNodeId: 'node:own', status: 'waiting' }, { id: 'run:other', threadId, rootNodeId: 'node:other', status: 'waiting' }],
    nodes: [{ id: 'node:own', threadId, runId, rootNodeId: 'node:own', runtimeRequestId: null }, { id: 'node:other', threadId, runId: 'run:other', rootNodeId: 'node:other', runtimeRequestId: null }],
    attempts: [], providerTurns: [], runtimeRequests: [], turnItems: [], visibleTurnItems: [],
  };
}
function request(id = 'request:one', extra = {}) {
  return { id, nodeId: 'node:own', providerTurnId: null, nativeRequestRef: null, kind: 'permission', status: 'pending', responseCapability: { type: 'live', providerSessionId: 'private-session-do-not-copy' }, createdAt: '2026-11-13T00:00:00.000Z', resolvedAt: null, ...extra };
}
function item(extra = {}) {
  return { id: 'item:one', threadId, runId, nodeId: 'node:own', providerThreadId: null, providerTurnId: null, nativeItemRef: null, parentItemId: null, ordinal: 1, type: 'approval_request', requestId: 'request:one', requestKind: 'permission', status: 'waiting', title: 'Allow workspace access', startedAt: null, completedAt: null, updatedAt: '2026-11-13T00:00:00.000Z', ...extra };
}
const read = projection => getNativeAttention(projection, runId);
function freeze(value) { if (value && typeof value === 'object') { Object.freeze(value); for (const child of Object.values(value)) freeze(child); } return value; }

test('real shipped runtime shape joins node ownership without runtimeRequest.runId', () => {
  const p = fixture(); p.runtimeRequests.push(request()); p.turnItems.push(item());
  const result = read(freeze(p));
  assert.equal(result.available, true); assert.equal(result.pendingCount, 1);
  assert.equal(result.requests[0].requestId, 'request:one');
  assert.equal(result.requests[0].type, 'approval');
  assert.equal(result.requests[0].status, 'pending');
  assert.equal(result.requests[0].title, 'Allow workspace access');
  assert.match(result.fingerprint, /^[0-9a-f]{64}$/);
  assert.ok(!JSON.stringify(result).includes('private-session'));
});

test('uses provider-turn attempt ownership when request node is absent', () => {
  const p = fixture();
  p.attempts.push({ id: 'attempt:own', runId, rootNodeId: 'node:own' });
  p.providerTurns.push({ id: 'turn:own', nodeId: 'not-in-window', runAttemptId: 'attempt:own' });
  p.runtimeRequests.push(request('request:one', { nodeId: 'not-in-window', providerTurnId: 'turn:own', kind: 'user_input' }));
  assert.equal(read(p).requests[0].type, 'question');
});

test('real pi confirm runtime command maps to its specific file-change approval card', () => {
  const p = fixture();
  // Confirmed live: a pending Pi approval can coexist with run.status=running.
  p.runs[0].status = 'running';
  p.runtimeRequests.push(request('request:one', { kind: 'command' }));
  p.turnItems.push(item({ requestKind: 'file-change', title: 'Allow write?' }));
  const result = read(p);
  assert.equal(result.available, true); assert.equal(result.pendingCount, 1);
  assert.equal(result.requests[0].kind, 'file-change');
  assert.equal(result.requests[0].type, 'approval');
  p.turnItems[0].type = 'user_input_request';
  assert.equal(read(p).available, false); assert.equal(read(p).pendingCount, 0);
});

test('ignores foreign, unknown, and forged runtime runId ownership', () => {
  const p = fixture();
  p.runtimeRequests.push(request('foreign', { nodeId: 'node:other', runId }), request('unknown', { nodeId: 'missing', runId }));
  assert.equal(read(p).pendingCount, 0);
});

test('refuses conflicting node, item, or request identity joins', () => {
  const p = fixture(); p.runtimeRequests.push(request());
  p.turnItems.push(item({ runId: 'run:other', nodeId: 'node:other' }));
  assert.equal(read(p).pendingCount, 0);
  p.turnItems = [item({ threadId: 'thread:foreign' })];
  assert.equal(read(p).pendingCount, 0);
});

test('resolved, expired, cancelled, answered or decided runtime requests suppress stale cards', () => {
  for (const patch of [{ status: 'resolved' }, { status: 'expired' }, { status: 'cancelled' }, { resolvedAt: '2026-11-13T01:00:00Z' }, { decision: 'accept' }, { answers: { choice: 'private answer' } }]) {
    const p = fixture(); p.runtimeRequests.push(request(), request('request:one', patch)); p.turnItems.push(item());
    assert.equal(read(p).pendingCount, 0);
    p.runtimeRequests.reverse(); assert.equal(read(p).pendingCount, 0);
  }
});

test('closed or answered turn items suppress stale pending runtime records', () => {
  for (const patch of [{ status: 'completed' }, { status: 'failed' }, { status: 'cancelled' }, { questionAnswer: { answers: { text: 'private answer' } } }]) {
    const p = fixture(); p.runtimeRequests.push(request()); p.turnItems.push(item(), item(patch));
    assert.equal(read(p).pendingCount, 0);
  }
});

test('turn-only message-mode questions retain exact run and omit answer/options fields', () => {
  const p = fixture();
  p.turnItems.push(item({ type: 'user_input_request', requestKind: undefined, responseMode: 'message', title: null, questions: [{ id: 'q1', header: 'Output format', question: 'Which output format should be used?', options: [{ label: 'Private option', value: 'PRIVATE_OPTION_VALUE' }], initialAnswer: 'PRIVATE_INITIAL_ANSWER' }] }));
  const result = read(p);
  assert.equal(result.pendingCount, 1); assert.equal(result.requests[0].type, 'question');
  assert.equal(result.requests[0].reason, 'Which output format should be used?');
  assert.equal(result.requests[0].questionCount, 1);
  assert.ok(!JSON.stringify(result).includes('PRIVATE'));
});

test('deduplicates runtime and visible items with order-independent fingerprint', () => {
  const p = fixture();
  p.runtimeRequests.push(request('b'), request('a'), request('b'));
  p.turnItems.push(item({ requestId: 'b', id: 'item:b' }), item({ requestId: 'a', id: 'item:a' }));
  p.visibleTurnItems = p.turnItems.map(value => ({ item: value }));
  const before = read(p);
  for (const key of ['runtimeRequests', 'turnItems', 'visibleTurnItems', 'nodes', 'runs']) p[key].reverse();
  assert.deepEqual(read(p), before);
  assert.deepEqual(before.requests.map(value => value.id), ['a', 'b']);
});

test('secret cards never read secret label, reason, placeholder or entered value', () => {
  const p = fixture();
  const secret = item({ type: 'secret_request', requestId: undefined, secretStatus: 'pending' });
  for (const key of ['label', 'reason', 'placeholder', 'value', 'input']) Object.defineProperty(secret, key, { get() { throw new Error('Private field was read: ' + key); } });
  p.turnItems.push(secret);
  const result = read(p);
  assert.equal(result.pendingCount, 1); assert.equal(result.requests[0].type, 'secret');
  assert.equal(result.requests[0].userOnly, true); assert.equal(result.requests[0].requestId, null);
  p.turnItems.push(item({ type: 'secret_request', secretStatus: 'saved' }));
  assert.equal(read(p).pendingCount, 0);
});

test('auth refresh is generic and dynamic tool calls are not user attention', () => {
  const p = fixture();
  p.runtimeRequests.push(request('auth', { kind: 'auth_refresh', responseCapability: { type: 'not_resumable', reason: 'PRIVATE_AUTH_VALUE' }, nativeRequestRef: { nativeId: 'PRIVATE_AUTH_VALUE' } }), request('tool', { kind: 'dynamic_tool_call' }));
  const result = read(p);
  assert.equal(result.pendingCount, 1); assert.equal(result.requests[0].type, 'authentication');
  assert.equal(result.requests[0].userOnly, true); assert.ok(!JSON.stringify(result).includes('PRIVATE'));
});

test('credential-like question text is replaced and private initial answers do not affect fingerprint', () => {
  const p = fixture();
  p.turnItems.push(item({ type: 'user_input_request', requestKind: undefined, title: 'Authorization: Bearer SENSITIVE_VALUE', questions: [{ header: 'Password', question: 'Use api_key=SENSITIVE_VALUE?', initialAnswer: 'SENSITIVE_VALUE' }] }));
  const first = read(p);
  assert.ok(!JSON.stringify(first).includes('SENSITIVE_VALUE'));
  p.turnItems[0].questions[0].initialAnswer = 'DIFFERENT_PRIVATE_VALUE';
  assert.equal(read(p).fingerprint, first.fingerprint);
});

test('approval raw prompt, inputs, command and output never enter the summary', () => {
  const p = fixture(); p.runtimeRequests.push(request());
  p.turnItems.push(item({ prompt: 'curl -H PRIVATE_HEADER', input: 'PRIVATE_INPUT', output: 'PRIVATE_OUTPUT', command: 'PRIVATE_COMMAND' }));
  assert.ok(!JSON.stringify(read(p)).includes('PRIVATE'));
});

test('limits every displayed string and request count without order dependence', () => {
  const p = fixture();
  for (let n = 0; n < ATTENTION_LIMITS.requests + 8; n++) p.turnItems.push(item({
    id: 'item:' + n, requestId: 'request:' + String(n).padStart(3, '0') + 'x'.repeat(200),
    type: 'user_input_request', requestKind: undefined, title: 'T'.repeat(1000),
    questions: [{ header: 'Q'.repeat(1000), question: 'R'.repeat(3000) }],
  }));
  const result = read(p);
  assert.equal(result.requests.length, ATTENTION_LIMITS.requests);
  assert.equal(result.pendingCount, ATTENTION_LIMITS.requests + 8); assert.equal(result.truncated, true);
  for (const entry of result.requests) {
    assert.ok(entry.id.length <= ATTENTION_LIMITS.id); assert.ok(entry.title.length <= ATTENTION_LIMITS.title);
    assert.ok(entry.reason.length <= ATTENTION_LIMITS.reason);
  }
  p.turnItems.reverse(); assert.deepEqual(read(p), result);
});

test('semantic changes affect fingerprint but observation timestamps do not', () => {
  const p = fixture(); p.runtimeRequests.push(request()); p.turnItems.push(item());
  const initial = read(p).fingerprint;
  p.turnItems[0].updatedAt = '2026-11-13T05:00:00Z'; p.runtimeRequests[0].createdAt = '2026-11-13T02:00:00Z';
  assert.equal(read(p).fingerprint, initial);
  p.turnItems[0].title = 'Another approval'; assert.notEqual(read(p).fingerprint, initial);
  p.runtimeRequests[0].status = 'resolved'; assert.equal(read(p).pendingCount, 0);
});

test('unknown or oversized projection is unavailable rather than clearing attention', () => {
  assert.equal(getNativeAttention(fixture(), 'missing-run').available, false);
  assert.equal(getNativeAttention(null, runId).available, false);
  assert.equal(getNativeAttention(fixture(), null).available, false);
  const p = fixture(); p.runtimeRequests = new Array(ATTENTION_LIMITS.inputRecords + 1);
  assert.equal(read(p).reason, 'projection_too_large');
  assert.equal(read(fixture()).available, true); assert.equal(read(fixture()).pendingCount, 0);
});

test('missing canonical graph arrays cannot clear attention from a bounded projection', () => {
  for (const field of ['nodes', 'attempts', 'providerTurns', 'runtimeRequests', 'turnItems']) {
    const p = fixture(); delete p[field];
    assert.equal(read(p).available, false, field);
    assert.equal(read(p).reason, 'incomplete_graph', field);
  }
  const p = fixture(); delete p.visibleTurnItems;
  assert.equal(read(p).available, true);
});

test('partial graph can retain proven cards but remains unavailable as a complete clear', () => {
  const p = fixture(); p.turnItems.push(item()); delete p.nodes;
  const result = read(p);
  assert.equal(result.available, false); assert.equal(result.pendingCount, 1);
  assert.equal(result.requests[0].requestId, 'request:one');
});

test('unresolved pending ownership is unknown while clean foreign requests are excluded', () => {
  const p = fixture(); p.runtimeRequests.push(request('foreign', { nodeId: 'node:other' }));
  assert.equal(read(p).available, true); assert.equal(read(p).pendingCount, 0);
  p.runtimeRequests.push(request('unknown', { nodeId: 'not-in-window' }));
  assert.equal(read(p).available, false); assert.equal(read(p).reason, 'request_ownership_unresolved');
  p.runtimeRequests[1].status = 'resolved'; assert.equal(read(p).available, true);
  p.runtimeRequests[1] = request('tool', { nodeId: 'not-in-window', kind: 'dynamic_tool_call' });
  assert.equal(read(p).available, true);
});
