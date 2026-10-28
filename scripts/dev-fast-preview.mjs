import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import readline from 'node:readline';

// Disposable, foreground, renderer-asset consumption only. The Electron Main
// process, profile/bootstrap, shared out/, and Chrome are never started here.
// The incumbent --qualify-build --select-stage operation is the sole authority
// for source/compiler/compiled-output identity, including private evidence.
const SCHEMA = 'cos_dev_renderer_preview_v1';
const NAME = /^chat42-private-out-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DIGEST = /^[a-f\d]{64}$/i;
const MAX_ASSET_BYTES = 8 * 1024 * 1024;
const MAX_RENDERER_BYTES = 32 * 1024 * 1024;
const MAX_ASSET_COUNT = 2048;
const HTTP_DEADLINE_MS = 1800;
const SELECTOR_DEADLINE_MS = 15000;
const HTTP_ALL_ASSETS_DEADLINE_MS = 12000;
const NEXT_ACTION = {
  'private-preview-generation-stale-or-unverified': 'rebuild-or-reselect-current-exact-private-generation',
  'private-preview-selection-receipt-unverified': 'inspect-current-generation-and-compiler-provenance',
  'private-preview-owner-busy-or-stale': 'inspect-exact-private-preview-owner-before-retry',
  'private-preview-owner-live-or-unknown': 'wait-for-positive-original-process-exit-evidence',
  'private-preview-descendant-or-runtime-unverified': 'verify-all-original-preview-descendants-exited-before-recovery',
  'private-preview-listener-live-or-unknown': 'inspect-original-localhost-listener-before-recovery',
  'private-preview-owner-unverified': 'inspect-private-preview-lease-without-forced-cleanup',
  'private-preview-owner-birth-unverified': 'restore-verifiable-native-process-identity',
  'private-preview-health-timeout': 'inspect-private-renderer-preview-health-before-another-switch',
  'private-preview-health-response-unverified': 'inspect-private-renderer-preview-health-before-another-switch',
  'private-preview-health-bytes-mismatch': 'revalidate-private-output-before-switch',
  'private-preview-activation-cancelled': 'verify-preview-owner-and-active-generation-before-retry'
};

const sha = bytes => createHash('sha256').update(bytes).digest('hex').toUpperCase();
const elapsedMs = began => Number((process.hrtime.bigint() - began) / 1000000n);
const failure = code => { throw Object.assign(new Error(code), { code }); };
const emit = (event, data = {}) => {
  const receipt = { schema: SCHEMA, event,
    nativeRuntimeVerified: false, installedRuntimeVerified: false, ...data,
    ...(event === 'refused' ? { nextAction: NEXT_ACTION[data.reason] ??
      'review-private-preview-custody-and-qualification-before-retry',
      retrySafe: 'only-after-named-failure-is-corrected-and-source-ownership-is-clear' } : {}) };
  console.log(JSON.stringify(receipt));
  return receipt;
};

function option(args, prefix) {
  const matches = args.filter(arg => arg.startsWith(prefix));
  return matches.length === 1 ? matches[0].slice(prefix.length) : null;
}

function parseArgs(args) {
  if (args.length === 1 && args[0] === '--recover-private-preview') return { recovery: true };
  const previews = args.filter(arg => arg.startsWith('--preview-private-out='));
  const probes = args.filter(arg => arg.startsWith('--probe-private-out='));
  const allowed = ['--json', '--preview-private-out=', '--probe-private-out=',
    '--expect-source-sha256=', '--expect-compiled-sha256=', '--expect-compiler-sha256='];
  const pick = prefix => option(args, prefix);
  const generation = previews.length ? pick('--preview-private-out=') : pick('--probe-private-out=');
  const source = pick('--expect-source-sha256=');
  const compiled = pick('--expect-compiled-sha256=');
  const compiler = pick('--expect-compiler-sha256=');
  if (previews.length + probes.length !== 1 || args.filter(x => x === '--json').length !== 1 ||
      !NAME.test(generation ?? '') || !DIGEST.test(source ?? '') || !DIGEST.test(compiled ?? '') ||
      !DIGEST.test(compiler ?? '') || args.length !== 5 ||
      args.some(x => !allowed.some(prefix => prefix.endsWith('=') ? x.startsWith(prefix) : x === prefix)))
    failure('invalid-private-preview-options');
  return { recovery: false, probe: probes.length === 1, generation,
    source: source.toUpperCase(), compiled: compiled.toUpperCase(), compiler: compiler.toUpperCase() };
}

