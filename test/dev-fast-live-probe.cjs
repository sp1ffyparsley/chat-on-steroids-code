// Physical, explicitly opted-in Electron/Vite verification for a disposable checkout.
// This is not a launcher and never controls Chrome, user profiles, or production processes.
const { createHash, randomUUID } = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { Script } = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const WebSocket = require('ws');

const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const args = process.argv.slice(2);
const argument = flag => {
  const index = args.indexOf(flag);
  return index < 0 ? null : args[index + 1] || null;
};
const run = args.includes('--run');
const fixtureArg = argument('--fixture');
const cssExpected = argument('--css-sha256');
const htmlExpected = argument('--html-sha256');
const watchPreload = args.includes('--watch-preload');
const custodyOnly = args.includes('--custody-only');
const navigationAudit = args.includes('--navigation-audit');
const cssOnly = args.includes('--css-only');
const chromeCustodyOnly = args.includes('--chrome-custody-only');
const chromeProfileArg = argument('--chrome-profile');
const chromeWorkerReceipt = argument('--chrome-worker-receipt');
const preloadExpected = argument('--preload-sha256');
const expectedFlags = ['--run', '--fixture', '--css-sha256', '--html-sha256', '--watch-preload', '--preload-sha256', '--custody-only', '--navigation-audit', '--css-only', '--chrome-custody-only', '--chrome-profile', '--chrome-worker-receipt'];
const fail = message => { throw new Error(message); };

// Guard the original disposable files from this probe's own edits. A failing
// watcher or another editor must not turn a finally block into a blind rewrite
// of someone else's bytes. This is best-effort local custody, not an OS-level
// cross-process lock; the native fixture still must be task-owned.
function createOwnedSourceEdits(entries) {
  const slots = new Map(Object.entries(entries).map(([name, entry]) => {
    const original = Buffer.from(entry.original);
    const canonical = fs.realpathSync.native(entry.path);
    return [name, { path: entry.path, canonical, original, expected: original, edited: false }];
  }));
  const read = (name, slot) => {
    const info = fs.lstatSync(slot.path);
    if (!info.isFile() || info.isSymbolicLink() ||
        fs.realpathSync.native(slot.path).toLowerCase() !== slot.canonical.toLowerCase())
      fail('SOURCE_CONFLICT:' + name);
    return fs.readFileSync(slot.path);
  };
  for (const [name, slot] of slots) {
    if (!read(name, slot).equals(slot.original)) fail('SOURCE_CONFLICT:' + name);
  }
  return {
    write(name, next) {
      const slot = slots.get(name);
      if (!slot) fail('SOURCE_CONFLICT:unknown-edit-owner');
      if (!read(name, slot).equals(slot.expected)) fail('SOURCE_CONFLICT:' + name);
      const bytes = Buffer.from(next);
      if (!bytes.equals(slot.expected)) {
        fs.writeFileSync(slot.path, bytes);
        slot.edited = true;
        slot.expected = bytes;
      }
    },
    wasEdited(name) { return Boolean(slots.get(name)?.edited); },
    restore() {
      const report = {};
      for (const [name, slot] of slots) {
        try {
          const current = read(name, slot);
          if (current.equals(slot.original)) report[name] = true;
          else if (!current.equals(slot.expected)) report[name] = false;
          else {
            fs.writeFileSync(slot.path, slot.original);
            report[name] = read(name, slot).equals(slot.original);
          }
        } catch { report[name] = false; }
      }
      return report;
    },
    // A successful earlier restore receipt is not durable ownership of a
    // mutable file. Recheck original bytes and identity throughout the
    // subsequent generated-output wait; never overwrite a competing author.
    assertRestored() {
      for (const [name, slot] of slots) {
        if (!read(name, slot).equals(slot.original)) fail('SOURCE_CONFLICT:' + name);
      }
      return true;
    },
    assertExpected() {
      for (const [name, slot] of slots) {
        if (!read(name, slot).equals(slot.expected)) fail('SOURCE_CONFLICT:' + name);
      }
      return true;
    }
  };
}

function preflight() {
  if (args.includes('--help')) {
    console.log('Usage: node test/dev-fast-live-probe.cjs --run --fixture <absolute-disposable-checkout> --css-sha256 <hex> --html-sha256 <hex> [--watch-preload --preload-sha256 <hex> | --css-only | --custody-only | --navigation-audit | --chrome-custody-only --chrome-profile <absolute-disposable-profile> [--chrome-worker-receipt <source-revision-token>]]');
    return null;
  }
  if (!run || !fixtureArg || !path.isAbsolute(fixtureArg) ||
      !/^[a-f0-9]{64}$/i.test(cssExpected || '') || !/^[a-f0-9]{64}$/i.test(htmlExpected || '') ||
      Number(watchPreload) + Number(custodyOnly) + Number(chromeCustodyOnly) + Number(navigationAudit) + Number(cssOnly) > 1 ||
      (watchPreload ? (args.length !== 10 || !/^[a-f0-9]{64}$/i.test(preloadExpected || '')) :
        args.length !== (chromeCustodyOnly ? (chromeWorkerReceipt ? 12 : 10) : custodyOnly || navigationAudit || cssOnly ? 8 : 7)) ||
      (chromeCustodyOnly !== Boolean(chromeProfileArg)) ||
      (args.includes('--chrome-worker-receipt') !== Boolean(chromeWorkerReceipt)) ||
      (chromeWorkerReceipt && (!chromeCustodyOnly || !/^[a-z0-9][a-z0-9-]{5,79}$/.test(chromeWorkerReceipt))) ||
      args.some(value => value.startsWith('--') && !expectedFlags.includes(value)))
    fail('Refused: explicit --run, absolute disposable --fixture, and both original SHA-256 values are required');
  const root = fs.realpathSync.native(fixtureArg);
  // The owner is this checkout's scratch directory, not one machine's display
  // name. Strict qualification runs the same checks in an immutable local clone.
  const scratchPath = path.resolve(__dirname, '..', '.test_tmp');
  const scratchRoot = fs.realpathSync.native(scratchPath);
  const relative = path.relative(scratchRoot, root);
  if (fs.lstatSync(scratchPath).isSymbolicLink() ||
      scratchRoot.toLowerCase() !== scratchPath.toLowerCase() ||
      !relative || relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative))
    fail('Refused: fixture must be a distinct checkout under the existing Chat On Steroids .test_tmp directory');
  let chromeProfile = null;
  if (chromeCustodyOnly) {
    if (!path.isAbsolute(chromeProfileArg)) fail('Refused: Chrome profile must be an absolute disposable path');
    chromeProfile = fs.realpathSync.native(chromeProfileArg);
    const parent = scratchRoot;
    if (!chromeProfile.toLowerCase().startsWith(parent.toLowerCase() + path.sep.toLowerCase()) ||
        !path.basename(chromeProfile).toLowerCase().startsWith('chat42_chrome_dev') ||
        fs.lstatSync(chromeProfileArg).isSymbolicLink() || !fs.lstatSync(chromeProfile).isDirectory())
      fail('Refused: Chrome profile is not an owned disposable .test_tmp directory');
  }
  if (!fs.statSync(path.join(root, '.git')).isDirectory()) fail('Refused: expected a disposable Git checkout');
  const css = path.join(root, 'src', 'renderer', 'styles.css');
  const html = path.join(root, 'src', 'renderer', 'index.html');
  for (const filename of [css, html]) {
    if (!fs.lstatSync(filename).isFile() || fs.lstatSync(filename).isSymbolicLink() ||
        !fs.realpathSync.native(filename).toLowerCase().startsWith(root.toLowerCase() + path.sep.toLowerCase()))
      fail('Refused: renderer source must be a regular file inside the disposable checkout');
  }
  const originalCss = fs.readFileSync(css);
  const originalHtml = fs.readFileSync(html);
  if (digest(originalCss).toLowerCase() !== cssExpected.toLowerCase() ||
      digest(originalHtml).toLowerCase() !== htmlExpected.toLowerCase())
    fail('Refused: source SHA mismatch; no fixture source changed');
  const preload = path.join(root, 'src', 'preload', 'index.ts');
  const preloadBuild = path.join(root, 'out', 'preload', 'index.js');
  let originalPreload = null;
  let originalPreloadBuild = null;
  let originalPreloadBuildCanonical = null;
  if (watchPreload) {
    for (const filename of [preload, preloadBuild]) {
      if (!fs.lstatSync(filename).isFile() || fs.lstatSync(filename).isSymbolicLink() ||
          !fs.realpathSync.native(filename).toLowerCase().startsWith(root.toLowerCase() + path.sep.toLowerCase()))
        fail('Refused: expected regular fixture-owned preload source and built output');
    }
    originalPreload = fs.readFileSync(preload);
    originalPreloadBuild = digest(fs.readFileSync(preloadBuild));
    originalPreloadBuildCanonical = fs.realpathSync.native(preloadBuild);
    if (digest(originalPreload).toLowerCase() !== preloadExpected.toLowerCase())
      fail('Refused: preload SHA mismatch; no fixture source changed');
  }
  const stateRoot = path.join(os.tmpdir(), 'chat-on-steroids-fast-dev', digest(root).slice(0, 12));
  const normalizedStateRoot = process.platform === 'win32' ? stateRoot.toLowerCase() : stateRoot;
  const expectedInstance = 'dev-' + digest(normalizedStateRoot).slice(0, 24);
  return { root, css, html, originalCss, originalHtml, expectedInstance,
    preload, preloadBuild, originalPreload, originalPreloadBuild,
    originalPreloadBuildCanonical, chromeProfile, chromeWorkerReceipt };
}

