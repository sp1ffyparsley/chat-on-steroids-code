// Finite, read-only acceptance verifier for one explicitly named CoS Loop pair.
// It consumes the incumbent durable recorder only. It never sends, retries, reloads,
// opens a browser, edits runtime state, or turns its report into acceptance authority.
import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const MAX_META_BYTES = 1024 * 1024;
const MAX_EVENTS_BYTES = 64 * 1024 * 1024;
const MAX_MESSAGE_FILE_BYTES = 2 * 1024 * 1024;
const MAX_MESSAGE_BYTES = 64 * 1024 * 1024;
const MAX_MESSAGE_FILES = 8192;
const MAX_CONFIG_BYTES = 4 * 1024 * 1024;
const MAX_STATE_BYTES = 4 * 1024 * 1024;

const remainingLiveGates = Object.freeze([
  'installed-byte-identity',
  'qualified-runtime-identity',
  'known-qualified-generation-gap',
  'provider-retry-reload-custody',
  'temporary-helper-provider-recovery',
  'provider-load-retry-classifier',
  'worker-delivery-effort',
  'browser-window-group-ownership',
  'exact-conversation-window-focus',
  'automation-error-badges',
  'always-on-activity-timestamps',
  'sign-in-alert',
  'owned-blank-root-cleanup',
  'garry-route',
  'nickname-day-mode-persistence',
  'work-updates-readability',
  'progress-readability',
  'diagnostic-incident-recovery'
]);

// This verifier is specific to the current Loop acceptance campaign. Keep exact, already-qualified
// generations that were later proven to omit an acceptance-required repair fail-closed here rather
// than allowing a physically installed but superseded package to produce a misleading green subset.
// This is not a second package-qualification authority: installed bytes/provenance still come only
// from Assert-InstalledQualifiedBuild above, and releaseAccepted remains false below.
const knownRequiredGenerationGaps = Object.freeze([
  Object.freeze({
    // Windows qualified and installed on October 7. The three later source differences were
    // verified by Git comparison against this exact commit and installed file hashes.
    gitCommit: 'af4a4f1873ea71f068e51cf286ba7e6a6a64e1c8',
    appExecutableSha256: '9fb3cef6448fe4e58f1d29c943466a9ecf81d458ff8367c81b7d2b9dcfb4275e',
    appAsarSha256: '71036a6cb9ed8d1cf99dca06f9c1522e10f5e4b990d42d9e08294ce82fe8adcc',
    extensionBackgroundSha256: '2a61beba35412db89f7f84f3e5eeca61e0877c1ec305cb348a2cde8a19a6051d',
    extensionContentSha256: 'ad50515929d2295e4ac09763ecea52c119582b99044af93e3f6d13d4cade7623',
    gaps: Object.freeze([
      'recovering-tab-status',
      'deletion-restore-order',
      'runtime-source-visibility',
      'aborted-helper-wake-custody',
      'work-updates-inline-detail'
    ])
  }),
  Object.freeze({
    gitCommit: '63c78797f0152b718a78472077e6bf0f6e8649f6',
    appExecutableSha256: 'ac5ed7cfc41c4241b0cd13a996f47d5a430ffc70470dd8fc1a1cf251cebc663c',
    appAsarSha256: 'c8b7af57a4710ed1ad37897bbbc4ddc79c136f1721d173598e6d41d62fec93e9',
    extensionBackgroundSha256: 'e92ddf4e041db4e1c90e8414df52394ca46993c1b56559879d652e91747f3b72',
    extensionContentSha256: '03578eab29dc501aaddf05789b519d697f998b7736ad9cea5d93e999121ccec2',
    gaps: Object.freeze([
      'stale-diagnostic-chat-binding',
      'never-claimed-helper-cancellation',
      'bounded-unknown-tool-hold',
      'temporary-helper-provider-recovery',
      'provider-load-retry-classifier',
      'exact-conversation-window-focus',
      'always-on-activity-timestamps',
      'work-updates-readability'
    ])
  })
]);