function verifyDirectory(directory) {
  const stat = lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() ||
      realpathSync.native(directory).toLowerCase() !== path.resolve(directory).toLowerCase())
    failure('private-preview-directory-unverified');
}

function verifyExactGeneration(launcher, project, desired) {
  const input = [launcher, '--qualify-build', '--json',
    `--select-stage=${desired.generation}`,
    `--expect-source-sha256=${desired.source}`,
    `--expect-compiled-sha256=${desired.compiled}`,
    `--expect-compiler-sha256=${desired.compiler}`];
  const checked = spawnSync(process.execPath, input, {
    cwd: project, encoding: 'utf8', windowsHide: true, timeout: SELECTOR_DEADLINE_MS,
    maxBuffer: 1024 * 1024
  });
  if (checked.error || checked.status !== 0) failure('private-preview-generation-stale-or-unverified');
  let proof;
  try { proof = JSON.parse(checked.stdout); }
  catch { failure('private-preview-selection-receipt-unverified'); }
  if (proof.schema !== 'cos_dev_build_qualification_v1' ||
      proof.mode !== 'exact-staged-artifact-selection' ||
      proof.stageSelectedForReview !== true || proof.accepted !== false ||
      proof.sourceSha256 !== desired.source ||
      proof.compiledOutputSha256 !== desired.compiled ||
      proof.toolchain?.electronViteCliSha256 !== desired.compiler ||
      proof.nativeRuntimeVerified !== false || proof.installedRuntimeVerified !== false ||
      proof.failures.length !== 0) failure('private-preview-selection-receipt-unverified');
  return proof;
}

