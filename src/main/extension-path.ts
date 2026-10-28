/**
 * Where the Chrome extension lives on this machine.
 *
 * Chrome loads an unpacked extension from a real folder, so the extension cannot live
 * inside the asar — it ships as an extraResource and is copied out verbatim by the
 * package. Development can point Chrome at the repo's own `extension/`, but a packaged
 * build first mirrors `resources/extension` into the app's stable per-user data directory.
 * That extra hop matters on Linux AppImage: `process.resourcesPath` lives in a temporary
 * mount which disappears when the app exits, while Chrome remembers the exact folder used
 * for Load unpacked. The per-user copy keeps that path stable on every desktop OS and is
 * refreshed from the package on every launch/update.
 */

import { createHash, randomBytes } from 'node:crypto';
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync
} from 'node:fs';
import path from 'node:path';
import { app } from 'electron';
import { logInfo, logWarn } from './logger.js';

const MATERIALIZED_FINGERPRINT = '.chat-on-steroids-source';

/**
 * One-use page owned by an already-paired unpacked companion.
 *
 * The extension origin is the OS-encrypted origin frozen during pairing; never guess an id or
 * inspect browser profiles. The popup spends the nonce before requesting worker-owned reload.
 * The legacy close marker stays wire-compatible; current popups retain an unconfirmed recovery
 * tab because a reload request or torn-down response channel is not loaded-successor proof.
 */
export function companionReloadUrl(origin: string | null, nonce: string): string | null {
  if (!origin || !/^chrome-extension:\/\/[a-p]{32}\/?$/.test(origin) || !/^[a-zA-Z0-9_-]{1,64}$/.test(nonce)) return null;
  const url = new URL('/popup.html', origin.endsWith('/') ? origin : `${origin}/`);
  url.searchParams.set('clf-reload', '1');
  url.searchParams.set('nonce', nonce);
  url.searchParams.set('close', '1');
  return url.toString();
}

function extensionFingerprint(root: string): string {
  const hash = createHash('sha256');
  const visit = (dir: string, relativeDir = ''): void => {
    const entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const relative = relativeDir ? path.posix.join(relativeDir, entry.name) : entry.name;
      // The marker describes these bytes; it is not itself package content.
      if (relative === MATERIALIZED_FINGERPRINT) continue;
      const absolute = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        hash.update(`d\0${relative}\0`);
        visit(absolute, relative);
      } else if (entry.isFile()) {
        hash.update(`f\0${relative}\0`);
        hash.update(readFileSync(absolute));
        hash.update('\0');
      } else {
        // The shipped extension is plain files/directories. Refuse an unexpected special entry
        // instead of materializing host-dependent links/devices into Chrome's trusted folder.
        throw new Error(`Unsupported extension entry: ${relative}`);
      }
    }
  };
  visit(root);
  return hash.digest('hex');
}

function validExtension(dir: string): boolean {
  try {
    return statSync(path.join(dir, 'manifest.json')).isFile();
  } catch {
    return false;
  }
}

function materializedFingerprint(dir: string): string | null {
  try {
    return readFileSync(path.join(dir, MATERIALIZED_FINGERPRINT), 'utf8').trim() || null;
  } catch {
    return null;
  }
}

/** All packaged profiles share one publisher, not an account-window lifetime.
 * Atomic mkdir is the cross-process admission boundary. Never wait on Main's
 * synchronous startup or steal a live/unknown owner because a clock expired. */