function parseArgs(argv) {
  const out = { requireResume: false, requireProviderRecovery: false, requireProgressState: false,
    requiredProfiles: [], expectedChecklistCount: 6 };
  for (let at = 0; at < argv.length; at += 1) {
    const arg = argv[at];
    if (arg === '--require-resume') { out.requireResume = true; continue; }
    if (arg === '--require-provider-recovery') { out.requireProviderRecovery = true; continue; }
    if (arg === '--require-progress-state') { out.requireProgressState = true; continue; }
    if (!arg.startsWith('--')) throw new Error(`Unexpected argument: ${arg}`);
    const value = argv[++at];
    if (!value || value.startsWith('--')) throw new Error(`Missing value for ${arg}`);
    if (arg === '--session-dir') out.sessionDir = value;
    else if (arg === '--anchor-message') out.anchorMessage = value;
    else if (arg === '--next-message') out.nextMessage = value;
    else if (arg === '--expected-model') out.expectedModel = value;
    else if (arg === '--expected-effort') out.expectedEffort = value;
    else if (arg === '--core-tool') out.coreTool = value;
    else if (arg === '--install-script') out.installScript = value;
    else if (arg === '--install-root') out.installRoot = value;
    else if (arg === '--expected-install-verifier-sha256') out.expectedInstallVerifierSha256 = value.toLowerCase();
    else if (arg === '--expected-installed-content-sha256') out.expectedInstalledContentSha256 = value.toLowerCase();
    else if (arg === '--expected-installed-source-commit') out.expectedInstalledSourceCommit = value.toLowerCase();
    else if (arg === '--runtime-port') out.runtimePort = Number(value);
    else if (arg === '--worker-session-dir') out.workerSessionDir = value;
    else if (arg === '--expected-worker-model') out.expectedWorkerModel = value;
    else if (arg === '--expected-worker-effort') out.expectedWorkerEffort = value;
    else if (arg === '--config-file') out.configFile = value;
    else if (arg === '--required-profile') out.requiredProfiles.push(value);
    else if (arg === '--expected-automation-profile') out.expectedAutomationProfile = value;
    else if (arg === '--diagnostic-state') out.diagnosticState = value;
    else if (arg === '--expected-checklist-count') out.expectedChecklistCount = Number(value);
    else throw new Error(`Unknown argument: ${arg}`);
  }
  for (const key of ['sessionDir', 'anchorMessage', 'nextMessage', 'expectedModel', 'expectedEffort', 'coreTool']) {
    if (!out[key]) throw new Error(`Missing required --${key.replace(/[A-Z]/g, match => '-' + match.toLowerCase())}`);
  }
  if (out.anchorMessage === out.nextMessage) throw new Error('Anchor and next message ids must be different');
  const installedArgs = [out.installScript, out.installRoot, out.expectedInstallVerifierSha256,
    out.expectedInstalledContentSha256, out.expectedInstalledSourceCommit];
  if (installedArgs.some(Boolean) && !installedArgs.every(Boolean)) {
    throw new Error('Installed-byte proof requires --install-script, --install-root, --expected-install-verifier-sha256, --expected-installed-content-sha256 and --expected-installed-source-commit together');
  }
  if (out.expectedInstallVerifierSha256 && !/^[0-9a-f]{64}$/.test(out.expectedInstallVerifierSha256)) {
    throw new Error('Expected install verifier SHA-256 must be 64 lowercase/uppercase hex characters');
  }
  if (out.expectedInstalledContentSha256 && !/^[0-9a-f]{64}$/.test(out.expectedInstalledContentSha256)) {
    throw new Error('Expected installed content SHA-256 must be 64 lowercase/uppercase hex characters');
  }
  if (out.expectedInstalledSourceCommit && !/^[0-9a-f]{40,64}$/.test(out.expectedInstalledSourceCommit)) {
    throw new Error('Expected installed source commit must be a 40-64 character hex object id');
  }
  if (out.runtimePort !== undefined && (!Number.isSafeInteger(out.runtimePort) || out.runtimePort < 1 || out.runtimePort > 65535)) {
    throw new Error('Runtime port must be an integer from 1 through 65535');
  }
  if (out.runtimePort !== undefined && !installedArgs.every(Boolean)) {
    throw new Error('Runtime identity proof requires the complete installed-byte proof bundle');
  }
  if ((out.expectedWorkerModel || out.expectedWorkerEffort) && !out.workerSessionDir) {
    throw new Error('Worker model/effort expectations require --worker-session-dir');
  }
  if ((out.requiredProfiles.length > 0 || out.expectedAutomationProfile) && !out.configFile) {
    throw new Error('Profile/Day-mode proof requires --config-file');
  }
  if (out.expectedAutomationProfile && !['day', 'overnight', 'rotation'].includes(out.expectedAutomationProfile)) {
    throw new Error('Expected automation profile must be day, overnight, or rotation');
  }
  if (!Number.isSafeInteger(out.expectedChecklistCount) || out.expectedChecklistCount < 1 || out.expectedChecklistCount > 24) {
    throw new Error('Expected checklist count must be an integer from 1 through 24');
  }
  return out;
}

async function sha256File(file) {
  const bytes = await fs.readFile(file);
  return createHash('sha256').update(bytes).digest('hex');
}

async function installedByteIdentityGate(options) {
  if (!options.installScript) {
    return { pass: false, required: false, status: 'not-run', evidence: null };
  }
  const installScript = path.resolve(options.installScript);
  const installRoot = path.resolve(options.installRoot);
  const verifierSha256 = await sha256File(installScript);
  if (verifierSha256 !== options.expectedInstallVerifierSha256) {
    return {
      pass: false,
      required: true,
      status: 'verifier-hash-mismatch',
      evidence: { verifierSha256, expectedVerifierSha256: options.expectedInstallVerifierSha256 }
    };
  }

  // Reuse the release owner's one installed-byte authority. Dot-sourcing defines the canonical
  // assertion without executing Invoke-CustomInstall; the function itself performs the exact
  // EXE/app.asar/background/content/version/CUSTOM_BUILD/provenance checks against its pinned
  // qualified candidate. This verifier never reimplements those byte comparisons.
  const powershell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const input = [
    "$ErrorActionPreference='Stop'",
    "$ProgressPreference='SilentlyContinue'",
    ". (Get-Item -LiteralPath $env:COS_INSTALL_VERIFIER).FullName",
    "try {",
    "  $receipt=Assert-InstalledQualifiedBuild -InstallRoot $env:COS_INSTALL_ROOT",
    "  $receipt | ConvertTo-Json -Compress -Depth 8",
    "} catch {",
    "  [Console]::Error.WriteLine($_.Exception.Message)",
    "  exit 23",
    "}"
  ].join('\r\n');
  const encodedCommand = Buffer.from(input, 'utf16le').toString('base64');
  const result = spawnSync(powershell, ['-NoProfile', '-NonInteractive', '-EncodedCommand', encodedCommand], {
    encoding: 'utf8',
    timeout: 30_000,
    maxBuffer: 4 * 1024 * 1024,
    env: { ...process.env, COS_INSTALL_VERIFIER: installScript, COS_INSTALL_ROOT: installRoot }
  });
  if (result.error) {
    return { pass: false, required: true, status: 'canonical-verifier-launch-failed', evidence: { verifierSha256, error: result.error.message } };
  }
  if (result.status !== 0) {
    const stderr = String(result.stderr || '').trim() || 'canonical installed-byte verifier rejected the install';
    return { pass: false, required: true, status: 'canonical-verifier-rejected', evidence: { verifierSha256, error: stderr.slice(0, 1000) } };
  }
  const output = String(result.stdout || '').trim().split(/\r?\n/).filter(Boolean).at(-1);
  let receipt;
  try { receipt = JSON.parse(output || ''); }
  catch { return { pass: false, required: true, status: 'canonical-verifier-invalid-receipt', evidence: { verifierSha256 } }; }
  const contentSha256 = String(receipt?.ExtensionContentSha256 || '').toLowerCase();
  const sourceCommit = String(receipt?.GitCommit || '').toLowerCase();
  const pass = contentSha256 === options.expectedInstalledContentSha256 &&
    sourceCommit === options.expectedInstalledSourceCommit &&
    /^[0-9a-f]{64}$/.test(String(receipt?.AppExecutableSha256 || '').toLowerCase()) &&
    /^[0-9a-f]{64}$/.test(String(receipt?.AppAsarSha256 || '').toLowerCase()) &&
    /^[0-9a-f]{64}$/.test(String(receipt?.ExtensionBackgroundSha256 || '').toLowerCase());
  return {
    pass,
    required: true,
    status: pass ? 'verified' : 'receipt-binding-mismatch',
    evidence: {
      verifierSha256,
      version: receipt?.Version ?? null,
      appExecutableSha256: receipt?.AppExecutableSha256 ?? null,
      appAsarSha256: receipt?.AppAsarSha256 ?? null,
      extensionBackgroundSha256: receipt?.ExtensionBackgroundSha256 ?? null,
      extensionContentSha256: receipt?.ExtensionContentSha256 ?? null,
      sourceProvenanceSha256: receipt?.SourceProvenanceSha256 ?? null,
      gitCommit: receipt?.GitCommit ?? null,
      gitTree: receipt?.GitTree ?? null
    }
  };
}