async function jsonFrom(url) {
  let response;
  try {
    response = await fetch(url, { signal: AbortSignal.timeout(2500), redirect: 'error' });
  } catch {
    fail('Refused: development endpoint unreachable; no fixture file was modified');
  }
  if (!response.ok) fail('Refused: development endpoint returned a non-success status; no source edit');
  try { return await response.json(); } catch {
    fail('Refused: development endpoint did not return usable JSON; no source edit');
  }
}

// /hello and CDP URL do not prove the Vite HTTP renderer belongs to this
// Electron/watcher's process tree. Refuse foreign ports before any source edit.
function electronParentPid(pid) {
  const script = "$ErrorActionPreference='Stop'; $p=Get-CimInstance Win32_Process -Filter 'ProcessId=" +
    pid + "'; if ($null -eq $p) { exit 3 }; [Console]::Out.Write([string]$p.ParentProcessId)";
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    encoding: 'utf8', windowsHide: true, timeout: 6000, maxBuffer: 32 * 1024
  });
  const parent = typeof result.stdout === 'string' ? result.stdout.trim() : '';
  if (result.status !== 0 || !/^[1-9][0-9]{0,9}$/.test(parent) || !Number.isSafeInteger(Number(parent)))
    fail('Refused: Electron watcher ancestry could not be verified');
  return Number(parent);
}
function assertWindowsListenerCustody(includeChrome = false) {
  if (process.platform !== 'win32') fail('Refused: native debugger/bridge custody requires Windows');
  // -p tcp on Windows omits TCPv6, including Vite's default [::1]:5173.
  // Enumerate both families; the parser below still admits TCP LISTENING only.
  const result = spawnSync('netstat.exe', ['-ano'], {
    encoding: 'utf8', windowsHide: true, timeout: 4000, maxBuffer: 2 * 1024 * 1024
  });
  if (result.status !== 0 || typeof result.stdout !== 'string')
    fail('Refused: Windows private listener ownership could not be verified');
  const byPort = new Map([[5173, new Set()], [8796, new Set()], [9333, new Set()],
    ...(includeChrome ? [[9444, new Set()]] : [])]);
  let unsafeBinding = false;
  for (const line of result.stdout.split(/\r?\n/)) {
    const fields = line.trim().split(/\s+/);
    if (fields.length !== 5 || fields[0].toUpperCase() !== 'TCP' ||
        fields[3].toUpperCase() !== 'LISTENING') continue;
    const colon = fields[1].lastIndexOf(':');
    if (colon < 0) continue;
    const port = Number(fields[1].slice(colon + 1));
    if (!byPort.has(port)) continue;
    const address = fields[1].slice(0, colon).replace(/^\[|\]$/g, '').toLowerCase();
    if (!['127.0.0.1', '::1'].includes(address)) {
      unsafeBinding = true;
      continue;
    }
    const pid = Number(fields[4]);
    if (!Number.isSafeInteger(pid) || pid < 1) {
      unsafeBinding = true;
      continue;
    }
    byPort.get(port).add(pid);
  }
  if (includeChrome && byPort.get(9444).size !== 1)
    fail('Refused: Chrome debugger listener is missing or ambiguous');
  if (unsafeBinding || [...byPort.values()].some(pids => pids.size !== 1))
    fail('Refused: Windows private listener ownership unavailable, non-loopback, or ambiguous');
  if ([...byPort.get(8796)][0] !== [...byPort.get(9333)][0])
    fail('Refused: CDP debugger and dev bridge have different Windows listener owners');
  // The current electron-vite watcher directly starts the Electron process.
  // Refuse a Vite port owned by any other process, even if its URL matches.
  const vitePid = [...byPort.get(5173)][0];
  const electronPid = [...byPort.get(8796)][0];
  if (electronParentPid(electronPid) !== vitePid)
    fail('Refused: development renderer is not owned by the Electron watcher');
  if (includeChrome) return [...byPort.get(9444)][0];
  return { electronPid, vitePid };
}

// Compare the *one* Chrome listener's actual process identity and user-data-dir
// without exposing a command line, tab content, account or token. A debugger
// URL alone could otherwise select production or an unrelated local profile.
function assertChromeProfileOwner(chromePid, profile) {
  const literal = profile.replaceAll("'", "''");
  const script = "$ErrorActionPreference='Stop'; $p=Get-CimInstance Win32_Process -Filter 'ProcessId=" +
    chromePid + "'; if (!$p -or $p.Name -ne 'chrome.exe') { exit 3 }; " +
    "$expected='" + literal + "'; " +
    "$matches=[regex]::Matches($p.CommandLine, '(?:^|\\s)(?:\"--user-data-dir=([^\"]+)\"|--user-data-dir=\"([^\"]+)\"|--user-data-dir=([^\\s\"]+))(?=\\s|$)'); " +
    "if ($matches.Count -ne 1) { exit 4 }; " +
    "$actual=($matches[0].Groups | Select-Object -Skip 1 | Where-Object Success | Select-Object -First 1).Value; " +
    "if ([IO.Path]::GetFullPath($actual) -ine [IO.Path]::GetFullPath($expected)) { exit 5 }; " +
    "[Console]::Out.Write('OWNED')";
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    encoding: 'utf8', windowsHide: true, timeout: 6000, maxBuffer: 32 * 1024
  });
  if (result.status !== 0 || result.stdout?.trim() !== 'OWNED')
    fail('Refused: Chrome debugger process is not the isolated profile owner');
}