function acquireMaterialization(stable: string): (() => void) | null {
  const lock = `${stable}.materialize.lock`;
  const ownerPath = path.join(lock, 'owner.json');
  const nonce = randomBytes(16).toString('hex');
  const owner = JSON.stringify({ version: 1, pid: process.pid, nonce });
  const readOwner = (): { bytes: string; pid: number } | null => {
    try {
      const directory = lstatSync(lock), info = lstatSync(ownerPath);
      if (!directory.isDirectory() || directory.isSymbolicLink() || !info.isFile() || info.isSymbolicLink() || info.size > 2048) return null;
      const bytes = readFileSync(ownerPath, 'utf8');
      const row = JSON.parse(bytes);
      return row && typeof row === 'object' && !Array.isArray(row) && Object.keys(row).sort().join(',') === 'nonce,pid,version' &&
        row.version === 1 && Number.isSafeInteger(row.pid) && row.pid > 0 && row.pid <= 0xffff_ffff &&
        typeof row.nonce === 'string' && /^[a-f0-9]{32}$/.test(row.nonce)
        ? { bytes, pid: row.pid } : null;
    } catch { return null; }
  };
  const ownerAbsent = (pid: number): boolean => {
    try { process.kill(pid, 0); return false; }
    catch (error) { return (error as NodeJS.ErrnoException).code === 'ESRCH'; }
  };
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      mkdirSync(lock);
      try { writeFileSync(ownerPath, owner, { encoding: 'utf8', flag: 'wx', mode: 0o600 }); }
      catch (error) { rmSync(lock, { recursive: true, force: true }); throw error; }
      return () => {
        if (readOwner()?.bytes !== owner) return;
        try { rmSync(lock, { recursive: true, force: true }); }
        catch { logWarn('Browser companion materialization lock release failed; inspect its exact owner before retrying.'); }
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    const previous = readOwner();
    if (!previous || !ownerAbsent(previous.pid)) {
      logWarn(previous
        ? `Browser companion publisher PID ${previous.pid} is live or inaccessible; its shared lock was not stolen.`
        : 'Browser companion publisher ownership is unreadable or incomplete; inspect extension.materialize.lock before retrying.');
      return null;
    }
    // Only ONE reclaimer may rename a positively dead owner's directory. A late
    // reclaimer that reaches a new live owner's path rereads its identity AFTER
    // acquiring this marker and cannot move that replacement lock. An existing
    // recovery marker is ambiguous (including a second crash), never age-stolen.
    const recoveryPath = path.join(lock, 'recovering');
    const recovery = JSON.stringify({ pid: process.pid, nonce });
    let recovering = false;
    try {
      if (readdirSync(lock).join(',') !== 'owner.json') {
        logWarn('Browser companion publisher recovery is already claimed or contains unknown records; retaining its lock and previous shared copy.');
        return null;
      }
      writeFileSync(recoveryPath, recovery, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
      recovering = true;
      if (readOwner()?.bytes !== previous.bytes || !ownerAbsent(previous.pid) ||
          readdirSync(lock).sort().join(',') !== 'owner.json,recovering') return null;
      const retired = `${lock}.recovered-${nonce}`;
      renameSync(lock, retired);
      recovering = false;
      rmSync(retired, { recursive: true, force: true });
      logInfo('Browser companion materialization recovered a verified absent process owner.');
    } catch {
      logWarn('Browser companion absent-owner recovery could not be verified; retaining shared publisher custody for inspection.');
      return null;
    }
    finally {
      if (recovering) {
        try { if (readFileSync(recoveryPath, 'utf8') === recovery) unlinkSync(recoveryPath); } catch { /* Never remove another claimant. */ }
      }
    }
  }
  return null;
}

/**
 * Identity of the exact companion bytes currently published for Chrome.
 *
 * Each isolated COS account owns a separate Chrome extension process. Updating the shared
 * unpacked directory does not reload those already-running processes, so startup compares this
 * value with that account's last activated fingerprint before deciding whether it must request
 * a one-use companion reload.
 */
export function companionMaterializedFingerprint(dir: string | null): string | null {
  return dir ? materializedFingerprint(dir) : null;
}

function recoverInterruptedMaterialization(stable: string, stage: string, backup: string): void {
  if (validExtension(stable)) return;

  // The backup is authoritative over staging: it was the previously published Chrome folder,
  // whereas `.new` may have been copied but not yet promoted when the process stopped.
  if (validExtension(backup)) {
    if (existsSync(stable)) rmSync(stable, { recursive: true, force: true });
    renameSync(backup, stable);
    rmSync(stage, { recursive: true, force: true });
    return;
  }

  // First-install crashes have no old copy to restore. A staged tree is recoverable only after
  // our fingerprint marker was written, which happens after the recursive copy and manifest
  // validation complete. A partial `.new` without that marker is never promoted.
  if (validExtension(stage) && materializedFingerprint(stage) !== null) {
    if (existsSync(stable)) rmSync(stable, { recursive: true, force: true });
    renameSync(stage, stable);
  }
}

/**
 * Refreshes the Chrome-visible copy transactionally while keeping its pathname stable.
 *
 * Copying package files directly into a folder Chrome already remembers makes an update
 * destructive before it is known-good: a stale destination shape, disk error, or interrupted
 * copy can leave a mixture of two extension versions. Stage the complete source beside the live
 * directory, then rename it into place. Directory rename is atomic on the same filesystem. The
 * backup makes the two-rename replacement recoverable, and a failed refresh keeps serving the
 * previous valid copy instead of disabling the extension-folder UI.
 */
function materializePackagedExtension(bundled: string, stable: string): string | null {
  mkdirSync(path.dirname(stable), { recursive: true });
  const release = acquireMaterialization(stable);
  if (!release) {
    logWarn('Browser companion materialization deferred: publisher is live or ownership is unknown; retaining the previous valid shared copy.');
    return validExtension(stable) ? stable : null;
  }
  try { return materializePackagedExtensionLocked(bundled, stable); }
  finally { release(); }
}

function materializePackagedExtensionLocked(bundled: string, stable: string): string | null {
  const stage = `${stable}.new`;
  const backup = `${stable}.old`;
  recoverInterruptedMaterialization(stable, stage, backup);

  // The package is the update source, not the only usable copy. If an installed resource is
  // damaged after a successful earlier materialization, keep exposing the last-known-good stable
  // folder so Chrome and Finder do not lose a working extension merely because refresh is broken.
  if (!validExtension(bundled)) {
    logWarn('Browser companion package manifest is missing or unreadable; retaining the previous shared copy, not certifying it as current.');
    return validExtension(stable) ? stable : null;
  }
  const fingerprint = extensionFingerprint(bundled);
  const stableFingerprint = validExtension(stable) ? extensionFingerprint(stable) : null;
  if (stableFingerprint === fingerprint && materializedFingerprint(stable) === fingerprint) {
    logInfo(`Browser companion shared package fingerprint already current (${fingerprint}); Chrome loaded bytes are not implied.`);
    return stable;
  }
  logInfo(`Browser companion shared refresh needed: package=${fingerprint} stable=${stableFingerprint ?? 'missing'}; previous valid copy stays until verified promotion.`);
  rmSync(stage, { recursive: true, force: true });

  let oldMoved = false;
  try {
    cpSync(bundled, stage, { recursive: true, force: true });
    if (!validExtension(stage)) throw new Error('Staged extension is missing manifest.json');
    if (extensionFingerprint(stage) !== fingerprint || extensionFingerprint(bundled) !== fingerprint)
      throw new Error('Packaged companion changed or staged copy is incomplete');
    writeFileSync(path.join(stage, MATERIALIZED_FINGERPRINT), fingerprint, { encoding: 'utf8', mode: 0o600 });

    // Only now do we have both a complete replacement and whatever last-known-good published
    // copy survived recovery above. It is safe to retire a stale backup from an older transaction.
    rmSync(backup, { recursive: true, force: true });
    if (existsSync(stable)) {
      if (validExtension(stable)) {
        renameSync(stable, backup);
        oldMoved = true;
      } else {
        // Never preserve a known-corrupt directory as the rollback authority. This removal is
        // delayed until the new staged tree has been completely copied and fingerprinted.
        rmSync(stable, { recursive: true, force: true });
      }
    }
    try {
      renameSync(stage, stable);
    } catch (error) {
      if (oldMoved && !existsSync(stable) && existsSync(backup)) renameSync(backup, stable);
      throw error;
    }
    if (oldMoved) rmSync(backup, { recursive: true, force: true });
    logInfo('Browser companion shared copy published from the current installed package; loaded Chrome bytes still require their own receipt.');
    return stable;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code;
    logWarn(`Browser companion refresh failed (${typeof code === 'string' && /^[A-Z0-9_]{1,32}$/.test(code) ? code : 'copy_or_promotion_unverified'}); retaining the previous valid shared copy and recoverable staging.`);
    // If rollback succeeded, the stale/partial stage is disposable. If no published copy exists,
    // preserve a completed stage or backup for the next startup's recovery instead of deleting
    // the only remaining recoverable material.
    if (validExtension(stable)) rmSync(stage, { recursive: true, force: true });
    // Promotion never mutates the old directory in place. If it is still valid, keeping it is a
    // strictly safer recovery than telling the user the extension disappeared during an update.
    return validExtension(stable) ? stable : null;
  }
}

/**
 * The folder to open for chrome://extensions → Load unpacked, or null if it is missing.
 *
 * Packaged first: in an installed build the source tree is not present at all, and in a
 * dev run process.resourcesPath points into Electron's own resources, where there is no
 * extension folder — so the checkout path is what answers there.
 */
let sharedStableExtensionRoot: string | null = null;

/** An isolated account reuses the installed companion already loaded in its Chrome profile. */
export function usePrimaryStableExtensionRoot(canonicalUserDataRoot: string): void {
  if (!path.isAbsolute(canonicalUserDataRoot)) throw new Error('Primary extension root must be absolute');
  sharedStableExtensionRoot = path.resolve(canonicalUserDataRoot);
}

export function extensionDir(): string | null {
  if (app.isPackaged) {
    const bundled = path.join(process.resourcesPath, 'extension');
    const stable = path.join(sharedStableExtensionRoot ?? app.getPath('userData'), 'extension');
    // Isolated profiles may be the only eligible running accounts. Every process
    // joins the same bounded publication lock; no personal account must be launched.
    try {
      return materializePackagedExtension(bundled, stable);
    } catch (error) {
      // Fingerprinting itself can fail if the packaged resource is damaged. A previously
      // materialized extension remains useful and must not be hidden merely because the update
      // source is unreadable.
      const code = (error as NodeJS.ErrnoException)?.code;
      logWarn(`Browser companion package publication could not be verified (${typeof code === 'string' && /^[A-Z0-9_]{1,32}$/.test(code) ? code : 'fingerprint_or_lock_unverified'}); retaining any valid shared copy, not certifying current or loaded bytes.`);
      return validExtension(stable) ? stable : null;
    }
  }

  const candidates = [
    path.join(app.getAppPath(), 'extension'),
    path.join(process.cwd(), 'extension'),
    path.join(process.resourcesPath, 'extension')
  ];
  for (const candidate of candidates) {
    if (existsSync(path.join(candidate, 'manifest.json'))) return candidate;
  }
  return null;
}