function knownQualifiedGenerationGapGate(installedByteIdentity) {
  if (!installedByteIdentity?.required || !installedByteIdentity.pass) {
    return { pass: false, required: false, status: 'not-run', evidence: null };
  }
  const fingerprint = {
    gitCommit: String(installedByteIdentity.evidence?.gitCommit || '').toLowerCase(),
    appExecutableSha256: String(installedByteIdentity.evidence?.appExecutableSha256 || '').toLowerCase(),
    appAsarSha256: String(installedByteIdentity.evidence?.appAsarSha256 || '').toLowerCase(),
    extensionBackgroundSha256: String(installedByteIdentity.evidence?.extensionBackgroundSha256 || '').toLowerCase(),
    extensionContentSha256: String(installedByteIdentity.evidence?.extensionContentSha256 || '').toLowerCase()
  };
  const known = knownRequiredGenerationGaps.find(candidate =>
    candidate.gitCommit === fingerprint.gitCommit &&
    candidate.appExecutableSha256 === fingerprint.appExecutableSha256 &&
    candidate.appAsarSha256 === fingerprint.appAsarSha256 &&
    candidate.extensionBackgroundSha256 === fingerprint.extensionBackgroundSha256 &&
    candidate.extensionContentSha256 === fingerprint.extensionContentSha256);
  const gaps = known?.gaps || [];
  const pass = gaps.length === 0;
  return {
    pass,
    required: true,
    status: pass ? 'verified' : 'known-required-gap',
    evidence: { ...fingerprint, gaps: [...gaps] }
  };
}

async function inspectRuntimeByPort(port) {
  if (process.platform !== 'win32') {
    return { error: 'qualified-runtime inspection is currently implemented for the Windows release target only' };
  }
  const powershell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const input = [
    "$ErrorActionPreference='Stop'",
    "$port=[int]$env:COS_RUNTIME_PORT",
    "$listeners=@(Get-NetTCPConnection -State Listen -LocalPort $port | Where-Object { $_.LocalAddress -eq '127.0.0.1' -or $_.LocalAddress -eq '::1' })",
    "$owners=@($listeners | Select-Object -ExpandProperty OwningProcess -Unique)",
    "if ($owners.Count -ne 1) { throw ('Expected one loopback listener owner on port {0}; found {1}.' -f $port,$owners.Count) }",
    "$process=Get-Process -Id ([int]$owners[0]) -ErrorAction Stop",
    "$exe=$process.Path",
    "if (-not $exe) { $exe=(Get-CimInstance Win32_Process -Filter ('ProcessId = {0}' -f $process.Id)).ExecutablePath }",
    "if (-not $exe) { throw 'Runtime executable path is unavailable.' }",
    "$started=[DateTimeOffset]$process.StartTime.ToUniversalTime()",
    "[pscustomobject]@{pid=$process.Id;executablePath=$exe;startedAt=$started.ToUnixTimeMilliseconds()} | ConvertTo-Json -Compress"
  ].join('\r\n');
  const encodedCommand = Buffer.from(input, 'utf16le').toString('base64');
  const result = spawnSync(powershell, ['-NoProfile', '-NonInteractive', '-EncodedCommand', encodedCommand], {
    encoding: 'utf8', timeout: 15_000, maxBuffer: 1024 * 1024,
    env: { ...process.env, COS_RUNTIME_PORT: String(port) }
  });
  if (result.error) return { error: result.error.message };
  if (result.status !== 0) return { error: String(result.stderr || '').trim() || 'runtime listener inspection failed' };
  try { return JSON.parse(String(result.stdout || '').trim().split(/\r?\n/).filter(Boolean).at(-1) || ''); }
  catch { return { error: 'runtime listener inspection returned an invalid receipt' }; }
}

async function runtimeCandidateIdentityGate(options, installedByteIdentity) {
  if (options.runtimePort === undefined) {
    return { pass: false, required: false, status: 'not-run', notBefore: null, evidence: null };
  }
  if (!installedByteIdentity.pass) {
    return { pass: false, required: true, status: 'installed-identity-not-verified', notBefore: null, evidence: null };
  }
  const inspected = options.runtimeInspector
    ? await options.runtimeInspector(options.runtimePort)
    : await inspectRuntimeByPort(options.runtimePort);
  if (!inspected || inspected.error) {
    return { pass: false, required: true, status: 'runtime-inspection-failed', notBefore: null,
      evidence: { error: String(inspected?.error || 'runtime inspection returned no result').slice(0, 1000) } };
  }
  const pid = Number(inspected.pid);
  const startedAt = Number(inspected.startedAt);
  const executablePath = typeof inspected.executablePath === 'string' ? path.resolve(inspected.executablePath) : '';
  const installedExecutable = path.resolve(options.installRoot, 'Chat On Steroids.exe');
  if (!Number.isSafeInteger(pid) || pid < 1 || !Number.isFinite(startedAt) || startedAt <= 0 || !executablePath) {
    return { pass: false, required: true, status: 'runtime-receipt-invalid', notBefore: null, evidence: null };
  }
  let executableSha256;
  try {
    executableSha256 = inspected.executableSha256
      ? String(inspected.executableSha256).toLowerCase()
      : await sha256File(executablePath);
  } catch (error) {
    return { pass: false, required: true, status: 'runtime-executable-unreadable', notBefore: null,
      evidence: { pid, executablePath, error: error instanceof Error ? error.message : String(error) } };
  }
  const expectedSha256 = String(installedByteIdentity.evidence?.appExecutableSha256 || '').toLowerCase();
  const samePath = executablePath.toLowerCase() === installedExecutable.toLowerCase();
  const pass = samePath && /^[0-9a-f]{64}$/.test(executableSha256) && executableSha256 === expectedSha256;
  return {
    pass,
    required: true,
    status: pass ? 'verified' : 'runtime-binding-mismatch',
    notBefore: pass ? startedAt : null,
    evidence: { port: options.runtimePort, pid, startedAt, executablePath, installedExecutable,
      executableSha256, expectedExecutableSha256: expectedSha256, samePath }
  };
}