// An arbitrary extension's background.js is not evidence of the COS companion.
// Only Chrome's own unpacked-extension registry, exact fixture source path and
// extension ID can identify the intended service worker. MV3 may sleep when
// correctly installed; a missing CDP worker is not itself a disabled extension.
function installedCompanion(profile, fixtureRoot) {
  const expectedSource = path.join(fixtureRoot, 'extension');
  const manifestFile = path.join(expectedSource, 'manifest.json');
  if (!fs.statSync(expectedSource).isDirectory() || !fs.lstatSync(manifestFile).isFile() ||
      fs.lstatSync(manifestFile).isSymbolicLink() ||
      !fs.realpathSync.native(manifestFile).toLowerCase().startsWith(fixtureRoot.toLowerCase() + path.sep.toLowerCase()))
    fail('Refused: expected fixture-owned unpacked companion manifest is missing or unsafe');
  const sourceManifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
  if (sourceManifest.manifest_version !== 3 ||
      sourceManifest.name !== 'Luna Forge X7 Companion' ||
      sourceManifest.background?.service_worker !== 'background.js')
    fail('Refused: fixture does not contain the intended companion manifest');
  const defaultDir = path.join(profile, 'Default');
  // The profile root was checked at admission, but a nested Windows
  // junction can still redirect either preferences file into a personal
  // profile. Modern Chrome writes unpacked entries to Secure Preferences.
  if (fs.existsSync(defaultDir) &&
      fs.realpathSync.native(defaultDir).toLowerCase() !== path.resolve(defaultDir).toLowerCase())
    fail('Refused: Chrome Preferences leaves the isolated profile directory');
  const canonical = fs.realpathSync.native(expectedSource).toLowerCase();
  const matching = [];
  for (const filename of ['Preferences', 'Secure Preferences']) {
    const preferenceFile = path.join(defaultDir, filename);
    if (!fs.existsSync(preferenceFile)) continue;
    const stat = fs.lstatSync(preferenceFile);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 8 * 1024 * 1024)
      fail('Refused: isolated Chrome Preferences is not a bounded regular file');
    if (fs.realpathSync.native(preferenceFile).toLowerCase() !== path.resolve(preferenceFile).toLowerCase())
      fail('Refused: Chrome Preferences leaves the isolated profile directory');
    let stored;
    try { stored = JSON.parse(fs.readFileSync(preferenceFile, 'utf8')); }
    catch { fail('Refused: isolated Chrome Preferences cannot be verified'); }
    const settings = stored?.extensions?.settings;
    if (settings == null) continue;
    if (!settings || typeof settings !== 'object' || Array.isArray(settings))
      fail('Refused: Chrome extension registry is malformed');
    for (const [id, entry] of Object.entries(settings)) {
      if (!/^[a-p]{32}$/.test(id) || typeof entry?.path !== 'string' ||
          !path.isAbsolute(entry.path)) continue;
      if (path.resolve(entry.path).toLowerCase() === canonical)
        matching.push({ id, entry, filename });
    }
  }
  if (matching.length > 1) fail('Refused: duplicate Chrome registration for the same unpacked companion');
  if (!matching.length) return { state: 'absent', id: null };
  const { id, entry, filename } = matching[0];
  // Secure Preferences from Chrome 153 can legitimately omit manifest and
  // state. Presence is registration evidence, not enabled/runtime proof:
  // require an independently checked live Chrome service worker before
  // projecting running_* to callers.
  if (entry.location !== 4 ||
      (entry.manifest && (entry.manifest.manifest_version !== 3 ||
        entry.manifest.name !== sourceManifest.name ||
        entry.manifest.background?.service_worker !== sourceManifest.background.service_worker)) ||
      (!entry.manifest && filename !== 'Secure Preferences'))
    fail('Refused: Chrome registered a different extension at the expected source path');
  if (entry.state === 0) return { state: 'disabled', id };
  if (entry.state === undefined && filename === 'Secure Preferences')
    return { state: 'registered_unverified', id };
  if (entry.state !== 1) fail('Refused: Chrome companion enabled state cannot be verified');
  return { state: 'installed', id };
}

// CLI-installed unpacked extensions are allowed to be ephemeral: Chromium
// exposes their active service worker even when it does not persist an entry
// under Default/Preferences. Only accept that *distinct* runtime state when
// Chrome's actual owned process was launched for the one exact disposable
// extension path with both explicit allowlist switches.
function assertExactCliCompanion(chromePid, fixtureRoot) {
  const expected = path.join(fixtureRoot, 'extension').replaceAll("'", "''");
  const script = "$ErrorActionPreference='Stop'; $p=Get-CimInstance Win32_Process -Filter 'ProcessId=" +
    chromePid + "'; if (!$p -or $p.Name -ne 'chrome.exe') { exit 3 }; " +
    "$expected='" + expected + "'; foreach ($flag in @('load-extension','disable-extensions-except')) { " +
    "$pattern='(?:^|\\s)(?:\"--'+$flag+'=([^\"]+)\"|--'+$flag+'=\"([^\"]+)\"|--'+$flag+'=([^\\s\"]+))(?=\\s|$)'; " +
    "$matches=[regex]::Matches($p.CommandLine,$pattern); if ($matches.Count -ne 1) { exit 4 }; " +
    "$actual=($matches[0].Groups | Select-Object -Skip 1 | Where-Object Success | Select-Object -First 1).Value; " +
    "if ([IO.Path]::GetFullPath($actual) -ine [IO.Path]::GetFullPath($expected)) { exit 5 } }; " +
    "[Console]::Out.Write('CLI_COMPANION')";
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    encoding: 'utf8', windowsHide: true, timeout: 6000, maxBuffer: 32 * 1024
  });
  if (result.status !== 0 || result.stdout?.trim() !== 'CLI_COMPANION')
    fail('Refused: active Chrome worker has no verified exact disposable extension launch');
}

// The target URL is only a hint. Ask this one *owned* extension worker for
// its public manifest and id. No bearer, storage or page data is read.
async function verifyCliWorker(target, fixtureRoot, expectedReceipt = null, Socket = WebSocket) {
  if (!/^ws:\/\/127\.0\.0\.1:9444\/devtools\/(?:page|worker)\/[a-z0-9-]+$/i.test(target.webSocketDebuggerUrl || ''))
    fail('Refused: companion worker debugger target is not owned by isolated Chrome');
  if (expectedReceipt !== null) {
    if (typeof expectedReceipt !== 'string' || !/^[a-z0-9][a-z0-9-]{5,79}$/.test(expectedReceipt))
      fail('Refused: invalid source runtime receipt request');
    const background = path.join(fixtureRoot, 'extension', 'background.js');
    const info = fs.lstatSync(background);
    if (!info.isFile() || info.isSymbolicLink() ||
        !fs.realpathSync.native(background).toLowerCase().startsWith(
          fs.realpathSync.native(fixtureRoot).toLowerCase() + path.sep.toLowerCase()) ||
        !fs.readFileSync(background, 'utf8').includes(
          "globalThis.__cosDevNativeReloadOct10 = '" + expectedReceipt + "';"))
      fail('Refused: source runtime receipt does not match exact disposable background.js');
  }
  const ws = new Socket(target.webSocketDebuggerUrl, { handshakeTimeout: 2500 });
  const publicManifest = await new Promise((resolve, reject) => {
    const deadline = setTimeout(() => reject(new Error('Companion public manifest query timed out')), 4500);
    const done = (error, value) => {
      clearTimeout(deadline);
      if (error) reject(error); else resolve(value);
    };
    ws.once('open', () => ws.send(JSON.stringify({
      id: 1, method: 'Runtime.evaluate', params: {
        expression: "JSON.stringify({id:chrome.runtime.id,name:chrome.runtime.getManifest().name,version:chrome.runtime.getManifest().version,worker:chrome.runtime.getManifest().background?.service_worker,receipt:typeof globalThis.__cosDevNativeReloadOct10==='string'?globalThis.__cosDevNativeReloadOct10:null})",
        returnByValue: true
      }
    })));
    ws.on('message', bytes => {
      let answer;
      try { answer = JSON.parse(bytes.toString()); } catch { return; }
      if (answer.id !== 1) return;
      if (answer.error || answer.result?.exceptionDetails ||
          typeof answer.result?.result?.value !== 'string') {
        done(new Error('Companion public manifest query rejected'));
        return;
      }
      try { done(null, JSON.parse(answer.result.result.value)); }
      catch { done(new Error('Companion public manifest query malformed')); }
    });
    ws.once('error', () => done(new Error('Companion public manifest debugger unavailable')));
  }).finally(() => ws.close());
  const sourceManifest = JSON.parse(fs.readFileSync(path.join(fixtureRoot, 'extension', 'manifest.json'), 'utf8'));
  if (publicManifest.id !== target.url.split('/')[2] ||
      publicManifest.name !== sourceManifest.name ||
      publicManifest.version !== sourceManifest.version ||
      publicManifest.worker !== sourceManifest.background?.service_worker)
    fail('Refused: active Chrome worker manifest does not match exact disposable source');
  if (expectedReceipt !== null && publicManifest.receipt !== expectedReceipt)
    fail('Refused: extension runtime receipt not applied to the actual Chrome service worker');
  return publicManifest.id;
}

