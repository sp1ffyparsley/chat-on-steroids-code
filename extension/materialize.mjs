/** Shared, atomic companion publisher. Main and the offline release operator use this same owner.
 * Publication changes disk assets only; it never launches Chrome, reloads a worker, changes pairing or grants Send. */
import { createHash, randomBytes } from 'node:crypto';
import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
const MATERIALIZED_FINGERPRINT = '.chat-on-steroids-source';

function publicationGeneration(root) {
  try {
    const manifest = JSON.parse(readFileSync(path.join(root, 'manifest.json'), 'utf8'));
    const version = /^(0|[1-9]\d{0,4})\.(0|[1-9]\d{0,4})\.(0|[1-9]\d{0,4})$/.exec(manifest.version);
    if (!version) return null;
    const revisions = [['background.js', 'PAGE_RECORDER_VERSION'], ['content.js', 'RECORDER_VERSION'], ['fiber.js', 'PRODUCER_VERSION']]
      .map(([file, name]) => {
        const full = path.join(root, file), info = lstatSync(full);
        if (!info.isFile() || info.isSymbolicLink() || info.size > 8 * 1024 * 1024) return null;
        const matches = [...readFileSync(full, 'utf8').matchAll(new RegExp('^\\s*const ' + name + ' = ([1-9]\\d{0,6});\\s*$', 'gm'))];
        return matches.length === 1 ? Number(matches[0][1]) : null;
      });
    return { version: version.slice(1).map(Number), recorder: revisions[0] !== null && revisions.every(n => n === revisions[0]) ? revisions[0] : null };
  } catch { return null; }
}

function newerPublication(stable, bundled) {
  const current = publicationGeneration(stable), source = publicationGeneration(bundled);
  if (!current || !source) return false;
  for (let i = 0; i < 3; i++) if (current.version[i] !== source.version[i]) return current.version[i] > source.version[i];
  return current.recorder !== null && source.recorder !== null && current.recorder > source.recorder;
}