async function inspectExpectedRuntime(port, options, installedByteIdentity) {
  const inspected = options.runtimeInspector
    ? await options.runtimeInspector(port)
    : await inspectRuntimeByPort(port);
  if (!inspected || inspected.error) {
    return { pass: false, port, status: 'runtime-inspection-failed',
      error: String(inspected?.error || 'runtime inspection returned no result').slice(0, 1000) };
  }
  const executablePath = typeof inspected.executablePath === 'string' ? path.resolve(inspected.executablePath) : '';
  const installedExecutable = path.resolve(options.installRoot, 'Chat On Steroids.exe');
  const pid = Number(inspected.pid);
  let executableSha256 = typeof inspected.executableSha256 === 'string'
    ? inspected.executableSha256.toLowerCase() : null;
  if (!executableSha256 && executablePath) {
    try { executableSha256 = await sha256File(executablePath); }
    catch (error) {
      return { pass: false, port, pid, status: 'runtime-executable-unreadable', executablePath,
        error: error instanceof Error ? error.message : String(error) };
    }
  }
  const expectedSha256 = String(installedByteIdentity.evidence?.appExecutableSha256 || '').toLowerCase();
  const samePath = executablePath.toLowerCase() === installedExecutable.toLowerCase();
  const pass = Number.isSafeInteger(pid) && pid > 0 && samePath &&
    /^[0-9a-f]{64}$/.test(String(executableSha256 || '')) && executableSha256 === expectedSha256;
  return { pass, port, pid, status: pass ? 'verified' : 'runtime-binding-mismatch', executablePath,
    executableSha256, expectedExecutableSha256: expectedSha256, samePath };
}

async function profilePersistenceAndRoutingGate(options, installedByteIdentity) {
  if (!options.configFile) {
    return { pass: false, required: false, status: 'not-run', evidence: null };
  }
  const configPath = path.resolve(options.configFile);
  const configRoot = path.dirname(configPath);
  const config = await readJsonBounded(configPath, MAX_CONFIG_BYTES);
  const expectedAutomationProfile = options.expectedAutomationProfile || 'day';
  const profiles = Array.isArray(config?.instances?.profiles) ? config.instances.profiles : [];
  const requiredNames = [...new Set((options.requiredProfiles || []).filter(value => typeof value === 'string' && value.trim()).map(value => value.trim()))];
  const registryPorts = profiles.map(profile => profile?.bridge?.port).filter(Number.isSafeInteger);
  const uniqueRegistryPorts = new Set(registryPorts).size === registryPorts.length;
  const selected = [];
  for (const name of requiredNames) {
    const matches = profiles.filter(profile => profile?.displayName === name || profile?.accountLabel === name);
    if (matches.length !== 1) {
      selected.push({ name, pass: false, status: matches.length === 0 ? 'profile-missing' : 'profile-ambiguous' });
      continue;
    }
    const profile = matches[0];
    const stateRoot = typeof profile?.state?.root === 'string' ? path.resolve(profile.state.root) : '';
    const isolatedRoot = path.resolve(configRoot, 'instances');
    const rootAllowed = profile?.state?.mode === 'legacy'
      ? stateRoot.toLowerCase() === configRoot.toLowerCase()
      : profile?.state?.mode === 'isolated' && stateRoot.toLowerCase().startsWith(`${isolatedRoot.toLowerCase()}${path.sep}`);
    const identityPass = profile.enabled !== false && profile?.bridge?.host === '127.0.0.1' &&
      Number.isSafeInteger(profile?.bridge?.port) && profile.bridge.port >= 1024 && profile.bridge.port <= 65535 &&
      typeof profile?.browser?.profileId === 'string' && profile.browser.profileId.length > 0 &&
      rootAllowed && (profile?.state?.mode !== 'isolated' ||
        (typeof profile?.browser?.profileDirectory === 'string' && profile.browser.profileDirectory.length > 0));
    let runtimeConfig = null;
    let profileAutomationProfile = null;
    let automationPaused = null;
    if (identityPass) {
      try {
        runtimeConfig = profile.state.mode === 'legacy'
          ? config
          : await readJsonBounded(path.join(stateRoot, 'runtime', 'config.json'), MAX_CONFIG_BYTES);
        profileAutomationProfile = runtimeConfig?.ui?.automationProfile ?? null;
        automationPaused = typeof runtimeConfig?.ui?.automationPaused === 'boolean' ? runtimeConfig.ui.automationPaused : null;
      } catch {
        runtimeConfig = null;
      }
    }
    const dayModePass = profileAutomationProfile === expectedAutomationProfile;
    let runtime = { pass: false, status: installedByteIdentity.pass ? 'not-checked' : 'installed-identity-not-verified' };
    if (identityPass && dayModePass && installedByteIdentity.pass) {
      runtime = await inspectExpectedRuntime(profile.bridge.port, options, installedByteIdentity);
    }
    selected.push({
      name,
      pass: identityPass && dayModePass && runtime.pass,
      status: !identityPass ? 'profile-routing-invalid' : !dayModePass ? 'profile-day-mode-mismatch' : runtime.status,
      id: profile.id ?? null,
      displayName: profile.displayName ?? null,
      accountLabel: profile.accountLabel ?? null,
      bridgePort: profile?.bridge?.port ?? null,
      browserProfileId: profile?.browser?.profileId ?? null,
      browserProfileDirectory: profile?.browser?.profileDirectory ?? null,
      stateMode: profile?.state?.mode ?? null,
      stateRoot,
      automationProfile: profileAutomationProfile,
      automationPaused,
      runtime
    });
  }
  const automationProfile = config?.ui?.automationProfile ?? null;
  const pass = automationProfile === expectedAutomationProfile && uniqueRegistryPorts && requiredNames.length > 0 &&
    selected.length === requiredNames.length && selected.every(row => row.pass);
  return { pass, required: true, status: pass ? 'verified' : 'profile-proof-incomplete', evidence: {
    automationProfile, expectedAutomationProfile, activeInstanceId: config?.instances?.activeInstanceId ?? null,
    uniqueRegistryPorts, requiredProfiles: requiredNames, profiles: selected
  } };
}