async function inspectIsolatedChrome(profile, fixtureRoot, bridgePaired, expectedReceipt = null) {
  const pid = assertWindowsListenerCustody(true);
  assertChromeProfileOwner(pid, profile);
  const registration = installedCompanion(profile, fixtureRoot);
  const browser = await jsonFrom('http://127.0.0.1:9444/json/version');
  if (!/^Chrome\/[0-9]+\./.test(browser?.Browser || '') ||
      !/^ws:\/\/127\.0\.0\.1:9444\/devtools\/browser\/[a-z0-9-]+$/i.test(browser?.webSocketDebuggerUrl || ''))
    fail('Refused: isolated Chrome browser debugger identity is invalid');
  const targets = await jsonFrom('http://127.0.0.1:9444/json/list');
  if (!Array.isArray(targets) || targets.some(t => !t || typeof t.type !== 'string' ||
      (typeof t.url === 'string' && /^https?:\/\/(chatgpt\.com|chat\.openai\.com)(?:\/|$)/i.test(t.url))))
    fail('Refused: isolated Chrome targets are malformed or include a signed-in provider origin');
  const potentiallyRegistered = registration.state === 'installed' ||
    registration.state === 'registered_unverified';
  const matchedRegisteredWorker = potentiallyRegistered &&
    targets.some(t => t.type === 'service_worker' &&
      t.url === 'chrome-extension://' + registration.id + '/background.js');
  let registrationVerifiedByWorker = false;
  if (potentiallyRegistered &&
      (expectedReceipt !== null || registration.state === 'registered_unverified')) {
    if (!matchedRegisteredWorker)
      if (expectedReceipt !== null)
        fail('Refused: extension runtime receipt not applied; registered MV3 worker is inactive');
    if (matchedRegisteredWorker) {
      await verifyCliWorker(targets.find(t => t.type === 'service_worker' &&
        t.url === 'chrome-extension://' + registration.id + '/background.js'), fixtureRoot, expectedReceipt);
      registrationVerifiedByWorker = true;
    }
  }
  let matchedCliWorker = false;
  if (registration.state === 'absent') {
    const candidates = targets.filter(t => t.type === 'service_worker' &&
      /^chrome-extension:\/\/[a-p]{32}\/background\.js$/.test(t.url || ''));
    if (candidates.length > 0) {
      if (candidates.length !== 1)
        fail('Refused: ambiguous active command-line companion worker candidates');
      assertExactCliCompanion(pid, fixtureRoot);
      await verifyCliWorker(candidates[0], fixtureRoot, expectedReceipt);
      matchedCliWorker = true;
    }
  }
  const companionWorkerVisible = matchedRegisteredWorker || matchedCliWorker;
  const extensionState = registration.state === 'registered_unverified'
    ? registrationVerifiedByWorker ? bridgePaired
      ? 'running_registered_bridge_reports_paired' : 'running_registered_unpaired'
      : 'registered_unverified'
    : registration.state === 'installed'
    ? companionWorkerVisible
      ? bridgePaired ? 'running_bridge_reports_paired' : 'running_unpaired'
      : 'installed_inactive'
    : matchedCliWorker
      ? bridgePaired ? 'running_cli_bridge_reports_paired' : 'running_cli_unpaired'
      : registration.state;
  const after = assertWindowsListenerCustody(true);
  if (after !== pid) fail('Refused: isolated Chrome debugger listener owner changed during inspection');
  assertChromeProfileOwner(after, profile);
  if (matchedCliWorker) assertExactCliCompanion(after, fixtureRoot);
  const stableRegistration = installedCompanion(profile, fixtureRoot);
  if (stableRegistration.state !== registration.state || stableRegistration.id !== registration.id)
    fail('Refused: isolated Chrome extension registration changed during inspection');
  console.log('DEV_CHROME_CUSTODY=' + JSON.stringify({
    chromeProfileOwned: true, chromePort: 9444, browserTarget: true,
    extensionState, chromeCompanionWorkerVisible: companionWorkerVisible,
    bridgeReportsPaired: bridgePaired, connectionReady: false,
    authentication: 'unverified',
    fixtureUnchanged: true, signedInProviderTargetObserved: false,
    runtimeReceiptVerified: expectedReceipt !== null,
    registrationVerifiedByWorker
  }));
}

async function findPageTarget() {
  const targets = await jsonFrom('http://127.0.0.1:9333/json/list');
  if (!Array.isArray(targets)) fail('Refused: debugger target listing is invalid');
  const matches = targets.filter(t => t.type === 'page' && t.url === 'http://localhost:5173/');
  if (matches.length !== 1 || !/^ws:\/\/127\.0\.0\.1:9333\//.test(matches[0].webSocketDebuggerUrl || ''))
    fail('Refused: expected one exact task-owned visible Electron renderer target on CDP 9333');
  return matches[0];
}

async function connectPage(target, Socket = WebSocket) {
  const ws = new Socket(target.webSocketDebuggerUrl);
  const waiting = new Map();
  let sequence = 0;
  let documentEpoch = 0;
  let disconnected = false;
  const events = [];
  const rejectWaiting = reason => {
    for (const [id, command] of waiting) {
      waiting.delete(id);
      command.reject(new Error(reason));
    }
  };
  ws.on('message', bytes => {
    let message; try { message = JSON.parse(bytes.toString()); } catch { return; }
    if (message.method === 'Page.frameNavigated') events.push(message.method);
    if (message.method === 'Page.loadEventFired') events.push(message.method);
    // An old execution context can reply after navigation has begun. That
    // acknowledgement cannot establish a fact about the replacement page.
    if (message.method === 'Runtime.executionContextsCleared' ||
        (message.method === 'Page.frameNavigated' && !message.params?.frame?.parentId)) {
      documentEpoch++;
      for (const [id, command] of waiting) {
        if (command.method !== 'Runtime.evaluate') continue;
        waiting.delete(id);
        command.reject(new Error('Renderer evaluation document changed'));
      }
    }
    if (message.id && waiting.has(message.id)) {
      const complete = waiting.get(message.id); waiting.delete(message.id);
      if (complete.method === 'Runtime.evaluate' && complete.epoch !== documentEpoch)
        complete.reject(new Error('Renderer evaluation document changed'));
      else complete.resolve(message);
    }
  });
  const lostDebugger = () => {
    disconnected = true;
    rejectWaiting('Renderer debugger disconnected during CDP command');
  };
  ws.on('close', lostDebugger);
  ws.on('error', lostDebugger);
  // A valid-looking page target can keep its TCP debugger listener alive but
  // never finish the WebSocket upgrade. Without a bounded handshake, the
  // physical source probe hangs indefinitely before its try/finally custody
  // fence and the user cannot distinguish the failure from a healthy watcher.
  await new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      if (error) {
        ws.terminate();
        reject(error);
      } else resolve();
    };
    const deadline = setTimeout(
      () => finish(new Error('Renderer debugger handshake timed out')), 2500
    );
    ws.once('open', () => finish());
    ws.once('error', () => finish(new Error('Renderer debugger handshake failed')));
    ws.once('close', () => finish(new Error('Renderer debugger closed before handshake')));
  });
  const command = (method, params = {}) => new Promise((resolve, reject) => {
    if (disconnected) { reject(new Error('Renderer debugger disconnected during CDP command')); return; }
    const id = ++sequence;
    const deadline = setTimeout(() => { waiting.delete(id); reject(new Error('CDP command timed out: ' + method)); }, 5000);
    waiting.set(id, { method, epoch: documentEpoch,
      reject: error => { clearTimeout(deadline); reject(error); },
      resolve: value => {
        clearTimeout(deadline);
        value.error ? reject(new Error('CDP refused: ' + method)) : resolve(value.result);
      }
    });
    try { ws.send(JSON.stringify({ id, method, params })); }
    catch {
      waiting.delete(id);
      clearTimeout(deadline);
      reject(new Error('Renderer debugger disconnected during CDP command'));
    }
  });
  const evaluate = async expression => {
    const result = await command('Runtime.evaluate', { expression, returnByValue: true });
    if (result.exceptionDetails) fail('Renderer evaluation failed');
    return result.result.value;
  };
  await command('Runtime.enable');
  await command('Page.enable');
  return { ws, events, command, evaluate };
}

