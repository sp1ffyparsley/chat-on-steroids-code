import path from 'node:path';
import { createHash } from 'node:crypto';
import { open, stat } from 'node:fs/promises';
import type { Stats } from 'node:fs';
import { effectiveCapabilities, getConfig } from '../config.js';
import { resolvePath } from '../sandbox.js';

export const MAX_CANONICAL_SKILL_BYTES = 32 * 1024 * 1024;

/** The reviewed compact Goal has a reserved opening, even when the subsequent
 * archive pointer was damaged. A missing pointer must not discard the human
 * original's Skill intent or acceptance quality bar. */
export function isReviewedCompactGoal(scope: string): boolean {
  return /^Continue the SAME retained original objective\b/i.test(scope.trim());
}

export function sameFileSnapshot(a: Stats, b: Stats): boolean {
  return a.dev === b.dev && a.ino === b.ino && a.size === b.size &&
    a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;
}

/** Verify the original text of an adjacent, reviewed compact canonical file.
 * The archive is evidence of earlier human scope, not a new human instruction
 * and not a source of explicit Skill invocations. */
export async function archivedCanonicalMain(compact: string, id: string, canonicalReal: string): Promise<string | null> {
  if (!/prompt-scope-20261017\.json|documents\["chat-\d+\.md"\]\.text/i.test(compact)) return null;
  const pointer = /Read the complete original in ([^\r\n]+?[\\/]processed[\\/]prompt-scope-20261017\.json), documents\["(chat-\d+\.md)"\]\.text \(SHA-256 ([a-f0-9]{64})\)/i.exec(compact);
  if (!pointer || pointer[2] !== `${id}.md`) throw new Error('Canonical task has an incomplete or mismatched original-scope archive pointer');
  const expectedPath = path.join(path.dirname(canonicalReal), 'processed', 'prompt-scope-20261017.json');
  if (!path.isAbsolute(pointer[1]!) || path.normalize(pointer[1]!).toLowerCase() !== path.normalize(expectedPath).toLowerCase()) {
    throw new Error('Canonical task original-scope archive pointer does not match the adjacent approved file');
  }
  const approved = await resolvePath(getConfig().roots, expectedPath).catch(() => {
    throw new Error('Canonical task original-scope archive is unavailable in approved folders');
  });
  const handle = await open(approved.real, 'r').catch(() => {
    throw new Error('Canonical task original-scope archive could not be opened');
  });
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.size <= 0 || before.size > MAX_CANONICAL_SKILL_BYTES) {
      throw new Error('Canonical task original-scope archive is empty or exceeds the 32 MiB read limit');
    }
    const chunks: Buffer[] = [];
    let received = 0;
    for await (const chunk of handle.createReadStream({ autoClose: false })) {
      const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      received += data.length;
      if (received > MAX_CANONICAL_SKILL_BYTES) throw new Error('Canonical task original-scope archive exceeds the 32 MiB read limit');
      chunks.push(data);
    }
    const checked = await resolvePath(getConfig().roots, expectedPath);
    if (received !== before.size || !sameFileSnapshot(before, await handle.stat()) ||
        checked.real !== approved.real || !sameFileSnapshot(before, await stat(checked.real)) ||
        !effectiveCapabilities(getConfig()).read) {
      throw new Error('Canonical task original-scope archive changed during preparation');
    }
    const raw = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, received));
    const document = JSON.parse(raw) as { schema?: string; documents?: Record<string, { sha256?: string; text?: string }> };
    const entry = document.schema === 'spiffy_prompt_scope_archive_v1' ? document.documents?.[`${id}.md`] : null;
    if (!entry || typeof entry.text !== 'string' || typeof entry.sha256 !== 'string' ||
        Buffer.byteLength(entry.text, 'utf8') > MAX_CANONICAL_SKILL_BYTES ||
        entry.sha256.toLowerCase() !== pointer[3]!.toLowerCase() ||
        createHash('sha256').update(entry.text).digest('hex') !== pointer[3]!.toLowerCase()) {
      throw new Error('Canonical task original-scope archive document is missing or hash-mismatched');
    }
    const marker = `<!-- source: ${id} -->`;
    const start = entry.text.indexOf(marker);
    const end = start < 0 ? -1 : entry.text.indexOf('<!-- end-source -->', start + marker.length);
    if (start < 0 || end < 0) throw new Error('Canonical task original-scope archive has an incomplete main prompt');
    return entry.text.slice(start + marker.length, end);
  } finally {
    await handle.close();
  }
}