async function diagnosticRecoveryGate(options, primeMeta, notBefore = null) {
  if (!options.diagnosticState) {
    return { pass: false, required: false, status: 'not-run', evidence: null };
  }
  const state = await readJsonBounded(path.resolve(options.diagnosticState), MAX_STATE_BYTES);
  const incidents = Array.isArray(state?.incidents) ? state.incidents : [];
  const receipt = incidents.find(row => ['delivery', 'loop', 'worker'].includes(row?.kind) &&
    row?.sourceSessionId === primeMeta?.id && row?.status === 'resolved' &&
    row?.disposition === 'recovered' && row?.repeatCount === 1 && typeof row?.wakeInputId === 'string' && row.wakeInputId.length > 0 &&
    typeof row?.wakeMessageId === 'string' && row.wakeMessageId.length > 0 && Number.isFinite(row?.settledAt) &&
    (row?.inputCustody === 'sent' || row?.inputCustody === 'ambiguous') &&
    (notBefore === null || (Number.isFinite(row?.exhaustedAt) && row.exhaustedAt >= notBefore && row.settledAt >= notBefore)));
  const pass = state?.version === 1 && Number(state?.overflowCount) === 0 && Boolean(state?.chat?.sessionId) &&
    Boolean(state?.chat?.conversationId) && Boolean(receipt);
  return { pass, required: true, status: pass ? 'verified' : 'diagnostic-proof-incomplete', evidence: receipt ? {
    ownerId: state.ownerId ?? null,
    diagnosticChat: { sessionId: state.chat?.sessionId ?? null, conversationId: state.chat?.conversationId ?? null },
    incidentId: receipt.id ?? null,
    kind: receipt.kind ?? null,
    sourceSessionId: receipt.sourceSessionId,
    sourceConversationId: receipt.sourceConversationId ?? null,
    inputCustody: receipt.inputCustody ?? null,
    wakeInputId: receipt.wakeInputId,
    wakeMessageId: receipt.wakeMessageId,
    exhaustedAt: receipt.exhaustedAt ?? null,
    settledAt: receipt.settledAt,
    disposition: receipt.disposition,
    repeatCount: receipt.repeatCount,
    overflowCount: state.overflowCount
  } : { version: state?.version ?? null, overflowCount: state?.overflowCount ?? null, incidentCount: incidents.length } };
}

async function progressStateGate(options, sessionDir) {
  if (!options.requireProgressState) {
    return { pass: false, required: false, status: 'not-run', evidence: null };
  }
  let plan;
  try { plan = await readJsonBounded(path.join(sessionDir, 'plan.json'), MAX_STATE_BYTES); }
  catch (error) {
    if (error?.code === 'ENOENT') return { pass: false, required: true, status: 'plan-missing', evidence: null };
    throw error;
  }
  const steps = Array.isArray(plan?.plan) ? plan.plan : [];
  const checklist = Array.isArray(plan?.checklist) ? plan.checklist : [];
  const ids = checklist.map(row => row?.id).filter(value => typeof value === 'string' && value.length > 0);
  const statuses = new Set(['pending', 'implemented', 'verified', 'blocked', 'excluded']);
  const stepStatuses = new Set(['pending', 'in_progress', 'completed']);
  const valid = Number.isFinite(plan?.updatedAt) && steps.length > 0 && checklist.length > 0 &&
    checklist.length === options.expectedChecklistCount && new Set(ids).size === checklist.length && checklist.every(row => statuses.has(row?.status) &&
      typeof row?.requirement === 'string' && typeof row?.acceptance === 'string') &&
    steps.every(row => stepStatuses.has(row?.status) && typeof row?.step === 'string') &&
    steps.filter(row => row?.status === 'in_progress').length <= 1;
  return { pass: valid, required: true, status: valid ? 'verified' : 'plan-invalid', evidence: {
    updatedAt: plan?.updatedAt ?? null, stepCount: steps.length, checklistCount: checklist.length,
    expectedChecklistCount: options.expectedChecklistCount,
    verifiedCount: checklist.filter(row => row?.status === 'verified').length,
    inProgressCount: steps.filter(row => row?.status === 'in_progress').length
  } };
}

async function readJsonBounded(file, maxBytes) {
  const stat = await fs.stat(file);
  if (!stat.isFile() || stat.size > maxBytes) throw new Error(`Refusing oversized or non-file evidence: ${file}`);
  return JSON.parse(await fs.readFile(file, 'utf8'));
}

function evidenceKey(row) {
  if ((row?.kind === 'user_message' || row?.kind === 'assistant_message') && row.messageId) {
    return `${row.kind}\u0000${row.messageId}`;
  }
  if (row?.kind === 'tool_call' && row.call?.callId) return `tool_call\u0000${row.call.callId}`;
  return null;
}

function validSeq(row) {
  return row && Number.isSafeInteger(row.seq) && row.seq > 0 && Number.isFinite(row.time) && typeof row.kind === 'string';
}

// Same stable-position rule as src/shared/chronology.ts::positionOf. Canonical message
// revisions keep `origin` at their first recorder position while `seq` advances with hydration.
function positionOf(row) {
  return Number.isFinite(row?.origin) ? row.origin : row?.seq;
}