// Only a lost execution context caused by an in-flight navigation, or a
// temporarily absent generated bundle, is an expected retry. Do not hide
// source conflicts, CDP refusal, permissions failures or watcher death as
// a generic "document did not change" timeout.
function retryableUpdateError(error) {
  return error?.message === 'Renderer evaluation document changed' ||
    error?.message === 'Renderer evaluation failed' ||
    error?.code === 'ENOENT';
}
async function until(label, predicate, timeout = 14000, verifyOwner = null) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    // Keep the identity check OUTSIDE the catch below: losing the admitted
    // watcher is terminal, not a navigational evaluation retry. Check again
    // after the predicate so a last old-document reply cannot win a race.
    if (verifyOwner) verifyOwner();
    let ready = false;
    try { ready = await predicate(); }
    catch (error) {
      if (!retryableUpdateError(error)) throw error;
    }
    if (verifyOwner) verifyOwner();
    if (ready) return;
    await sleep(120);
  }
  if (verifyOwner) verifyOwner();
  fail('LIVE_FAIL:' + label);
}

// One generated-output custody fence handles both directions of an actual
// preload update. An intermediate, incomplete or foreign build is not a
// qualifying candidate merely because its SHA differs from the baseline.
// These are build receipts ONLY, never evidence the renderer adopted code.
async function awaitStablePreloadBuild(buildPath, qualifyBytes, failureCode,
  verifyPrivateWatcher, timeout, originalCanonicalPath, verifySource) {
  const deadline = Date.now() + timeout;
  let matchingSince = null;
  let matchingSamples = 0;
  let matchingHash = null;
  while (Date.now() < deadline) {
    if (verifySource) verifySource();
    try { verifyPrivateWatcher(); }
    catch { fail('LIVE_FAIL:private-preload-watcher-disappeared; generated output unverified'); }
    let matching = false;
    let observedHash = null;
    try {
      const entry = fs.lstatSync(buildPath);
      if (!entry.isFile() || entry.isSymbolicLink() ||
          (originalCanonicalPath &&
            fs.realpathSync.native(buildPath).toLowerCase() !== originalCanonicalPath.toLowerCase()))
        fail('LIVE_FAIL:preload-generated-output-identity-changed');
      const bytes = fs.readFileSync(buildPath);
      observedHash = digest(bytes);
      matching = qualifyBytes(bytes, observedHash) === true;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      // Electron/Vite may briefly remove the generated file before replacing it.
    }
    try {
      verifyPrivateWatcher();
    } catch {
      fail('LIVE_FAIL:private-preload-watcher-disappeared; generated output unverified');
    }
    if (verifySource) verifySource();
    if (matching) {
      if (matchingHash !== observedHash) {
        matchingSamples = 0;
        matchingSince = Date.now();
        matchingHash = observedHash;
      }
      matchingSamples++;
      if (matchingSamples >= 2 && Date.now() - matchingSince >= 250)
        return { sha256: observedHash };
    } else {
      matchingSamples = 0;
      matchingSince = null;
      matchingHash = null;
    }
    await sleep(200);
  }
  fail('LIVE_FAIL:' + failureCode);
}
async function awaitOriginalPreloadBuild(buildPath, expectedHash,
  verifyPrivateWatcher = assertWindowsListenerCustody, timeout = 14000,
  originalCanonicalPath = null, verifySourceRestored = null) {
  await awaitStablePreloadBuild(buildPath, (_bytes, hash) => hash === expectedHash,
    'preload-original-built-output-not-restored', verifyPrivateWatcher, timeout,
    originalCanonicalPath, verifySourceRestored);
  return true;
}
async function awaitChangedPreloadBuild(buildPath, originalHash, property, receipt,
  verifyPrivateWatcher = assertWindowsListenerCustody, timeout = 14000,
  originalCanonicalPath = null, verifySourceExpected = null) {
  if (!property || !receipt) fail('LIVE_FAIL:preload-changed-revision-missing');
  return awaitStablePreloadBuild(buildPath, (bytes, hash) => {
    if (hash === originalHash || bytes.length > 1024 * 1024) return false;
    const source = bytes.toString('utf8');
    if (!source.includes(property) || !source.includes(receipt)) return false;
    try {
      // Syntax check without evaluating the generated Electron bundle or
      // launching a second Node/compiler process. Runtime proof stays CDP.
      new Script(source, { filename: 'preload.js' });
      return true;
    } catch { return false; }
  }, 'preload-changed-built-output-not-verified', verifyPrivateWatcher,
  timeout, originalCanonicalPath, verifySourceExpected);
}

// A byte-identical restored bundle is only a disk receipt. The current
// primary document must itself have been replaced AFTER the document that
// executed the temporary preload, and the temporary API must be absent.
// This is a verdict on a real CDP-observed snapshot, never a build watcher
// status or a synthetic success inferred from a filename or renderer survival.
function originalPreloadAppliedToRenderer(witness, appliedTimeOrigin) {
  return !!witness && typeof witness === 'object' &&
    Number.isFinite(appliedTimeOrigin) && appliedTimeOrigin > 0 &&
    Number.isFinite(witness.timeOrigin) && witness.timeOrigin > 0 &&
    witness.timeOrigin > appliedTimeOrigin &&
    witness.url === 'http://localhost:5173/' &&
    witness.readyState === 'complete' &&
    witness.preloadApiAvailable === true &&
    witness.temporaryApiReceipt === null &&
    witness.appliedDocumentWitness === false;
}

// Compilation plus a new time origin is not sufficient: the temporary API
// could be observed on a plain browser page, a stale document or a new
// Electron document that lost the regular preload IPC bridge. Read every
// field from the current primary CDP execution context before accepting it.
function temporaryPreloadAppliedToPrimary(witness, previousTimeOrigin, expectedReceipt) {
  return !!witness && typeof witness === 'object' &&
    Number.isFinite(previousTimeOrigin) && previousTimeOrigin > 0 &&
    Number.isFinite(witness.timeOrigin) && witness.timeOrigin > previousTimeOrigin &&
    typeof expectedReceipt === 'string' && expectedReceipt.length > 0 &&
    witness.url === 'http://localhost:5173/' &&
    witness.readyState === 'complete' &&
    witness.preloadApiAvailable === true &&
    witness.transientGlobalSurvived === false &&
    witness.temporaryApiReceipt === expectedReceipt;
}

