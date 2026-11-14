// Explicit manual integration validation. Never imported or run by automated CI.
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { HelperState, publicJob } from './deepai-helper-state.mjs';
import { ensureWorker } from './deepai-helper.mjs';

const root = path.join(homedir(), 'Documents', 'ChatGPT', 'DeepAI-Integration-Validation', 'bridge');
const manifestPath = path.join(root, 'manifest.json');
const action = process.argv[2] || 'status';
const state = new HelperState();
try {
  if (action === 'start') {
    if (existsSync(manifestPath)) throw new Error('Live test already exists; inspect its status instead of repeating it.');
    mkdirSync(root, { recursive: true });
    const manifest = { createdAt: new Date().toISOString(), jobs: [] };
    for (let index = 1; index <= 12; index++) {
      const workspace = path.join(root, 'worker-' + String(index).padStart(2, '0'));
      mkdirSync(workspace, { recursive: true });
      writeFileSync(path.join(workspace, 'AGENTS.md'), '# Isolated helper validation\nOnly work in this directory. Do not use network, install dependencies, delegate, read credentials, or modify other projects. Do not modify .cos-deepai. Use Node built-in test/assert if needed.\n');
      const marker = 'helper-' + index + '-' + randomUUID();
      let prompt;
      if (index === 1) {
        writeFileSync(path.join(workspace, 'format-frames.mjs'), 'export function formatFrames(frames, fps) { return String(frames / fps); }\n');
        writeFileSync(path.join(workspace, 'format-frames.test.mjs'), `import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport {formatFrames} from './format-frames.mjs';\ntest('timecode formatting',()=>{assert.equal(formatFrames(1234,25),'00:00:49:09');assert.equal(formatFrames(0,30),'00:00:00:00');assert.equal(formatFrames(90000,25),'01:00:00:00');});\ntest('reject invalid inputs',()=>{for(const args of [[-1,25],[1.5,25],[1,0],[1,29.97],[Infinity,25]])assert.throws(()=>formatFrames(...args),TypeError);});\n`);
        prompt = 'Implement formatFrames(frames,fps) as HH:MM:SS:FF with each field at least two digits. Require integer nonnegative frames and positive integer fps, otherwise throw TypeError. Do not change the provided tests. Run node --test format-frames.test.mjs. Report files changed and actual test outcome.';
      } else if (index === 2) {
        writeFileSync(path.join(workspace, 'overlap.mjs'), 'export const overlaps = (a,b) => a.start <= b.end && b.start <= a.end;\n');
        prompt = 'Review overlap.mjs for half-open video clip intervals [start,end). Touching clips must not overlap. Write regression.test.mjs using node:test and assert that proves the boundary bug without changing overlap.mjs. Run it; report the expected failed test honestly, explain the fix, and do not label the buggy code correct.';
      } else {
        const cases = ['zero-duration clips', 'trim endpoints beyond media duration', 'noninteger frame rates', 'missing media on reopen', 'audio clips touching boundaries', 'undo after deleting a track', 'duplicate media imports', 'seeking during playback', 'export frame count rounding', 'negative timeline offsets'];
        prompt = `Give exactly three concrete test cases for ${cases[index - 3]} in a video editor, each with input/action and observable expected behavior. This is a reasoning-only helper: do not read or change files or run commands. Keep the answer below 250 words.`;
      }
      const request = { owner: 'validation-profile-' + Math.ceil(index / 2) + '-chat-' + ((index - 1) % 2 + 1), requestKey: 'native-bridge-v1-' + index, workspace, title: 'CoS validation ' + index, model: index === 2 ? 'deepai/deepseek-v4.1-flash' : 'deepai/glm-5.3-flash', maxRunMinutes: 5, prompt: prompt + `\nInclude this exact correlation marker in your final response and remember it for a later continuation: ${marker}` };
      const { job } = state.enqueue(request);
      manifest.jobs.push({ id: job.id, owner: job.owner, marker, workspace, model: job.model });
      writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
    }
    ensureWorker(state);
    console.log(JSON.stringify({ queued: manifest.jobs.length, nativeCapacity: 2, manifestPath, jobs: manifest.jobs.map(item => ({ id: item.id, owner: item.owner })) }, null, 2));
  } else if (action === 'status') {
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    ensureWorker(state);
    console.log(JSON.stringify({ worker: state.runtime('worker'), jobs: manifest.jobs.map(item => { const job = state.get(item.id, item.owner); return { ...publicJob(job), markerPresent: job.result ? job.result.assistantText.includes(item.marker) : null, nativeStartedAt: job.result?.run.startedAt ?? job.nativeStartedAt, nativeCompletedAt: job.result?.run.completedAt ?? null }; }) }, null, 2));
  } else if (action === 'cancel-check') {
    const resultPath = path.join(root, 'cancel-check.json');
    if (existsSync(resultPath)) throw new Error('Cancellation check already exists; inspect it instead of repeating.');
    const workspace = path.join(root, 'cancel-check'); mkdirSync(workspace, { recursive: true });
    writeFileSync(path.join(workspace, 'AGENTS.md'), '# Isolated cancellation check\nWork only in this directory. Read the test script before running it. No network, installations, delegation, or edits. The coordinator will interrupt the task.\n');
    writeFileSync(path.join(workspace, 'cancel-hold.mjs'), `import {setTimeout} from 'node:timers/promises';\nimport {writeFileSync} from 'node:fs';\nwriteFileSync('started.json',JSON.stringify({pid:process.pid,startedAt:new Date().toISOString()}));\nawait setTimeout(45000);\nwriteFileSync('late.txt','Reached the end without an interrupt.');\nconsole.log('Cancellation fixture reached the end.');\n`);
    const {job} = state.enqueue({ owner: 'validation-cancellation-2', requestKey: 'native-cancel-automated-v1', workspace, title: 'CoS native cancellation validation', maxRunMinutes: 2, prompt: 'Read cancel-hold.mjs, then run node cancel-hold.mjs. This is an authorized cancellation test: the local script writes its own start marker, waits45seconds and then writes an end marker. The coordinator will interrupt the native run as soon as the start marker appears. Do not modify files, delegate, use network, or run other commands. Report actual outcome if it completes.' });
    writeFileSync(resultPath, JSON.stringify({id:job.id,owner:job.owner,workspace,submittedAt:new Date().toISOString()},null,2));
    ensureWorker(state);
    const deadline = Date.now()+30000;
    while (!existsSync(path.join(workspace,'started.json')) && Date.now()<deadline) await delay(250);
    const started = existsSync(path.join(workspace,'started.json')) ? JSON.parse(readFileSync(path.join(workspace,'started.json'),'utf8')) : null;
    state.cancel(job.id,job.owner); ensureWorker(state);
    const observation = {id:job.id,owner:job.owner,workspace,started,cancelRequestedAt:new Date().toISOString(),requestReachedNative:!!started};
    writeFileSync(resultPath,JSON.stringify(observation,null,2));
    console.log(JSON.stringify(observation,null,2));
  } else { throw new Error('Use start, status, or cancel-check.'); }
} finally { state.close(); }