async function readCanonicalMessages(sessionDir) {
  const canonical = new Map();
  let bytes = 0;
  const messagesDir = path.join(sessionDir, 'messages');
  try {
    const entries = await fs.readdir(messagesDir, { withFileTypes: true });
    const files = entries.filter(entry => entry.isFile() && entry.name.endsWith('.json'));
    if (files.length > MAX_MESSAGE_FILES) throw new Error(`Too many canonical message shards: ${files.length}`);
    for (const entry of files) {
      const file = path.join(messagesDir, entry.name);
      const stat = await fs.stat(file);
      if (stat.size > MAX_MESSAGE_FILE_BYTES) throw new Error(`Canonical message shard is too large: ${entry.name}`);
      bytes += stat.size;
      if (bytes > MAX_MESSAGE_BYTES) throw new Error('Canonical message evidence exceeds the bounded read limit');
      const row = JSON.parse(await fs.readFile(file, 'utf8'));
      if (!validSeq(row)) continue;
      const key = evidenceKey(row);
      if (!key) continue;
      const previous = canonical.get(key);
      if (!previous || row.seq >= previous.seq) canonical.set(key, row);
    }
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }

  // Read legacy canonical storage only as a compatibility overlay. A shard with the same
  // stable identity wins when it is newer; neither representation becomes a second event.
  const legacyFile = path.join(sessionDir, 'messages.json');
  try {
    const legacy = await readJsonBounded(legacyFile, MAX_MESSAGE_BYTES);
    const rows = Array.isArray(legacy) ? legacy : legacy && typeof legacy === 'object' ? Object.values(legacy) : [];
    for (const row of rows) {
      if (!validSeq(row)) continue;
      const key = evidenceKey(row);
      if (!key) continue;
      const previous = canonical.get(key);
      if (!previous || row.seq > previous.seq) canonical.set(key, row);
    }
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  return canonical;
}

async function readRows(sessionDir) {
  const canonical = await readCanonicalMessages(sessionDir);
  const rows = [];
  const eventsFile = path.join(sessionDir, 'events.jsonl');
  const stat = await fs.stat(eventsFile);
  if (!stat.isFile() || stat.size > MAX_EVENTS_BYTES) throw new Error('events.jsonl exceeds the bounded read limit');
  const raw = await fs.readFile(eventsFile, 'utf8');
  let damaged = 0;
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line);
      if (!validSeq(row)) { damaged += 1; continue; }
      const key = evidenceKey(row);
      if (key && canonical.has(key)) continue;
      rows.push(row);
    } catch { damaged += 1; }
  }
  if (damaged > 0) throw new Error(`Recorder evidence contains ${damaged} unreadable or malformed event row(s)`);
  rows.push(...canonical.values());
  rows.sort((a, b) => positionOf(a) - positionOf(b) || a.seq - b.seq);
  return rows;
}

function exactMessage(rows, messageId) {
  const matches = rows.filter(row => row.kind === 'user_message' && row.messageId === messageId);
  return matches.length === 1 ? matches[0] : null;
}

function freshEnough(row, notBefore) {
  return notBefore === null || notBefore === undefined || (Number.isFinite(row?.time) && row.time >= notBefore);
}

function exactGoalNativeReceipt(row) {
  // Browser Goal/Loop sends have no outbox input: the incumbent /goal/ack owner recorded
  // their exact provider message ID and automatic origin. A later sparse native page echo
  // may replace the source with extension, but canonical storage keeps automationOrigin.
  return Boolean(row?.automationOrigin === 'goal' &&
    (row.source === 'app' || row.source === 'extension') && !row.inputId && !row.inputDelivery);
}

function nativeSendGate(row, expectedModel, expectedEffort, notBefore = null, allowAutomaticGoal = false) {
  const fromOutbox = Boolean(row?.inputId && row.inputDelivery === 'confirmed');
  const fromGoal = allowAutomaticGoal && exactGoalNativeReceipt(row);
  const pass = Boolean(row?.kind === 'user_message' && row.messageId && (fromOutbox || fromGoal) &&
    row.model === expectedModel && row.reasoningEffort === expectedEffort && freshEnough(row, notBefore));
  return {
    pass,
    evidence: row ? {
      seq: row.seq,
      position: positionOf(row),
      messageId: row.messageId ?? null,
      inputId: row.inputId ?? null,
      inputDelivery: row.inputDelivery ?? null,
      automationOrigin: row.automationOrigin ?? null,
      deliveryKind: fromGoal ? 'native-goal-ack' : fromOutbox ? 'confirmed-outbox' : null,
      model: row.model ?? null,
      reasoningEffort: row.reasoningEffort ?? null
      ,time: row.time ?? null, notBefore
    } : null
  };
}

function usefulCore(row, coreTool, chatIds, expectedTurn, expectedModel, expectedEffort,
  currentConversationOnly = false, currentConversation = null, notBefore = null) {
  return row?.kind === 'tool_call' && row.source === 'mcp' && row.turnId === expectedTurn &&
    row.call?.tool === coreTool && row.call?.outcome === 'ok' && row.call?.attributionMethod === 'request_id' &&
    typeof row.call?.requestId === 'string' && row.call.requestId.length > 0 &&
    typeof row.call?.callId === 'string' && row.call.callId.length > 0 &&
    row.call?.model === expectedModel && row.call?.reasoningEffort === expectedEffort &&
    freshEnough(row, notBefore) && chatIds.has(row.call?.conversationId) &&
    (!currentConversationOnly || row.call?.conversationId === currentConversation);
}

function gateEvidenceTool(row) {
  return row ? {
    seq: row.seq,
    position: positionOf(row),
    turnId: row.turnId ?? null,
    callId: row.call?.callId ?? null,
    requestId: row.call?.requestId ?? null,
    conversationId: row.call?.conversationId ?? null,
    tool: row.call?.tool ?? null,
    outcome: row.call?.outcome ?? null,
    attributionMethod: row.call?.attributionMethod ?? null,
    model: row.call?.model ?? null,
    reasoningEffort: row.call?.reasoningEffort ?? null,
    time: row.time ?? null
  } : null;
}

function currentSelectionGate(meta, expectedModel, expectedEffort, notBefore = null) {
  const selection = meta?.selectedModel;
  const pass = Boolean(selection && selection.conversationId === meta?.conversationId &&
    selection.model === expectedModel && selection.reasoningEffort === expectedEffort &&
    (notBefore === null || (Number.isFinite(selection.observedAt) && selection.observedAt >= notBefore)));
  return { pass, evidence: selection ? {
    conversationId: selection.conversationId ?? null,
    model: selection.model ?? null,
    reasoningEffort: selection.reasoningEffort ?? null,
    observedAt: selection.observedAt ?? null,
    notBefore
  } : null };
}

function providerRecoveryGate(rows, required, notBefore = null) {
  const candidates = rows.filter(row => row?.kind === 'progress' && typeof row.progressId === 'string' &&
    row.progressId.startsWith('browser-repair:') && freshEnough(row, notBefore) &&
    typeof (row.message?.text ?? row.text) === 'string');
  const textOf = row => String(row?.message?.text ?? row?.text ?? '');
  const receipt = candidates.find(row => /^Retried the exact failed turn to recover\b/.test(textOf(row))) ??
    candidates.find(row => /^Reloaded chat to recover\b/.test(textOf(row)));
  return {
    pass: required ? Boolean(receipt) : true,
    required,
    status: receipt ? 'verified' : required ? 'missing-live-repair-receipt' : 'not-required',
    evidence: receipt ? { seq: receipt.seq, position: positionOf(receipt), time: receipt.time,
      progressId: receipt.progressId, turnId: receipt.turnId ?? null,
      action: textOf(receipt).startsWith('Retried ') ? 'retried' : 'reloaded' } : null
  };
}

