#!/usr/bin/env node
// Opt-in local-client revocation check. Never logs or reads an upstream account credential.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { connectNative } from './deepai-native.mjs';
import { HelperState, defaultStateRoot } from './deepai-helper-state.mjs';
import { requiresNativeReconnect, verifyRun } from './deepai-helper.mjs';

const { values } = parseArgs({ options: { job: { type: 'string' }, output: { type: 'string' }, 'state-root': { type: 'string' } } });
if (!values.job || !values.output) throw new Error('Use --job EXISTING_JOB --output RECEIPT_JSON. This probe creates no model run.');
const baseDir = process.env.COS_DEEPAI_HOME || path.join(homedir(), '.deepai-code');
const desktop = process.env.COS_DEEPAI_DESKTOP_EXE || path.join(homedir(), 'AppData', 'Local', 'Programs', 'deepai-code-desktop', 'DeepAI Code.exe');
const entry = path.join(path.dirname(desktop), 'resources', 'server.asar', 'apps', 'server', 'dist', 'bin.mjs');
const issuedSessions = [];
async function command(args) {
  const stdout = await new Promise((resolve, reject) => {
    const child = execFile(desktop, [entry, ...args], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', T3CODE_HOME: baseDir },
      windowsHide: true, encoding: 'utf8', timeout: 20000, maxBuffer: 1024 * 1024
    }, (error, out) => error ? reject(new Error('Local scoped credential command failed.')) : resolve(out));
    child.stdin?.end();
  });
  if (args[0] === 'auth' && args[1] === 'session' && args[2] === 'issue') issuedSessions.push(JSON.parse(stdout).sessionId);
  return stdout;
}
const state = new HelperState(values['state-root'] || defaultStateRoot());
const receipt = { version: 1, test: 'scoped-client-revocation-and-reconnect', startedAt: new Date().toISOString(), jobId: values.job, createsModelRun: false };
let first, second;
try {
  const before = state.get(values.job);
  assert.ok(before.runId && before.resultSavedAt, 'Probe needs a saved native turn.');
  first = await connectNative({ websocket: true }, { nativeCommand: command });
  const original = await first.http(`/api/orchestration/threads/${encodeURIComponent(before.threadId)}`);
  const originalRun = verifyRun(before, original.projection);
  assert.equal(originalRun?.id, before.runId);
  assert.equal(issuedSessions.length, 1);
  // Revoke ONLY the local client session minted by this invocation, not the user's login.
  await command(['auth', 'session', 'revoke', issuedSessions[0]]);
  let rejected;
  try { await first.http('/api/orchestration/shell'); }
  catch (error) { rejected = error; }
  assert.equal(rejected?.code, 'NATIVE_HTTP_STATUS');
  assert.equal(rejected?.httpStatus, 401);
  assert.equal(requiresNativeReconnect(rejected), true);
  await first.close();
  second = await connectNative({ websocket: true }, { nativeCommand: command });
  const restored = await second.http(`/api/orchestration/threads/${encodeURIComponent(before.threadId)}`);
  assert.equal(verifyRun(before, restored.projection)?.id, originalRun.id);
  assert.equal(issuedSessions.length, 2);
  assert.notEqual(issuedSessions[0], issuedSessions[1]);
  const after = state.get(values.job);
  assert.equal(after.sendAttempts, before.sendAttempts);
  assert.equal(after.threadId, before.threadId);
  assert.equal(after.messageId, before.messageId);
  Object.assign(receipt, {
    passed: true, serverVersion: second.descriptor.serverVersion,
    protocol: second.descriptor.orchestrationProtocolVersion,
    rejectedAfterRevocation: { code: rejected.code, httpStatus: rejected.httpStatus },
    freshScopedClient: true, sameThreadAndRun: true, unchangedSendAttempts: true,
    originalStatus: before.status, pendingJobs: state.pending().length
  });
} catch (error) {
  Object.assign(receipt, { passed: false, errorCode: error?.code || 'PROBE_ASSERTION_FAILED' });
  process.exitCode = 1;
} finally {
  const closed = await Promise.allSettled([first?.close(), second?.close()]);
  receipt.localClientsRetired = closed.every(item => item.status === 'fulfilled' && (!item.value || item.value.credentialRevoked === true));
  receipt.finishedAt = new Date().toISOString();
  state.close();
  mkdirSync(path.dirname(path.resolve(values.output)), { recursive: true });
  writeFileSync(values.output, JSON.stringify(receipt, null, 2));
  console.log(JSON.stringify(receipt, null, 2));
}