export function extensionFingerprint(root) {
  const hash = createHash('sha256');
  const visit = (dir, relativeDir = '') => {
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

export function validExtension(dir) {
  try {
    const root = lstatSync(dir), manifest = lstatSync(path.join(dir, 'manifest.json'));
    return root.isDirectory() && !root.isSymbolicLink() && manifest.isFile() && !manifest.isSymbolicLink();
  } catch {
    return false;
  }
}

function materializedFingerprint(dir) {
  try {
    return readFileSync(path.join(dir, MATERIALIZED_FINGERPRINT), 'utf8').trim() || null;
  } catch {
    return null;
  }
}

/** All packaged profiles share one publisher, not an account-window lifetime.
 * Atomic mkdir is the cross-process admission boundary. Never wait on Main's
 * synchronous startup or steal a live/unknown owner because a clock expired. */
function acquireMaterialization(stable, logger) {
  const lock = `${stable}.materialize.lock`;
  const ownerPath = path.join(lock, 'owner.json');
  const nonce = randomBytes(16).toString('hex');
  const owner = JSON.stringify({ version: 1, pid: process.pid, nonce });
  const readOwner = () => {
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
  const ownerAbsent = (pid) => {
    try { process.kill(pid, 0); return false; }
    catch (error) { return (error).code === 'ESRCH'; }
  };
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      mkdirSync(lock);
      try { writeFileSync(ownerPath, owner, { encoding: 'utf8', flag: 'wx', mode: 0o600 }); }
      catch (error) { rmSync(lock, { recursive: true, force: true }); throw error; }
      return () => {
        if (readOwner()?.bytes !== owner) return;
        try { rmSync(lock, { recursive: true, force: true }); }
        catch { logger.warn('Browser companion materialization lock release failed; inspect its exact owner before retrying.'); }
      };
    } catch (error) {
      if ((error).code !== 'EEXIST') throw error;
    }
    const previous = readOwner();
    if (!previous || !ownerAbsent(previous.pid)) {
      logger.warn(previous
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
        logger.warn('Browser companion publisher recovery is already claimed or contains unknown records; retaining its lock and previous shared copy.');
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
      logger.info('Browser companion materialization recovered a verified absent process owner.');
    } catch {
      logger.warn('Browser companion absent-owner recovery could not be verified; retaining shared publisher custody for inspection.');
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
export function companionMaterializedFingerprint(dir) {
  try {
    const marker = dir && materializedFingerprint(dir);
    return dir && /^[a-f0-9]{64}$/.test(marker ?? '') && extensionFingerprint(dir) === marker ? marker : null;
  } catch { return null; }
}

function recoverInterruptedMaterialization(stable, stage, backup) {
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
  if (validExtension(stage) && companionMaterializedFingerprint(stage) !== null) {
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
export function materializePackagedExtension(bundled, stable, options = {}) {
  const logger = options.logger ?? { info: (text) => console.error(text), warn: (text) => console.error(text) };
  mkdirSync(path.dirname(stable), { recursive: true });
  const release = acquireMaterialization(stable, logger);
  if (!release) {
    logger.warn('Browser companion materialization deferred: publisher is live or ownership is unknown; retaining the previous valid shared copy.');
    return validExtension(stable) ? stable : null;
  }
  try { return materializePackagedExtensionLocked(bundled, stable, options, logger); }
  finally { release(); }
}

function materializePackagedExtensionLocked(bundled, stable, options, logger) {
  const stage = `${stable}.new`;
  const backup = `${stable}.old`;
  if (options.expectedSourceFingerprint !== undefined && (!validExtension(bundled) || extensionFingerprint(bundled) !== options.expectedSourceFingerprint))
    throw Object.assign(new Error('Companion source changed; no recovery or promotion was attempted.'), { code: 'PUBLICATION_SOURCE_CHANGED' });
  if (options.expectedCurrentFingerprint !== undefined && (validExtension(stable) ? extensionFingerprint(stable) : null) !== options.expectedCurrentFingerprint)
    throw Object.assign(new Error('Shared companion changed; no recovery or promotion was attempted.'), { code: 'PUBLICATION_CHANGED' });
  recoverInterruptedMaterialization(stable, stage, backup);

  // The package is the update source, not the only usable copy. If an installed resource is
  // damaged after a successful earlier materialization, keep exposing the last-known-good stable
  // folder so Chrome and Finder do not lose a working extension merely because refresh is broken.
  if (!validExtension(bundled)) {
    logger.warn('Browser companion package manifest is missing or unreadable; retaining the previous shared copy, not certifying it as current.');
    return validExtension(stable) ? stable : null;
  }
  const fingerprint = extensionFingerprint(bundled);
  const stableFingerprint = validExtension(stable) ? extensionFingerprint(stable) : null;
  if (options.expectedSourceFingerprint !== undefined && options.expectedSourceFingerprint !== fingerprint)
    throw Object.assign(new Error('Companion source changed before staging.'), { code: 'PUBLICATION_SOURCE_CHANGED' });
  if (options.allowDowngrade === true && (!/^[a-f0-9]{64}$/.test(options.expectedSourceFingerprint ?? '') ||
      !/^[a-f0-9]{64}$/.test(options.expectedCurrentFingerprint ?? '') || options.expectedCurrentFingerprint !== stableFingerprint))
    throw new Error('Explicit rollback requires both exact source and prior publication fingerprints.');
  if (stableFingerprint && materializedFingerprint(stable) === stableFingerprint &&
      newerPublication(stable, bundled) && options.allowDowngrade !== true) {
    logger.warn('Browser companion publication retained a coherent newer generation; the older package was not published. Loaded Chrome bytes remain unverified.');
    return stable;
  }
  if (stableFingerprint === fingerprint && materializedFingerprint(stable) === fingerprint) {
    logger.info(`Browser companion shared package fingerprint already current (${fingerprint}); Chrome loaded bytes are not implied.`);
    return stable;
  }
  logger.info(`Browser companion shared refresh needed: package=${fingerprint} stable=${stableFingerprint ?? 'missing'}; previous valid copy stays until verified promotion.`);
  rmSync(stage, { recursive: true, force: true });

  let oldMoved = false;
  try {
    cpSync(bundled, stage, { recursive: true, force: true });
    if (!validExtension(stage)) throw new Error('Staged extension is missing manifest.json');
    if (extensionFingerprint(stage) !== fingerprint || extensionFingerprint(bundled) !== fingerprint)
      throw new Error('Packaged companion changed or staged copy is incomplete');
    writeFileSync(path.join(stage, MATERIALIZED_FINGERPRINT), fingerprint, { encoding: 'utf8', mode: 0o600 });
    if ((validExtension(stable) ? extensionFingerprint(stable) : null) !== stableFingerprint)
      throw Object.assign(new Error('Shared companion changed while staging; its newer publication was retained.'), { code: 'PUBLICATION_CHANGED' });

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
    logger.info('Browser companion shared copy published from the current installed package; loaded Chrome bytes still require their own receipt.');
    return stable;
  } catch (error) {
    const code = (error)?.code;
    logger.warn(`Browser companion refresh failed (${typeof code === 'string' && /^[A-Z0-9_]{1,32}$/.test(code) ? code : 'copy_or_promotion_unverified'}); retaining the previous valid shared copy and recoverable staging.`);
    // If rollback succeeded, the stale/partial stage is disposable. If no published copy exists,
    // preserve a completed stage or backup for the next startup's recovery instead of deleting
    // the only remaining recoverable material.
    if (validExtension(stable)) rmSync(stage, { recursive: true, force: true });
    // Promotion never mutates the old directory in place. If it is still valid, keeping it is a
    // strictly safer recovery than telling the user the extension disappeared during an update.
    return validExtension(stable) ? stable : null;
  }
}

/** Finite disk preparation for the existing release/lifecycle operator. No app or browser startup. */
function prepareFromCommandLine(argv) {
  const names = new Set(['--source', '--expected-source', '--expected-current']);
  const values = new Map();
  let allowDowngrade = false;
  for (let index = 0; index < argv.length; index++) {
    const key = argv[index];
    if (key === '--allow-downgrade' && !allowDowngrade) { allowDowngrade = true; continue; }
    if (!names.has(key) || values.has(key) || !argv[index + 1] || argv[index + 1].startsWith('--'))
      throw new Error('Use --source PATH --expected-source SHA256 --expected-current SHA256|missing; explicit rollback additionally uses --allow-downgrade.');
    values.set(key, argv[++index]);
  }
  if (values.size !== 3 || !path.isAbsolute(values.get('--source') ?? '') ||
      !/^[a-f0-9]{64}$/.test(values.get('--expected-source') ?? '') ||
      !/^(?:[a-f0-9]{64}|missing)$/.test(values.get('--expected-current') ?? ''))
    throw new Error('Offline preparation requires an absolute qualified source and exact prior/source fingerprints.');
  const appData = process.platform === 'win32' ? process.env.APPDATA : process.platform === 'darwin'
    ? path.join(homedir(), 'Library', 'Application Support') : process.env.XDG_CONFIG_HOME || path.join(homedir(), '.config');
  if (!appData || !path.isAbsolute(appData)) throw new Error('Canonical application data root is unavailable.');
  const source = path.resolve(values.get('--source')), stable = path.join(appData, 'chat-on-steroids', 'extension');
  const plain = value => {
    for (let cursor = value; cursor; cursor = path.dirname(cursor) === cursor ? '' : path.dirname(cursor))
      if (existsSync(cursor) && (!lstatSync(cursor).isDirectory() || lstatSync(cursor).isSymbolicLink()))
        throw new Error('Companion preparation refuses redirected or non-directory ancestors.');
  };
  plain(source); plain(stable);
  const compareSource = process.platform === 'win32' ? source.toLowerCase() : source;
  const compareStable = process.platform === 'win32' ? stable.toLowerCase() : stable;
  if (compareSource === compareStable || compareSource.startsWith(compareStable + path.sep) || compareStable.startsWith(compareSource + path.sep))
    throw new Error('Qualified source and shared publication must be independent directories.');
  if (publicationGeneration(source)?.recorder == null) throw new Error('Qualified companion source has no coherent readable release generation.');
  mkdirSync(path.dirname(stable), { recursive: true });
  const result = materializePackagedExtension(source, stable, {
    expectedSourceFingerprint: values.get('--expected-source'),
    expectedCurrentFingerprint: values.get('--expected-current') === 'missing' ? null : values.get('--expected-current'),
    allowDowngrade
  });
  const fingerprint = result && validExtension(result) ? extensionFingerprint(result) : null;
  const published = fingerprint === values.get('--expected-source') && materializedFingerprint(stable) === fingerprint;
  console.log(JSON.stringify({ prepared: published, fingerprint, sourceFingerprint: values.get('--expected-source'),
    chromeLaunched: false, reloadRequested: false, nativeSend: false, loadedGenerationVerified: false }));
  if (!published) process.exitCode = 1;
}

function isCommandLineEntry() {
  try {
    if (!/(?:^|[\\/])materialize\.mjs$/i.test(process.argv[1] ?? '')) return false;
    const entry = realpathSync(process.argv[1]), module = realpathSync(fileURLToPath(import.meta.url));
    return process.platform === 'win32' ? entry.toLowerCase() === module.toLowerCase() : entry === module;
  } catch { return false; }
}

if (isCommandLineEntry()) {
  try { prepareFromCommandLine(process.argv.slice(2)); }
  catch (error) { console.error(`Companion disk preparation refused: ${error instanceof Error ? error.message : 'unverified failure'}`); process.exitCode = 1; }
}