async function workerEffortGate(options, primeMeta, notBefore = null) {
  if (!options.workerSessionDir) {
    return { pass: false, required: false, status: 'not-run', evidence: null };
  }
  const sessionDir = path.resolve(options.workerSessionDir);
  const meta = await readJsonBounded(path.join(sessionDir, 'meta.json'), MAX_META_BYTES);
  const rows = await readRows(sessionDir);
  const model = options.expectedWorkerModel || options.expectedModel;
  const effort = options.expectedWorkerEffort || options.expectedEffort;
  const selection = currentSelectionGate(meta, model, effort, notBefore);
  const execution = rows.find(row => row?.kind === 'tool_call' && row.source === 'mcp' &&
    row.call?.outcome === 'ok' && row.call?.attributionMethod === 'request_id' &&
    row.call?.conversationId === meta.conversationId && row.call?.model === model &&
    row.call?.reasoningEffort === effort && freshEnough(row, notBefore));
  const origin = meta?.origin;
  const lineage = Boolean(origin?.kind === 'worker' && origin.fromSessionId === primeMeta?.id &&
    typeof origin.agentId === 'string' && /^worker-\d+$/.test(origin.agentId));
  const pass = lineage && selection.pass && Boolean(execution);
  return { pass, required: true, status: pass ? 'verified' : 'worker-proof-incomplete', evidence: {
    sessionId: meta?.id ?? null, conversationId: meta?.conversationId ?? null,
    origin: origin ? { kind: origin.kind ?? null, fromSessionId: origin.fromSessionId ?? null, agentId: origin.agentId ?? null } : null,
    expectedModel: model, expectedEffort: effort, selection: selection.evidence,
    execution: gateEvidenceTool(execution)
  } };
}