function rendererMemoryDigest(contents) {
  const hash = createHash('sha256');
  for (const [name, bytes] of [...contents.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    hash.update(name);
    hash.update('\0');
    hash.update(String(bytes.length));
    hash.update('\0');
    hash.update(bytes);
    hash.update('\0');
  }
  return hash.digest('hex').toUpperCase();
}

// Use the incumbent qualifier's recordTree schema for renderer files.
// Compared after copying, this binds the exact bytes used by the HTTP
// consumer to the complete independently selected compiled generation.
function qualifiedRendererManifest(contents) {
  const files = [...contents.entries()].map(([name, bytes]) => ({
    file: `renderer/${name}`, size: bytes.length, sha256: sha(bytes)
  })).sort((a, b) => a.file.localeCompare(b.file, 'en'));
  return sha(Buffer.from(JSON.stringify(files)));
}

function loadRendererSnapshot(project, launcher, desired) {
  const temp = path.join(project, '.test_tmp');
  verifyDirectory(temp);
  const folder = path.join(temp, desired.generation, 'out', 'renderer');
  verifyDirectory(folder);
  const contents = new Map();
  let total = 0;
  const walk = (folderPath, prefix = '') => {
    for (const filename of readdirSync(folderPath).sort()) {
      if (!filename || filename === '.' || filename === '..') failure('private-preview-unsafe-asset-path');
      const relative = prefix ? `${prefix}/${filename}` : filename;
      const full = path.join(folderPath, filename);
      const stat = lstatSync(full);
      if (stat.isSymbolicLink()) failure('private-preview-linked-asset');
      if (stat.isDirectory()) { walk(full, relative); continue; }
      if (!stat.isFile() || stat.size > MAX_ASSET_BYTES || contents.size >= MAX_ASSET_COUNT)
        failure('private-preview-asset-limit');
      total += stat.size;
      if (total > MAX_RENDERER_BYTES) failure('private-preview-asset-limit');
      const bytes = readFileSync(full);
      if (bytes.length !== stat.size) failure('private-preview-asset-changed-during-read');
      contents.set(relative, bytes);
    }
  };
  walk(folder);
  if (!contents.has('index.html')) failure('private-preview-index-missing');
  // One complete selection after reading the bounded stage is sufficient:
  // its verified per-file renderer digest must match the copied bytes.
  // The activation barrier selects again after HTTP proof to fence races.
  const proof = verifyExactGeneration(launcher, project, desired);
  const manifestSha256 = qualifiedRendererManifest(contents);
  if (proof.rendererOutputFileCount !== contents.size ||
      proof.rendererOutputManifestSha256 !== manifestSha256)
    failure('private-preview-copied-renderer-bytes-unverified');
  return { ...desired, contents, memoryDigest: rendererMemoryDigest(contents),
    qualifiedRendererManifestSha256: manifestSha256,
    bytes: total, files: contents.size,
    sourceCheckout: project, outputRoot: folder, selectionRunId: proof.validationRunId };
}

function portAvailable(port) {
  return new Promise(resolve => {
    const probe = net.createServer();
    probe.unref();
    probe.once('error', () => resolve(false));
    probe.listen(port, '127.0.0.1', () => probe.close(() => resolve(true)));
  });
}

async function recoverLease(project, lease, windowsProcessBirth, windowsPostSpawnProcessesClear) {
  if (process.platform !== 'win32') failure('private-preview-recovery-requires-windows-process-evidence');
  verifyDirectory(lease);
  if (readdirSync(lease).join(',') !== 'owner.json') failure('private-preview-lease-unknown-contents');
  const ownerPath = path.join(lease, 'owner.json');
  const ownerInfo = lstatSync(ownerPath);
  if (!ownerInfo.isFile() || ownerInfo.isSymbolicLink() || ownerInfo.size > 2048)
    failure('private-preview-owner-unverified');
  const bytes = readFileSync(ownerPath, 'utf8');
  let owner;
  try { owner = JSON.parse(bytes); } catch { failure('private-preview-owner-unverified'); }
  if (owner.schema !== 1 || owner.checkout !== project ||
      !NAME.test(owner.generation) || !/^[0-9a-f-]{36}$/i.test(owner.token) ||
      !Number.isSafeInteger(owner.pid) || owner.pid < 1 ||
      !/^\d{4}-\d\d-\d\dT/.test(owner.startedAt ?? '') ||
      !['reserved', 'listening', 'switching'].includes(owner.phase) ||
      !(owner.port === null || (Number.isSafeInteger(owner.port) && owner.port > 0 && owner.port <= 65535)))
    failure('private-preview-owner-unverified');
  if (owner.phase === 'listening' && owner.port === null)
    failure('private-preview-owner-unverified');
  const validGeneration = value => value === null || (value && NAME.test(value.generation) &&
    DIGEST.test(value.source) && DIGEST.test(value.compiled) && DIGEST.test(value.compiler));
  if (![owner.active ?? null, owner.previous ?? null, owner.pending ?? null].every(validGeneration) ||
      (owner.phase === 'switching' && (!owner.pending || owner.port === null)))
    failure('private-preview-owner-unverified');
  if (windowsProcessBirth(owner.pid) !== 'absent') failure('private-preview-owner-live-or-unknown');
  if (owner.port !== null && !(await portAvailable(owner.port)))
    failure('private-preview-listener-live-or-unknown');
  if (windowsProcessBirth(owner.pid) !== 'absent' ||
      (owner.port !== null && !(await portAvailable(owner.port))))
    failure('private-preview-owner-live-or-unknown');
  // A crashed preview may have been killed while its exact source-selector
  // subprocess was still running. Windows preserves the original parent PID
  // on descendants after the parent dies. Fail closed until the incumbent
  // read-only process-tree/checkout-runtime census positively clears them.
  if (!windowsPostSpawnProcessesClear(owner.pid, owner.pid))
    failure('private-preview-descendant-or-runtime-unverified');
  if (readFileSync(ownerPath, 'utf8') !== bytes || readdirSync(lease).join(',') !== 'owner.json')
    failure('private-preview-owner-changed');
  const quarantined = path.join(path.dirname(lease), `.chat42-recovered-preview-${randomUUID()}`);
  renameSync(lease, quarantined); // One atomic recovery claimant; loser refuses.
  if (readFileSync(path.join(quarantined, 'owner.json'), 'utf8') !== bytes)
    failure('private-preview-owner-changed');
  unlinkSync(path.join(quarantined, 'owner.json'));
  rmdirSync(quarantined);
  return { recovered: true, listenerCleared: true, runtimeStarted: false,
    lastConfirmed: owner.active ?? null,
    interruptedTransition: owner.phase === 'switching',
    pendingUnconfirmed: owner.phase === 'switching' ? owner.pending : null };
}

function reserveLease(project, lease, generation, windowsProcessBirth) {
  const birth = process.platform === 'win32' ? windowsProcessBirth(process.pid) : new Date().toISOString();
  if (!birth || birth === 'absent') failure('private-preview-owner-birth-unverified');
  try { mkdirSync(lease); } // Atomic exclusion against second foreground consumer.
  catch { failure('private-preview-owner-busy-or-stale'); }
  const owner = { schema: 1, checkout: project, generation, pid: process.pid,
    startedAt: birth, token: randomUUID(), phase: 'reserved', port: null,
    active: null, previous: null, pending: null };
  const file = path.join(lease, 'owner.json');
  try { writeFileSync(file, JSON.stringify(owner), { flag: 'wx' }); }
  catch { failure('private-preview-owner-write-unverified'); }
  return owner;
}

function updateLease(lease, owner, port) {
  const file = path.join(lease, 'owner.json');
  const stat = lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 2048)
    failure('private-preview-lease-owner-changed');
  const previousBytes = readFileSync(file, 'utf8');
  let current;
  try { current = JSON.parse(previousBytes); }
  catch { failure('private-preview-lease-owner-changed'); }
  if (current.token !== owner.token || current.pid !== owner.pid ||
      current.startedAt !== owner.startedAt ||
      current.phase !== owner.phase || JSON.stringify(current) !== JSON.stringify(owner))
    failure('private-preview-lease-owner-changed');
  const next = { ...owner, ...(typeof port === 'number' ?
    { phase: 'listening', port } : port) };
  const temporary = path.join(lease, `${owner.token}.tmp`);
  writeFileSync(temporary, JSON.stringify(next), { flag: 'wx' });
  if (readFileSync(file, 'utf8') !== previousBytes)
    failure('private-preview-lease-owner-changed');
  renameSync(temporary, file);
  return next;
}