export type VerifiedSavedGoalOriginal = {
  id: string;
  main: string;
  compactMain: string;
};

/** A reviewed saved '-goal' entry must match the complete approved Goal body.
 * A historical quotation or foreign prose containing the same path is inert.
 * The original main stays local; callers expose only derived bounded context. */
export async function readVerifiedSavedGoalOriginal(saved: string): Promise<VerifiedSavedGoalOriginal | null> {
  const pattern = /Recover the complete original scope from ([^\r\n]+?[\\/]processed[\\/]prompt-scope-20261017\.json), documents\["(chat-\d+\.md)"\]\.text/i;
  const pointer = pattern.exec(saved);
  if (!pointer) return null;
  if (!path.isAbsolute(pointer[1]!) || !effectiveCapabilities(getConfig()).read) {
    throw new Error('Canonical saved-Goal scope archive is not approved for reading');
  }
  const filename = path.join(path.dirname(path.dirname(pointer[1]!)), pointer[2]!);
  const id = pointer[2]!.slice(0, -3);
  const resolved = await resolvePath(getConfig().roots, filename).catch(() => {
    throw new Error('Canonical saved-Goal document is unavailable in approved folders');
  });
  const handle = await open(resolved.real, 'r').catch(() => {
    throw new Error('Canonical saved-Goal document could not be opened');
  });
  let full: string;
  let compactSnapshot: Stats | null = null;
  try {
    const before = await handle.stat();
    compactSnapshot = before;
    if (!before.isFile() || before.size <= 0 || before.size > MAX_CANONICAL_SKILL_BYTES) {
      throw new Error('Canonical saved-Goal document exceeds the safe read limit');
    }
    const bytes = await handle.readFile();
    const checked = await resolvePath(getConfig().roots, filename);
    if (bytes.length !== before.size || !sameFileSnapshot(before, await handle.stat()) ||
        checked.real !== resolved.real || !sameFileSnapshot(before, await stat(checked.real)) ||
        !effectiveCapabilities(getConfig()).read) {
      throw new Error('Canonical saved-Goal document changed while reading');
    }
    full = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } finally {
    await handle.close();
  }
  const goalMarker = `<!-- source: ${id}-goal -->`;
  const goalStart = full.indexOf(goalMarker);
  const goalEnd = goalStart < 0 ? -1 : full.indexOf('<!-- end-source -->', goalStart + goalMarker.length);
  const mainMarker = `<!-- source: ${id} -->`;
  const mainStart = full.indexOf(mainMarker);
  const mainEnd = mainStart < 0 ? -1 : full.indexOf('<!-- end-source -->', mainStart + mainMarker.length);
  if (goalStart < 0 || goalEnd < 0 || mainStart < 0 || mainEnd < 0) {
    throw new Error('Canonical saved-Goal pointer disagrees with the approved compact document');
  }
  const approvedGoal = full.slice(goalStart + goalMarker.length, goalEnd).trim();
  if (saved.trim() !== approvedGoal) return null;
  const compactMain = full.slice(mainStart + mainMarker.length, mainEnd);
  const main = await archivedCanonicalMain(compactMain, id, resolved.real);
  if (!main) throw new Error('Canonical saved-Goal document lacks its pinned full original');
  // This second source-identity fence comes AFTER the archive I/O. Otherwise a
  // concurrent editor could replace the compact pointer while the originally
  // approved archived text was still being read.
  const final = await resolvePath(getConfig().roots, filename);
  if (!compactSnapshot || final.real !== resolved.real ||
      !sameFileSnapshot(compactSnapshot, await stat(final.real)) || !effectiveCapabilities(getConfig()).read) {
    throw new Error('Canonical saved-Goal document changed during original-scope recovery');
  }
  return { id, main, compactMain };
}
