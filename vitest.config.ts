import { defineConfig } from 'vitest/config';
import type { Reporter } from 'vitest/node';
import { mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

/** Progress only, never a test receipt. Strict packaging deletes this existing cache after success. */
export function strictBuildProgressReporter(root = process.cwd()): Reporter {
  const file = path.join(root, 'node_modules', '.vite', 'vitest', 'strict-build-progress.json');
  const temporary = `${file}.${process.pid}.tmp`;
  const active = new Map<string, { module: string; phase: 'module-import' | 'module-tests' }>();
  let completedModules = 0, warned = false;
  const name = (relative: string) => {
    const normalized = relative.replaceAll('\\', '/');
    return /^test\/(?:[a-zA-Z0-9_.-]+\/)*[a-zA-Z0-9_.-]+\.test\.[cm]?[jt]sx?$/.test(normalized) &&
      !normalized.split('/').some(part => part === '.' || part === '..')
      ? path.posix.basename(normalized).slice(0, 160) : 'unavailable';
  };
  const publish = (phase: string, module: string | null) => {
    try {
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(temporary, JSON.stringify({ version: 1, pid: process.pid, phase, module,
        completedModules, updatedAt: Date.now(), activeModules: [...active.values()], qualificationAuthority: false }) + '\n', 'utf8');
      renameSync(temporary, file);
    } catch {
      try { rmSync(temporary, { force: true }); } catch { /* No capture failure can accept or reject tests. */ }
      if (!warned) { warned = true; process.stderr.write('Strict test progress snapshot unavailable; test results remain authoritative.\n'); }
    }
  };
  const modulePhase = (relative: string, phase: 'module-import' | 'module-tests') => {
    const module = name(relative);
    active.set(relative, { module, phase });
    // The configured pool has two workers; retain a small bounded diagnostic window if overridden.
    if (active.size > 32) active.delete(active.keys().next().value!);
    publish(phase, module);
  };
  return {
    onTestRunStart() { active.clear(); completedModules = 0; publish('run-start', null); },
    // Vitest v5 queues a module BEFORE loading it. onTestModuleStart is too late for import hangs.
    onTestModuleQueued(module) { modulePhase(module.relativeModuleId, 'module-import'); },
    onTestModuleStart(module) { modulePhase(module.relativeModuleId, 'module-tests'); },
    onTestModuleEnd(module) {
      active.delete(module.relativeModuleId); completedModules++; publish('module-end', name(module.relativeModuleId));
    },
    onTestRunEnd(modules, errors, reason) {
      active.clear();
      publish(reason === 'interrupted' ? 'run-interrupted' : reason === 'failed' || errors.length ||
        modules.some(module => module.state() === 'failed') ? 'run-failed' : 'run-finished', null);
    }
  };
}

export default defineConfig({
  test: {
    ...(process.env.COS_STRICT_BUILD === '1' ? { reporters: ['default', strictBuildProgressReporter()] } : {}),
    include: ['test/**/*.test.ts'],
    environment: 'node',
    // Real filesystem, real child processes and a real HTTP server, so the
    // defaults are too tight.
    testTimeout: 30_000,
    hookTimeout: 30_000,
    // This suite includes native capture, child-process resource limits and atomic Windows
    // file replacement. Letting Vitest scale to every logical CPU can starve the limit tests
    // and make antivirus/file-indexer locks look like product failures on high-core machines.
    maxWorkers: 2,
    env: {
      // Never let a test bind — or worse, fall through to — the shipped bridge range.
      // The developer's own installed app is usually listening on 8765 while the suite
      // runs, and a test that lost the bind race used to talk to it with a test token.
      CLF_BRIDGE_PORTS: '0',
      // In-process evidence arrives in microseconds or never; the production windows only
      // exist for a real browser that is seconds late. Without this the suite spent minutes
      // waiting out fifteen-second timeouts to prove calls stay unattributed.
      CLF_EVIDENCE_MS: '1500'
    }
  }
});