function htmlRevisionAppliedToPrimary(witness, previousTimeOrigin, expectMarker) {
  return !!witness && typeof witness === 'object' &&
    Number.isFinite(previousTimeOrigin) && previousTimeOrigin > 0 &&
    Number.isFinite(witness.timeOrigin) && witness.timeOrigin > 0 &&
    witness.timeOrigin > previousTimeOrigin &&
    witness.url === 'http://localhost:5173/' &&
    witness.readyState === 'complete' &&
    witness.transientGlobalSurvived === false &&
    witness.preloadApiAvailable === true &&
    witness.headMarkerPresent === expectMarker &&
    typeof expectMarker === 'boolean';
}

// One final machine-readable VERDICT over the incumbent independent witnesses.
// LIVE_PROOF contains intentionally useful partial diagnostics even on failure;
// neither those fields nor SOURCE_RESTORED alone authorizes a native claim.
// This function does not collect new observations or override process custody.
function qualifyLiveProof({ stage, exitCode, evidence, sourceRestored, provenance }) {
  const mode = evidence?.mode;
  const unmet = [];
  const need = (name, passed) => { if (passed !== true) unmet.push(name); };
  const sha256 = value => typeof value === 'string' && /^[a-f0-9]{64}$/i.test(value);
  need('process.exit-zero', exitCode === 0);
  need('source.css-restored', sourceRestored?.css === true);
  need('source.html-restored', sourceRestored?.html === true);
  need('renderer.current-target-and-owner', evidence?.finalRendererConnectionVerified === true);
  need('provenance.css-source-sha256', sha256(provenance?.cssSourceSha256));
  need('provenance.html-source-sha256', sha256(provenance?.htmlSourceSha256));
  if (mode === 'css-only') {
    need('stage.css-only-verified', stage === 'verified-css-only');
    need('renderer.css-applied', evidence.cssApplied === true);
    need('renderer.css-restored', evidence.cssRestored === true);
    need('navigation.external-denied', evidence.externalDenied === true);
  } else if (mode === 'full-renderer') {
    need('stage.full-renderer-verified', stage === 'verified');
    need('renderer.css-applied', evidence.cssApplied === true);
    need('renderer.css-restored', evidence.cssRestored === true);
    need('renderer.html-new-document', evidence.htmlReloaded === true);
    need('renderer.html-restored-document', evidence.htmlRestoreReloaded === true);
    need('navigation.external-denied', evidence.externalDenied === true);
  } else if (mode === 'watch-preload') {
    need('stage.preload-verified', stage === 'verified');
    need('source.preload-restored', sourceRestored?.preload === true);
    need('provenance.preload-source-sha256', sha256(provenance?.preloadSourceSha256));
    need('provenance.original-preload-build-sha256', sha256(provenance?.originalPreloadBuildSha256));
    need('provenance.changed-preload-build-sha256', sha256(provenance?.changedPreloadBuildSha256));
    need('provenance.changed-build-matches-witness',
      sha256(provenance?.changedPreloadBuildSha256) &&
      sha256(evidence?.preloadBuiltSha256) &&
      provenance.changedPreloadBuildSha256.toLowerCase() === evidence.preloadBuiltSha256.toLowerCase());
    need('provenance.changed-build-differs-from-original',
      sha256(provenance?.originalPreloadBuildSha256) &&
      sha256(provenance?.changedPreloadBuildSha256) &&
      provenance.originalPreloadBuildSha256.toLowerCase() !== provenance.changedPreloadBuildSha256.toLowerCase());
    need('build.preload-changed', evidence.preloadBuildChanged === true);
    need('build.preload-unique-api', evidence.preloadBuiltContainsUniqueApi === true);
    need('build.preload-revision-hash', /^[a-f0-9]{64}$/i.test(evidence.preloadBuiltSha256 || ''));
    need('renderer.preload-changed-code-executed', evidence.preloadAppliedToRenderer === true);
    need('build.original-preload-restored', evidence.preloadBuildRestored === true);
    need('renderer.original-preload-executed', evidence.preloadRendererRestored === true);
  } else if (mode === 'navigation-audit') {
    need('stage.navigation-verified', stage === 'verified');
    need('navigation.external-denied', evidence.externalDenied === true);
    for (const field of ['externalDenied', 'sameOriginOtherPathDenied',
      'sameOriginOtherQueryDenied', 'popupDenied', 'exactDevSelfReloaded',
      'primaryFrameRetained']) need('navigation.' + field,
      evidence.navigationAudit?.[field] === true);
  } else {
    unmet.push('mode.unrecognized');
  }
  const accepted = unmet.length === 0;
  return {
    schema: 'cos_dev_native_qualification_v1',
    mode: mode ?? 'unknown', status: accepted ? 'qualified' : 'failed', accepted,
    stage: stage || 'unknown', unmet,
    sourceBuildRuntimeSeparated: true,
    verifiedLevel: accepted ? 'isolated-native-electron-current-runtime' : 'unqualified-partial-observations',
    installedRuntimeVerified: false,
    provenance: provenance || {}
  };
}