function releaseLease(lease, token) {
  try {
    if (readdirSync(lease).join(',') !== 'owner.json') return false;
    const file = path.join(lease, 'owner.json');
    const owner = JSON.parse(readFileSync(file, 'utf8'));
    if (owner.token !== token) return false;
    const quarantine = path.join(path.dirname(lease), `.chat42-released-preview-${randomUUID()}`);
    renameSync(lease, quarantine);
    if (JSON.parse(readFileSync(path.join(quarantine, 'owner.json'), 'utf8')).token !== token) return false;
    unlinkSync(path.join(quarantine, 'owner.json'));
    rmdirSync(quarantine);
    return true;
  } catch { return false; }
}

function assetType(name) {
  if (name.endsWith('.html')) return 'text/html; charset=utf-8';
  if (name.endsWith('.js')) return 'application/javascript; charset=utf-8';
  if (name.endsWith('.css')) return 'text/css; charset=utf-8';
  if (name.endsWith('.svg')) return 'image/svg+xml';
  if (name.endsWith('.woff2')) return 'font/woff2';
  if (name.endsWith('.woff')) return 'font/woff';
  if (name.endsWith('.png')) return 'image/png';
  if (name.endsWith('.webp')) return 'image/webp';
  return 'application/octet-stream';
}

const generationIdentity = generation => generation ? {
  generation: generation.generation, source: generation.source,
  compiled: generation.compiled, compiler: generation.compiler
} : null;

