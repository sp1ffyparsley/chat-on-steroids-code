import { readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { app } from 'electron';
import type { RuntimeSourceIdentity } from '../shared/types.js';

const SOURCE_PROVENANCE_SCHEMA = 2;

type GitSourceIdentity = RuntimeSourceIdentity & {
  objectFormat: string;
};

type PackagingProvenanceModule = {
  readGitSourceIdentity(repoRoot?: string): GitSourceIdentity;
};

let cachedIdentity: Promise<RuntimeSourceIdentity | null> | null = null;

function objectIdLength(objectFormat: unknown): number {
  return objectFormat === 'sha1' ? 40 : objectFormat === 'sha256' ? 64 : 0;
}

function projectPackagedSource(record: unknown): RuntimeSourceIdentity | null {
  if (!record || typeof record !== 'object' || Array.isArray(record)) return null;
  const value = record as Record<string, unknown>;
  if (value.schema !== SOURCE_PROVENANCE_SCHEMA) return null;
  const length = objectIdLength(value.objectFormat);
  if (!length) return null;
  const objectId = new RegExp(`^[0-9a-f]{${length}}$`);
  if (typeof value.commit !== 'string' || !objectId.test(value.commit)) return null;
  if (typeof value.tree !== 'string' || !objectId.test(value.tree)) return null;
  if (typeof value.dirty !== 'boolean') return null;
  return { commit: value.commit, tree: value.tree, dirty: value.dirty };
}

function packagedSourceIdentity(): RuntimeSourceIdentity | null {
  const resourcesPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
  if (!resourcesPath) return null;
  try {
    const raw = readFileSync(path.join(resourcesPath, 'SOURCE_PROVENANCE.json'), 'utf8');
    return projectPackagedSource(JSON.parse(raw));
  } catch {
    // Provenance is diagnostic. A missing/damaged package record must not expose a path or
    // borrow identity from an unrelated checkout that happens to exist on the same machine.
    return null;
  }
}

async function developmentSourceIdentity(): Promise<RuntimeSourceIdentity | null> {
  try {
    const repoRoot = app.getAppPath();
    const moduleUrl = pathToFileURL(path.join(repoRoot, 'scripts', 'package.mjs')).href;
    const provenance = (await import(/* @vite-ignore */ moduleUrl)) as PackagingProvenanceModule;
    if (typeof provenance.readGitSourceIdentity !== 'function') return null;
    const source = provenance.readGitSourceIdentity(repoRoot);
    return { commit: source.commit, tree: source.tree, dirty: source.dirty };
  } catch {
    // The canonical Git helper can include local repository paths in its errors. Keep the
    // renderer-facing projection path-free and fail closed when the checkout is unavailable.
    return null;
  }
}

/**
 * Read-only source identity for the running process.
 *
 * Packaged builds trust only their immutable embedded SOURCE_PROVENANCE.json. Development uses
 * the packaging owner's Git reader so repository selection, ignored source inputs and dirty-tree
 * semantics stay identical to package generation. Ordinary callers reuse the cached projection;
 * an explicit dev refresh is available for state:get after a source edit.
 */
export function runtimeSourceIdentity(refreshDev = false): Promise<RuntimeSourceIdentity | null> {
  if (!app.isPackaged && refreshDev) cachedIdentity = null;
  cachedIdentity ??= app.isPackaged
    ? Promise.resolve(packagedSourceIdentity())
    : developmentSourceIdentity();
  return cachedIdentity;
}
