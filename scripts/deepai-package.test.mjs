import test from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { load as loadYaml } from 'js-yaml';

test('declared packaged resources run independently of the source tree and asar resolver', t => {
  const source = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const builder = loadYaml(readFileSync(path.join(source, 'electron-builder.yml'), 'utf8'));
  const helper = builder.extraResources.find(row => row.to === 'deepai-helper');
  const socket = builder.extraResources.find(row => row.to === 'deepai-helper/node_modules/ws');
  assert.ok(helper && socket, 'Both executable helper modules and their ws dependency must ship.');
  const fixture = mkdtempSync(path.join(tmpdir(), 'cos-deepai-package-'));
  t.after(() => rmSync(fixture, { recursive: true, force: true }));
  const resources = path.join(fixture, 'resources'), target = path.join(resources, helper.to);
  mkdirSync(target, { recursive: true });
  for (const name of helper.filter) {
    assert.match(name, /^[a-z-]+\.mjs$/);
    cpSync(path.join(source, helper.from, name), path.join(target, name));
  }
  cpSync(path.join(source, socket.from), path.join(resources, socket.to), { recursive: true });
  assert.ok(existsSync(path.join(resources, socket.to, 'LICENSE')));
  const result = JSON.parse(execFileSync(process.execPath, [path.join(target, 'deepai-helper.mjs'), 'health', '--state-root', path.join(fixture, 'state'), '--no-worker'], {
    cwd: fixture, encoding: 'utf8', windowsHide: true, env: { ...process.env, NODE_PATH: '' }
  }));
  assert.equal(result.pending, 0); assert.equal(result.worker, null); assert.equal(result.maxActive, 2);
});