export async function runPrivateRendererPreview({
  args, project, launcher, windowsProcessBirth, windowsPostSpawnProcessesClear,
  onReceipt = null, externalSignal = null
}) {
  const report = (event, data) => {
    const receipt = emit(event, data);
    onReceipt?.(receipt);
  };
  let options;
  try { options = parseArgs(args); }
  catch (error) { report('refused', { reason: error.code ?? 'private-preview-options-unverified' }); return 1; }
  const temp = path.join(project, '.test_tmp');
  const lease = path.join(temp, '.chat42-private-preview-owner');
  if (options.recovery) {
    try {
      verifyDirectory(temp);
      report('recovered', await recoverLease(project, lease,
        windowsProcessBirth, windowsPostSpawnProcessesClear));
      return 0;
    } catch (error) { report('refused', { reason: error.code ?? 'private-preview-recovery-unverified' }); return 1; }
  }
  let owner = null;
  let server = null;
  let current = null;
  let pending = null;
  let previous = null;
  let stoppedBy = 'stdin-closed';
  let cleanupVerified = false;
  let leaseHealthy = true;
  let cancellationSignal = null;
  let inputReader = null;
  const onSignal = signal => {
    if (!cancellationSignal) cancellationSignal = signal;
    stoppedBy = cancellationSignal;
    inputReader?.close();
  };
  const sigint = () => onSignal('SIGINT');
  const sigterm = () => onSignal('SIGTERM');
  const externalCancel = () => onSignal('external-cancel');
  const started = process.hrtime.bigint();
  const nonce = randomUUID();
  const serverHandler = (request, response) => {
    response.setHeader('Connection', 'close');
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self'; img-src 'self' data:; connect-src 'none'; frame-ancestors 'none'");
    if (request.method !== 'GET' || typeof request.url !== 'string' || request.url.length > 1024 ||
        !request.url.startsWith(`/${nonce}/`)) { response.writeHead(404); response.end(); return; }
    const partial = request.url.slice(nonce.length + 2);
    const candidate = partial.startsWith('__pending/') ? pending : current;
    const name = partial.startsWith('__pending/') ? partial.slice('__pending/'.length) : partial;
    if (!candidate || !name || name.includes('..') || name.includes('%') || name.includes('?') || name.includes('\\')) {
      response.writeHead(404); response.end(); return;
    }
    if (name === '__health') {
      response.setHeader('Content-Type', 'application/json; charset=utf-8');
      response.writeHead(200);
      response.end(JSON.stringify({ schema: SCHEMA, ownerPid: process.pid,
        generation: candidate.generation, compiledOutputSha256: candidate.compiled,
        rendererFileCount: candidate.files, nativeRuntimeVerified: false }));
      return;
    }
    const bytes = candidate.contents.get(name);
    if (!bytes) { response.writeHead(404); response.end(); return; }
    response.setHeader('Content-Type', assetType(name));
    response.setHeader('X-CoS-Output-SHA256', candidate.compiled);
    response.writeHead(200);
    response.end(bytes);
  };

  try {
    verifyDirectory(temp);
    // Every preview is one foreground process with a single explicit owner.
    // Unknown stale leases remain untouched until --recover-private-preview
    // positively proves the original PID and listener absent.
    owner = reserveLease(project, lease, options.generation, windowsProcessBirth);
    process.on('SIGINT', sigint);
    process.on('SIGTERM', sigterm);
    externalSignal?.addEventListener('abort', externalCancel, { once: true });
    if (externalSignal?.aborted) externalCancel();
    server = http.createServer(serverHandler);
    server.requestTimeout = 3000;
    server.headersTimeout = 3000;
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const port = server.address()?.port;
    if (!Number.isSafeInteger(port) || port <= 0) failure('private-preview-listener-unverified');
    owner = updateLease(lease, owner, port);
    const target = `http://127.0.0.1:${port}/${nonce}`;
    const boundedResponse = async (url, maxBytes) => {
      const controller = new AbortController();
      let deadline;
      let expired = false;
      try {
        // Bound the full response, not just fetch() headers. A peer can send
        // a 200 and then hold the body open forever (or stream unlimited data).
        const work = (async () => {
          const response = await fetch(url, { redirect: 'error', signal: controller.signal });
          if (!response.ok) failure('private-preview-health-response-unverified');
          const declared = response.headers.get('content-length');
          if (declared !== null &&
              (!/^\d+$/.test(declared) || !Number.isSafeInteger(Number(declared)) ||
                Number(declared) > maxBytes))
            failure('private-preview-health-body-limit');
          const reader = response.body?.getReader();
          if (!reader) failure('private-preview-health-response-unverified');
          const chunks = [];
          let length = 0;
          while (true) {
            const part = await reader.read();
            if (part.done) break;
            length += part.value.byteLength;
            if (length > maxBytes) {
              controller.abort();
              failure('private-preview-health-body-limit');
            }
            chunks.push(Buffer.from(part.value));
          }
          return { response, bytes: Buffer.concat(chunks, length) };
        })();
        const timeout = new Promise((_, reject) => {
          deadline = setTimeout(() => {
            expired = true;
            controller.abort();
            reject(Object.assign(new Error('private-preview-health-timeout'),
              { code: 'private-preview-health-timeout' }));
          }, HTTP_DEADLINE_MS);
        });
        return await Promise.race([work, timeout]);
      } catch (error) {
        if (expired) failure('private-preview-health-timeout');
        throw error;
      } finally {
        clearTimeout(deadline);
        controller.abort();
      }
    };
    const probeHealth = async (snapshot, pendingCheck) => {
      const checkedAt = process.hrtime.bigint();
      const prefix = pendingCheck ? '/__pending' : '';
      const html = snapshot.contents.get('index.html');
      const { response, bytes } = await boundedResponse(`${target}${prefix}/index.html`, html.length);
      if (response.headers.get('x-cos-output-sha256') !== snapshot.compiled ||
          !response.headers.get('content-type')?.startsWith('text/html'))
        failure('private-preview-health-response-unverified');
      if (bytes.length !== html.length || sha(bytes) !== sha(html))
        failure('private-preview-health-bytes-mismatch');
      const health = await boundedResponse(`${target}${prefix}/__health`, 2048);
      if (!health.response.headers.get('content-type')?.startsWith('application/json'))
        failure('private-preview-health-response-unverified');
      let evidence;
      try { evidence = JSON.parse(health.bytes.toString('utf8')); }
      catch { failure('private-preview-health-response-unverified'); }
      if (evidence.schema !== SCHEMA || evidence.ownerPid !== process.pid ||
          evidence.generation !== snapshot.generation ||
          evidence.compiledOutputSha256 !== snapshot.compiled || evidence.nativeRuntimeVerified !== false)
        failure('private-preview-health-identity-mismatch');
      // The index alone cannot prove the served JS/CSS/fonts came from the
      // selected stage. Verify every bounded asset over the same real HTTP
      // listener BEFORE changing the active renderer, with one total deadline.
      // No application/Electron/Chrome process is started by this probe.
      for (const [name, expected] of snapshot.contents) {
        if (name === 'index.html') continue;
        if (!name || name.includes('..') || name.includes('%') ||
            name.includes('?') || name.includes('\\') ||
            elapsedMs(checkedAt) > HTTP_ALL_ASSETS_DEADLINE_MS)
          failure('private-preview-health-timeout');
        const asset = await boundedResponse(`${target}${prefix}/${name}`, expected.length);
        if (asset.response.headers.get('x-cos-output-sha256') !== snapshot.compiled ||
            asset.response.headers.get('content-type') !== assetType(name) ||
            asset.bytes.length !== expected.length || sha(asset.bytes) !== sha(expected))
          failure('private-preview-health-bytes-mismatch');
      }
      if (elapsedMs(checkedAt) > HTTP_ALL_ASSETS_DEADLINE_MS ||
          rendererMemoryDigest(snapshot.contents) !== snapshot.memoryDigest ||
          qualifiedRendererManifest(snapshot.contents) !== snapshot.qualifiedRendererManifestSha256)
        failure('private-preview-health-bytes-mismatch');
      return { httpVerifiedAssetCount: snapshot.files, httpVerifiedAssetBytes: snapshot.bytes,
        servedRendererSha256: snapshot.memoryDigest,
        qualifiedRendererManifestSha256: snapshot.qualifiedRendererManifestSha256 };
    };
    const activate = async (desired, restoring = false) => {
      const tick = process.hrtime.bigint();
      const original = current;
      try {
        if (cancellationSignal) failure('private-preview-activation-cancelled');
        // Restoration is restricted to this exact process's previously
        // health-verified bytes. A newer source edit can make the prior stage
        // ineligible for a *fresh* selection, but must not destroy a known-good
        // in-memory rollback target. Never load an unverified old disk stage.
        if (restoring && (desired !== previous ||
            !desired?.contents || rendererMemoryDigest(desired.contents) !== desired.memoryDigest))
          failure('private-preview-previous-memory-unverified');
        const candidate = restoring ? desired : loadRendererSnapshot(project, launcher, desired);
        owner = updateLease(lease, owner, { phase: 'switching',
          pending: generationIdentity(candidate) });
        pending = candidate;
        await probeHealth(candidate, true);
        if (cancellationSignal) failure('private-preview-activation-cancelled');
        const old = current;
        current = candidate;
        pending = null;
        let served;
        try { served = await probeHealth(candidate, false); }
        catch (error) {
          current = old; // No external mutation: restore the in-memory target.
          throw error;
        }
        // A source edit, modified compiler, changed published receipt, or
        // rewritten stage during HTTP checks cannot finish a transition.
        try {
          if (restoring) {
            if (rendererMemoryDigest(candidate.contents) !== candidate.memoryDigest)
              failure('private-preview-previous-memory-unverified');
          } else verifyExactGeneration(launcher, project, desired);
        }
        catch (error) {
          current = old;
          throw error;
        }
        if (cancellationSignal) {
          current = old;
          failure('private-preview-activation-cancelled');
        }
        // Only the health-verified, reselected candidate becomes the durable
        // last-known-good revision. An interrupted switch leaves the earlier
        // active identity and an explicitly unconfirmed pending generation.
        owner = updateLease(lease, owner, {
          phase: 'listening', active: generationIdentity(candidate),
          previous: restoring ? null : generationIdentity(old), pending: null
        });
        previous = restoring ? null : old;
        return { event: restoring ? 'restored' : old ? 'activated' : 'ready',
          generation: candidate.generation, compiledOutputSha256: candidate.compiled,
          sourceSha256: candidate.source, compilerSha256: candidate.compiler,
          previousGeneration: old?.generation ?? null,
          ...(restoring ? { restorationEvidence: 'same-process-previous-health-verified-memory',
            currentSourceMatchNotAsserted: true } : {}),
          healthConfirmed: true, targetKind: 'isolated-loopback-renderer-only',
          ...served,
          assetCount: candidate.files, assetBytes: candidate.bytes,
          targetOwnerPid: process.pid, targetOwnerBirth: owner.startedAt,
          targetPort: port,
          endpoint: `${target}/index.html`,
          durationMs: Number((process.hrtime.bigint() - tick) / 1000000n) };
      } catch (error) {
        pending = null;
        current = original;
        if (owner?.phase === 'switching') {
          try { owner = updateLease(lease, owner, { phase: 'listening', pending: null }); }
          catch { leaseHealthy = false; }
        }
        if (error.code === 'private-preview-lease-owner-changed') leaseHealthy = false;
        if (!leaseHealthy) inputReader?.close();
        return { event: 'refused', reason: error.code ?? 'private-preview-activation-unverified',
          requestedGeneration: desired.generation, activeGeneration: current?.generation ?? null,
          activeServedRendererSha256: current?.memoryDigest ?? null,
          historyPreserved: true, healthConfirmed: false };
      }
    };
    const first = await activate(options);
    report(first.event, first);
    if (first.event === 'refused') return 1;
    if (options.probe) { stoppedBy = 'probe-complete'; return 0; }
    if (cancellationSignal) return 1;
    const reader = readline.createInterface({ input: process.stdin, crlfDelay: Infinity, terminal: false });
    inputReader = reader;
    if (cancellationSignal) reader.close();
    try {
      for await (const line of reader) {
        if (cancellationSignal) break;
        let command;
        try { command = JSON.parse(line); }
        catch { report('refused', { reason: 'private-preview-command-invalid-json', activeGeneration: current?.generation }); continue; }
        if (command?.command === 'stop') { stoppedBy = 'explicit-stop'; break; }
        if (command?.command === 'status') {
          let status = 'verified';
          try { verifyExactGeneration(launcher, project, current); await probeHealth(current, false); }
          catch { status = 'stale-or-health-unverified'; }
          report('status', { generation: current.generation, compiledOutputSha256: current.compiled,
            health: status, servedRendererSha256: current.memoryDigest,
            httpAssetsReverified: status === 'verified' ? current.files : null,
            previousGeneration: previous?.generation ?? null,
            targetKind: 'isolated-loopback-renderer-only' });
          continue;
        }
        if (command?.command === 'restore') {
          if (!previous) { report('refused', { reason: 'private-preview-no-known-previous-generation' }); continue; }
          const receipt = await activate(previous, true);
          report(receipt.event, receipt);
          continue;
        }
        if (command?.command === 'use') {
          const desired = { generation: command.generation, source: command.source,
            compiled: command.compiled, compiler: command.compiler };
          if (!NAME.test(desired.generation ?? '') || ![desired.source, desired.compiled, desired.compiler]
            .every(value => DIGEST.test(value ?? ''))) {
            report('refused', { reason: 'private-preview-command-unverified', activeGeneration: current?.generation });
            continue;
          }
          for (const field of ['source', 'compiled', 'compiler']) desired[field] = desired[field].toUpperCase();
          const receipt = await activate(desired);
          report(receipt.event, receipt);
          continue;
        }
        report('refused', { reason: 'private-preview-command-unsupported', activeGeneration: current?.generation });
      }
    } finally {
      inputReader = null;
      reader.close();
    }
    return cancellationSignal || !leaseHealthy ? 1 : 0;
  } catch (error) {
    report('refused', { reason: error.code ?? 'private-preview-startup-or-ownership-unverified',
      activeGeneration: current?.generation ?? null, historyPreserved: true });
    return 1;
  } finally {
    process.off('SIGINT', sigint);
    process.off('SIGTERM', sigterm);
    externalSignal?.removeEventListener('abort', externalCancel);
    // No daemon or process children remain. Release only our own exact lease.
    if (server?.listening) {
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    }
    if (owner && leaseHealthy) cleanupVerified = releaseLease(lease, owner.token);
    report('stopped', { reason: stoppedBy, leaseReleased: cleanupVerified,
      generationAtStop: current?.generation ?? null,
      lastServedRendererSha256: current?.memoryDigest ?? null,
      sharedOutModified: false, historyPreserved: true,
      durationMs: Number((process.hrtime.bigint() - started) / 1000000n) });
    // A failed owner release is not a successful stop. Never convert unknown
    // lease custody into exit0 because an earlier operation returned success.
    if (!cleanupVerified && owner) return 1;
  }
}