export async function verifyLoopLiveAcceptance(options) {
  const sessionDir = path.resolve(options.sessionDir);
  const meta = await readJsonBounded(path.join(sessionDir, 'meta.json'), MAX_META_BYTES);
  const rows = await readRows(sessionDir);
  const installedByteIdentity = await installedByteIdentityGate(options);
  const knownQualifiedGenerationGap = knownQualifiedGenerationGapGate(installedByteIdentity);
  const qualifiedRuntimeIdentity = await runtimeCandidateIdentityGate(options, installedByteIdentity);
  const notBefore = qualifiedRuntimeIdentity.pass ? qualifiedRuntimeIdentity.notBefore : null;
  const chatIds = new Set(Array.isArray(meta.chatIds) ? meta.chatIds.filter(value => typeof value === 'string') : []);
  if (typeof meta.conversationId === 'string') chatIds.add(meta.conversationId);

  const anchor = exactMessage(rows, options.anchorMessage);
  const next = exactMessage(rows, options.nextMessage);
  const anchorNativeSend = nativeSendGate(anchor, options.expectedModel, options.expectedEffort, notBefore);
  const nextLoopNativeSend = nativeSendGate(next, options.expectedModel, options.expectedEffort, notBefore, true);

  let firstFinal = null;
  let firstCore = null;
  let firstStart = null;
  let firstEnd = null;
  const anchorPosition = anchor ? positionOf(anchor) : null;
  const nextPosition = next ? positionOf(next) : null;
  if (anchor && next && nextPosition > anchorPosition) {
    const starts = rows.filter(row => row.kind === 'turn_start' && typeof row.turnId === 'string' &&
      positionOf(row) > anchorPosition && positionOf(row) < nextPosition);
    for (const start of starts) {
      if (!freshEnough(start, notBefore)) continue;
      const final = rows.find(row => row.kind === 'assistant_message' && row.final === true &&
        row.goalEligible === true && row.turnId === start.turnId && freshEnough(row, notBefore));
      const core = rows.find(row => usefulCore(row, options.coreTool, chatIds, start.turnId,
        options.expectedModel, options.expectedEffort, false, null, notBefore));
      const end = rows.find(row => row.kind === 'turn_end' && row.turnId === start.turnId &&
        row.outcome === 'completed' && freshEnough(row, notBefore));
      if (final && core && end) { firstFinal = final; firstCore = core; firstStart = start; firstEnd = end; break; }
    }
  }

  let nextStart = null;
  let nextCore = null;
  let nextFinal = null;
  let nextEnd = null;
  if (next) {
    const starts = rows.filter(row => row.kind === 'turn_start' && typeof row.turnId === 'string' && positionOf(row) > nextPosition &&
      row.turnId !== firstFinal?.turnId);
    for (const start of starts) {
      if (!freshEnough(start, notBefore)) continue;
      const core = rows.find(row => usefulCore(row, options.coreTool, chatIds, start.turnId,
        options.expectedModel, options.expectedEffort, true, meta.conversationId, notBefore));
      const final = rows.find(row => row.kind === 'assistant_message' && row.final === true &&
        row.goalEligible === true && row.turnId === start.turnId && freshEnough(row, notBefore));
      const end = rows.find(row => row.kind === 'turn_end' && row.turnId === start.turnId &&
        row.outcome === 'completed' && freshEnough(row, notBefore));
      if (core && !nextCore) { nextStart = start; nextCore = core; }
      if (core && final && end) { nextStart = start; nextCore = core; nextFinal = final; nextEnd = end; break; }
    }
  }

  const anchorInput = anchor?.inputId;
  const nextIsGoal = exactGoalNativeReceipt(next);
  const inputIds = [anchorInput, ...(nextIsGoal ? [] : [next?.inputId])].filter(Boolean);
  const distinctMessages = Boolean(anchor?.messageId && next?.messageId && anchor.messageId !== next.messageId);
  const uniqueInputs = distinctMessages && Boolean(anchorInput) &&
    (nextIsGoal || Boolean(next?.inputId && next.inputId !== anchorInput)) && inputIds.every(inputId => {
    const ids = new Set(rows.filter(row => row.kind === 'user_message' && row.inputId === inputId && row.messageId)
      .map(row => row.messageId));
    return ids.size === 1;
  });

  const resumeLineagePass = !options.requireResume || Boolean(
    Array.isArray(meta.chatIds) && meta.chatIds.length >= 2 &&
    typeof meta.lastCommittedResumeHandoffId === 'string' && meta.lastCommittedResumeHandoffId.length > 0 &&
    meta.conversationId === meta.chatIds.at(-1)
  );
  // A picker observation from before the subsequent native Send cannot prove the account
  // still has the requested model/effort after Retry, continuation or a successor bind.
  const selectionNotBefore = Number.isFinite(next?.time)
    ? Math.max(notBefore ?? 0, next.time)
    : notBefore;
  const currentSelectionRetention = currentSelectionGate(meta, options.expectedModel, options.expectedEffort, selectionNotBefore);
  const providerRecoveryCustody = providerRecoveryGate(rows, options.requireProviderRecovery === true, notBefore);
  const workerDeliveryEffort = await workerEffortGate(options, meta, notBefore);
  const profilePersistenceAndRouting = await profilePersistenceAndRoutingGate(options, installedByteIdentity);
  const diagnosticIncidentRecovery = await diagnosticRecoveryGate(options, meta, notBefore);
  const progressState = await progressStateGate(options, sessionDir);

  const gates = {
    installedByteIdentity,
    qualifiedRuntimeIdentity,
    knownQualifiedGenerationGap,
    anchorNativeSend,
    firstUsefulCore: { pass: Boolean(firstStart && firstCore), evidence: gateEvidenceTool(firstCore) },
    firstFinal: { pass: Boolean(firstFinal && firstEnd), evidence: firstFinal ? {
      seq: firstFinal.seq, position: positionOf(firstFinal), messageId: firstFinal.messageId ?? null, turnId: firstFinal.turnId,
      final: firstFinal.final, goalEligible: firstFinal.goalEligible, turnEndSeq: firstEnd?.seq ?? null,
      turnEndPosition: firstEnd ? positionOf(firstEnd) : null
    } : null },
    nextLoopNativeSend,
    subsequentLoopWork: { pass: Boolean(nextStart && nextCore), evidence: gateEvidenceTool(nextCore) },
    subsequentFinal: { pass: Boolean(nextFinal && nextEnd), evidence: nextFinal ? {
      seq: nextFinal.seq, position: positionOf(nextFinal), messageId: nextFinal.messageId ?? null,
      turnId: nextFinal.turnId, final: nextFinal.final, goalEligible: nextFinal.goalEligible,
      turnEndSeq: nextEnd?.seq ?? null, turnEndPosition: nextEnd ? positionOf(nextEnd) : null
    } : null },
    currentSelectionRetention,
    providerRecoveryCustody,
    workerDeliveryEffort,
    profilePersistenceAndRouting,
    diagnosticIncidentRecovery,
    progressState,
    noInputReplay: { pass: uniqueInputs, evidence: {
      anchorInputId: anchor?.inputId ?? null, nextInputId: next?.inputId ?? null,
      nextAutomationOrigin: next?.automationOrigin ?? null,
      distinctProviderMessages: distinctMessages
    } },
    resumeLineage: { pass: resumeLineagePass, evidence: {
      required: options.requireResume === true,
      chatCount: Array.isArray(meta.chatIds) ? meta.chatIds.length : 0,
      currentConversationId: meta.conversationId ?? null,
      lastCommittedResumeHandoffId: meta.lastCommittedResumeHandoffId ?? null
    } }
  };
  const pass = Object.values(gates).every(gate => gate.required === false ? true : gate.pass === true);
  const remaining = remainingLiveGates.filter(gate => {
    if (gate === 'installed-byte-identity') return !installedByteIdentity.pass;
    if (gate === 'qualified-runtime-identity') return !qualifiedRuntimeIdentity.pass;
    if (gate === 'known-qualified-generation-gap') return !knownQualifiedGenerationGap.required || !knownQualifiedGenerationGap.pass;
    if (gate === 'provider-retry-reload-custody') return !providerRecoveryCustody.required || !providerRecoveryCustody.pass;
    if (gate === 'worker-delivery-effort') return !workerDeliveryEffort.required || !workerDeliveryEffort.pass;
    if (gate === 'diagnostic-incident-recovery') return !diagnosticIncidentRecovery.required || !diagnosticIncidentRecovery.pass;
    if (gate === 'garry-route') {
      const coversGarry = (options.requiredProfiles || []).some(name => /garry/i.test(name));
      return !coversGarry || !profilePersistenceAndRouting.pass;
    }
    if (gate === 'nickname-day-mode-persistence') return !profilePersistenceAndRouting.required || !profilePersistenceAndRouting.pass;
    return true;
  });
  return {
    schema: 'cos_loop_live_acceptance_receipts_v2',
    pass,
    // Installed bytes, runtime freshness and several durable live owners can be proved here, but
    // the companion-only Chrome topology and visual UI gates still require real application
    // observation. Keep this false so even a complete machine-readable subset cannot promote
    // itself into release acceptance.
    releaseAccepted: false,
    sessionId: typeof meta.id === 'string' ? meta.id : null,
    proofScope: qualifiedRuntimeIdentity.pass ? 'qualified-runtime' : 'recorder-only',
    notBefore,
    gates,
    remainingLiveGates: remaining,
    evidencePolicy: 'Exact durable session receipts, incumbent config/profile and diagnostic owners, plus the optional exact qualified-runtime process binding. A generation later proven to omit an acceptance-required repair remains quarantined even if its original package qualification is valid. Temporary-helper native recovery, provider load-Retry classification, exact Chrome window focus, always-on activity timestamps, Work & updates readability, browser topology and other visual companion behavior remain live-observation gates unless an incumbent durable owner can prove them. Queue admission, composer text, tab presence, timeout, missing ACK, null binding, reload alone, status labels and source/package state are never Send or Loop proof.'
  };
}

async function main() {
  try {
    const options = parseArgs(process.argv.slice(2));
    const report = await verifyLoopLiveAcceptance(options);
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    process.exitCode = report.pass ? 0 : 1;
  } catch (error) {
    process.stdout.write(`${JSON.stringify({
      schema: 'cos_loop_live_acceptance_receipts_v2', pass: false, releaseAccepted: false,
      error: error instanceof Error ? error.message : String(error), remainingLiveGates: [...remainingLiveGates]
    }, null, 2)}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) await main();