async function main() {
  let fixture;
  try { fixture = preflight(); if (!fixture) return; } catch (error) {
    console.error('PREFLIGHT_FAILED:' + error.message); process.exitCode = 2; return;
  }
  // Establish source custody BEFORE any debugger connection. If a foreign
  // writer changed a fixture after preflight, abort without a dangling CDP
  // socket or a partial renderer edit.
  const sourceEdits = createOwnedSourceEdits({
    css: { path: fixture.css, original: fixture.originalCss },
    html: { path: fixture.html, original: fixture.originalHtml },
    ...(watchPreload ? { preload: { path: fixture.preload, original: fixture.originalPreload } } : {})
  });
  const hello = await jsonFrom('http://127.0.0.1:8796/hello');
  if (hello.app !== 'chat-on-steroids' || hello.instanceId !== fixture.expectedInstance ||
      hello.legacyInstance !== false || typeof hello.paired !== 'boolean' ||
      (!chromeCustodyOnly && hello.paired !== false) || hello.bridge !== 16)
    fail('Refused: private development instance/bridge identity unverified or paired');
  assertWindowsListenerCustody();
  if (chromeCustodyOnly) {
    await inspectIsolatedChrome(fixture.chromeProfile, fixture.root, hello.paired, fixture.chromeWorkerReceipt);
    return;
  }
  const target = await findPageTarget();
  if (custodyOnly) {
    console.log('DEV_CUSTODY_VERIFIED=' + JSON.stringify({
      sameElectronListenerOwner: true, rendererViteParentVerified: true,
      rendererTarget: 'http://localhost:5173/',
      instanceMatched: true, paired: false, fixtureUnchanged: true
    }));
    return;
  }
  const client = await connectPage(target);
  // Refuse an ownership change during debugger attachment before touching source.
  let originalOwner;
  try { originalOwner = assertWindowsListenerCustody(); }
  catch (error) { client.ws.close(); throw error; }
  const assertSameOwner = () => {
    const current = assertWindowsListenerCustody();
    if (current.electronPid !== originalOwner.electronPid || current.vitePid !== originalOwner.vitePid)
      fail('LIVE_FAIL:private-renderer-process-changed-during-proof');
  };
  const nonce = randomUUID().replaceAll('-', '');
  const cssRule = '--cos-live-' + nonce;
  const cssExpression = `getComputedStyle(document.documentElement).getPropertyValue('${cssRule}').trim()`;
  const htmlMarker = 'cos-live-html-' + nonce;
  let stage = 'ready';
  let preloadAppliedTimeOrigin = null;
  let preloadProperty = null;
  const evidence = { mode: cssOnly ? 'css-only' : navigationAudit ? 'navigation-audit' : watchPreload ? 'watch-preload' : 'full-renderer', cssApplied: false, cssRestored: false, htmlReloaded: false, htmlRestoreReloaded: false, externalDenied: false };
  try {
    if (navigationAudit) {
      stage = 'navigation-guard-audit';
      // No source edit or forced Page.reload: the app shell itself must allow
      // an exact self-document navigation while denying all other attempts.
      const url = await client.evaluate('location.href');
      if (url !== 'http://localhost:5173/')
        fail('Refused: primary renderer URL changed before navigation audit');
      const frame = (await client.command('Page.getFrameTree')).frameTree.frame;
      if (frame.url !== url || typeof frame.id !== 'string')
        fail('Refused: debugger primary frame identity cannot be established');
      const timeOrigin = await client.evaluate('performance.timeOrigin');
      const nav = evidence.navigationAudit = {
        primaryFrameIdentity: true, externalDenied: false,
        sameOriginOtherPathDenied: false, sameOriginOtherQueryDenied: false,
        popupDenied: false,
        exactDevSelfReloaded: false, observedSelfReloadMs: null
      };
      const evalAssign = value => client.evaluate('location.assign(' + JSON.stringify(value) + ');true');
      const evalSameDocument = () => client.evaluate(
        'location.href === ' + JSON.stringify(url) + ' && performance.timeOrigin === ' + timeOrigin
      );
      const witness = '__cosNavWitness' + nonce;
      await client.evaluate('window[' + JSON.stringify(witness) + '] = "alive";true');
      await evalAssign('https://example.invalid/cos-navigation-audit');
      await sleep(320);
      nav.externalDenied = await evalSameDocument();
      evidence.externalDenied = nav.externalDenied;
      if (!nav.externalDenied) fail('LIVE_FAIL:external-navigation-security-boundary-failed');
      await evalAssign('http://localhost:5173/__cos_guard_forbidden_' + nonce);
      await sleep(320);
      nav.sameOriginOtherPathDenied = await evalSameDocument();
      if (!nav.sameOriginOtherPathDenied) fail('LIVE_FAIL:same-origin-unapproved-path-allowed');
      // A broad "same localhost origin + root pathname" dev exception would
      // admit arbitrary query-bearing documents. Guard the *exact* dev URL.
      await evalAssign(url + '?__cos_guard_forbidden_' + nonce + '=1');
      await sleep(320);
      nav.sameOriginOtherQueryDenied = await evalSameDocument();
      if (!nav.sameOriginOtherQueryDenied) fail('LIVE_FAIL:same-origin-unapproved-query-allowed');
      nav.popupDenied = await client.evaluate('window.open("https://example.invalid/cos-popup-audit", "_blank") === null');
      if (!nav.popupDenied) fail('LIVE_FAIL:unsafe-popup-allowed');
      const start = process.hrtime.bigint();
      try {
        await evalAssign(url);
      } catch (error) {
        // A correctly allowed Vite full reload may destroy the runtime
        // execution context while the Runtime.evaluate response is in flight.
        // Keep the *independent* new-document witness authoritative; never
        // turn a successful navigation into a false diagnostic failure.
        if (error.message !== 'Renderer evaluation failed' &&
            error.message !== 'Renderer evaluation document changed' &&
            error.message !== 'CDP command timed out: Runtime.evaluate')
          throw error;
        nav.dispatchContextChanged = true;
      }
      try {
        await until('exact-dev-self-document-navigation-blocked', () => client.evaluate(
          'performance.timeOrigin !== ' + timeOrigin + ' && window[' + JSON.stringify(witness) +
          '] === undefined && location.href === ' + JSON.stringify(url)
        ), 5500, assertSameOwner);
        nav.exactDevSelfReloaded = true;
        nav.observedSelfReloadMs = Number(process.hrtime.bigint() - start) / 1e6;
      } catch (error) {
        nav.selfReloadWitness = await client.evaluate(
          '({sameTimeOrigin:performance.timeOrigin === ' + timeOrigin +
          ',transientGlobalSurvived:window[' + JSON.stringify(witness) + '] === "alive"})'
        ).catch(() => 'unavailable');
        throw error;
      }
      const after = (await client.command('Page.getFrameTree')).frameTree.frame;
      nav.primaryFrameRetained = after.id === frame.id && after.url === url;
      if (!nav.primaryFrameRetained) fail('LIVE_FAIL:main-frame-identity-changed-on-exact-dev-self-reload');
      assertSameOwner();
      stage = 'verified';
      return;
    }
    if (watchPreload) {
      stage = 'preload-baseline';
      const property = '__cosPreloadLive' + nonce;
      preloadProperty = property;
      const initialTime = await client.evaluate('performance.timeOrigin');
      if (await client.evaluate(`typeof window['${property}'] !== 'undefined'`))
        fail('Refused: preload probe property already exists');
      await client.evaluate(`window.__cosPreloadOldPage = '${nonce}'; true`);
      stage = 'preload-build';
      // Test-only exposure changes observable preload behavior, not renderer HTML.
      sourceEdits.write('preload', Buffer.concat([
        fixture.originalPreload,
        Buffer.from(`\ncontextBridge.exposeInMainWorld('${property}', { receipt: '${nonce}' });\n`)
      ]));
      const changedBuild = await awaitChangedPreloadBuild(
        fixture.preloadBuild, fixture.originalPreloadBuild, property, nonce,
        assertSameOwner, 14000, fixture.originalPreloadBuildCanonical,
        () => sourceEdits.assertExpected());
      evidence.preloadBuildChanged = true;
      evidence.preloadBuiltContainsUniqueApi = true;
      evidence.preloadBuiltSha256 = changedBuild.sha256;
      stage = 'preload-renderer-update';
      try {
        await until('preload-built-but-primary-electron-document-not-updated', async () =>
          temporaryPreloadAppliedToPrimary(await client.evaluate(`({
            url: location.href,
            timeOrigin: performance.timeOrigin,
            readyState: document.readyState,
            preloadApiAvailable: typeof window.api === 'object' && window.api !== null,
            transientGlobalSurvived: window.__cosPreloadOldPage === ${JSON.stringify(nonce)},
            temporaryApiReceipt: window[${JSON.stringify(property)}]?.receipt ?? null
          })`), initialTime, nonce), 14000, assertSameOwner);
        // Mark the actual *new* document before rollback, so a no-op Vite
        // compile or an old CDP reply can never masquerade as a restored
        // renderer after the temporary preload source is removed.
        preloadAppliedTimeOrigin = await client.evaluate('performance.timeOrigin');
        if (!Number.isFinite(preloadAppliedTimeOrigin) || preloadAppliedTimeOrigin <= initialTime)
          fail('LIVE_FAIL:preload-applied-document-identity-unverified');
        await client.evaluate(`window.__cosPreloadAppliedPage = '${nonce}'; true`);
        evidence.preloadAppliedToRenderer = true;
      } finally {
        // Explain the failure without inferring it from missing APIs alone: a reload would
        // also replace both the page's time origin and its deliberately transient global.
        try {
          evidence.preloadRendererWitness = await client.evaluate(
            `({samePageTimeOrigin: performance.timeOrigin === ${initialTime},
               transientGlobalSurvived: window.__cosPreloadOldPage === '${nonce}',
               newPreloadApiPresent: window['${property}']?.receipt === '${nonce}'})`
          );
        } catch { evidence.preloadRendererWitness = 'unavailable-during-navigation'; }
        // Reverting the fixture input also reverses the watcher output, not merely its source.
        sourceEdits.write('preload', fixture.originalPreload);
        // The single output-restoration fence below owns the final build
        // receipt, including an interrupted watcher. Never wait twice.
      }
      assertSameOwner();
      stage = 'verified';
      return;
    }
    const initial = await client.evaluate(cssExpression);
    if (initial) fail('Refused: CSS proof property exists already');
    stage = 'css-update';
    sourceEdits.write('css', Buffer.concat([fixture.originalCss, Buffer.from(`\n:root { ${cssRule}: applied; }\n`)]));
    await until('css-not-applied-in-Electron-renderer', async () => await client.evaluate(cssExpression) === 'applied', 14000, assertSameOwner);
    evidence.cssApplied = true;
    sourceEdits.write('css', fixture.originalCss);
    stage = 'css-restore';
    await until('css-not-restored-in-Electron-renderer', async () => await client.evaluate(cssExpression) === '', 14000, assertSameOwner);
    evidence.cssRestored = true;
    stage = 'external-navigation';
    const currentUrl = await client.evaluate('location.href');
    await client.evaluate(`location.assign('https://example.invalid/cos-live-denied'); true`);
    await sleep(450);
    evidence.externalDenied = await client.evaluate(`location.href === ${JSON.stringify(currentUrl)}`);
    if (!evidence.externalDenied) fail('LIVE_FAIL:external-navigation-allowed');
    // CSS has a separate native verdict, independent of the pending app-shell
    // HTML navigation change. The proof still checks private process ownership.
    if (cssOnly) {
      assertSameOwner();
      stage = 'verified-css-only';
      return;
    }
    const initialTime = await client.evaluate('performance.timeOrigin');
    await client.evaluate(`window.__cosLiveProof = '${nonce}'; true`);
    const htmlDocumentWitness = () => client.evaluate(`({
      url: location.href, timeOrigin: performance.timeOrigin,
      readyState: document.readyState,
      transientGlobalSurvived: window.__cosLiveProof === ${JSON.stringify(nonce)},
      headMarkerPresent: document.head?.innerHTML.includes(${JSON.stringify(htmlMarker)}) === true,
      preloadApiAvailable: typeof window.api === 'object' && window.api !== null
    })`);
    stage = 'html-update';
    const htmlBytes = Buffer.from(fixture.originalHtml.toString('utf8').replace('</head>', `<!-- ${htmlMarker} -->\n</head>`));
    if (digest(htmlBytes) === digest(fixture.originalHtml)) fail('Refused: expected HTML head closing tag missing');
    sourceEdits.write('html', htmlBytes);
    await until('html-not-reloaded-in-Electron-renderer', async () =>
      htmlRevisionAppliedToPrimary(await htmlDocumentWitness(), initialTime, true), 14000, assertSameOwner);
    evidence.htmlReloaded = true;
    const secondTime = await client.evaluate('performance.timeOrigin');
    await client.evaluate(`window.__cosLiveProof = '${nonce}'; true`);
    sourceEdits.write('html', fixture.originalHtml);
    stage = 'html-restore';
    await until('html-restore-not-reloaded-in-Electron-renderer', async () =>
      htmlRevisionAppliedToPrimary(await htmlDocumentWitness(), secondTime, false), 14000, assertSameOwner);
    evidence.htmlRestoreReloaded = true;
    assertSameOwner();
    stage = 'verified';
  } catch (error) {
    console.error(`LIVE_FAILED_STAGE=${stage} REASON=${error.message}`);
    process.exitCode = 1;
  } finally {
    // An edit that failed halfway through a watch/reload is still subject to
    // source custody. No-op paths never write; foreign edits are preserved.
    const sourceIntact = sourceEdits.restore();
    if (Object.values(sourceIntact).some(value => value !== true)) {
      console.error('SOURCE_CONFLICT:fixture changed outside probe custody; conflicting files not overwritten');
      process.exitCode = 1;
    }
    // Source restoration alone cannot prove a preload compilation was restored.
    // A delayed/stalled watcher must not leave a changed compiled preload
    // reported as a clean acceptance. Never mutate compiled output ourselves.
    if (watchPreload && sourceEdits.wasEdited('preload') && sourceIntact.preload) {
      try {
        await awaitOriginalPreloadBuild(fixture.preloadBuild, fixture.originalPreloadBuild,
          assertSameOwner, 14000, fixture.originalPreloadBuildCanonical,
          () => sourceEdits.assertRestored());
        evidence.preloadBuildRestored = true;
      } catch (error) {
        console.error('RESTORE_FAILED:' + error.message);
        process.exitCode = 1;
      }
    }
    // Restored source + restored compiled output can leave the *current*
    // Electron renderer running the temporary preload for its lifetime.
    // The original app-shell guards currently prevent the required
    // replacement document. Report that blocked native recovery explicitly
    // instead of publishing a false verified/clean rollback receipt.
    if (watchPreload && evidence.preloadAppliedToRenderer &&
        sourceIntact.preload && evidence.preloadBuildRestored) {
      let lastWitness = null;
      try {
        await until('preload-original-runtime-not-adopted', async () => {
          assertSameOwner();
          lastWitness = await client.evaluate(`({
            url: location.href,
            timeOrigin: performance.timeOrigin,
            readyState: document.readyState,
            preloadApiAvailable: typeof window.api === 'object' && window.api !== null,
            temporaryApiReceipt: window[${JSON.stringify(preloadProperty)}]?.receipt ?? null,
            appliedDocumentWitness: window.__cosPreloadAppliedPage === ${JSON.stringify(nonce)}
          })`);
          return originalPreloadAppliedToRenderer(lastWitness, preloadAppliedTimeOrigin);
        }, 6500, assertSameOwner);
        evidence.preloadRendererRestored = true;
      } catch (error) {
        evidence.preloadRendererRestored = false;
        evidence.preloadRollbackWitness = lastWitness && {
          sameDocument: lastWitness.timeOrigin === preloadAppliedTimeOrigin,
          temporaryApiStillBound: lastWitness.temporaryApiReceipt !== null,
          appliedDocumentSurvived: lastWitness.appliedDocumentWitness === true,
          primaryDocumentRestored: lastWitness.url === 'http://localhost:5173/',
          rendererReady: lastWitness.readyState === 'complete',
          preloadBridgeAttached: lastWitness.preloadApiAvailable === true
        };
        console.error('RESTORE_FAILED:preload-original-runtime-not-adopted; ' +
          'source-and-built-output-restored-but-current-renderer-not-proven: ' + error.message);
        process.exitCode = 1;
      }
    }
    // The source/build digest can settle after the exact private watcher or
    // renderer has gone away. A verified result still needs both live owners
    // at the end of cleanup; byte restoration alone is a narrower receipt.
    if (stage.startsWith('verified') && !process.exitCode) {
      try {
        sourceEdits.assertRestored();
        assertSameOwner();
        if (await client.evaluate('location.href') !== 'http://localhost:5173/')
          fail('LIVE_FAIL:renderer-target-changed-after-restoration');
        evidence.finalRendererConnectionVerified = true;
      } catch (error) {
        console.error('LIVE_FAILED_STAGE=final-custody REASON=' + error.message);
        process.exitCode = 1;
      }
    }
    console.log('LIVE_PROOF=' + JSON.stringify(evidence));
    console.log('REAL_NAV_EVENTS=' + JSON.stringify(client.events));
    console.log('SOURCE_RESTORED=' + JSON.stringify(sourceIntact));
    const qualification = qualifyLiveProof({ stage, exitCode: process.exitCode ?? 0,
      evidence, sourceRestored: sourceIntact, provenance: {
        cssSourceSha256: digest(fixture.originalCss),
        htmlSourceSha256: digest(fixture.originalHtml),
        ...(watchPreload ? {
          preloadSourceSha256: digest(fixture.originalPreload),
          originalPreloadBuildSha256: fixture.originalPreloadBuild,
          changedPreloadBuildSha256: evidence.preloadBuiltSha256 ?? null
        } : {})
      } });
    console.log('NATIVE_QUALIFICATION=' + JSON.stringify(qualification));
    if (!qualification.accepted) process.exitCode ||= 1;
    client.ws.close();
  }
}
if (require.main === module) {
  main().catch(error => { console.error('LIVE_PROBE_REFUSED:' + error.message); process.exitCode ||= 2; });
} else {
  module.exports = { createOwnedSourceEdits, awaitOriginalPreloadBuild, awaitChangedPreloadBuild,
    originalPreloadAppliedToRenderer, temporaryPreloadAppliedToPrimary, htmlRevisionAppliedToPrimary,
    connectPage, verifyCliWorker, until, qualifyLiveProof };
}
