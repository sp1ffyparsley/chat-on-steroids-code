import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(import.meta.dirname, '..');
const installScript = path.join(repoRoot, 'scripts', 'install-custom.ps1');
const applyUpdate = path.join(repoRoot, 'Apply Custom Update.cmd');
const rollbackUpdate = path.join(repoRoot, 'Rollback Custom Update.cmd');
const packageManifest = path.join(repoRoot, 'package.json');
const packageOwner = path.join(repoRoot, 'scripts', 'package.mjs');
const updaterOwner = path.join(repoRoot, 'src', 'main', 'update.ts');
const updaterIpc = path.join(repoRoot, 'src', 'main', 'ipc.ts');
const updaterLifecycle = path.join(repoRoot, 'src', 'main', 'index.ts');
const updaterPreload = path.join(repoRoot, 'src', 'preload', 'index.ts');
const updaterRenderer = path.join(repoRoot, 'src', 'renderer', 'main.ts');
const releaseRoot = path.join(repoRoot, 'release');
const unpackedRoot = path.join(releaseRoot, 'win-unpacked');
const releaseInstaller = path.join(releaseRoot, 'Chat-On-Steroids-Setup-x64.exe');
const pinnedInstallerSha256 = /InstallerSha256 = '([0-9a-f]{64})'/.exec(readFileSync(installScript, 'utf8'))?.[1] ?? '';
const pinnedGitCommit = /GitCommit = '([0-9a-f]{40,64})'/.exec(readFileSync(installScript, 'utf8'))?.[1] ?? '';
const hasPinnedReleaseFixture = existsSync(releaseInstaller) && pinnedInstallerSha256.length === 64 &&
  createHash('sha256').update(readFileSync(releaseInstaller)).digest('hex') === pinnedInstallerSha256;

function ps(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}


describe.runIf(process.platform === 'win32')('installed program file-lock preflight', () => {
  const shells = ['powershell.exe', ...(spawnSync('pwsh.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', 'exit 0'], { windowsHide: true }).status === 0 ? ['pwsh.exe'] : [])];
  it.each(shells)('refuses held files and unknown census before the installer runner in %s', shell => {
    const root = mkdtempSync(path.join(tmpdir(), 'cos-install-lock-'));
    try {
      const code = String.raw`$ErrorActionPreference='Stop'
. __INSTALL_SCRIPT__
$root=__FIXTURE_ROOT__
$file=Join-Path $root 'fixture.asar'
[IO.File]::WriteAllText($file,'retained-program-bytes')
$held=[IO.File]::Open($file,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read)
try {
  $owners=@(Get-InstalledProgramFileLocks -InstallRoot $root)
  if (@($owners | Where-Object { $_.ProcessId -eq $PID }).Count -ne 1) { throw 'HELD_FILE_OWNER_NOT_FOUND' }
} finally { $held.Dispose() }
if (@(Get-InstalledProgramFileLocks -InstallRoot $root).Count -ne 0) { throw 'RELEASED_FILE_STILL_HELD' }
$script:runnerCalls=0
$script:successorCalls=0
function Get-InstalledProgramFileLocks { param($InstallRoot) return [pscustomobject]@{ProcessId=4242;ApplicationName='fixture owner';ServiceName=''} }
try {
  Invoke-QualifiedInstallerTransaction -Qualified ([pscustomobject]@{InstallerPath='fixture.exe'}) -InstallRoot $root -InstallerRunner { $script:runnerCalls++;return 0 } -SuccessorLauncher {$script:successorCalls++} | Out-Null
  throw 'LOCKED_TRANSACTION_WAS_NOT_REFUSED'
} catch { if ($_.Exception.Message -notlike '*fixture owner*4242*') { throw } }
if ($script:runnerCalls -ne 0 -or $script:successorCalls -ne 0) { throw 'LOCKED_TRANSACTION_REACHED_SIDE_EFFECT' }
function Get-InstalledProgramFileLocks { param($InstallRoot) throw 'fixture native census unavailable' }
try {
  Invoke-QualifiedInstallerTransaction -Qualified ([pscustomobject]@{InstallerPath='fixture.exe'}) -InstallRoot $root -InstallerRunner { $script:runnerCalls++;return 0 } -SuccessorLauncher {$script:successorCalls++} | Out-Null
  throw 'UNKNOWN_CENSUS_WAS_NOT_REFUSED'
} catch { if ($_.Exception.Message -notlike '*census unavailable*') { throw } }
if ($script:runnerCalls -ne 0 -or $script:successorCalls -ne 0) { throw 'UNKNOWN_CENSUS_REACHED_SIDE_EFFECT' }
function Get-InstalledProgramFileLocks { param($InstallRoot) return @() }
try {
  Invoke-QualifiedInstallerTransaction -Qualified ([pscustomobject]@{InstallerPath='fixture.exe'}) -InstallRoot $root -InstallerRunner { $script:runnerCalls++;return 37 } -SuccessorLauncher {$script:successorCalls++} | Out-Null
  throw 'INSTALLER_FAILURE_WAS_NOT_RETAINED'
} catch { if ($_.Exception.Message -notlike '*exited with code 37*') { throw } }
if ($script:runnerCalls -ne 1 -or $script:successorCalls -ne 0) { throw 'EMPTY_CENSUS_CHANGED_INSTALLER_CUSTODY' }
if ([IO.File]::ReadAllText($file) -cne 'retained-program-bytes') { throw 'PREFLIGHT_MUTATED_PROGRAM' }
Write-Output 'FILE_LOCK_CASES=5'
`.replace('__INSTALL_SCRIPT__', ps(installScript)).replace('__FIXTURE_ROOT__', ps(root));
      const result = spawnSync(shell, ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(code, 'utf16le').toString('base64')], { encoding: 'utf8', windowsHide: true, timeout: 25_000 });
      expect(result.status, result.stdout + result.stderr).toBe(0);
      expect(result.stdout).toContain('FILE_LOCK_CASES=5');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});


describe.runIf(process.platform === 'win32')('native state backup checkpoint', () => {
  const shells = ['powershell.exe', ...(spawnSync('pwsh.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', 'exit 0'], { windowsHide: true }).status === 0 ? ['pwsh.exe'] : [])];
  it.each(shells)('requires manifest and final receipt custody in %s', shell => {
    const root = mkdtempSync(path.join(tmpdir(), 'cos-native-state-checkpoint-'));
    try {
      const code = String.raw`$ErrorActionPreference = 'Stop'
. __INSTALL_SCRIPT__
$root = __FIXTURE_ROOT__
$node = __NODE_PATH__
$fixtureScript = Join-Path $root 'reviewed utility.mjs'
[IO.File]::WriteAllText($fixtureScript, 'Fixture process seam; this file is never executed.', [Text.UTF8Encoding]::new($false))
$scriptHash = Get-FileHashHex -Path $fixtureScript
$source = Join-Path $root 'closed source 日本語'
New-Item -ItemType Directory -Path (Join-Path $source 'state') | Out-Null
$payload = Join-Path $source 'state\日本語.txt'
[IO.File]::WriteAllText($payload, 'abc', [Text.UTF8Encoding]::new($false))
$rowHash = Get-FileHashHex -Path $payload
$treeHash = '__TREE_HASH__'
$script:cases = 0
function Expect-CheckpointFailure {
  param([scriptblock]$Action,[string]$Needle)
  try { & $Action | Out-Null; throw 'CHECKPOINT_EXPECTED_FAILURE_MISSING' }
  catch { if ($_.Exception.Message -notlike "*$Needle*") { throw } }
}
foreach ($case in @('valid-capture','valid-verify','valid-refresh','missing-manifest','missing-receipt',
  'error-receipt','receipt-count','receipt-path','receipt-tree','receipt-digest','null-exit','nonzero-exit',
  'verify-missing-receipt','verify-mutated-before','verify-mutated-during','utility-mismatch',
  'manifest-count','manifest-bytes','manifest-owner','manifest-tree','manifest-receipt-tree')) {
  $script:currentCase = $case
  $script:runnerCalls = 0
  $script:process = $null
  $backup = Join-Path $root ('private backup 日本語-' + $case)
  $manifestPath = Join-Path $backup 'manifest.json'
  $script:manifest = [ordered]@{ format=1; capturedAt='2030-01-02T03:04:05.000Z'; source=$source; backup=$backup;
    selections=@(@{relative='state';exists=$true;directory=$true});
    rows=@(@{relative='state\日本語.txt';bytes=3;sha256=$rowHash});
    fileCount=1;totalBytes=3;treeSha256=$treeHash }
  $script:manifestPath = $manifestPath
  $script:source = $source
  $script:backup = $backup
  $mode = if ($case.StartsWith('verify-') -or $case -eq 'valid-verify') { 'verify' } else { 'capture' }
  if ($mode -eq 'verify') {
    New-Item -ItemType Directory -Path $backup | Out-Null
    [IO.File]::WriteAllText($manifestPath, ($script:manifest | ConvertTo-Json -Depth 8), [Text.UTF8Encoding]::new($false))
  }
  $checkpointParameters = @{ Mode=$mode;NodePath=$node;ScriptPath=$fixtureScript;ExpectedScriptSha256=$scriptHash;
    SourceRoot=$source;BackupRoot=$backup;EvidencePrefix=(Join-Path $root ('evidence-' + $case)) }
  if ($mode -eq 'verify') { $checkpointParameters.ExpectedManifestDigest = Get-FileHashHex -Path $manifestPath }
  if ($case -eq 'verify-mutated-before') {
    $script:manifest.capturedAt='2030-01-02T03:04:06.000Z'
    [IO.File]::WriteAllText($manifestPath, ($script:manifest | ConvertTo-Json -Depth 8), [Text.UTF8Encoding]::new($false))
  }
  if ($case -eq 'utility-mismatch') { $checkpointParameters.ExpectedScriptSha256 = '0' * 64 }
  $checkpointParameters.ProcessRunner = {
    param([hashtable]$StartParameters)
    $script:runnerCalls++
    if (-not $StartParameters.Wait -or -not $StartParameters.PassThru -or
        $StartParameters.WindowStyle -cne 'Hidden' -or $StartParameters.FilePath -cne $node -or
        $StartParameters.RedirectStandardOutput -ceq $StartParameters.RedirectStandardError) { throw 'BAD_STRUCTURED_PROCESS_OWNER' }
    if (($StartParameters.ArgumentList -join ' ') -notlike ('*"' + $script:source + '"*') -or
        ($StartParameters.ArgumentList -join ' ') -notlike ('*"' + $script:backup + '"*')) { throw 'UNQUOTED_NATIVE_PATH_ARGUMENTS' }
    if ($script:currentCase -ne 'missing-manifest') {
      if (-not (Test-Path -LiteralPath $script:backup)) { New-Item -ItemType Directory -Path $script:backup | Out-Null }
      New-Item -ItemType Directory -Path (Join-Path $script:backup 'files\state') -Force | Out-Null
      [IO.File]::Copy($payload, (Join-Path $script:backup 'files\state\日本語.txt'), $true)
      if ($script:currentCase -eq 'manifest-count') { $script:manifest.fileCount=2 }
      if ($script:currentCase -eq 'manifest-bytes') { $script:manifest.totalBytes=4 }
      if ($script:currentCase -eq 'manifest-owner') { $script:manifest.source=Join-Path $root 'foreign source' }
      if ($script:currentCase -eq 'manifest-tree') { $script:manifest.treeSha256='not-a-digest' }
      if ($script:currentCase -eq 'manifest-receipt-tree') { $script:manifest.treeSha256='0' * 64 }
      if ($script:currentCase -eq 'verify-mutated-during') { $script:manifest.capturedAt='2030-01-02T03:04:06.000Z' }
      [IO.File]::WriteAllText($script:manifestPath, ($script:manifest | ConvertTo-Json -Depth 8), [Text.UTF8Encoding]::new($false))
    }
    $receipt = [ordered]@{ stage= $(if ($mode -eq 'capture') {'closed-state-captured'} else {'closed-state-after-install-exact'});
      fileCount=1;totalBytes=3;treeSha256=$treeHash;manifestPath=$script:manifestPath }
    if ($mode -eq 'capture') {
      $receipt.manifestSha256 = if (Test-Path -LiteralPath $script:manifestPath) {
        Get-FileHashHex -Path $script:manifestPath
      } else { '1' * 64 }
    }
    if ($script:currentCase -eq 'error-receipt') { $receipt.stage='error' }
    if ($script:currentCase -eq 'receipt-count') { $receipt.fileCount=2 }
    if ($script:currentCase -eq 'receipt-path') { $receipt.manifestPath=Join-Path $root 'foreign-manifest.json' }
    if ($script:currentCase -in @('receipt-tree','manifest-receipt-tree')) { $receipt.treeSha256='0' * 64 }
    if ($script:currentCase -eq 'receipt-digest') { $receipt.manifestSha256='0' * 64 }
    $output = '[state-backup] fixture progress' + [Environment]::NewLine
    if ($script:currentCase -notin @('missing-receipt','verify-missing-receipt')) {
      $output += ($receipt | ConvertTo-Json -Compress) + [Environment]::NewLine
    }
    [IO.File]::WriteAllText($StartParameters.RedirectStandardOutput,$output,[Text.UTF8Encoding]::new($false))
    [IO.File]::WriteAllText($StartParameters.RedirectStandardError,'',[Text.UTF8Encoding]::new($false))
    $exitCode = if ($script:currentCase -eq 'null-exit') { $null } elseif ($script:currentCase -eq 'nonzero-exit') { 19 } else { 0 }
    $script:process = [pscustomobject]@{ ExitCode=$(if($script:currentCase -eq 'valid-refresh'){$null}else{$exitCode});
      RefreshedExitCode=$exitCode;RefreshCount=0 }
    $script:process | Add-Member ScriptMethod Refresh { $this.RefreshCount++;$this.ExitCode=$this.RefreshedExitCode }
    return $script:process
  }
  if ($case -in @('valid-capture','valid-verify','valid-refresh')) {
    $accepted = Invoke-NativeStateBackupCheckpoint @checkpointParameters
    if ($accepted.ManifestPath -cne $manifestPath -or $accepted.ManifestSha256 -cne (Get-FileHashHex -Path $manifestPath) -or
        $accepted.FileCount -ne 1 -or $accepted.TotalBytes -ne 3 -or $accepted.TreeSha256 -cne $treeHash -or
        $script:runnerCalls -ne 1 -or $script:process.RefreshCount -ne 1) { throw ('BAD_CHECKPOINT_RECEIPT:' + $case) }
  } else {
    $needle = if ($case -eq 'utility-mismatch') { 'utility SHA-256' }
      elseif ($case -in @('null-exit','nonzero-exit')) { 'exit code' }
      elseif ($case.StartsWith('manifest-') -or $case -eq 'missing-manifest') { 'manifest' }
      elseif ($case.StartsWith('verify-mutated-')) { 'manifest digest' }
      else { 'receipt' }
    Expect-CheckpointFailure { Invoke-NativeStateBackupCheckpoint @checkpointParameters } $needle
    $expectedCalls = if ($case -in @('utility-mismatch','verify-mutated-before')) { 0 } else { 1 }
    if ($script:runnerCalls -ne $expectedCalls) { throw ('BAD_RUNNER_CALL_COUNT:' + $case) }
  }
  $script:cases++
}
Write-Output ('NATIVE_CHECKPOINT_CASES=' + $script:cases)
`
        .replace('__INSTALL_SCRIPT__', ps(installScript))
        .replace('__FIXTURE_ROOT__', ps(root))
        .replace('__NODE_PATH__', ps(process.execPath))
        .replace('__TREE_HASH__', createHash('sha256').update('state/日本語.txt\u00003\u0000' + createHash('sha256').update('abc').digest('hex') + '\n').digest('hex'));
      const result = spawnSync(shell, ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(code, 'utf16le').toString('base64')], { encoding: 'utf8', windowsHide: true, timeout: 25_000 });
      expect(result.status, result.stdout + result.stderr).toBe(0);
      expect(result.stdout).toContain('NATIVE_CHECKPOINT_CASES=21');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

describe.runIf(process.platform === 'win32')('installed predecessor receipt proposal', () => {
  const shells = ['powershell.exe', ...(spawnSync('pwsh.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', 'exit 0'], { windowsHide: true }).status === 0 ? ['pwsh.exe'] : [])];
  it.each(shells)('accepts only exact receipt bytes in %s and refuses changed, missing, extra, or foreign provenance', (shell) => {
    const root = mkdtempSync(path.join(tmpdir(), 'cos-installed-predecessor-proposal-'));
    try {
      const command = [
        "$ErrorActionPreference='Stop'",
        '. ' + ps(installScript),
        '$root=' + ps(root),
        "$package=Join-Path $root 'win-unpacked';$installed=Join-Path $root 'installed';New-Item -ItemType Directory -Path $package,$installed -Force | Out-Null",
        "foreach($name in @('Chat On Steroids.exe','resources\\app.asar','resources\\extension\\background.js','resources\\extension\\manifest.json','resources\\CUSTOM_BUILD','resources\\SOURCE_PROVENANCE.json')){ $path=Join-Path $package $name;New-Item -ItemType Directory -Path (Split-Path -Parent $path) -Force | Out-Null;[IO.File]::WriteAllText($path,('fixture:'+ $name),[Text.UTF8Encoding]::new($false)) }",
        'Copy-Item -LiteralPath (Join-Path $package \'Chat On Steroids.exe\') -Destination (Join-Path $installed \'Chat On Steroids.exe\')',
        'Copy-Item -LiteralPath (Join-Path $package \'resources\') -Destination $installed -Recurse',
        "[IO.File]::WriteAllText((Join-Path $installed 'Uninstall Chat On Steroids.exe'),'normal NSIS uninstaller',[Text.UTF8Encoding]::new($false))",
        "$script:proposalSource=[pscustomobject]@{schema=2;commit=('a'*40);tree=('b'*40)};$script:proposalPinnedSource=[pscustomobject]@{GitCommit=('a'*40);GitTree=('b'*40)}",
        "function Assert-QualifiedPrebuiltCandidate { param($ReleaseDirectory,$RepoRoot,$Candidate) if($Candidate.ReleaseDate -isnot [string] -or $Candidate.ReleaseDate -cne '2030-01-02T03:04:05.000Z'){throw 'accepted ReleaseDate bytes changed during receipt parsing'};[pscustomobject]@{InstallerPath='accepted-installer.exe'} }",
        "function Read-InstallerCandidatePayloadIdentity { param($InstallerPath,$RepoRoot,$ReleaseDirectory) [pscustomobject]@{UnpackedCrossCheck='exact';FileCount=6;TotalBytes=[int64]100;TreeSha256=('f'*64)} }",
        "function Assert-InstalledQualifiedBuild { param($InstallRoot,$Candidate) $p=Join-Path $InstallRoot 'resources\\SOURCE_PROVENANCE.json';if((Get-FileHashHex -Path $p) -cne $Candidate.SourceProvenanceSha256){throw 'source provenance hash mismatch'};[pscustomobject]@{AppExecutableSha256=$Candidate.AppExecutableSha256;AppAsarSha256=$Candidate.AppAsarSha256;ExtensionBackgroundSha256=$Candidate.ExtensionBackgroundSha256} }",
        "function Read-SourceProvenanceRecord { param($Path) if(-not (Test-Path -LiteralPath $Path -PathType Leaf)){return $null};return $script:proposalSource }",
        "function Get-CandidatePinnedSourceProvenance { param($Candidate) return $script:proposalPinnedSource }",
        "function Assert-SourceProvenanceRecordsEqual { param($Expected,$Actual,$Context) if($Expected.GitCommit -cne $Actual.commit -or $Expected.GitTree -cne $Actual.tree){throw ($Context+' mismatch')} }",
        "$candidate=[pscustomobject]@{Version='9.9.9';InstallerFile='Chat-On-Steroids-Setup-x64.exe';InstallerSize=[int64]1;InstallerSha256=('c'*64);InstallerSha512='YQ==';LatestYmlSha256=('d'*64);ReleaseDate='2030-01-02T03:04:05.000Z';AppExecutableSha256=(Get-FileHashHex -Path (Join-Path $package 'Chat On Steroids.exe'));AppAsarSha256=(Get-FileHashHex -Path (Join-Path $package 'resources\\app.asar'));ExtensionBackgroundSha256=(Get-FileHashHex -Path (Join-Path $package 'resources\\extension\\background.js'));FileVersion='9.9.9';ProductVersion='9.9.9.0';SourceProvenanceSha256=(Get-FileHashHex -Path (Join-Path $package 'resources\\SOURCE_PROVENANCE.json'));GitCommit=('a'*40);GitTree=('b'*40);CustomBuildText='fixture'};[IO.File]::WriteAllText((Join-Path $root 'accepted-package.json'),($candidate|ConvertTo-Json -Depth 20),[Text.UTF8Encoding]::new($false))",
        "$ok=Get-InstalledPredecessorProposal -InstallRoot $installed -RepoRoot $root -ReleaseDirectory $root -AcceptedPackageReceipt $candidate;if($ok.GitCommit -cne ('a'*40) -or $ok.GitTree -cne ('b'*40) -or $ok.Status -cne 'exact-accepted-predecessor' -or $ok.Differences.Extra.Count -ne 0 -or $ok.TreeHashFrame -notlike '*TAB*' -or $ok.FileCount -ne 7 -or $ok.PayloadFileCount -ne 6 -or $ok.PayloadTotalBytes -ne 100){throw 'exact installed payload was not accepted with canonical tree receipt'};$script:QualifiedCandidate=$candidate;$before=$script:QualifiedCandidate|ConvertTo-Json -Compress;$receiptPath=Join-Path $root 'accepted-package.json';$receiptHashBefore=Get-FileHashHex -Path $receiptPath;$wired=Invoke-CustomInstall -ProposeInstalledPredecessor -AcceptedPackageReceiptPath $receiptPath -RepoRoot $root -ReleaseDirectory $root -InstallRoot $installed -OperationLockName ('Local\\COSInstalledPredecessorFixture-'+[guid]::NewGuid().ToString('N')) -ProcessProbe {throw 'proposal probed processes'} -SleepAction {throw 'proposal waited'} -InstallerRunner {throw 'proposal invoked installer'} -SuccessorLauncher {throw 'proposal launched successor'};if($wired.Status -cne 'exact-accepted-predecessor' -or ($script:QualifiedCandidate|ConvertTo-Json -Compress) -cne $before -or (Get-FileHashHex -Path $receiptPath) -cne $receiptHashBefore){throw 'wired proposal changed pinned or accepted receipt or returned wrong status'}",
        "if($wired.AcceptedPackageReceiptSha256 -cne $receiptHashBefore -or $wired.InstallerSha256 -cne $candidate.InstallerSha256 -or $null -ne $wired.PSObject.Properties['PackageReceiptSha256']){throw 'wired proposal misreported accepted receipt bytes as installer identity'};$retainedReceiptBytes=[IO.File]::ReadAllBytes($receiptPath);[IO.File]::WriteAllBytes($receiptPath,[byte[]]@(123,255,125));try{Invoke-CustomInstall -ProposeInstalledPredecessor -AcceptedPackageReceiptPath $receiptPath -RepoRoot $root -ReleaseDirectory $root -InstallRoot $installed -OperationLockName ('Local\\COSInstalledPredecessorUtf8-'+[guid]::NewGuid().ToString('N'))|Out-Null;throw 'invalid UTF-8 receipt accepted'}catch{if($_.Exception.Message -notlike '*not valid JSON*'){throw}}finally{[IO.File]::WriteAllBytes($receiptPath,$retainedReceiptBytes)}",
        "try{Invoke-CustomInstall -ProposeInstalledPredecessor -RepoRoot $root -ReleaseDirectory $root -InstallRoot $installed -OperationLockName ('Local\\COSInstalledPredecessorMissingReceipt-'+[guid]::NewGuid().ToString('N'))|Out-Null;throw 'missing accepted receipt accepted'}catch{if($_.Exception.Message -notlike '*requires -AcceptedPackageReceiptPath*'){throw}}",
        "[IO.File]::AppendAllText((Join-Path $installed 'resources\\app.asar'),'substituted');try{Get-InstalledPredecessorProposal -InstallRoot $installed -RepoRoot $root -ReleaseDirectory $root -AcceptedPackageReceipt $candidate|Out-Null;throw 'substituted payload accepted'}catch{if($_.Exception.Message -notlike '*substituted=1*'){throw}};Copy-Item -LiteralPath (Join-Path $package 'resources\\app.asar') -Destination (Join-Path $installed 'resources\\app.asar') -Force",
        "$originalAsar=Join-Path $installed 'resources\\app.asar';$temporaryAsar=Join-Path $installed 'resources\\app.asar.case-tmp';$caseAsar=Join-Path $installed 'resources\\App.asar';Move-Item -LiteralPath $originalAsar -Destination $temporaryAsar;Move-Item -LiteralPath $temporaryAsar -Destination $caseAsar;try{Get-InstalledPredecessorProposal -InstallRoot $installed -RepoRoot $root -ReleaseDirectory $root -AcceptedPackageReceipt $candidate|Out-Null;throw 'case-only payload path substitution accepted'}catch{if($_.Exception.Message -notlike '*missing=1 extra=1*'){throw}};Move-Item -LiteralPath $caseAsar -Destination $temporaryAsar;Move-Item -LiteralPath $temporaryAsar -Destination $originalAsar",
        "Remove-Item -LiteralPath (Join-Path $installed 'resources\\extension\\background.js');try{Get-InstalledPredecessorProposal -InstallRoot $installed -RepoRoot $root -ReleaseDirectory $root -AcceptedPackageReceipt $candidate|Out-Null;throw 'missing payload accepted'}catch{if($_.Exception.Message -notlike '*missing=1*'){throw}};Copy-Item -LiteralPath (Join-Path $package 'resources\\extension\\background.js') -Destination (Join-Path $installed 'resources\\extension\\background.js') -Force",
        "[IO.File]::WriteAllText((Join-Path $installed 'unexpected.bin'),'extra',[Text.UTF8Encoding]::new($false));try{Get-InstalledPredecessorProposal -InstallRoot $installed -RepoRoot $root -ReleaseDirectory $root -AcceptedPackageReceipt $candidate|Out-Null;throw 'extra payload accepted'}catch{if($_.Exception.Message -notlike '*extra=1*'){throw}};Remove-Item -LiteralPath (Join-Path $installed 'unexpected.bin')",
        "$script:proposalSource=[pscustomobject]@{schema=2;commit=('d'*40);tree=('e'*40)};try{Get-InstalledPredecessorProposal -InstallRoot $installed -RepoRoot $root -ReleaseDirectory $root -AcceptedPackageReceipt $candidate|Out-Null;throw 'foreign provenance accepted'}catch{if($_.Exception.Message -notlike '*mismatch*'){throw}}",
        "$script:proposalSource=$null;try{Get-InstalledPredecessorProposal -InstallRoot $installed -RepoRoot $root -ReleaseDirectory $root -AcceptedPackageReceipt $candidate|Out-Null;throw 'unknown provenance accepted'}catch{if($_.Exception.Message -notlike '*unknown source provenance*'){throw}};$script:proposalSource=[pscustomobject]@{schema=2;commit=('a'*40);tree=('b'*40)}",
        "$outside=Join-Path $root 'outside';New-Item -ItemType Directory -Path $outside -Force | Out-Null;[IO.File]::WriteAllText((Join-Path $outside 'sentinel.txt'),'outside',[Text.UTF8Encoding]::new($false));New-Item -ItemType Junction -Path (Join-Path $installed 'unsafe-link') -Target $outside | Out-Null;try{Get-InstalledPredecessorProposal -InstallRoot $installed -RepoRoot $root -ReleaseDirectory $root -AcceptedPackageReceipt $candidate|Out-Null;throw 'unsafe link accepted'}catch{if($_.Exception.Message -notlike '*link/reparse entry*'){throw}}",
        "'installed-predecessor-proposal-fixtures-passed'"
      ].join('; ');
      const result = spawnSync(shell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', command], {
        encoding: 'utf8', windowsHide: true, timeout: 30_000, cwd: repoRoot
      });
      expect(result.status, result.stderr + '\n' + result.stdout).toBe(0);
      expect(result.stdout).toContain('installed-predecessor-proposal-fixtures-passed');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe.runIf(process.platform === 'win32')('custom qualified install integrity', () => {
  it('reuses canonical snapshot cleanup with exact namespace guards and verified absence', () => {
    const code = `. ${ps(installScript)}; $owned=Join-Path ([IO.Path]::GetTempPath()) ('cos-strict-build-'+[guid]::NewGuid().ToString('N'));$outside=Join-Path ([IO.Path]::GetTempPath()) ('cos-unrelated-'+[guid]::NewGuid().ToString('N'));try {New-Item -ItemType Directory -Path $owned,$outside | Out-Null;[IO.File]::WriteAllText((Join-Path $owned 'fixture.txt'),'regenerable fixture');try {Remove-OwnedStrictBuildSnapshot -Path $outside;throw 'unexpected cleanup'}catch{if($_.Exception.Message -notlike '*Refusing strict-build cleanup*'){throw}};if(-not (Test-Path -LiteralPath $outside)){throw 'outside fixture removed'};Remove-OwnedStrictBuildSnapshot -Path $owned;if(Test-Path -LiteralPath $owned){throw 'owned fixture retained'};Remove-OwnedStrictBuildSnapshot -Path $owned;'CANONICAL_SNAPSHOT_CLEANUP_PASS'}finally{if(Test-Path -LiteralPath $outside){Remove-Item -LiteralPath $outside -ErrorAction Stop};if(Test-Path -LiteralPath $owned){Remove-OwnedStrictBuildSnapshot -Path $owned}}`;
    const result = spawnSync('powershell.exe', ['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(code,'utf16le').toString('base64')], { encoding:'utf8', windowsHide:true });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('CANONICAL_SNAPSHOT_CLEANUP_PASS');
  });

  it('retains linked snapshot contents instead of following a junction into another owner', () => {
    const code = `. ${ps(installScript)}; $owned=Join-Path ([IO.Path]::GetTempPath()) ('cos-strict-build-'+[guid]::NewGuid().ToString('N'));$outside=Join-Path ([IO.Path]::GetTempPath()) ('cos-storage-link-target-'+[guid]::NewGuid().ToString('N'));$link=Join-Path $owned 'foreign';try {New-Item -ItemType Directory -Path $owned,$outside | Out-Null;[IO.File]::WriteAllText((Join-Path $outside 'keep.txt'),'retained outside owner');New-Item -ItemType Junction -Path $link -Target $outside | Out-Null;try {Remove-OwnedStrictBuildSnapshot -Path $owned;throw 'unexpected linked cleanup'}catch{if($_.Exception.Message -notlike '*Linked strict-build cleanup target retained*'){throw}};if([IO.File]::ReadAllText((Join-Path $outside 'keep.txt')) -cne 'retained outside owner'){throw 'linked target changed'};'LINKED_SNAPSHOT_RETAINED'}finally{if(Test-Path -LiteralPath $link){[IO.Directory]::Delete($link)};if(Test-Path -LiteralPath $owned){Remove-OwnedStrictBuildSnapshot -Path $owned};if(Test-Path -LiteralPath $outside){Remove-Item -LiteralPath (Join-Path $outside 'keep.txt') -Force;[IO.Directory]::Delete($outside)}}`;
    const result = spawnSync('powershell.exe', ['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(code,'utf16le').toString('base64')], { encoding:'utf8', windowsHide:true });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('LINKED_SNAPSHOT_RETAINED');
  });

  it('refuses large candidate admission before allocating snapshot or release bytes on a nearly full volume', () => {
    const code = `. ${ps(installScript)}; $probe={param($Path) [pscustomobject]@{Volume='same';AvailableBytes=3791978496L}}; try { Assert-StrictBuildStorage -SnapshotPath ([IO.Path]::GetTempPath()) -ReleaseDirectory ${ps(releaseRoot)} -StorageProbe $probe; throw 'unexpected admission' } catch { if($_.Exception.Message -notlike '*STORAGE_HEADROOM_INSUFFICIENT*'){throw}; $_.Exception.Message }`;
    const result = spawnSync('powershell.exe', ['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(code,'utf16le').toString('base64')], { encoding:'utf8', windowsHide:true });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('STORAGE_HEADROOM_INSUFFICIENT');
    expect(result.stdout).toContain('available=3791978496');
  });

  it('reads actual capacity through Windows PowerShell with a trailing temp separator and a missing spaced release path', () => {
    const code = `. ${ps(installScript)}; try { Assert-StrictBuildStorage -SnapshotPath ([IO.Path]::GetTempPath()) -ReleaseDirectory (Join-Path ([IO.Path]::GetTempPath()) 'CoS storage probe with spaces/release') } catch { if($_.Exception.Message -notlike '*STORAGE_HEADROOM_INSUFFICIENT*'){throw} }; 'STORAGE_DEFAULT_PROBE_PASS'`;
    const result = spawnSync('powershell.exe', ['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(code,'utf16le').toString('base64')], { encoding:'utf8', windowsHide:true });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('STORAGE_DEFAULT_PROBE_PASS');
  });

  it('groups same-volume build headroom, separates publish volume and fails closed on unknown capacity', () => {
    const code = `. ${ps(installScript)}; $same={param($Path) [pscustomobject]@{Volume='same';AvailableBytes=7GB}}; try { Assert-StrictBuildStorage -SnapshotPath 'C:\\temp' -ReleaseDirectory 'C:\\release' -StorageProbe $same; throw 'unexpected same-volume admission' } catch {if($_.Exception.Message -notlike '*STORAGE_HEADROOM_INSUFFICIENT*'){throw}}; $separate={param($Path) [pscustomobject]@{Volume=$Path;AvailableBytes=7GB}}; Assert-StrictBuildStorage -SnapshotPath 'C:\\temp' -ReleaseDirectory 'D:\\release' -StorageProbe $separate; $unknown={param($Path) [pscustomobject]@{Volume='same';AvailableBytes=-1}};try {Assert-StrictBuildStorage -SnapshotPath 'C:\\temp' -ReleaseDirectory 'D:\\release' -StorageProbe $unknown;throw 'unexpected unknown admission'}catch{if($_.Exception.Message -notlike '*STORAGE_HEADROOM_UNKNOWN*'){throw}}; 'STORAGE_ADMISSION_CASES_PASS'`;
    const result = spawnSync('powershell.exe', ['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(code,'utf16le').toString('base64')], { encoding:'utf8', windowsHide:true });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('STORAGE_ADMISSION_CASES_PASS');
  });

  it('keeps a Windows-owned process alive after forcibly closing its launcher tree', async () => {
    const shell = path.join(process.env.SystemRoot!, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const childCode = Buffer.from('Start-Sleep -Seconds 60', 'utf16le').toString('base64');
    const code = `. ${ps(installScript)}; $p = Start-IndependentInstalledApp -Executable ${ps(shell)} -Arguments @('-NoProfile','-NonInteractive','-EncodedCommand','${childCode}'); Write-Output ("OWNED_PID=" + $p.Id); Start-Sleep -Seconds 60`;
    const launcher = spawn(shell, ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(code, 'utf16le').toString('base64')], { windowsHide: true });
    let ownedPid: number | undefined;
    let output = '';
    try {
      ownedPid = await new Promise<number>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Independent launch timed out: ' + output)), 15_000);
        launcher.stdout.on('data', chunk => {
          output += chunk.toString();
          const match = /OWNED_PID=(\d+)/.exec(output);
          if (match) { clearTimeout(timer); resolve(Number(match[1])); }
        });
        launcher.stderr.on('data', chunk => { output += chunk.toString(); });
        launcher.once('error', error => { clearTimeout(timer); reject(error); });
        launcher.once('exit', () => { clearTimeout(timer); reject(new Error('Launcher exited early: ' + output)); });
      });
      const killed = spawnSync('taskkill.exe', ['/PID', String(launcher.pid), '/T', '/F'], { encoding: 'utf8', windowsHide: true });
      expect(killed.status).toBe(0);
      const check = spawnSync(shell, ['-NoProfile', '-NonInteractive', '-Command', `$p=Get-CimInstance Win32_Process -Filter 'ProcessId=${ownedPid}'; if(-not $p -or $p.ParentProcessId -eq ${launcher.pid}){exit 1}; Write-Output 'SURVIVED_LAUNCHER_TREE'`], { encoding: 'utf8', windowsHide: true });
      expect(check.status, check.stderr).toBe(0);
      expect(check.stdout).toContain('SURVIVED_LAUNCHER_TREE');
    } finally {
      if (ownedPid) spawnSync('taskkill.exe', ['/PID', String(ownedPid), '/F'], { windowsHide: true });
      if (launcher.exitCode === null) launcher.kill();
    }
  }, 25_000);

  it('refuses a failed Windows broker without a child-process fallback', () => {
    const code = `. ${ps(installScript)}; function Invoke-CimMethod { return [pscustomobject]@{ ReturnValue=2; ProcessId=0 } }; function Start-Process { throw 'FORBIDDEN_FALLBACK' }; try { Start-IndependentInstalledApp -Executable (Get-Process -Id $PID).Path -Arguments @(); exit 2 } catch { if($_.Exception.Message -notlike '*Win32_Process.Create result=2*'){throw}; Write-Output 'REFUSED' }`;
    const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(code, 'utf16le').toString('base64')], { encoding: 'utf8', windowsHide: true });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('REFUSED');
  });
  it('launches production successors outside the initiating shell process tree', () => {
    const script = readFileSync(installScript, 'utf8');
    expect(script).toContain('function Start-IndependentInstalledApp');
    expect(script).toContain("-ClassName Win32_Process -MethodName Create");
    expect(script).toContain('$successor = Start-IndependentInstalledApp');
    expect(script).toContain('$retry = Start-IndependentInstalledApp');
    expect(script).not.toContain('$successor = Start-Process');
    expect(script).not.toContain('$retry = Start-Process');
  });
  it('preserves quoted arguments and hidden startup through the Windows broker', () => {
    const expected = ['', 'with spaces', 'a"b', 'C:\\path with space\\', '\\\\"quoted', '日本語', '--cos-instance-runtime=profile-example'];
    const encoded = Buffer.from(JSON.stringify(expected)).toString('base64');
    const code = `[Console]::OutputEncoding = [Text.Encoding]::UTF8; . ${ps(installScript)}; $expected = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encoded}')) | ConvertFrom-Json; function Invoke-CimMethod { param($ClassName,$MethodName,$Arguments); if($Arguments.ProcessStartupInformation.ShowWindow -ne 0){throw 'not hidden'}; $script:actual = @(ConvertFrom-WindowsProcessCommandLine $Arguments.CommandLine); return [pscustomobject]@{ReturnValue=0;ProcessId=$PID} }; Start-IndependentInstalledApp -Executable (Get-Process -Id $PID).Path -Arguments @($expected) -ReceiptOnly | Out-Null; Write-Output ('ARGV=' + (ConvertTo-Json -Compress -InputObject @($script:actual | Select-Object -Skip 1)))`;
    const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(code, 'utf16le').toString('base64')], { encoding: 'utf8', windowsHide: true });
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout.split(/\r?\n/).find(line => line.startsWith('ARGV='))!.slice(5))).toEqual(expected);
  });
  it('keeps the executable-hash legacy exception bound to immutable old installer bytes', () => {
    const script = readFileSync(installScript, 'utf8');
    expect(script).toContain("$script:LegacyExecutableHashlessInstallerSha256 = '3712bf47815ad5a328962c5b77352dd1116f3c0701ff9eb5123932362c7d8161'");
    expect(script).not.toContain('$script:LegacyExecutableHashlessInstallerSha256 = $script:QualifiedCandidate');
  });
  it('keeps the reviewed 2.1.39 installed predecessor exact and lifecycle-capable', () => {
    const code = `. ${ps(installScript)}; if(-not (Test-InstalledSafeCloseCapability -Baseline $script:InstalledUpgradeBaseline)){throw 'reviewed predecessor lost its exact safe-close capability'}; $script:InstalledUpgradeBaseline | ConvertTo-Json -Compress`;
    const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(code, 'utf16le').toString('base64')], { encoding: 'utf8', windowsHide: true });
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      Version: '2.1.39',
      SafeCloseForUpdate: true,
      FileCount: 291,
      TotalBytes: 571507249,
      TreeSha256: '0ee50259882c014bc11dce808255603028b2a135ea536cb26b75287b27651117',
      FileVersion: '2.1.39',
      ProductVersion: '2.1.39.0',
      ExeSha256: 'ee27769bbc18874067b8f5090689471f5e7c15b34d6fcd16459c24d49d4de7ed',
      AppAsarSha256: '105f194555778a57445a5ab16ca82c745ae383312c699206a1d842acc06cd6c8',
      ExtensionVersion: '2.1.39',
      ExtensionBackgroundSha256: '81100d5e0531eee79155898f964a8d1eb756e7fa30943fede19d6a0ed72eedbc',
      SourceProvenanceSha256: '914fcf6c9af72362fb1da3831df793b14d8a53e3298363b1d74e699a0a2f6c58',
      CustomBuildText: 'Chat On Steroids local custom build. Update through scripts/update-custom.ps1 and reinstall from this checkout.',
    });
  });

  it('requires exact whole-tree and provenance receipts before predecessor safe-close eligibility', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'cos-install-predecessor-'));
    try {
      const code = `. ${ps(installScript)}
$root = ${ps(root)}
$resources = Join-Path $root 'resources'
$extension = Join-Path $resources 'extension'
New-Item -ItemType Directory -Path $extension | Out-Null
$app = Join-Path $root 'Chat On Steroids.exe'
Copy-Item -LiteralPath (Join-Path $env:SystemRoot 'System32\\cmd.exe') -Destination $app
$files = @{
  'resources/app.asar' = 'predecessor fixture asar'
  'resources/extension/background.js' = 'predecessor fixture companion'
  'resources/extension/manifest.json' = '{"version":"2.1.15"}'
  'resources/CUSTOM_BUILD' = 'fixture custom build'
  'resources/SOURCE_PROVENANCE.json' = '{"fixture":true}'
  'uninstaller-extra.dat' = 'complete installed tree, not only packaged payload'
}
foreach ($relative in $files.Keys) {
  [IO.File]::WriteAllText((Join-Path $root $relative), $files[$relative], [Text.UTF8Encoding]::new($false))
}
$fingerprint = Get-DirectoryFingerprint -Root $root
$version = (Get-Item -LiteralPath $app).VersionInfo
$baseline = [pscustomobject]@{
  Version = '2.1.15'; SafeCloseForUpdate = $true
  FileCount = $fingerprint.FileCount; TotalBytes = [int64]$fingerprint.TotalBytes; TreeSha256 = $fingerprint.TreeSha256
  FileVersion = $version.FileVersion; ProductVersion = $version.ProductVersion
  ExeSha256 = (Get-FileHashHex -Path $app)
  AppAsarSha256 = (Get-FileHashHex -Path (Join-Path $resources 'app.asar'))
  ExtensionVersion = '2.1.15'; ExtensionBackgroundSha256 = (Get-FileHashHex -Path (Join-Path $extension 'background.js'))
  SourceProvenanceSha256 = (Get-FileHashHex -Path (Join-Path $resources 'SOURCE_PROVENANCE.json'))
  CustomBuildText = 'fixture custom build'
}
function Expect-Refusal([scriptblock]$Action, [string]$Needle) {
  try { & $Action | Out-Null; throw 'EXPECTED_REFUSAL_MISSING' }
  catch { if ($_.Exception.Message -notlike "*$Needle*") { throw } }
}
$before = $baseline | ConvertTo-Json -Compress
$accepted = Assert-RollbackTree -Root $root -Baseline $baseline
if ($accepted.FileCount -ne 7 -or -not (Test-InstalledSafeCloseCapability -Baseline $baseline)) { throw 'exact predecessor was not accepted' }
[IO.File]::AppendAllText((Join-Path $root 'uninstaller-extra.dat'), 'changed')
Expect-Refusal { Assert-RollbackTree -Root $root -Baseline $baseline } 'byte-count mismatch'
[IO.File]::WriteAllText((Join-Path $root 'uninstaller-extra.dat'), $files['uninstaller-extra.dat'], [Text.UTF8Encoding]::new($false))
[IO.File]::AppendAllText((Join-Path $resources 'SOURCE_PROVENANCE.json'), 'changed')
Expect-Refusal { Assert-RollbackTree -Root $root -Baseline $baseline } 'source provenance hash mismatch'
$missingProvenance = $baseline.PSObject.Copy(); $missingProvenance.PSObject.Properties.Remove('SourceProvenanceSha256')
Expect-Refusal { Test-InstalledSafeCloseCapability -Baseline $missingProvenance } 'without exact source provenance'
$disabled = $baseline.PSObject.Copy(); $disabled.SafeCloseForUpdate = $false
if (Test-InstalledSafeCloseCapability -Baseline $disabled) { throw 'disabled capability was promoted' }
if (($baseline | ConvertTo-Json -Compress) -cne $before) { throw 'drift automatically changed predecessor receipt' }
Write-Output 'EXACT_PREDECESSOR_AND_CAPABILITY_GATES'
`;
      const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(code, 'utf16le').toString('base64')], { encoding: 'utf8', windowsHide: true });
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain('EXACT_PREDECESSOR_AND_CAPABILITY_GATES');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
  it('keeps the user entry point on exact-prebuilt activation without a rebuild or force-run', () => {
    const command = readFileSync(applyUpdate, 'utf8');
    const rollbackCommand = readFileSync(rollbackUpdate, 'utf8');
    const script = readFileSync(installScript, 'utf8');
    const packages = JSON.parse(readFileSync(packageManifest, 'utf8')) as { scripts: Record<string, string> };
    const packager = readFileSync(packageOwner, 'utf8');
    expect(command).toContain('-QualifiedPrebuilt -WaitForSafeQuit');
    expect(command).not.toContain('-SkipVerify');
    expect(command).not.toMatch(/npm\s+run|dist:x64|Chat-On-Steroids-Setup-x64\.exe/i);
    expect(command).toContain('exit /b 1');
    expect(command).toContain('exit /b 0');
    expect(command).toContain('Read the exact state above');
    expect(command).not.toContain('no success or resume was reported');
    expect(command.match(/Update complete\./g)).toHaveLength(1);
    expect(rollbackCommand).toContain('-Rollback -WaitForSafeQuit');
    expect(rollbackCommand).not.toMatch(/-QualifiedPrebuilt|Move-Item|Remove-Item|Start-Process|Setup-x64|npm\s+run|dist:x64/i);
    expect(rollbackCommand).toContain('exit /b 1');
    expect(rollbackCommand).toContain('exit /b 0');
    expect(rollbackCommand).toContain('Read the exact state above');
    expect(rollbackCommand).not.toContain('Rollback did not complete successfully');
    expect(rollbackCommand.match(/Rollback complete\./g)).toHaveLength(1);
    expect(script).not.toMatch(/\$SkipVerify\b/);
    expect(script).not.toContain('[scriptblock]$CandidatePayloadReader');
    expect(script).toContain('function Invoke-StrictCandidateBuild');
    expect(script).toContain("--strict --platform win32 --arch x64");
    expect(script).not.toContain("Invoke-Checked npm @('run', 'dist:x64')");
    expect(script).toContain("if ($QualifiedPrebuilt) {");
    expect(script).toContain('function Assert-CustomInstallOperationAvailable');
    expect(script).toContain('Read-InstallerSourceProvenance -InstallerPath');
    expect(script).toContain("Assert-SourceProvenanceRecordsEqual -Expected $pinnedSource -Actual $sourceBinding");
    expect(script).toContain("Assert-SourceProvenanceRecordsEqual -Expected $pinnedSource -Actual $installedSource");
    expect(script).toContain('Assert-CustomInstallOperationAvailable -Name $OperationLockName');
    // Inspect activation, not an earlier read-only proposal/helper with the same verifier.
    const activation = script.slice(script.indexOf('function Invoke-CustomInstall {'));
    const candidateCheck = activation.indexOf('Assert-QualifiedPrebuiltCandidate -ReleaseDirectory');
    const rollbackCheck = activation.indexOf('Assert-RollbackArchive -ArchivePath $RollbackArchivePath', candidateCheck);
    const processWait = activation.indexOf('Wait-ForNormalAppExit -ProcessProbe', rollbackCheck);
    const safeCloseRequest = activation.indexOf('Request-InstalledAppSafeClose -InstallRoot $InstallRoot', rollbackCheck);
    expect(candidateCheck).toBeGreaterThan(-1);
    expect(rollbackCheck).toBeGreaterThan(candidateCheck);
    expect(safeCloseRequest).toBeGreaterThan(rollbackCheck);
    expect(processWait).toBeGreaterThan(rollbackCheck);
    expect(processWait).toBeGreaterThan(safeCloseRequest);
    expect(script).not.toContain("@('/S', '--updated', '--force-run')");
    expect(script).toContain("@('/S', '--updated')");
    expect(script).toContain("@('--updated', '--background')");
    expect(script).toContain('Start-VerifiedSuccessor');
    expect(script).toContain('foreach ($profile in $profiles)');
    expect(script).toContain('"--cos-instance-runtime=$profileId"');
    expect(script).toContain("$_.PSObject.Properties['enabled']");
    expect(script).toContain("$_.PSObject.Properties['state']");
    expect(script).toContain("$_.PSObject.Properties['id']");
    expect(script).toContain("-not $enabledProperty -or $enabledProperty.Value -ne $false");
    expect(script).not.toContain("$_.enabled -ne $false");
    expect(script).not.toContain("@('--updated', '--background', '--resume-automation')");
    expect(script).toContain("-WindowStyle Hidden -PassThru");
    expect(script).toContain('$successor.WaitForExit(5000)');
    expect(script).toContain('$retry.WaitForExit(8000)');
    expect(script).toContain('exited during both bounded reopen attempts');
    expect(script).toContain('function Invoke-ExplicitRollbackTransaction');
    expect(script).toContain('function Enter-CustomInstallOperationLock');
    expect(script).toContain("Assert-AppNotRunning -ProcessProbe $ProcessProbe -Context 'qualified installer'");
    expect(script).toContain("Assert-AppNotRunning -ProcessProbe $ProcessProbe -Context 'rollback swap'");
    expect(script).toContain('the requested custom operation is waiting at the normal-Quit boundary');
    expect(script).toContain('This invocation did not advance the requested custom operation.');
    expect(script).not.toContain('exact qualified candidate is ready;');
    expect(script).not.toContain('Nothing was installed. Run this script again when ready.');
    expect(script).not.toMatch(/Stop-Process|taskkill|\.Kill\(/i);
    expect(script).not.toMatch(/Remove-Item.*(?:userData|chat-on-steroids)/i);
    for (const [name, value] of Object.entries(packages.scripts).filter(([name]) => name.startsWith('dist'))) {
      expect(value, name).toContain('scripts/package.mjs');
      expect(value, name).not.toContain('install-custom.ps1');
    }
    expect(packager).toContain("'--publish'");
    expect(packager).toContain("'never'");
    expect(packager).not.toMatch(/install-custom|Programs[\\/]Chat On Steroids/i);
  });

  it('reopens prepared accounts without launching or preparing registered setup-only profiles', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'cos-successor-registry-'));
    try {
      // Execute the actual default launcher, not the injected SuccessorLauncher fixtures.
      const code = `. ${ps(installScript)}
$tokens = $null; $parseErrors = $null
$ast = [Management.Automation.Language.Parser]::ParseFile(${ps(installScript)}, [ref]$tokens, [ref]$parseErrors)
if ($parseErrors.Count) { throw 'INSTALLER_PARSE_FAILED' }
$assignments = @($ast.FindAll({ param($node)
  $node -is [Management.Automation.Language.AssignmentStatementAst] -and
  $node.Left -is [Management.Automation.Language.VariableExpressionAst] -and
  $node.Left.VariablePath.UserPath -eq 'SuccessorLauncher' -and
  $node.Right -is [Management.Automation.Language.CommandExpressionAst] -and
  $node.Right.Expression -is [Management.Automation.Language.ScriptBlockExpressionAst]
}, $true))
if ($assignments.Count -ne 1) { throw 'DEFAULT_SUCCESSOR_OWNER_NOT_UNIQUE' }
$body = $assignments[0].Right.Extent.Text.Trim()
if (-not $body.StartsWith('{') -or -not $body.EndsWith('}')) { throw 'DEFAULT_SUCCESSOR_BODY_NOT_FOUND' }
$launcher = [scriptblock]::Create($body.Substring(1, $body.Length - 2))
$env:APPDATA = ${ps(root)}
$canonical = Join-Path $env:APPDATA 'chat-on-steroids'
$configPath = Join-Path $canonical 'config.json'
New-Item -ItemType Directory -Path $canonical | Out-Null
$profiles = @(
  @{id='local-instance';enabled=$true;state=@{mode='legacy'}}
  @{id='profile-prepared';enabled=$true;state=@{mode='isolated'}}
  @{id='profile-legacy';state=@{mode='isolated'}}
  @{id='profile-setup';enabled=$true;state=@{mode='isolated'}}
  @{id='profile-disabled';enabled=$false;state=@{mode='isolated'}}
  @{id='../outside';enabled=$true;state=@{mode='isolated'}}
)
foreach ($id in @('profile-prepared','profile-legacy','profile-disabled')) {
  $runtime = Join-Path $canonical "instances\\$id\\runtime"
  New-Item -ItemType Directory -Path $runtime -Force | Out-Null
  [IO.File]::WriteAllText((Join-Path $runtime 'config.json'), '{}')
}
[IO.File]::WriteAllText($configPath, (@{instances=@{profiles=$profiles}} | ConvertTo-Json -Depth 8))
$script:launched = [Collections.Generic.List[string]]::new()
$script:earlyExit = $false
function Start-IndependentInstalledApp {
  param($Executable,$Arguments)
  $label = if ($Arguments[0] -like '--cos-instance-runtime=*') { $Arguments[0].Substring('--cos-instance-runtime='.Length) } else { 'primary' }
  if ($label -eq 'profile-setup') { throw 'UNPREPARED_PROFILE_WAS_LAUNCHED' }
  $script:launched.Add($label)
  $process = [pscustomobject]@{ ExitCode=17 }
  $process | Add-Member ScriptMethod WaitForExit { param($milliseconds); return $script:earlyExit }
  return $process
}
function Start-Sleep { param($Milliseconds) }
$before = [Convert]::ToBase64String([IO.File]::ReadAllBytes($configPath))
& $launcher 'fixture-only.exe'
if (($script:launched -join ',') -ne 'primary,profile-prepared,profile-legacy') { throw ('WRONG_FLEET:' + ($script:launched -join ',')) }
if (Test-Path -LiteralPath (Join-Path $canonical 'instances\\profile-setup')) { throw 'SETUP_PROFILE_WAS_PREPARED' }
if ([Convert]::ToBase64String([IO.File]::ReadAllBytes($configPath)) -cne $before) { throw 'REGISTRY_MUTATED' }
$script:launched.Clear(); $script:earlyExit = $true
try { & $launcher 'fixture-only.exe'; throw 'EXPECTED_REOPEN_FAILURE_MISSING' }
catch { if ($_.Exception.Message -notlike '*both bounded reopen attempts*') { throw } }
if (($script:launched -join ',') -ne 'primary,primary') { throw 'BOUNDED_REOPEN_LOST' }
$script:earlyExit = $false
[IO.File]::WriteAllText($configPath, '{invalid')
try { & $launcher 'fixture-only.exe'; throw 'EXPECTED_REGISTRY_FAILURE_MISSING' }
catch { if ($_.Exception.Message -notlike '*registry could not be read*') { throw } }
[IO.File]::Delete($configPath)
try { & $launcher 'fixture-only.exe'; throw 'EXPECTED_MISSING_REGISTRY_FAILURE_MISSING' }
catch { if ($_.Exception.Message -notlike '*registry is missing*') { throw } }
Write-Output 'PREPARED_FLEET_ONLY_NO_SETUP_MUTATION'
`;
      const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(code, 'utf16le').toString('base64')], { encoding: 'utf8', windowsHide: true, timeout: 20_000 });
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain('PREPARED_FLEET_ONLY_NO_SETUP_MUTATION');
      expect(result.stdout).toContain('registered but not prepared');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('targets each exact installed account once and rejects ambiguous safe-close process identity', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'cos-safe-close-contract-'));
    const harness = path.join(root, 'safe-close.ps1');
    writeFileSync(harness, `
$ErrorActionPreference = 'Stop'
. ${ps(installScript)}
$install = Join-Path ${ps(root)} 'Program'
$app = Join-Path $install 'Chat On Steroids.exe'
New-Item -ItemType Directory -Path $install -Force | Out-Null
[IO.File]::WriteAllText($app,'fixture',[Text.UTF8Encoding]::new($false))
function Row([int]$Id,[string]$Arguments,[string]$Executable=$app,[long]$Generation=0) {
  if($Generation -eq 0){$Generation=1700000000000 + $Id}
  [pscustomobject]@{
    Name='Chat On Steroids.exe'; ProcessId=$Id; ExecutablePath=$Executable;
    CommandLine=('"' + $Executable + '" ' + $Arguments).TrimEnd();
    CreationDate=[DateTimeOffset]::FromUnixTimeMilliseconds($Generation).UtcDateTime
  }
}
function Expect-Failure([scriptblock]$Action,[string]$Needle) {
  try { & $Action; throw "expected failure containing: $Needle" }
  catch { if ($_.Exception.Message -notlike "*$Needle*") { throw } }
}
$script:rows = @(
  (Row 101 '--pause-automation'),
  (Row 101 '--pause-automation'),
  (Row 102 '--cos-instance-runtime=profile-foot'),
  (Row 201 '--type=renderer --cos-instance-runtime=profile-foot')
)
$script:launches = @()
$launcher = {
  param([string]$Executable,[string[]]$Arguments,[string]$Profile,[int]$TargetProcessId,[string]$TargetGeneration)
  $script:launches += [pscustomobject]@{ Executable=$Executable; Arguments=@($Arguments); Profile=$Profile; TargetProcessId=$TargetProcessId; TargetGeneration=$TargetGeneration }
}
$script:rows = @()
$empty = Request-InstalledAppSafeClose -InstallRoot $install -ProcessInventory { $script:rows } -SafeCloseLauncher $launcher
if ($empty.RequestCount -ne 0 -or $empty.RequestedProfiles.Count -ne 0 -or $empty.AlreadyStoppedProfiles.Count -ne 0) { throw 'empty safe-close inventory did not return an idle summary' }
if ($script:launches.Count -ne 0) { throw 'empty safe-close inventory launched a close request' }
$script:launches = @()
$script:rows = @(
  (Row 101 '--pause-automation'),
  (Row 101 '--pause-automation'),
  (Row 102 '--cos-instance-runtime=profile-foot'),
  (Row 201 '--type=renderer --cos-instance-runtime=profile-foot')
)
Request-InstalledAppSafeClose -InstallRoot $install -ProcessInventory { $script:rows } -SafeCloseLauncher $launcher
if ($script:launches.Count -ne 2) { throw "expected two exact safe-close requests, got $($script:launches.Count)" }
$local = @($script:launches | Where-Object Profile -eq 'local-instance')
$isolated = @($script:launches | Where-Object Profile -eq 'profile-foot')
if ($local.Count -ne 1 -or ($local[0].Arguments -join '|') -cne '--safe-close-for-update=local-instance|--safe-close-for-update-pid=101|--safe-close-for-update-generation=1700000000101') { throw 'primary safe-close arguments were not exact' }
if ($isolated.Count -ne 1 -or ($isolated[0].Arguments -join '|') -cne '--cos-instance-runtime=profile-foot|--safe-close-for-update=profile-foot|--safe-close-for-update-pid=102|--safe-close-for-update-generation=1700000000102') { throw 'isolated safe-close arguments were not exact' }
if ($local[0].TargetGeneration -cne '1700000000101' -or $isolated[0].TargetGeneration -cne '1700000000102') { throw 'safe-close launcher did not receive exact process generations' }
if ($local[0].Executable -cne $app -or $isolated[0].Executable -cne $app) { throw 'safe-close executable was not the exact installed app' }

$script:launches = @()
$script:rows = @((Row 301 ''), (Row 302 ''))
Expect-Failure { Request-InstalledAppSafeClose -InstallRoot $install -ProcessInventory { $script:rows } -SafeCloseLauncher $launcher } 'more than one main process'
if ($script:launches.Count -ne 0) { throw 'ambiguous profile launched a close request' }
$script:rows = @((Row 303 '--cos-instance-runtime=profile-foot;calc'))
Expect-Failure { Request-InstalledAppSafeClose -InstallRoot $install -ProcessInventory { $script:rows } -SafeCloseLauncher $launcher } 'malformed instance-runtime'
if ($script:launches.Count -ne 0) { throw 'malformed profile launched a close request' }
$foreign = Join-Path ${ps(root)} 'Other\Chat On Steroids.exe'
New-Item -ItemType Directory -Path (Split-Path -Parent $foreign) -Force | Out-Null
[IO.File]::WriteAllText($foreign,'foreign',[Text.UTF8Encoding]::new($false))
$script:rows = @((Row 304 '' $foreign))
Expect-Failure { Request-InstalledAppSafeClose -InstallRoot $install -ProcessInventory { $script:rows } -SafeCloseLauncher $launcher } 'exact installed'
if ($script:launches.Count -ne 0) { throw 'foreign executable launched a close request' }

$badCreation=Row 305 ''
$badCreation.CreationDate='2026-10-02T12:00:00Z'
$script:rows=@($badCreation)
Expect-Failure { Request-InstalledAppSafeClose -InstallRoot $install -ProcessInventory { $script:rows } -SafeCloseLauncher $launcher } 'no valid creation-time generation'

# A reused PID with the same profile but a different process generation is a replacement, not the
# target proven during planning. It must receive no helper launch.
$script:generationInventoryCalls=0;$script:launches=@()
Expect-Failure {
  Request-InstalledAppSafeClose -InstallRoot $install -ProcessInventory {
    $script:generationInventoryCalls += 1
    if($script:generationInventoryCalls -eq 1){return @((Row 401 '' $app 1700000000401))}
    return @((Row 401 '' $app 1700000000402))
  } -SafeCloseLauncher $launcher
} 'process generation changed'
if($script:launches.Count -ne 0){throw 'same-PID replacement received a stale safe-close request'}

# A helper error may have occurred after delivery. Attempt each distinct planned profile once,
# aggregate the fleet outcome, and fail before install without retrying or pretending to reopen it.
$script:rows=@((Row 501 ''),(Row 502 '--cos-instance-runtime=profile-foot'))
$script:partialAttempts=@()
$partialLauncher={
  param([string]$Executable,[string[]]$Arguments,[string]$Profile,[int]$TargetProcessId,[string]$TargetGeneration)
  $script:partialAttempts += $Profile
  if($Profile -ceq 'local-instance'){throw 'synthetic helper ambiguity'}
}
Expect-Failure { Request-InstalledAppSafeClose -InstallRoot $install -ProcessInventory { $script:rows } -SafeCloseLauncher $partialLauncher } 'only partially completed'
if(($script:partialAttempts -join '|') -cne 'local-instance|profile-foot'){throw "partial fleet was not attempted once per profile: $($script:partialAttempts -join '|')"}

$script:lifecyclePoll=0
$waitOutput=@(Wait-ForLifecycleOwnedAppExit -ProcessProbe {
    $script:lifecyclePoll += 1
    if($script:lifecyclePoll -eq 1){return [pscustomobject]@{Id=1}}
    return @()
  } -SleepAction { } -RequestSummary ([pscustomobject]@{RequestCount=1;RequestedProfiles=@('local-instance')}) 6>&1 |
  ForEach-Object { [string]$_ })
if(($waitOutput -join ' ') -notlike '*Cancel Drain in the app*'){throw 'lifecycle wait omitted wait/cancel-Drain guidance'}
if(($waitOutput -join ' ') -like '*tray icon*'){throw 'lifecycle wait incorrectly gave manual tray-Quit guidance'}
Expect-Failure {
  Assert-AppNotRunning -ProcessProbe { [pscustomobject]@{Id=1} } -Context 'qualified installer' -LifecycleOwned
} 'Cancel Drain in the app'

if (Test-InstalledSafeCloseCapability -Baseline ([pscustomobject]@{ SafeCloseForUpdate=$false })) { throw 'unsupported predecessor enabled automatic safe close' }
$capable = [pscustomobject]@{ SafeCloseForUpdate=$true; SourceProvenanceSha256=('a' * 64) }
if (-not (Test-InstalledSafeCloseCapability -Baseline $capable)) { throw 'provenance-bound capability was not accepted' }
Expect-Failure { Test-InstalledSafeCloseCapability -Baseline ([pscustomobject]@{ SafeCloseForUpdate=$true }) | Out-Null } 'without exact source provenance'
Write-Output 'safe-close-contract-ok'
`, 'utf8');
    try {
      const result = spawnSync('powershell.exe', [
        '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', harness
      ], { encoding: 'utf8', timeout: 120_000 });
      expect(result.status, `${result.error ?? ''}\n${result.stdout}\n${result.stderr}`).toBe(0);
      expect(result.stdout).toContain('safe-close-contract-ok');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('drops only a transient blank-command-line row whose exact PID is proven gone', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'cos-safe-close-transient-row-'));
    const harness = path.join(root, 'safe-close-transient-row.ps1');
    writeFileSync(harness, `
$ErrorActionPreference = 'Stop'
. ${ps(installScript)}
$install = Join-Path ${ps(root)} 'Program'
$app = Join-Path $install 'Chat On Steroids.exe'
New-Item -ItemType Directory -Path $install -Force | Out-Null
[IO.File]::WriteAllText($app,'fixture',[Text.UTF8Encoding]::new($false))
function Row([int]$Id,[string]$Arguments,[long]$Generation=0) {
  if($Generation -eq 0){$Generation=1700000000000 + $Id}
  [pscustomobject]@{
    Name='Chat On Steroids.exe'; ProcessId=$Id; ExecutablePath=$app;
    CommandLine=('"' + $app + '" ' + $Arguments).TrimEnd();
    CreationDate=[DateTimeOffset]::FromUnixTimeMilliseconds($Generation).UtcDateTime
  }
}
function BlankRow([int]$Id,[long]$Generation=0) {
  $row = Row $Id '' $Generation
  $row.CommandLine = ''
  return $row
}
function Expect-Failure([scriptblock]$Action,[string]$Needle) {
  try { & $Action; throw "expected failure containing: $Needle" }
  catch { if ($_.Exception.Message -notlike "*$Needle*") { throw } }
}

# Reproduce the activation race: the first two fleet snapshots are complete, then the process
# already asked to close lingers for one broad CIM projection with an empty CommandLine. Its exact
# PID is absent and the independent PID probe agrees, so only that row is omitted; the remaining
# account still receives its one generation-bound lifecycle request.
$script:inventoryCalls = 0
$script:launches = @()
$inventory = {
  $script:inventoryCalls += 1
  Get-StableInstalledAppProcessInventory -ProcessInventoryQuery {
    if($script:inventoryCalls -lt 3){return @((Row 701 ''),(Row 702 '--cos-instance-runtime=profile-foot'))}
    return @((BlankRow 701),(Row 702 '--cos-instance-runtime=profile-foot'))
  } -ProcessIdentityQuery { param([int]$ProcessId) return @() } -ProcessExistsProbe { param([int]$ProcessId) return $false }
}
$launcher = {
  param([string]$Executable,[string[]]$Arguments,[string]$Profile,[int]$TargetProcessId,[string]$TargetGeneration)
  $script:launches += $Profile
}
$summary = Request-InstalledAppSafeClose -InstallRoot $install -ProcessInventory $inventory -SafeCloseLauncher $launcher
if(($script:launches -join '|') -cne 'local-instance|profile-foot'){throw "remaining fleet was not closed exactly once: $($script:launches -join '|')"}
if($summary.RequestCount -ne 2){throw "unexpected safe-close request count: $($summary.RequestCount)"}

# A PID that still exists but has no exact CIM identity is unresolved live process state. Never
# reinterpret it as an exited row or let the caller continue to another profile/installer.
Expect-Failure {
  Get-StableInstalledAppProcessInventory -ProcessInventoryQuery { @(BlankRow 703) } -ProcessIdentityQuery { param([int]$ProcessId) return @() } -ProcessExistsProbe { param([int]$ProcessId) return $true }
} 'remains live but its exact process identity is unreadable'
Expect-Failure {
  Get-StableInstalledAppProcessInventory -ProcessInventoryQuery { @(BlankRow 705) } -ProcessIdentityQuery { param([int]$ProcessId) return @() } -ProcessExistsProbe { param([int]$ProcessId) throw 'synthetic PID existence ambiguity' }
} 'synthetic PID existence ambiguity'

# A live exact-PID row whose CommandLine is still blank is equally unsafe: it may be a main process
# the lifecycle owner cannot identify, so fail closed rather than silently dropping it.
Expect-Failure {
  Get-StableInstalledAppProcessInventory -ProcessInventoryQuery { @(BlankRow 704) } -ProcessIdentityQuery { param([int]$ProcessId) return @((BlankRow $ProcessId)) } -ProcessExistsProbe { param([int]$ProcessId) return $true }
} 'remains live with no readable command line'
Write-Output 'transient-safe-close-row-ok'
`, 'utf8');
    try {
      const result = spawnSync('powershell.exe', [
        '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', harness
      ], { encoding: 'utf8', timeout: 120_000 });
      expect(result.status, `${result.error ?? ''}\n${result.stdout}\n${result.stderr}`).toBe(0);
      expect(result.stdout).toContain('transient-safe-close-row-ok');
      expect(readFileSync(installScript, 'utf8')).toMatch(
        /\$SafeCloseProcessInventory\s*=\s*\{\s*@\(Get-StableInstalledAppProcessInventory\)\s*\}/,
      );
      expect(readFileSync(installScript, 'utf8')).not.toContain('catch [InvalidOperationException]');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('keeps the official updater path positively fenced from CUSTOM_BUILD through UI, IPC, lifecycle and shutdown', () => {
    const updater = readFileSync(updaterOwner, 'utf8');
    const ipc = readFileSync(updaterIpc, 'utf8');
    const lifecycle = readFileSync(updaterLifecycle, 'utf8');
    const preload = readFileSync(updaterPreload, 'utf8');
    const renderer = readFileSync(updaterRenderer, 'utf8');

    expect(updater).toContain('if (localCustomBuild(resourcesPath)) return null;');
    const markStart = updater.indexOf('export function markInstallOnQuit(): boolean {');
    const applyStart = updater.indexOf('export async function applyStagedUpdate(): Promise<void> {');
    const markFence = updater.indexOf('if (localCustomBuild()) {', markStart);
    const applyFence = updater.indexOf('if (localCustomBuild()) {', applyStart);
    expect(markStart).toBeGreaterThan(-1);
    expect(markFence).toBeGreaterThan(markStart);
    expect(markFence).toBeLessThan(applyStart);
    expect(applyFence).toBeGreaterThan(applyStart);
    expect(updater).toContain("if (localCustomBuild() && status.stage === 'ready') return { ...status, stage: 'idle' };");

    expect(renderer).toContain("const installable = update.stage === 'ready';");
    expect(preload).toContain("installUpdate: () => call<InstanceProfilesSnapshot>('update:install')");
    const ipcInstall = ipc.indexOf("handle('update:install'");
    expect(ipcInstall).toBeGreaterThan(-1);
    expect(ipc.indexOf('await lifecycle.requestUpdate()', ipcInstall)).toBeGreaterThan(ipcInstall);
    expect(ipc.indexOf('return buildInstanceProfilesSnapshot(lifecycle)', ipcInstall)).toBeGreaterThan(ipcInstall);
    const lifecycleApply = lifecycle.indexOf('applyUpdate: async () => {');
    const mark = lifecycle.indexOf('if (!markInstallOnQuit())', lifecycleApply);
    const quit = lifecycle.indexOf('app.quit();', mark);
    expect(lifecycleApply).toBeGreaterThan(-1);
    expect(mark).toBeGreaterThan(lifecycleApply);
    expect(quit).toBeGreaterThan(mark);
  });

  it.runIf(hasPinnedReleaseFixture)('fails closed across baseline drift and the quit-window artifact boundary', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'cos-custom-install-'));
    const fixtureRelease = path.join(root, 'release');
    mkdirSync(fixtureRelease, { recursive: true });
    const installerName = 'Chat-On-Steroids-Setup-x64.exe';
    const sourceInstaller = path.join(releaseRoot, installerName);
    const sourceLatest = path.join(releaseRoot, 'latest.yml');
    copyFileSync(sourceInstaller, path.join(fixtureRelease, installerName));
    copyFileSync(sourceLatest, path.join(fixtureRelease, 'latest.yml'));

    try {
      const harness = path.join(root, 'rehearse.ps1');
      writeFileSync(harness, `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression.FileSystem
. ${ps(installScript)}
$root = ${ps(root)}
$release = ${ps(fixtureRelease)}
$sourceInstaller = ${ps(sourceInstaller)}
$sourceLatest = ${ps(sourceLatest)}
$reviewRepo = ${ps(repoRoot)}
$candidateRoot = ${ps(unpackedRoot)}
# Every transaction here mutates only this disposable fixture. Never contend with a real
# qualification build's production mutex; explicit lock-contention probes below keep their
# own lock names and still exercise the real fail-closed owner.
$PSDefaultParameterValues['Invoke-CustomInstall:OperationLockName'] = 'Local\\COSCustomInstall-Fixture-' + [guid]::NewGuid().ToString('N')
$installer = Join-Path $release '${installerName}'
$latest = Join-Path $release 'latest.yml'
$install = Join-Path $root 'Current App'
$baselineSource = Join-Path $root 'baseline-source'
$baselineResources = Join-Path $baselineSource 'resources'
$baselineExtension = Join-Path $baselineResources 'extension'
New-Item -ItemType Directory -Path $baselineExtension -Force | Out-Null
Copy-Item -LiteralPath (Join-Path $env:SystemRoot 'System32\\cmd.exe') -Destination (Join-Path $baselineSource 'Chat On Steroids.exe')
[IO.File]::WriteAllText((Join-Path $baselineResources 'app.asar'),'baseline-asar',[Text.UTF8Encoding]::new($false))
[IO.File]::WriteAllText((Join-Path $baselineExtension 'background.js'),'baseline-companion',[Text.UTF8Encoding]::new($false))
[IO.File]::WriteAllText((Join-Path $baselineExtension 'manifest.json'),'{"version":"2.1.13"}',[Text.UTF8Encoding]::new($false))
[IO.File]::WriteAllText((Join-Path $baselineResources 'CUSTOM_BUILD'),'fixture custom build',[Text.UTF8Encoding]::new($false))
[IO.File]::WriteAllText((Join-Path $baselineResources 'SOURCE_PROVENANCE.json'),'{"fixture":true}',[Text.UTF8Encoding]::new($false))
[IO.File]::WriteAllText((Join-Path $baselineSource 'extra.dat'),'baseline-extra',[Text.UTF8Encoding]::new($false))

# Persisted tree identities must not inherit the process locale. Swedish orders ä after z while
# English collates it near a; the canonical fingerprint remains identical because paths are ordinal.
$orderProbe = Join-Path $root 'fingerprint-order-probe'
New-Item -ItemType Directory -Path $orderProbe | Out-Null
[IO.File]::WriteAllText((Join-Path $orderProbe 'a.txt'),'a',[Text.UTF8Encoding]::new($false))
[IO.File]::WriteAllText((Join-Path $orderProbe 'z.txt'),'z',[Text.UTF8Encoding]::new($false))
[IO.File]::WriteAllText((Join-Path $orderProbe 'ä.txt'),'umlaut',[Text.UTF8Encoding]::new($false))
$savedCulture = [Threading.Thread]::CurrentThread.CurrentCulture
try {
  [Threading.Thread]::CurrentThread.CurrentCulture = [Globalization.CultureInfo]::GetCultureInfo('en-US')
  $englishFingerprint = Get-DirectoryFingerprint -Root $orderProbe
  [Threading.Thread]::CurrentThread.CurrentCulture = [Globalization.CultureInfo]::GetCultureInfo('sv-SE')
  $swedishFingerprint = Get-DirectoryFingerprint -Root $orderProbe
} finally {
  [Threading.Thread]::CurrentThread.CurrentCulture = $savedCulture
}
if ($englishFingerprint.TreeSha256 -cne $swedishFingerprint.TreeSha256) {
  throw 'directory fingerprint changed with process culture'
}

$fingerprint = Get-DirectoryFingerprint -Root $baselineSource
$baselineExe = Get-Item -LiteralPath (Join-Path $baselineSource 'Chat On Steroids.exe')
$rollbackSourceDir = Join-Path $root 'rollback-source'
$rollbackLiveDir = Join-Path $root 'rollback-live'
New-Item -ItemType Directory -Path $rollbackSourceDir,$rollbackLiveDir -Force | Out-Null
$rollbackSource = Join-Path $rollbackSourceDir 'private-2.1.13-program.zip'
$rollbackLive = Join-Path $rollbackLiveDir 'private-2.1.13-program.zip'
[IO.Compression.ZipFile]::CreateFromDirectory($baselineSource,$rollbackSource,[IO.Compression.CompressionLevel]::Optimal,$false)
$baseline = [pscustomobject]@{
  Version='2.1.13'; ArchiveDirectory='unused'; ArchiveFile='private-2.1.13-program.zip'; ArchiveSize=[int64](Get-Item -LiteralPath $rollbackSource).Length; ArchiveSha256=(Get-FileHashHex -Path $rollbackSource);
  FileCount=$fingerprint.FileCount; TotalBytes=[int64]$fingerprint.TotalBytes; TreeSha256=$fingerprint.TreeSha256;
  FileVersion=$baselineExe.VersionInfo.FileVersion; ProductVersion=$baselineExe.VersionInfo.ProductVersion; ExeSha256=(Get-FileHashHex -Path $baselineExe.FullName);
  AppAsarSha256=(Get-FileHashHex -Path (Join-Path $baselineResources 'app.asar')); BundledMainSha256='fixture'; ExtensionVersion='2.1.13';
  ExtensionBackgroundSha256=(Get-FileHashHex -Path (Join-Path $baselineExtension 'background.js')); CustomBuildText='fixture custom build'
}
$capableBaseline=$baseline.PSObject.Copy()
$capableBaseline | Add-Member -NotePropertyName SafeCloseForUpdate -NotePropertyValue $true
$capableBaseline | Add-Member -NotePropertyName SourceProvenanceSha256 -NotePropertyValue (Get-FileHashHex -Path (Join-Path $baselineResources 'SOURCE_PROVENANCE.json'))

function Reset-Release { Copy-Item -LiteralPath $sourceInstaller -Destination $installer -Force; Copy-Item -LiteralPath $sourceLatest -Destination $latest -Force }
function Reset-Rollback { Copy-Item -LiteralPath $rollbackSource -Destination $rollbackLive -Force }
function Reset-BaselineInstall { if(Test-Path -LiteralPath $install){Remove-Item -LiteralPath $install -Recurse -Force}; Copy-Item -LiteralPath $baselineSource -Destination $install -Recurse -Force }
function Install-NewCandidate {
  if(Test-Path -LiteralPath $install){Remove-Item -LiteralPath $install -Recurse -Force}
  New-Item -ItemType Directory -Path (Join-Path $install 'resources\\extension') -Force | Out-Null
  Copy-Item -LiteralPath (Join-Path $candidateRoot 'Chat On Steroids.exe') -Destination (Join-Path $install 'Chat On Steroids.exe')
  Copy-Item -LiteralPath (Join-Path $candidateRoot 'resources\\app.asar') -Destination (Join-Path $install 'resources\\app.asar')
  Copy-Item -LiteralPath (Join-Path $candidateRoot 'resources\\extension\\background.js') -Destination (Join-Path $install 'resources\\extension\\background.js')
  Copy-Item -LiteralPath (Join-Path $candidateRoot 'resources\\extension\\manifest.json') -Destination (Join-Path $install 'resources\\extension\\manifest.json')
  Copy-Item -LiteralPath (Join-Path $candidateRoot 'resources\\CUSTOM_BUILD') -Destination (Join-Path $install 'resources\\CUSTOM_BUILD')
  Copy-Item -LiteralPath (Join-Path $candidateRoot 'resources\\SOURCE_PROVENANCE.json') -Destination (Join-Path $install 'resources\\SOURCE_PROVENANCE.json')
}
function Expect-Failure([scriptblock]$Action,[string]$Needle){ try{& $Action; throw "expected failure containing: $Needle"}catch{if($_.Exception.Message -notlike "*$Needle*"){throw}} }
function Flip-Byte([string]$Path,[int64]$Offset=128){ $s=[IO.File]::Open($Path,[IO.FileMode]::Open,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None); try{$s.Position=$Offset;$v=$s.ReadByte();if($v -lt 0){throw 'fixture file too short'};$s.Position=$Offset;$s.WriteByte(($v -bxor 1))}finally{$s.Dispose()} }

Reset-Release; Reset-Rollback; Reset-BaselineInstall
$readinessLock='Local\\COSCustomInstall-Readiness-' + [guid]::NewGuid().ToString('N')
$beforeInstaller=(Get-FileHashHex -Path $installer)
$beforeLatest=(Get-FileHashHex -Path $latest)
$beforeRollback=(Get-FileHashHex -Path $rollbackLive)
$readinessPaths=Get-RollbackTransactionPaths -InstallRoot $install
$qualified = Invoke-CustomInstall -QualifiedPrebuilt -RepoRoot $reviewRepo -ReleaseDirectory $release -InstallRoot $install -RollbackArchivePath $rollbackLive -RollbackBaseline $baseline -OperationLockName $readinessLock -ProcessProbe { throw 'readiness must not probe processes' } -SleepAction { throw 'readiness must not wait' } -InstallerRunner { throw 'readiness must not invoke installer' } -SuccessorLauncher { throw 'readiness must not launch successor' } -ArchiveExtractor { throw 'readiness must not stage rollback' } -MoveDirectory { throw 'readiness must not move directories' } -RemoveDirectory { throw 'readiness must not remove directories' }
if($qualified.Version -ne $script:QualifiedCandidate.Version){throw 'exact cutover preflight did not pass'}
if((Get-FileHashHex -Path $installer) -ne $beforeInstaller -or (Get-FileHashHex -Path $latest) -ne $beforeLatest -or (Get-FileHashHex -Path $rollbackLive) -ne $beforeRollback){throw 'readiness mutated a frozen artifact'}
if((Test-Path -LiteralPath $readinessPaths.Marker) -or (Test-Path -LiteralPath $readinessPaths.Stage) -or (Test-Path -LiteralPath $readinessPaths.Quarantine)){throw 'readiness created rollback transaction artifacts'}

# A same-version private update may start from one exact qualified predecessor while retaining
# the older frozen rollback archive. The fallback is still a full-tree proof and never reaches
# process probing when either accepted installed baseline has drifted.
$differentRollback = $baseline.PSObject.Copy(); $differentRollback.FileVersion = '0.0.0'
$predecessor = Invoke-CustomInstall -QualifiedPrebuilt -RepoRoot $reviewRepo -ReleaseDirectory $release -InstallRoot $install -RollbackArchivePath $rollbackLive -RollbackBaseline $differentRollback -InstalledUpgradeBaseline $baseline -OperationLockName ($readinessLock + '-predecessor') -ProcessProbe { throw 'predecessor readiness must not probe processes' }
if($predecessor.Version -ne $script:QualifiedCandidate.Version){throw 'qualified predecessor readiness did not pass'}
Flip-Byte (Join-Path $install 'extra.dat') 2
Expect-Failure { Invoke-CustomInstall -QualifiedPrebuilt -RepoRoot $reviewRepo -ReleaseDirectory $release -InstallRoot $install -RollbackArchivePath $rollbackLive -RollbackBaseline $differentRollback -InstalledUpgradeBaseline $baseline -OperationLockName ($readinessLock + '-drift') -ProcessProbe { throw 'drifted predecessor must not probe processes' } } 'matches neither accepted activation baseline'
Reset-BaselineInstall

# Readiness also proves that no other custom build/install/rollback transaction owns the canonical
# mutation lock. This is a point-in-time probe only; activation reacquires and holds the same lock.
$readyFile=Join-Path $root 'readiness-lock.ready'
$job=Start-Job -ScriptBlock {
  param($Name,$Ready)
  $created=$false
  $mutex=[Threading.Mutex]::new($false,$Name,[ref]$created)
  try {
    $null=$mutex.WaitOne()
    [IO.File]::WriteAllText($Ready,'ready',[Text.UTF8Encoding]::new($false))
    Start-Sleep -Seconds 30
  } finally {
    try{$mutex.ReleaseMutex()}catch{}
    $mutex.Dispose()
  }
} -ArgumentList $readinessLock,$readyFile
try {
  $deadline=(Get-Date).AddSeconds(10)
  while(-not (Test-Path -LiteralPath $readyFile) -and (Get-Date) -lt $deadline){Start-Sleep -Milliseconds 25}
  if(-not (Test-Path -LiteralPath $readyFile)){throw 'readiness lock-holder job did not become ready'}
  Expect-Failure { Invoke-CustomInstall -QualifiedPrebuilt -RepoRoot $reviewRepo -ReleaseDirectory $release -InstallRoot $install -RollbackArchivePath $rollbackLive -RollbackBaseline $baseline -OperationLockName $readinessLock -ProcessProbe { throw 'blocked readiness must not probe processes' } } 'readiness is blocked'
} finally {
  Stop-Job -Job $job -ErrorAction SilentlyContinue
  Remove-Job -Job $job -Force -ErrorAction SilentlyContinue
}

# A one-byte drift in an otherwise well-shaped private baseline fails before any process probe.
Flip-Byte (Join-Path $install 'extra.dat') 2
$probeCalls=0
Expect-Failure { Invoke-CustomInstall -QualifiedPrebuilt -WaitForSafeQuit -RepoRoot $reviewRepo -ReleaseDirectory $release -InstallRoot $install -RollbackArchivePath $rollbackLive -RollbackBaseline $baseline -ProcessProbe { $script:probeCalls += 1; throw 'process probe should not run' } -SleepAction { throw 'sleep should not run' } } 'fingerprint mismatch'
if($probeCalls -ne 0){throw 'drifted baseline reached process probing'}

# Missing and unreadable baseline files fail at the same pre-quit boundary.
Reset-BaselineInstall; Remove-Item -LiteralPath (Join-Path $install 'extra.dat')
$probeCalls=0
Expect-Failure { Invoke-CustomInstall -QualifiedPrebuilt -WaitForSafeQuit -RepoRoot $reviewRepo -ReleaseDirectory $release -InstallRoot $install -RollbackArchivePath $rollbackLive -RollbackBaseline $baseline -ProcessProbe { $script:probeCalls += 1 } -SleepAction { } } 'file-count mismatch'
if($probeCalls -ne 0){throw 'missing baseline file reached process probing'}
Reset-BaselineInstall
$locked=Join-Path $install 'extra.dat'; $lock=[IO.File]::Open($locked,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::None); $probeCalls=0
try {
  try { Invoke-CustomInstall -QualifiedPrebuilt -WaitForSafeQuit -RepoRoot $reviewRepo -ReleaseDirectory $release -InstallRoot $install -RollbackArchivePath $rollbackLive -RollbackBaseline $baseline -ProcessProbe { $script:probeCalls += 1 } -SleepAction { }; throw 'expected unreadable baseline failure' }
  catch { if($_.Exception.Message -like '*expected unreadable baseline failure*'){throw}; if($probeCalls -ne 0){throw 'unreadable baseline reached process probing'} }
} finally { $lock.Dispose() }

# Candidate replacement during the normal-quit wait is rejected at the mutation boundary.
Reset-Release; Reset-Rollback; Reset-BaselineInstall
$probeCalls=0;$runnerCalls=0;$mutated=$false
$probe={ $script:probeCalls += 1; if($script:probeCalls -eq 1){return [pscustomobject]@{Id=1}}; return @() }
Expect-Failure { Invoke-CustomInstall -QualifiedPrebuilt -WaitForSafeQuit -RepoRoot $reviewRepo -ReleaseDirectory $release -InstallRoot $install -RollbackArchivePath $rollbackLive -RollbackBaseline $baseline -ProcessProbe $probe -SleepAction { if(-not $script:mutated){Flip-Byte $installer 4096;$script:mutated=$true} } -InstallerRunner { param($p) $script:runnerCalls += 1; return 0 } } 'SHA-512 mismatch'
if($runnerCalls -ne 0){throw 'changed candidate reached installer invocation'}

# Rollback artifact replacement during that same wait is also rejected before installer invocation.
Reset-Release; Reset-Rollback; Reset-BaselineInstall
$probeCalls=0;$runnerCalls=0;$mutated=$false
$probe={ $script:probeCalls += 1; if($script:probeCalls -eq 1){return [pscustomobject]@{Id=2}}; return @() }
Expect-Failure { Invoke-CustomInstall -QualifiedPrebuilt -WaitForSafeQuit -RepoRoot $reviewRepo -ReleaseDirectory $release -InstallRoot $install -RollbackArchivePath $rollbackLive -RollbackBaseline $baseline -ProcessProbe $probe -SleepAction { if(-not $script:mutated){Flip-Byte $rollbackLive 128;$script:mutated=$true} } -InstallerRunner { param($p) $script:runnerCalls += 1; return 0 } } 'SHA-256 mismatch'
if($runnerCalls -ne 0){throw 'changed rollback artifact reached installer invocation'}

# The app can reappear after the normal-quit wait while artifact revalidation is running. A final
# process proof at the exact installer boundary must still fence NSIS, and failure releases the
# cross-process custom-install lock for a deliberate retry.
Reset-Release; Reset-Rollback; Reset-BaselineInstall
$probeCalls=0;$runnerCalls=0;$lockName='Local\\COSCustomInstall-Reappear-' + [guid]::NewGuid().ToString('N')
$probe={ $script:probeCalls += 1; if($script:probeCalls -eq 1){return [pscustomobject]@{Id=31}}; if($script:probeCalls -eq 2){return @()}; if($script:probeCalls -eq 3){return [pscustomobject]@{Id=32}}; return @() }
Expect-Failure { Invoke-CustomInstall -QualifiedPrebuilt -WaitForSafeQuit -RepoRoot $reviewRepo -ReleaseDirectory $release -InstallRoot $install -RollbackArchivePath $rollbackLive -RollbackBaseline $baseline -ProcessProbe $probe -SleepAction { } -InstallerRunner { param($p) $script:runnerCalls += 1; return 0 } -OperationLockName $lockName } 'qualified installer boundary'
if($runnerCalls -ne 0){throw 'reappeared app reached installer invocation'}
$lock=Enter-CustomInstallOperationLock -Name $lockName; Exit-CustomInstallOperationLock -Mutex $lock

# A provenance-bound capable predecessor requests one PID-bound lifecycle close, but only after
# candidate, rollback and installed-tree validation. A bad candidate cannot even inventory or
# launch that helper; the exact candidate then exercises the complete supported activation path.
Reset-Release; Reset-Rollback; Reset-BaselineInstall
$safeInventoryCalls=0;$safeLauncherCalls=0
Flip-Byte $installer 4096
Expect-Failure {
  Invoke-CustomInstall -QualifiedPrebuilt -WaitForSafeQuit -RepoRoot $reviewRepo -ReleaseDirectory $release -InstallRoot $install -RollbackArchivePath $rollbackLive -RollbackBaseline $differentRollback -InstalledUpgradeBaseline $capableBaseline -ProcessProbe { throw 'invalid candidate must not probe processes' } -SafeCloseProcessInventory { $script:safeInventoryCalls += 1; throw 'invalid candidate reached safe-close inventory' } -SafeCloseLauncher { $script:safeLauncherCalls += 1; throw 'invalid candidate reached safe-close launcher' } -SleepAction { throw 'invalid candidate must not wait' }
} 'SHA-512 mismatch'
if($safeInventoryCalls -ne 0 -or $safeLauncherCalls -ne 0){throw 'candidate validation did not precede safe-close mutation'}

Reset-Release; Reset-Rollback; Reset-BaselineInstall
$safeInventoryCalls=0;$safeLauncherCalls=0;$runnerCalls=0;$successorCalls=0;$capableRunning=$true;$safeEvents=@()
$safeRows=@([pscustomobject]@{
  Name='Chat On Steroids.exe'; ProcessId=5151; ExecutablePath=(Join-Path $install 'Chat On Steroids.exe');
  CommandLine=('"' + (Join-Path $install 'Chat On Steroids.exe') + '" --background');
  CreationDate=[DateTimeOffset]::FromUnixTimeMilliseconds(1700000005151).UtcDateTime
})
$capableInstalled=Invoke-CustomInstall -QualifiedPrebuilt -WaitForSafeQuit -RepoRoot $reviewRepo -ReleaseDirectory $release -InstallRoot $install -RollbackArchivePath $rollbackLive -RollbackBaseline $differentRollback -InstalledUpgradeBaseline $capableBaseline -ProcessProbe { if($script:capableRunning){return [pscustomobject]@{Id=5151}}; return @() } -SafeCloseProcessInventory { $script:safeInventoryCalls += 1; $script:safeEvents += 'inventory'; return $script:safeRows } -SafeCloseLauncher { param($exe,$arguments,$profile,$targetPid,$targetGeneration) $script:safeLauncherCalls += 1; $script:safeEvents += 'launcher'; if($exe -cne (Join-Path $install 'Chat On Steroids.exe')){throw 'capable helper used the wrong executable'}; if(($arguments -join '|') -cne '--safe-close-for-update=local-instance|--safe-close-for-update-pid=5151|--safe-close-for-update-generation=1700000005151' -or $profile -cne 'local-instance' -or $targetPid -ne 5151 -or $targetGeneration -cne '1700000005151'){throw 'capable helper arguments were not PID/generation-bound'}; $script:capableRunning=$false } -SleepAction { } -InstallerRunner { param($p) $script:runnerCalls += 1; $script:safeEvents += 'installer'; Install-NewCandidate; return 0 } -SuccessorLauncher { param($p) $script:successorCalls += 1 }
if($safeInventoryCalls -ne 2 -or $safeLauncherCalls -ne 1){throw "capable close counts inventory=$safeInventoryCalls launcher=$safeLauncherCalls"}
if(($safeEvents -join '|') -cne 'inventory|inventory|launcher|installer'){throw "capable ordering was not validation/inventory/launcher/install: $($safeEvents -join '|')"}
if($runnerCalls -ne 1 -or $successorCalls -ne 1 -or $capableInstalled.AppAsarSha256 -ne $script:QualifiedCandidate.AppAsarSha256){throw 'capable baseline activation did not finish exactly once'}

# Exact artifacts that survive the wait invoke the installer once, install the candidate fixture,
# pass exact post-install verification and launch the successor once.
Reset-Release; Reset-Rollback; Reset-BaselineInstall
$probeCalls=0;$runnerCalls=0;$successorCalls=0
$probe={ $script:probeCalls += 1; if($script:probeCalls -eq 1){return [pscustomobject]@{Id=3}}; return @() }
$installed=Invoke-CustomInstall -QualifiedPrebuilt -WaitForSafeQuit -RepoRoot $reviewRepo -ReleaseDirectory $release -InstallRoot $install -RollbackArchivePath $rollbackLive -RollbackBaseline $baseline -ProcessProbe $probe -SleepAction { } -InstallerRunner { param($p) $script:runnerCalls += 1; Install-NewCandidate; return 0 } -SuccessorLauncher { param($p) $script:successorCalls += 1 }
if($runnerCalls -ne 1 -or $successorCalls -ne 1){throw "exact cutover runner=$runnerCalls successor=$successorCalls"}
if($installed.AppAsarSha256 -ne $script:QualifiedCandidate.AppAsarSha256){throw 'post-install candidate proof mismatch'}

# A reopen failure occurs after the candidate has already been accepted. Preserve that committed
# truth in the error, keep the accepted bytes in place, and never imply that rollback ran.
Reset-Release; Reset-Rollback; Reset-BaselineInstall
$runnerCalls=0;$successorCalls=0;$committedMessage=$null
try {
  Invoke-CustomInstall -QualifiedPrebuilt -WaitForSafeQuit -RepoRoot $reviewRepo -ReleaseDirectory $release -InstallRoot $install -RollbackArchivePath $rollbackLive -RollbackBaseline $baseline -ProcessProbe { return @() } -SleepAction { } -InstallerRunner { param($p) $script:runnerCalls += 1; Install-NewCandidate; return 0 } -SuccessorLauncher { param($p) $script:successorCalls += 1; throw 'synthetic reopen failure' } | Out-Null
  throw 'expected accepted-install reopen failure'
} catch {
  $committedMessage=$_.Exception.Message
  if($committedMessage -like '*expected accepted-install reopen failure*'){throw}
}
if($committedMessage -notlike '*installation was accepted and remains installed*' -or $committedMessage -notlike '*automatic reopen/resume step failed or could not be confirmed*' -or $committedMessage -notlike '*Rollback remains a separate deliberate action and was not run automatically*'){throw "accepted-install reopen message was ambiguous: $committedMessage"}
if($committedMessage -like '*installed state was not accepted*'){throw 'accepted-install reopen failure falsely rejected committed bytes'}
if($runnerCalls -ne 1 -or $successorCalls -ne 1){throw "accepted-install reopen counts runner=$runnerCalls successor=$successorCalls"}
$acceptedAfterReopenFailure=Assert-InstalledQualifiedBuild -InstallRoot $install
if($acceptedAfterReopenFailure.Version -ne $script:QualifiedCandidate.Version){throw 'accepted candidate was not left installed after reopen failure'}

'custom install drift and TOCTOU rehearsal passed'
`, 'utf8');

      const result = spawnSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', harness], {
        // Real local clones and hash verification can cross two minutes on Windows while
        // Defender is scanning a freshly created candidate tree. The transaction itself is
        // still synchronous and fail-closed; this timeout only keeps the proof deterministic.
        encoding: 'utf8', windowsHide: true, timeout: 300_000, cwd: repoRoot
      });
      expect(result.status, result.stderr || result.stdout).toBe(0);
      expect(result.stdout).toContain('custom install drift and TOCTOU rehearsal passed');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 360_000);

  it('retries only bounded unchanged pre-move rollback locks and retains uncertain side effects', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'cos-rollback-move-'));
    try {
      const harness = path.join(root, 'move.ps1');
      writeFileSync(harness, `
$ErrorActionPreference='Stop'
. ${ps(installScript)}
$root=${ps(root)}
$script:delays=[Collections.Generic.List[int]]::new()
$moveArgs=@{ProcessProbe={return @()}}
function Start-Sleep { param([int]$Milliseconds) $script:delays.Add($Milliseconds) }
function New-Source([string]$Name) {
  $p=Join-Path $root $Name
  New-Item -ItemType Directory -Path $p | Out-Null
  [IO.File]::WriteAllText((Join-Path $p 'payload.txt'),'original',[Text.UTF8Encoding]::new($false))
  return $p
}
function Locked { return [UnauthorizedAccessException]::new('deterministic access-denied fixture') }
function Expect-MoveFailure([scriptblock]$Action,[string]$Needle) {
  $failure=$null
  try { & $Action } catch { $failure=$_ }
  if($null -eq $failure){throw "expected move failure containing: $Needle"}
  if($failure.Exception.Message -notlike "*$Needle*"){throw $failure}
}
$source=New-Source 'native-lock';$destination=$source+'-moved';$script:calls=0;$script:nativeFailure=$null
$script:lockedFile=[IO.File]::Open((Join-Path $source 'payload.txt'),[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read)
function Start-Sleep { param([int]$Milliseconds) $script:delays.Add($Milliseconds);$script:lockedFile.Dispose() }
$mover={param($s,$d) $script:calls++;try{[IO.Directory]::Move($s,$d)}catch{$script:nativeFailure=$_;for($e=$_.Exception;$null -ne $e;$e=$e.InnerException){Write-Host ('NATIVE_FAILURE_SHAPE='+$e.GetType().FullName+':'+$e.HResult)};throw}}
Move-RollbackOwnedDirectory @moveArgs -Source $source -Destination $destination -MoveDirectory $mover -Context 'fixture native lock'
if($script:calls -ne 2 -or $script:delays.Count -ne 1 -or $null -eq $script:nativeFailure -or (Test-Path -LiteralPath $source) -or -not (Test-Path -LiteralPath $destination)){throw 'real Windows child-file lock did not exercise a bounded rename retry'}
Write-Output ('NATIVE_LOCK=' + $script:nativeFailure.Exception.GetType().FullName + ':' + $script:nativeFailure.Exception.HResult + ':' + $script:nativeFailure.FullyQualifiedErrorId)
function Start-Sleep { param([int]$Milliseconds) $script:delays.Add($Milliseconds) }
$source=New-Source 'transient';$destination=$source+'-moved';$script:calls=0;$script:delays.Clear()
$mover={param($s,$d) $script:calls++;if($script:calls -le 2){throw (Locked)};Move-Item -LiteralPath $s -Destination $d}
Move-RollbackOwnedDirectory @moveArgs -Source $source -Destination $destination -MoveDirectory $mover -Context 'fixture transient'
if($script:calls -ne 3 -or ($script:delays -join ',') -cne '100,250' -or (Test-Path -LiteralPath $source) -or -not (Test-Path -LiteralPath $destination)){throw 'transient lock did not converge within exact bounded retries'}

$source=New-Source 'persistent';$destination=$source+'-moved';$script:calls=0;$script:delays.Clear()
Expect-MoveFailure { Move-RollbackOwnedDirectory @moveArgs -Source $source -Destination $destination -MoveDirectory {param($s,$d) $script:calls++;throw (Locked)} -Context 'fixture persistent' } 'access-denied fixture'
if($script:calls -ne 6 -or ($script:delays -join ',') -cne '100,250,500,1000,2000' -or -not (Test-Path -LiteralPath $source) -or (Test-Path -LiteralPath $destination)){throw 'persistent lock exceeded or skipped bounded retries'}

$source=New-Source 'nontransient';$destination=$source+'-moved';$script:calls=0;$script:delays.Clear()
Expect-MoveFailure { Move-RollbackOwnedDirectory @moveArgs -Source $source -Destination $destination -MoveDirectory {param($s,$d) $script:calls++;throw [IO.IOException]::new('unclassified IO failure')} -Context 'fixture nontransient' } 'unclassified IO failure'
if($script:calls -ne 1 -or $script:delays.Count -ne 0){throw 'unclassified failure was retried'}

$source=New-Source 'postmove';$destination=$source+'-moved';$script:calls=0;$script:delays.Clear()
Expect-MoveFailure { Move-RollbackOwnedDirectory @moveArgs -Source $source -Destination $destination -MoveDirectory {param($s,$d) $script:calls++;Move-Item -LiteralPath $s -Destination $d;throw (Locked)} -Context 'fixture postmove' } 'access-denied fixture'
if($script:calls -ne 1 -or $script:delays.Count -ne 0 -or (Test-Path -LiteralPath $source) -or -not (Test-Path -LiteralPath $destination)){throw 'post-side-effect exception was retried or falsely accepted'}

$source=New-Source 'collision';$destination=$source+'-moved';$script:calls=0;$script:delays.Clear()
Expect-MoveFailure { Move-RollbackOwnedDirectory @moveArgs -Source $source -Destination $destination -MoveDirectory {param($s,$d) $script:calls++;New-Item -ItemType Directory -Path $d | Out-Null;throw (Locked)} -Context 'fixture collision' } 'access-denied fixture'
if($script:calls -ne 1 -or $script:delays.Count -ne 0 -or -not (Test-Path -LiteralPath $source) -or -not (Test-Path -LiteralPath $destination)){throw 'destination collision was retried or overwritten'}

$source=New-Source 'mutated';$destination=$source+'-moved';$script:calls=0;$script:delays.Clear()
Expect-MoveFailure { Move-RollbackOwnedDirectory @moveArgs -Source $source -Destination $destination -MoveDirectory {param($s,$d) $script:calls++;[IO.File]::WriteAllText((Join-Path $s 'payload.txt'),'changed');throw (Locked)} -Context 'fixture mutated' } 'access-denied fixture'
if($script:calls -ne 1 -or $script:delays.Count -ne 0 -or [IO.File]::ReadAllText((Join-Path $source 'payload.txt')) -cne 'changed'){throw 'changed source was retried or rewritten'}

$source=New-Source 'late-collision';$destination=$source+'-moved';$script:calls=0;$script:delays.Clear()
function Start-Sleep { param([int]$Milliseconds) $script:delays.Add($Milliseconds);New-Item -ItemType Directory -Path $destination | Out-Null }
Expect-MoveFailure { Move-RollbackOwnedDirectory @moveArgs -Source $source -Destination $destination -MoveDirectory {param($s,$d) $script:calls++;throw (Locked)} -Context 'fixture late collision' } 'access-denied fixture'
if($script:calls -ne 1 -or $script:delays.Count -ne 1 -or -not (Test-Path -LiteralPath $source) -or -not (Test-Path -LiteralPath $destination)){throw 'collision during delay crossed the retry boundary'}

$source=New-Source 'late-source-change';$destination=$source+'-moved';$script:calls=0;$script:delays.Clear()
function Start-Sleep { param([int]$Milliseconds) $script:delays.Add($Milliseconds);[IO.File]::WriteAllText((Join-Path $source 'payload.txt'),'late change') }
Expect-MoveFailure { Move-RollbackOwnedDirectory @moveArgs -Source $source -Destination $destination -MoveDirectory {param($s,$d) $script:calls++;throw (Locked)} -Context 'fixture late change' } 'access-denied fixture'
if($script:calls -ne 1 -or $script:delays.Count -ne 1 -or [IO.File]::ReadAllText((Join-Path $source 'payload.txt')) -cne 'late change' -or (Test-Path -LiteralPath $destination)){throw 'source change during delay crossed the retry boundary'}

$source=New-Source 'replaced-root';$destination=$source+'-moved';$script:calls=0;$script:delays.Clear()
$created=(Get-Item -LiteralPath $source).CreationTimeUtc
function Start-Sleep { param([int]$Milliseconds) $script:delays.Add($Milliseconds);[IO.Directory]::Move($source,$source+'-retained');New-Item -ItemType Directory -Path $source | Out-Null;[IO.File]::WriteAllText((Join-Path $source 'payload.txt'),'original');[IO.Directory]::SetCreationTimeUtc($source,$created.AddSeconds(1)) }
Expect-MoveFailure { Move-RollbackOwnedDirectory @moveArgs -Source $source -Destination $destination -MoveDirectory {param($s,$d) $script:calls++;throw (Locked)} -Context 'fixture replaced root' } 'access-denied fixture'
if($script:calls -ne 1 -or $script:delays.Count -ne 1 -or -not (Test-Path -LiteralPath ($source+'-retained')) -or -not (Test-Path -LiteralPath $source) -or (Test-Path -LiteralPath $destination)){throw 'equal-content replaced root was retried'}

$source=New-Source 'process-reappeared';$destination=$source+'-moved';$script:calls=0;$script:delays.Clear()
function Start-Sleep { param([int]$Milliseconds) $script:delays.Add($Milliseconds) }
Expect-MoveFailure { Move-RollbackOwnedDirectory -ProcessProbe {return [pscustomobject]@{Id=42}} -Source $source -Destination $destination -MoveDirectory {param($s,$d) $script:calls++;throw (Locked)} -Context 'fixture process' } 'remained running'
if($script:calls -ne 1 -or $script:delays.Count -ne 1 -or -not (Test-Path -LiteralPath $source) -or (Test-Path -LiteralPath $destination)){throw 'reappeared process crossed retry boundary'}

$source=New-Source 'probe-unknown';$destination=$source+'-moved';$script:calls=0;$script:delays.Clear()
Expect-MoveFailure { Move-RollbackOwnedDirectory -ProcessProbe {throw 'process census unknown'} -Source $source -Destination $destination -MoveDirectory {param($s,$d) $script:calls++;throw (Locked)} -Context 'fixture unknown process' } 'process census unknown'
if($script:calls -ne 1 -or $script:delays.Count -ne 1){throw 'unknown process custody was retried'}

$source=New-Source 'changed-in-probe';$destination=$source+'-moved';$script:calls=0;$script:delays.Clear()
Expect-MoveFailure { Move-RollbackOwnedDirectory -ProcessProbe {New-Item -ItemType Directory -Path $destination | Out-Null;return @()} -Source $source -Destination $destination -MoveDirectory {param($s,$d) $script:calls++;throw (Locked)} -Context 'fixture probe collision' } 'access-denied fixture'
if($script:calls -ne 1 -or $script:delays.Count -ne 1 -or -not (Test-Path -LiteralPath $destination)){throw 'process probe changed topology without revoking retry'}

$source=New-Source 'no-probe';$destination=$source+'-moved';$script:calls=0;$script:delays.Clear()
Expect-MoveFailure { Move-RollbackOwnedDirectory -Source $source -Destination $destination -MoveDirectory {param($s,$d) $script:calls++;throw (Locked)} -Context 'fixture no probe' } 'access-denied fixture'
if($script:calls -ne 1 -or $script:delays.Count -ne 0){throw 'missing process proof was retried'}
'rollback move guards passed'
`, 'utf8');
      const result = spawnSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', harness], {
        encoding: 'utf8', windowsHide: true, timeout: 30_000, cwd: repoRoot
      });
      expect(result.status, result.stderr + '\n' + result.stdout).toBe(0);
      expect(result.stdout).toContain('rollback move guards passed');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it.each(['powershell.exe', ...(spawnSync('pwsh.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', 'exit 0'], { windowsHide: true }).status === 0 ? ['pwsh.exe'] : [])])('blocks older rollback readers on new or unreadable custody in every bounded account namespace in %s', (shell) => {
    const root = mkdtempSync(path.join(tmpdir(), 'cos-rollback-state-'));
    try {
      const harness = path.join(root, 'state.ps1');
      writeFileSync(harness, String.raw`
$ErrorActionPreference = 'Stop'
. __INSTALL_SCRIPT__
$root = __FIXTURE_ROOT__
$store = Join-Path $root 'canonical'
$state = Join-Path $store 'state'
New-Item -ItemType Directory -Path $state -Force | Out-Null
$ledger = Join-Path $state 'bridge-commands.json'
function Save-Ledger([string]$Json) { [IO.File]::WriteAllText($ledger, $Json, [Text.UTF8Encoding]::new($false)) }
function Expect-StateFailure([scriptblock]$Action, [string]$Needle = '') {
  try { & $Action | Out-Null; throw 'EXPECTED_STATE_FAILURE_MISSING' }
  catch { if ($_.Exception.Message -notlike '*Rollback state compatibility*' -or ($Needle -and $_.Exception.Message -notlike ('*'+$Needle+'*'))) { throw } }
}
Assert-LegacyRollbackStateCompatible -UserDataRoot (Join-Path $root 'absent')
foreach ($version in 1..6) {
  Save-Ledger ('{"version":' + $version + ',"commands":[]}')
  Assert-LegacyRollbackStateCompatible -UserDataRoot $store
}
Save-Ledger '{"version":6,"commands":[],"recoveryClaims":[],"repairTurnBudgets":[]}'
Assert-LegacyRollbackStateCompatible -UserDataRoot $store
foreach ($json in @('{', 'null', '[]', '[{"version":6,"commands":[]}]', '{}', '{"version":7,"commands":[]}', '{"version":6,"commands":{}}',
  '{"version":6,"commands":[],"recoveryClaims":null}', '{"version":6,"commands":[],"repairTurnBudgets":{}}',
  '{"version":6,"commands":[],"recoveryClaims":[{"token":"retained"}]}',
  '{"version":6,"commands":[],"repairTurnBudgets":[{"retry":true}]}')) {
  Save-Ledger $json
  $before = Get-FileHashHex -Path $ledger
  Expect-StateFailure { Assert-LegacyRollbackStateCompatible -UserDataRoot $store }
  if ((Get-FileHashHex -Path $ledger) -cne $before) { throw 'state guard rewrote retained custody' }
}
[IO.File]::WriteAllBytes($ledger, [byte[]]@(255))
Expect-StateFailure { Assert-LegacyRollbackStateCompatible -UserDataRoot $store }
Save-Ledger '{"version":6,"commands":[]}'
$locked = [IO.File]::Open($ledger, [IO.FileMode]::Open, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
try { Expect-StateFailure { Assert-LegacyRollbackStateCompatible -UserDataRoot $store } } finally { $locked.Dispose() }
$large = [IO.File]::OpenWrite($ledger)
try { $large.SetLength(64MB + 1) } finally { $large.Dispose() }
Expect-StateFailure { Assert-LegacyRollbackStateCompatible -UserDataRoot $store }
Save-Ledger '{"version":6,"commands":[]}'
$profileRoot = Join-Path $store 'instances\profile-retained'
New-Item -ItemType Directory -Path (Join-Path $profileRoot 'runtime') -Force | Out-Null
$deviceId = '00000000-0000-4000-8000-000000000001'
function New-StateProfile([string]$Id, [string]$Mode, [string]$StateRoot, [string]$Queue, [int]$Port) {
  return @{schemaVersion=1;id=$Id;displayName=$Id;platform='win32';deviceId=$deviceId;accountLabel=$Id;enabled=$true;
    state=@{mode=$Mode;root=$StateRoot};bridge=@{host='127.0.0.1';port=$Port};connector=@{identity=$Id;legacyNames=($Mode -eq 'legacy')};
    tunnelProfileRef=$Id;browser=@{profileId=$Id;profileDirectory=$Id;family='chrome';electronPartition=$Id};
    namespaces=@{sessions=('sessions-'+$Id);queue=$Queue;logs=('logs-'+$Id);health=('health-'+$Id)};approvedFolders=@();projects=@()}
}
$legacy = New-StateProfile 'default' 'legacy' $store 'legacy' 8765
$isolated = New-StateProfile 'profile-retained' 'isolated' $profileRoot 'queue-retained' 8766
$registry = @{schemaVersion=1;activeInstanceId='default';profiles=@($legacy,$isolated)}
function Save-Registry { [IO.File]::WriteAllText((Join-Path $store 'config.json'), (@{instances=$registry}|ConvertTo-Json -Depth 20), [Text.UTF8Encoding]::new($false)) }
Save-Registry
[IO.File]::WriteAllText((Join-Path $store 'device-identity.json'), (@{schemaVersion=1;id=$deviceId;platform='win32';createdAt='2026-01-01T00:00:00.000Z'}|ConvertTo-Json), [Text.UTF8Encoding]::new($false))
# This is the actual deriveInstanceOwnerPaths -> initDurableStore path, not Electron runtime/state.
$profile = Join-Path $profileRoot 'namespaces\queue\queue-retained\state'
New-Item -ItemType Directory -Path $profile -Force | Out-Null
$profileLedger = Join-Path $profile 'bridge-commands.json'
[IO.File]::WriteAllText($profileLedger, '{"version":6,"commands":[],"recoveryClaims":[{}]}', [Text.UTF8Encoding]::new($false))
Expect-StateFailure { Assert-LegacyRollbackStateCompatible -UserDataRoot $store }
[IO.File]::WriteAllText($profileLedger, '{"version":6,"commands":[],"repairTurnBudgets":[{}]}', [Text.UTF8Encoding]::new($false))
Expect-StateFailure { Assert-LegacyRollbackStateCompatible -UserDataRoot $store }
[IO.File]::WriteAllText($profileLedger, '{"version":6,"commands":[],"recoveryClaims":[],"repairTurnBudgets":[]}', [Text.UTF8Encoding]::new($false))
Assert-LegacyRollbackStateCompatible -UserDataRoot $store
# Registered roots are owner paths, not hardcoded profile-ID or Electron-runtime folders.
$customRoot = Join-Path $store 'instances\custom-group\account-data'
$custom = New-StateProfile 'profile-custom' 'isolated' $customRoot 'custom-queue' 8767
$custom.enabled = $false # Disabled accounts still retain possible action custody.
$registry.profiles += $custom
foreach ($index in 1..4) {
  $extra = New-StateProfile ('profile-extra-'+$index) 'isolated' (Join-Path $store ('instances\owner-'+$index)) ('queue-extra-'+$index) (8767+$index)
  $registry.profiles += $extra
}
Save-Registry
foreach ($owner in $registry.profiles | Where-Object {$_.state.mode -eq 'isolated'}) {
  $queueState = Join-Path $owner.state.root ('namespaces\queue\'+$owner.namespaces.queue+'\state')
  New-Item -ItemType Directory -Path $queueState -Force | Out-Null
  $queueLedger = Join-Path $queueState 'bridge-commands.json'
  if (-not (Test-Path -LiteralPath $queueLedger)) { [IO.File]::WriteAllText($queueLedger, '{"version":6,"commands":[]}', [Text.UTF8Encoding]::new($false)) }
}
Assert-LegacyRollbackStateCompatible -UserDataRoot $store
$customLedger = Join-Path $customRoot 'namespaces\queue\custom-queue\state\bridge-commands.json'
[IO.File]::WriteAllText($customLedger, '{"version":6,"commands":[],"repairTurnBudgets":[{}]}', [Text.UTF8Encoding]::new($false))
Expect-StateFailure { Assert-LegacyRollbackStateCompatible -UserDataRoot $store }
[IO.File]::WriteAllText($customLedger, '{"version":6,"commands":[]}', [Text.UTF8Encoding]::new($false))
$legacyQueueState = Join-Path $store 'namespaces\queue\legacy\state'
New-Item -ItemType Directory -Path $legacyQueueState -Force | Out-Null
$legacyQueueLedger = Join-Path $legacyQueueState 'bridge-commands.json'
[IO.File]::WriteAllText($legacyQueueLedger, '{"version":6,"commands":[],"recoveryClaims":[{}]}', [Text.UTF8Encoding]::new($false))
Expect-StateFailure { Assert-LegacyRollbackStateCompatible -UserDataRoot $store }
[IO.File]::WriteAllText($legacyQueueLedger, '{"version":6,"commands":[]}', [Text.UTF8Encoding]::new($false))
Assert-LegacyRollbackStateCompatible -UserDataRoot $store
$configPath = Join-Path $store 'config.json'; $configBytes = [IO.File]::ReadAllBytes($configPath)
# Session custody lives under the registered SESSION namespace, separately from queue state.
$sessionId = '2026-10-28-aabbccdd'
$conversationId = '11111111-1111-4111-8111-111111111111'
$sessionOwner = Join-Path $profileRoot ('namespaces\sessions\'+$isolated.namespaces.sessions+'\sessions\'+$sessionId)
New-Item -ItemType Directory -Path $sessionOwner -Force | Out-Null
$scopeA = @{version=1;profileId=$isolated.id;sessionId=$sessionId;conversationId=$conversationId;documentId='document-a';navigationEpoch=0;
  observedAt=1700000000000;reason='open-call';calls=1;codeCalls=0;openCalls=1;openCodeCalls=0;
  sourceUserMessageId='22222222-2222-4222-8222-222222222222';openRequestIds=@('request-a');coreCallMessageIds=@('native-a');
  allCoreRequestIds=@('request-a');codeCallMessageIds=@();openCodeCallMessageIds=@()}
$scopeB = @{documentId='document-b';navigationEpoch=1;observedAt=1700000001000;turnId='turn-b';
  sourceUserMessageId='33333333-3333-4333-8333-333333333333';reason='associated';calls=1;codeCalls=0;openCalls=0;openCodeCalls=0;
  settledFinalMessageId='44444444-4444-4444-8444-444444444444';openRequestIds=@();coreCallMessageIds=@('native-b');allCoreRequestIds=@('request-b');
  codeCallMessageIds=@();openCodeCallMessageIds=@();answeredCodeCallMessageIds=@()}
$scopeSlot = @{profileId=$isolated.id;sessionId=$sessionId;conversationId=$conversationId;fence=$scopeA;retiredObservedAt=$null;clearedFence=$null;clearedAt=$null;observations=@($scopeB)}
$v2 = @{version=2;slots=@{$conversationId=$scopeSlot}}
$v1Empty = @{version=1;slots=@{}}
function Write-SessionMeta([string]$Directory,[string]$Name,$Checkpoint,[string]$Id=$sessionId) {
  $summary = @{id=$Id;title='Compatibility fixture';conversationId=$conversationId}
  if ($null -ne $Checkpoint) { $summary.__nativeCompletionFences=$Checkpoint }
  [IO.File]::WriteAllText((Join-Path $Directory $Name), ($summary|ConvertTo-Json -Depth 20), [Text.UTF8Encoding]::new($false))
}
Write-SessionMeta $sessionOwner 'meta.json' $v2
Write-SessionMeta $sessionOwner 'meta.backup.json' $v1Empty
Expect-StateFailure { Assert-LegacyRollbackStateCompatible -UserDataRoot $store }
# A newer backup is custody even when the older primary is individually readable.
Write-SessionMeta $sessionOwner 'meta.json' $v1Empty
Write-SessionMeta $sessionOwner 'meta.backup.json' $v2
Expect-StateFailure { Assert-LegacyRollbackStateCompatible -UserDataRoot $store }
$v1Slot = $scopeSlot.Clone(); $v1Slot.Remove('observations')
foreach ($private in @(@{version=1;slots=@{$conversationId=$v1Slot}}, @{version=2;slots=@{}}, @{version=3;slots=@{}}, @{version=1;slots=@()}, @{version=1;slots=@{};unknown='custody'})) {
  Write-SessionMeta $sessionOwner 'meta.json' $private
  Write-SessionMeta $sessionOwner 'meta.backup.json' $v1Empty
  Expect-StateFailure { Assert-LegacyRollbackStateCompatible -UserDataRoot $store }
}
foreach ($name in @('meta.json','meta.backup.json')) {
  Write-SessionMeta $sessionOwner 'meta.json' $v1Empty
  Write-SessionMeta $sessionOwner 'meta.backup.json' $v1Empty
  [IO.File]::Delete((Join-Path $sessionOwner $name))
  Expect-StateFailure { Assert-LegacyRollbackStateCompatible -UserDataRoot $store }
  [IO.File]::WriteAllText((Join-Path $sessionOwner $name), '{', [Text.UTF8Encoding]::new($false))
  Expect-StateFailure { Assert-LegacyRollbackStateCompatible -UserDataRoot $store }
}
Write-SessionMeta $sessionOwner 'meta.json' $v1Empty
Write-SessionMeta $sessionOwner 'meta.backup.json' $v1Empty
$locked = [IO.File]::Open((Join-Path $sessionOwner 'meta.backup.json'), [IO.FileMode]::Open, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
try { Expect-StateFailure { Assert-LegacyRollbackStateCompatible -UserDataRoot $store } } finally { $locked.Dispose() }
Write-SessionMeta $sessionOwner 'meta.json' $null '2026-10-28-foreign0'
Expect-StateFailure { Assert-LegacyRollbackStateCompatible -UserDataRoot $store }
Write-SessionMeta $sessionOwner 'meta.json' $null
Write-SessionMeta $sessionOwner 'meta.backup.json' $null
Assert-LegacyRollbackStateCompatible -UserDataRoot $store
# Legacy metadata, deleted recovery, and direct late-metadata retain the same pair contract.
$legacySession = Join-Path $store ('sessions\'+$sessionId)
$deletedSession = Join-Path (Split-Path -Parent $sessionOwner) ('.deleted-sessions\'+$sessionId)
$lateSession = Join-Path $sessionOwner '.late-metadata-55555555-5555-4555-8555-555555555555'
$deletedLate = Join-Path $deletedSession '.late-metadata-66666666-6666-4666-8666-666666666666'
foreach ($directory in @($legacySession,$deletedSession,$lateSession,$deletedLate)) {
  [IO.Directory]::CreateDirectory($directory) | Out-Null
  Write-SessionMeta $directory 'meta.json' $v2
  Write-SessionMeta $directory 'meta.backup.json' $v1Empty
  Expect-StateFailure { Assert-LegacyRollbackStateCompatible -UserDataRoot $store }
  Write-SessionMeta $directory 'meta.json' $null
  Write-SessionMeta $directory 'meta.backup.json' $null
}
$events = Join-Path $sessionOwner 'events.jsonl'; [IO.File]::WriteAllText($events, 'history is not part of this metadata-only check')
$lockedHistory = [IO.File]::Open($events, [IO.FileMode]::Open, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
try { Assert-LegacyRollbackStateCompatible -UserDataRoot $store } finally { $lockedHistory.Dispose() }
$unknownSession = Join-Path (Split-Path -Parent $sessionOwner) 'unknown-owner!'; [IO.Directory]::CreateDirectory($unknownSession) | Out-Null
Expect-StateFailure { Assert-LegacyRollbackStateCompatible -UserDataRoot $store }
[IO.Directory]::Delete($unknownSession)
$unknownNamespace = Join-Path $profileRoot 'namespaces\sessions\unknown-session-namespace'; [IO.Directory]::CreateDirectory($unknownNamespace) | Out-Null
Expect-StateFailure { Assert-LegacyRollbackStateCompatible -UserDataRoot $store }
[IO.Directory]::Delete($unknownNamespace)
$heldMeta = Join-Path $root 'held-meta.json'; $metaPath = Join-Path $sessionOwner 'meta.json'; [IO.File]::Move($metaPath,$heldMeta)
New-Item -ItemType HardLink -Path $metaPath -Target $heldMeta | Out-Null
# Hard links are regular files; unlike a junction they do not redirect parent traversal.
Assert-LegacyRollbackStateCompatible -UserDataRoot $store
[IO.File]::Delete($metaPath); [IO.File]::Move($heldMeta,$metaPath)
$heldSession = Join-Path $root 'held-session'; [IO.Directory]::Move($legacySession,$heldSession)
New-Item -ItemType Junction -Path $legacySession -Target $heldSession | Out-Null
try { Expect-StateFailure { Assert-LegacyRollbackStateCompatible -UserDataRoot $store } } finally { [IO.Directory]::Delete($legacySession);[IO.Directory]::Move($heldSession,$legacySession) }
$large = [IO.File]::OpenWrite($metaPath); try { $large.SetLength(8MB+1) } finally { $large.Dispose() }
Expect-StateFailure { Assert-LegacyRollbackStateCompatible -UserDataRoot $store } 'capacity'
Write-SessionMeta $sessionOwner 'meta.json' $null
$budgetOwners = [Collections.Generic.List[string]]::new()
foreach ($index in 1..5) {
  $id = 'budget-owner-'+$index; $directory = Join-Path $store ('sessions\'+$id)
  [IO.Directory]::CreateDirectory($directory) | Out-Null; $budgetOwners.Add($directory)
  $bytes = '{"id":"'+$id+'"}'+(' '*7MB)
  foreach ($name in @('meta.json','meta.backup.json')) { [IO.File]::WriteAllText((Join-Path $directory $name),$bytes,[Text.UTF8Encoding]::new($false)) }
}
Expect-StateFailure { Assert-LegacyRollbackStateCompatible -UserDataRoot $store } 'capacity'
foreach ($directory in $budgetOwners) { foreach ($name in @('meta.json','meta.backup.json')) {[IO.File]::Delete((Join-Path $directory $name))};[IO.Directory]::Delete($directory) }
$capacityRoot = Join-Path $customRoot ('namespaces\sessions\'+$custom.namespaces.sessions+'\sessions'); [IO.Directory]::CreateDirectory($capacityRoot) | Out-Null
foreach ($index in 1..5001) { [IO.Directory]::CreateDirectory((Join-Path $capacityRoot ('capacity-owner-'+$index))) | Out-Null }
Expect-StateFailure { Assert-LegacyRollbackStateCompatible -UserDataRoot $store } 'capacity'
foreach ($index in 1..5001) { [IO.Directory]::Delete((Join-Path $capacityRoot ('capacity-owner-'+$index))) }
Assert-LegacyRollbackStateCompatible -UserDataRoot $store
[IO.File]::WriteAllText($configPath, ('['+[Text.UTF8Encoding]::new($false,$true).GetString($configBytes)+']'), [Text.UTF8Encoding]::new($false))
Expect-StateFailure { Assert-LegacyRollbackStateCompatible -UserDataRoot $store }
foreach ($invalidConfig in @('{','null','{"instances":null}','{"instances":{}}')) {
  [IO.File]::WriteAllText($configPath, $invalidConfig, [Text.UTF8Encoding]::new($false))
  Expect-StateFailure { Assert-LegacyRollbackStateCompatible -UserDataRoot $store }
}
[IO.File]::Delete($configPath)
Expect-StateFailure { Assert-LegacyRollbackStateCompatible -UserDataRoot $store }
[IO.File]::WriteAllBytes($configPath,$configBytes)
$deviceFile = Join-Path $store 'device-identity.json'; $deviceBytes = [IO.File]::ReadAllBytes($deviceFile)
[IO.File]::Delete($deviceFile)
Expect-StateFailure { Assert-LegacyRollbackStateCompatible -UserDataRoot $store }
[IO.File]::WriteAllBytes($deviceFile,$deviceBytes)
$isolated.namespaces.queue = '../wrong'; Save-Registry
Expect-StateFailure { Assert-LegacyRollbackStateCompatible -UserDataRoot $store }
$isolated.namespaces.queue = 'queue-retained'; $isolated.state.root = Join-Path $root 'outside-owner'; Save-Registry
Expect-StateFailure { Assert-LegacyRollbackStateCompatible -UserDataRoot $store }
$isolated.state.root = $profileRoot; Save-Registry
$unknownQueue = Join-Path $profileRoot 'namespaces\queue\queue-unknown'; New-Item -ItemType Directory -Path $unknownQueue | Out-Null
Expect-StateFailure { Assert-LegacyRollbackStateCompatible -UserDataRoot $store }
[IO.Directory]::Delete($unknownQueue)
$heldQueue = Join-Path $root 'held-queue'; $queueRoot = Split-Path -Parent $profile
[IO.Directory]::Move($queueRoot,$heldQueue)
New-Item -ItemType Junction -Path $queueRoot -Target $heldQueue | Out-Null
try { Expect-StateFailure { Assert-LegacyRollbackStateCompatible -UserDataRoot $store } } finally { [IO.Directory]::Delete($queueRoot);[IO.Directory]::Move($heldQueue,$queueRoot) }
$external = Join-Path $root 'external'; New-Item -ItemType Directory -Path $external | Out-Null
$junction = Join-Path $store 'instances\profile-linked'
New-Item -ItemType Junction -Path $junction -Target $external | Out-Null
try { Expect-StateFailure { Assert-LegacyRollbackStateCompatible -UserDataRoot $store } } finally { [IO.Directory]::Delete($junction) }
$invalid = Join-Path $store 'instances\unknown-owner'; New-Item -ItemType Directory -Path $invalid | Out-Null
Expect-StateFailure { Assert-LegacyRollbackStateCompatible -UserDataRoot $store }
[IO.Directory]::Delete($invalid)
$retainedProfiles = $registry.profiles; $registry.profiles = @(1..33 | ForEach-Object {$isolated}); Save-Registry
Expect-StateFailure { Assert-LegacyRollbackStateCompatible -UserDataRoot $store }
$registry.profiles = $retainedProfiles; Save-Registry
# Default inspection must use the canonical app namespace, never the current checkout.
$env:APPDATA = Join-Path $root 'roaming'
$defaultState = Join-Path $env:APPDATA 'chat-on-steroids\state'
New-Item -ItemType Directory -Path $defaultState -Force | Out-Null
[IO.File]::WriteAllText((Join-Path $defaultState 'bridge-commands.json'), '{"version":6,"commands":[],"recoveryClaims":[{}]}', [Text.UTF8Encoding]::new($false))
Expect-StateFailure { Assert-LegacyRollbackStateCompatible }
$script:launches = 0
Expect-StateFailure { Invoke-RollbackSuccessor -InstalledApp 'unused.exe' -Version '2.1.13' -SuccessorLauncher { $script:launches++ } }
if ($script:launches -ne 0) { throw 'older reader launched with unknown custody' }
'rollback state compatibility passed'
`.replaceAll('__INSTALL_SCRIPT__', ps(installScript)).replaceAll('__FIXTURE_ROOT__', ps(root)), 'utf8');
      const result = spawnSync(shell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', harness], {
        encoding: 'utf8', windowsHide: true, timeout: 30_000, cwd: repoRoot
      });
      expect(result.status, shell + '\n' + result.stderr + '\n' + result.stdout).toBe(0);
      expect(result.stdout).toContain('rollback state compatibility passed');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('restores only an explicitly requested verified rollback tree and recovers failed swaps', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'cos-rollback-transaction-'));
    try {
      const harness = path.join(root, 'rollback.ps1');
      writeFileSync(harness, `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression.FileSystem
. ${ps(installScript)}
$root = ${ps(root)}
$env:APPDATA = Join-Path $root 'fixture-roaming'
$userData = Join-Path $env:APPDATA 'chat-on-steroids'
New-Item -ItemType Directory -Path (Join-Path $userData 'state') -Force | Out-Null
[IO.File]::WriteAllText((Join-Path $userData 'keep.txt'),'keep-user-data',[Text.UTF8Encoding]::new($false))
$source = Join-Path $root 'baseline-source'
$resources = Join-Path $source 'resources'
$extension = Join-Path $resources 'extension'
New-Item -ItemType Directory -Path $extension -Force | Out-Null
Copy-Item -LiteralPath (Join-Path $env:SystemRoot 'System32\\cmd.exe') -Destination (Join-Path $source 'Chat On Steroids.exe')
[IO.File]::WriteAllText((Join-Path $resources 'app.asar'), 'exact-old-asar', [Text.UTF8Encoding]::new($false))
[IO.File]::WriteAllText((Join-Path $extension 'background.js'), 'exact-old-companion', [Text.UTF8Encoding]::new($false))
[IO.File]::WriteAllText((Join-Path $extension 'manifest.json'), '{"version":"2.1.13"}', [Text.UTF8Encoding]::new($false))
[IO.File]::WriteAllText((Join-Path $resources 'CUSTOM_BUILD'), 'test custom build', [Text.UTF8Encoding]::new($false))
[IO.File]::WriteAllText((Join-Path $source 'extra.dat'), 'frozen extra bytes', [Text.UTF8Encoding]::new($false))
$fingerprint = Get-DirectoryFingerprint -Root $source
$exe = Get-Item -LiteralPath (Join-Path $source 'Chat On Steroids.exe')
$archive = Join-Path $root 'private-2.1.13-program.zip'
[IO.Compression.ZipFile]::CreateFromDirectory($source, $archive, [IO.Compression.CompressionLevel]::Optimal, $false)
$baseline = [pscustomobject]@{
  Version='2.1.13'; ArchiveDirectory='unused'; ArchiveFile='private-2.1.13-program.zip'; ArchiveSize=[int64](Get-Item -LiteralPath $archive).Length; ArchiveSha256=(Get-FileHashHex -Path $archive);
  FileCount=$fingerprint.FileCount; TotalBytes=[int64]$fingerprint.TotalBytes; TreeSha256=$fingerprint.TreeSha256;
  FileVersion=$exe.VersionInfo.FileVersion; ProductVersion=$exe.VersionInfo.ProductVersion; ExeSha256=(Get-FileHashHex -Path $exe.FullName);
  AppAsarSha256=(Get-FileHashHex -Path (Join-Path $resources 'app.asar')); BundledMainSha256='fixture'; ExtensionVersion='2.1.13';
  ExtensionBackgroundSha256=(Get-FileHashHex -Path (Join-Path $extension 'background.js')); CustomBuildText='test custom build'
}

function Expect-Failure([scriptblock]$Action, [string]$Needle) {
  $failure=$null
  try { & $Action } catch { $failure=$_ }
  if($null -eq $failure){throw "expected failure containing: $Needle"}
  if($failure.Exception.Message -notlike "*$Needle*"){throw $failure}
}
$falseSuccessRejected=$false
try { Expect-Failure { } 'no actual failure' } catch { $falseSuccessRejected=$true }
if(-not $falseSuccessRejected){throw 'Expect-Failure accepted an action that did not fail'}
function Copy-Tree([string]$From, [string]$To) { Copy-Item -LiteralPath $From -Destination $To -Recurse -Force }
function New-Current([string]$Path, [string]$Marker) {
  New-Item -ItemType Directory -Path $Path -Force | Out-Null
  [IO.File]::WriteAllText((Join-Path $Path 'newer.txt'), $Marker, [Text.UTF8Encoding]::new($false))
}

# The exact frozen artifact and extracted tree are accepted.
$proof = Assert-RollbackArchive -ArchivePath $archive -Baseline $baseline
$extract = Join-Path $root 'accepted-extract'
Expand-RollbackArchive -ArchivePath $archive -Destination $extract
$accepted = Assert-RollbackTree -Root $extract -Baseline $baseline
if ($accepted.TreeSha256 -ne $baseline.TreeSha256) { throw 'exact rollback tree was not accepted' }

# Archive entries are validated before the staging directory is created. Traversal, absolute
# paths and link/reparse metadata all fail without materializing anything outside the target.
function New-UnsafeZip([string]$Path,[string]$EntryName,[int]$ExternalAttributes=0) {
  $stream=[IO.File]::Open($Path,[IO.FileMode]::Create,[IO.FileAccess]::Write,[IO.FileShare]::None)
  $zip=[IO.Compression.ZipArchive]::new($stream,[IO.Compression.ZipArchiveMode]::Create,$false)
  try {
    $entry=$zip.CreateEntry($EntryName)
    if($ExternalAttributes -ne 0){$entry.ExternalAttributes=$ExternalAttributes}
    $writer=[IO.StreamWriter]::new($entry.Open())
    try{$writer.Write('unsafe')}finally{$writer.Dispose()}
  } finally { $zip.Dispose(); $stream.Dispose() }
}
$unsafeRoot=Join-Path $root 'unsafe-zips'; New-Item -ItemType Directory -Path $unsafeRoot | Out-Null
$zipPath=Join-Path $unsafeRoot 'traversal.zip'; New-UnsafeZip $zipPath '../escape.txt'; $dest=Join-Path $root 'traversal-stage'; Expect-Failure { Expand-RollbackArchive -ArchivePath $zipPath -Destination $dest } 'unsafe path'; if(Test-Path -LiteralPath $dest){throw 'traversal archive created staging content'}; if(Test-Path -LiteralPath (Join-Path $root 'escape.txt')){throw 'traversal archive escaped staging'}
$zipPath=Join-Path $unsafeRoot 'absolute.zip'; New-UnsafeZip $zipPath 'C:/escape.txt'; $dest=Join-Path $root 'absolute-stage'; Expect-Failure { Expand-RollbackArchive -ArchivePath $zipPath -Destination $dest } 'absolute or drive-relative'; if(Test-Path -LiteralPath $dest){throw 'absolute archive created staging content'}
$zipPath=Join-Path $unsafeRoot 'reparse.zip'; New-UnsafeZip $zipPath 'link' -1610612736; $dest=Join-Path $root 'reparse-stage'; Expect-Failure { Expand-RollbackArchive -ArchivePath $zipPath -Destination $dest } 'link/reparse'; if(Test-Path -LiteralPath $dest){throw 'reparse archive created staging content'}

# Same-size archive tamper is rejected by the pinned artifact hash.
$tamperDir = Join-Path $root 'tamper'
New-Item -ItemType Directory -Path $tamperDir | Out-Null
$tampered = Join-Path $tamperDir $baseline.ArchiveFile
Copy-Item -LiteralPath $archive -Destination $tampered
$stream=[IO.File]::Open($tampered,[IO.FileMode]::Open,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None)
try { $stream.Position=128; $value=$stream.ReadByte(); $stream.Position=128; $stream.WriteByte(($value -bxor 1)) } finally { $stream.Dispose() }
Expect-Failure { Assert-RollbackArchive -ArchivePath $tampered -Baseline $baseline } 'SHA-256 mismatch'

# Key installed identities fail independently before a tree can be reported exact.
$wrong = Join-Path $root 'wrong-appasar'; Copy-Tree $source $wrong; [IO.File]::AppendAllText((Join-Path $wrong 'resources\\app.asar'),'x'); Expect-Failure { Assert-RollbackTree -Root $wrong -Baseline $baseline } 'app.asar hash mismatch'
$wrong = Join-Path $root 'wrong-companion'; Copy-Tree $source $wrong; [IO.File]::AppendAllText((Join-Path $wrong 'resources\\extension\\background.js'),'x'); Expect-Failure { Assert-RollbackTree -Root $wrong -Baseline $baseline } 'companion hash mismatch'
$wrong = Join-Path $root 'wrong-version'; Copy-Tree $source $wrong; [IO.File]::WriteAllText((Join-Path $wrong 'resources\\extension\\manifest.json'),'{"version":"2.1.14"}',[Text.UTF8Encoding]::new($false)); Expect-Failure { Assert-RollbackTree -Root $wrong -Baseline $baseline } 'companion version mismatch'
$wrong = Join-Path $root 'wrong-marker'; Copy-Tree $source $wrong; [IO.File]::WriteAllText((Join-Path $wrong 'resources\\CUSTOM_BUILD'),'wrong',[Text.UTF8Encoding]::new($false)); Expect-Failure { Assert-RollbackTree -Root $wrong -Baseline $baseline } 'CUSTOM_BUILD marker mismatch'
$badVersion = $baseline.PSObject.Copy(); $badVersion.FileVersion='0.0.0'; Expect-Failure { Assert-RollbackTree -Root $source -Baseline $badVersion } 'FileVersion mismatch'

# Exercise the actual transaction's default native directory mover with a real Windows child
# file handle that forbids deletion. Release ONLY when the retry delay is reached; no retry or
# successful promotion may be inferred from a mocked Move-Item exception.
$nativeCurrent=Join-Path $root 'Native Locked App';New-Current $nativeCurrent 'locked-before-rollback'
$script:nativeHandle=[IO.File]::Open((Join-Path $nativeCurrent 'newer.txt'),[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read)
$script:nativeRetryDelays=[Collections.Generic.List[int]]::new()
function Start-Sleep {param([int]$Milliseconds) $script:nativeRetryDelays.Add($Milliseconds);$script:nativeHandle.Dispose()}
try {
  $nativeRestored=Invoke-ExplicitRollbackTransaction -RollbackArchivePath $archive -InstallRoot $nativeCurrent -ProcessProbe {return @()} -SleepAction {} -SuccessorLauncher {param($p)} -Baseline $baseline
} finally {$script:nativeHandle.Dispose();Remove-Item Function:\\Start-Sleep}
$nativePaths=Get-RollbackTransactionPaths -InstallRoot $nativeCurrent
if($nativeRestored.TreeSha256 -cne $baseline.TreeSha256 -or ($script:nativeRetryDelays -join ',') -cne '100' -or (Test-Path -LiteralPath $nativePaths.Marker) -or (Test-Path -LiteralPath $nativePaths.Stage) -or (Test-Path -LiteralPath $nativePaths.Quarantine)){throw 'real default-mover lock retry did not complete one exact transaction'}

# Staging failure occurs before process probing and leaves the simulated current install intact.
$current = Join-Path $root 'Current App'
New-Current $current 'newer-before-stage-failure'
$probeCalls=0; $successorCalls=0
Expect-Failure {
  Invoke-ExplicitRollbackTransaction -RollbackArchivePath $archive -InstallRoot $current -ProcessProbe { $script:probeCalls += 1; return @() } -SleepAction { } -SuccessorLauncher { param($path) $script:successorCalls += 1 } -Baseline $baseline -ArchiveExtractor { param($a,$d) throw 'synthetic extract interruption' }
} 'staging failed'
if ($probeCalls -ne 0) { throw 'process probe ran before failed staging completed' }
if ((Get-Content -Raw -LiteralPath (Join-Path $current 'newer.txt')) -ne 'newer-before-stage-failure') { throw 'staging failure changed current install' }
$paths=Get-RollbackTransactionPaths -InstallRoot $current
if((Test-Path -LiteralPath $paths.Marker) -or (Test-Path -LiteralPath $paths.Stage) -or (Test-Path -LiteralPath $paths.Quarantine)){throw 'clean staging failure left stale rollback evidence'}

# If extraction creates a partial stage and cleanup itself fails, the marker must remain so the
# next deliberate retry can identify and retire exactly that owned stage. Both causes are reported.
Remove-Item -LiteralPath $current -Recurse -Force; New-Current $current 'newer-before-stage-cleanup-failure'
$probeCalls=0;$successorCalls=0;$cleanupFailureMessage=$null
$partialExtractor={param($a,$d) New-Item -ItemType Directory -Path $d -Force | Out-Null;[IO.File]::WriteAllText((Join-Path $d 'partial.txt'),'partial',[Text.UTF8Encoding]::new($false));throw 'synthetic extract interruption with partial stage'}
$failingRemover={param($p) throw 'synthetic stage cleanup failure'}
try{
  Invoke-ExplicitRollbackTransaction -RollbackArchivePath $archive -InstallRoot $current -ProcessProbe { $script:probeCalls += 1; return @() } -SleepAction { } -SuccessorLauncher { param($p) $script:successorCalls += 1 } -Baseline $baseline -ArchiveExtractor $partialExtractor -RemoveDirectory $failingRemover | Out-Null
  throw 'expected stage cleanup failure'
}catch{$cleanupFailureMessage=$_.Exception.Message;if($cleanupFailureMessage -like '*expected stage cleanup failure*'){throw}}
if($cleanupFailureMessage -notlike '*synthetic extract interruption with partial stage*' -or $cleanupFailureMessage -notlike '*synthetic stage cleanup failure*'){throw "staging cleanup error lost a failure cause: $cleanupFailureMessage"}
$paths=Get-RollbackTransactionPaths -InstallRoot $current
if(-not (Test-Path -LiteralPath $paths.Marker -PathType Leaf) -or -not (Test-Path -LiteralPath $paths.Stage -PathType Container) -or (Test-Path -LiteralPath $paths.Quarantine)){throw 'failed stage cleanup did not retain truthful marker/stage evidence'}
if($probeCalls -ne 0 -or $successorCalls -ne 0){throw 'stage cleanup failure crossed process/successor boundary'}
if((Get-Content -Raw -LiteralPath (Join-Path $current 'newer.txt')) -ne 'newer-before-stage-cleanup-failure'){throw 'stage cleanup failure changed current install'}
$retrySuccessorCalls=0
$retried=Invoke-ExplicitRollbackTransaction -RollbackArchivePath $archive -InstallRoot $current -ProcessProbe { return @() } -SleepAction { } -SuccessorLauncher { param($p) $script:retrySuccessorCalls += 1 } -Baseline $baseline
if($retried.TreeSha256 -ne $baseline.TreeSha256 -or $retrySuccessorCalls -ne 1){throw 'retry did not converge from retained staging evidence'}
if((Test-Path -LiteralPath $paths.Marker) -or (Test-Path -LiteralPath $paths.Stage) -or (Test-Path -LiteralPath $paths.Quarantine)){throw 'retry left rollback evidence after retained-stage recovery'}

# A cleanup seam that returns success without deleting is also a cleanup failure; marker removal
# is forbidden until absence is actually proven.
Remove-Item -LiteralPath $current -Recurse -Force; New-Current $current 'newer-before-noop-cleanup'
$noopCleanupMessage=$null
try{
  Invoke-ExplicitRollbackTransaction -RollbackArchivePath $archive -InstallRoot $current -ProcessProbe { return @() } -SleepAction { } -SuccessorLauncher { param($p) } -Baseline $baseline -ArchiveExtractor $partialExtractor -RemoveDirectory { param($p) } | Out-Null
  throw 'expected no-op cleanup failure'
}catch{$noopCleanupMessage=$_.Exception.Message;if($noopCleanupMessage -like '*expected no-op cleanup failure*'){throw}}
$paths=Get-RollbackTransactionPaths -InstallRoot $current
if($noopCleanupMessage -notlike '*returned without removing the owned path*' -or -not (Test-Path -LiteralPath $paths.Marker) -or -not (Test-Path -LiteralPath $paths.Stage)){throw "no-op cleanup was not retained as recoverable evidence: $noopCleanupMessage"}
$null=Invoke-ExplicitRollbackTransaction -RollbackArchivePath $archive -InstallRoot $current -ProcessProbe { return @() } -SleepAction { } -SuccessorLauncher { param($p) } -Baseline $baseline
if((Test-Path -LiteralPath $paths.Marker) -or (Test-Path -LiteralPath $paths.Stage) -or (Test-Path -LiteralPath $paths.Quarantine)){throw 'retry after no-op cleanup failure left rollback evidence'}

# The same invariant holds during restaging of an interrupted invalid stage: the old marker remains
# authoritative while the invalid stage is retired, and a second cleanup failure never hides it.
Remove-Item -LiteralPath $current -Recurse -Force; New-Current $current 'newer-before-restage-cleanup-failure'
$paths=Get-RollbackTransactionPaths -InstallRoot $current
Write-RollbackTransactionMarker -Paths $paths -Baseline $baseline
New-Item -ItemType Directory -Path $paths.Stage | Out-Null
[IO.File]::WriteAllText((Join-Path $paths.Stage 'invalid.txt'),'invalid interrupted stage',[Text.UTF8Encoding]::new($false))
$removeCalls=0;$restageMessage=$null
$restageRemover={param($p) $script:removeCalls += 1;if($script:removeCalls -eq 2){throw 'synthetic restage cleanup failure'};Remove-Item -LiteralPath $p -Recurse -Force}
try{
  Invoke-ExplicitRollbackTransaction -RollbackArchivePath $archive -InstallRoot $current -ProcessProbe { return @() } -SleepAction { } -SuccessorLauncher { param($p) } -Baseline $baseline -ArchiveExtractor $partialExtractor -RemoveDirectory $restageRemover | Out-Null
  throw 'expected restage cleanup failure'
}catch{$restageMessage=$_.Exception.Message;if($restageMessage -like '*expected restage cleanup failure*'){throw}}
if($restageMessage -notlike '*synthetic extract interruption with partial stage*' -or $restageMessage -notlike '*synthetic restage cleanup failure*'){throw "restage cleanup error lost a failure cause: $restageMessage"}
if(-not (Test-Path -LiteralPath $paths.Marker) -or -not (Test-Path -LiteralPath $paths.Stage)){throw 'restage cleanup failure hid its owned evidence'}
$restageRetry=Invoke-ExplicitRollbackTransaction -RollbackArchivePath $archive -InstallRoot $current -ProcessProbe { return @() } -SleepAction { } -SuccessorLauncher { param($p) } -Baseline $baseline
if($restageRetry.TreeSha256 -ne $baseline.TreeSha256){throw 'retry did not converge after restage cleanup failure'}
if((Test-Path -LiteralPath $paths.Marker) -or (Test-Path -LiteralPath $paths.Stage) -or (Test-Path -LiteralPath $paths.Quarantine)){throw 'restage retry left owned rollback evidence'}

Remove-Item -LiteralPath $current -Recurse -Force; New-Current $current 'newer-before-successful-rollback'

# A program-only rollback must not hand new action custody to an older reader.
$commandLedger=Join-Path $userData 'state\\bridge-commands.json'
foreach($newField in @('recoveryClaims','repairTurnBudgets')) {
  [IO.File]::WriteAllText($commandLedger, ('{"version":6,"commands":[],"'+$newField+'":[{}]}'), [Text.UTF8Encoding]::new($false))
  $heldHash=Get-FileHashHex -Path $commandLedger;$script:guardMoves=0;$script:guardLaunches=0
  Expect-Failure { Invoke-ExplicitRollbackTransaction -RollbackArchivePath $archive -InstallRoot $current -ProcessProbe {return @()} -SleepAction {} -SuccessorLauncher {$script:guardLaunches++} -Baseline $baseline -MoveDirectory {param($s,$d) $script:guardMoves++;[IO.Directory]::Move($s,$d)} } 'Rollback state compatibility'
  $paths=Get-RollbackTransactionPaths -InstallRoot $current
  if($script:guardMoves -ne 0 -or $script:guardLaunches -ne 0 -or (Get-FileHashHex -Path $commandLedger) -cne $heldHash -or -not (Test-Path -LiteralPath (Join-Path $current 'newer.txt')) -or (Test-Path -LiteralPath $paths.Quarantine)){throw 'custody refusal changed installed/user bytes or launched old code'}
  [IO.File]::WriteAllText($commandLedger, '{"version":6,"commands":[],"recoveryClaims":[],"repairTurnBudgets":[]}', [Text.UTF8Encoding]::new($false))
  $null=Invoke-ExplicitRollbackTransaction -RollbackArchivePath $archive -InstallRoot $current -UserDataRoot $userData -ProcessProbe {return @()} -SleepAction {} -SuccessorLauncher {} -Baseline $baseline
  Remove-Item -LiteralPath $current -Recurse -Force; New-Current $current 'newer-before-successful-rollback'
}
# Custody appearing during actual promotion retains quarantine and blocks launch.
$script:guardMoves=0;$script:guardLaunches=0
Expect-Failure { Invoke-ExplicitRollbackTransaction -RollbackArchivePath $archive -InstallRoot $current -UserDataRoot $userData -ProcessProbe {return @()} -SleepAction {} -SuccessorLauncher {$script:guardLaunches++} -Baseline $baseline -MoveDirectory {param($s,$d) $script:guardMoves++;[IO.Directory]::Move($s,$d);if($script:guardMoves -eq 2){[IO.File]::WriteAllText($commandLedger, '{"version":6,"commands":[],"recoveryClaims":[{}]}', [Text.UTF8Encoding]::new($false))}} } 'Rollback state compatibility'
$paths=Get-RollbackTransactionPaths -InstallRoot $current
if($script:guardLaunches -ne 0 -or -not (Test-Path -LiteralPath $paths.Quarantine) -or -not (Test-Path -LiteralPath $paths.Marker)){throw 'late custody did not retain rollback recovery evidence'}
# An interrupted promoted transaction applies the same guard before cleanup/reopen.
Expect-Failure { Invoke-ExplicitRollbackTransaction -RollbackArchivePath $archive -InstallRoot $current -UserDataRoot $userData -ProcessProbe {return @()} -SleepAction {} -SuccessorLauncher {$script:guardLaunches++} -Baseline $baseline } 'Rollback state compatibility'
if($script:guardLaunches -ne 0 -or -not (Test-Path -LiteralPath $paths.Quarantine) -or -not (Test-Path -LiteralPath $paths.Marker)){throw 'interrupted completion bypassed retained custody'}
[IO.File]::WriteAllText($commandLedger, '{"version":6,"commands":[],"recoveryClaims":[],"repairTurnBudgets":[]}', [Text.UTF8Encoding]::new($false))
$null=Invoke-ExplicitRollbackTransaction -RollbackArchivePath $archive -InstallRoot $current -UserDataRoot $userData -ProcessProbe {return @()} -SleepAction {} -SuccessorLauncher {} -Baseline $baseline
Remove-Item -LiteralPath $current -Recurse -Force; New-Current $current 'newer-before-successful-rollback'

# Successful explicit rollback stages once, swaps once, verifies, then launches once. User data is separate and untouched.
$extractCalls=0; $moveCalls=0; $successorCalls=0
$extractor = { param($a,$d) $script:extractCalls += 1; Expand-RollbackArchive -ArchivePath $a -Destination $d }
$mover = { param($s,$d) $script:moveCalls += 1; Move-Item -LiteralPath $s -Destination $d }
$restored = Invoke-ExplicitRollbackTransaction -RollbackArchivePath $archive -InstallRoot $current -ProcessProbe { return @() } -SleepAction { } -SuccessorLauncher { param($path) $script:successorCalls += 1 } -Baseline $baseline -ArchiveExtractor $extractor -MoveDirectory $mover
if ($extractCalls -ne 1) { throw "rollback archive extracted $extractCalls times" }
if ($moveCalls -ne 2) { throw "successful rollback used unexpected move count $moveCalls" }
if ($successorCalls -ne 1) { throw "successful rollback launched successor $successorCalls times" }
if ($restored.TreeSha256 -ne $baseline.TreeSha256) { throw 'restored rollback tree mismatch' }
if ((Get-Content -Raw -LiteralPath (Join-Path $userData 'keep.txt')) -ne 'keep-user-data') { throw 'rollback touched user data' }

# Once promotion is verified, quarantine cleanup must be proven before the marker disappears or a
# successor launches. A no-op cleanup keeps promoted+quarantine evidence recoverable for retry.
Remove-Item -LiteralPath $current -Recurse -Force; New-Current $current 'newer-before-committed-cleanup-failure'
$paths=Get-RollbackTransactionPaths -InstallRoot $current
$successorCalls=0;$committedCleanupMessage=$null
$noopQuarantineRemover={param($p) if($p -eq $paths.Quarantine){return};Remove-Item -LiteralPath $p -Recurse -Force}
try{
  Invoke-ExplicitRollbackTransaction -RollbackArchivePath $archive -InstallRoot $current -ProcessProbe { return @() } -SleepAction { } -SuccessorLauncher { param($p) $script:successorCalls += 1 } -Baseline $baseline -RemoveDirectory $noopQuarantineRemover | Out-Null
  throw 'expected committed quarantine cleanup failure'
}catch{$committedCleanupMessage=$_.Exception.Message;if($committedCleanupMessage -like '*expected committed quarantine cleanup failure*'){throw}}
if($committedCleanupMessage -notlike '*returned without removing the owned path*'){throw "committed cleanup did not prove quarantine absence: $committedCleanupMessage"}
if($successorCalls -ne 0 -or -not (Test-Path -LiteralPath $paths.Marker) -or -not (Test-Path -LiteralPath $paths.Quarantine) -or (Test-Path -LiteralPath $paths.Stage)){throw 'committed cleanup failure lost promoted rollback evidence or launched successor'}
$promotedExact=Assert-RollbackTree -Root $current -Baseline $baseline
if($promotedExact.TreeSha256 -ne $baseline.TreeSha256){throw 'committed cleanup failure damaged promoted exact rollback'}
$successorCalls=0
$finishedCommitted=Invoke-ExplicitRollbackTransaction -RollbackArchivePath $archive -InstallRoot $current -ProcessProbe { return @() } -SleepAction { } -SuccessorLauncher { param($p) $script:successorCalls += 1 } -Baseline $baseline
if(-not $finishedCommitted.RecoveredInterruptedTransaction -or $successorCalls -ne 1){throw 'retry did not finish committed rollback cleanup exactly once'}
if((Test-Path -LiteralPath $paths.Marker) -or (Test-Path -LiteralPath $paths.Stage) -or (Test-Path -LiteralPath $paths.Quarantine)){throw 'committed cleanup retry left rollback evidence'}

# A successor failure after verified promotion must report that rollback itself is already complete,
# leave the exact old tree in place, and never perform a compensating second swap.
Remove-Item -LiteralPath $current -Recurse -Force; New-Current $current 'newer-before-reopen-failure'
$moveCalls=0;$successorCalls=0;$rollbackReopenMessage=$null
$mover = { param($s,$d) $script:moveCalls += 1; Move-Item -LiteralPath $s -Destination $d }
try {
  Invoke-ExplicitRollbackTransaction -RollbackArchivePath $archive -InstallRoot $current -ProcessProbe { return @() } -SleepAction { } -SuccessorLauncher { param($path) $script:successorCalls += 1; throw 'synthetic rollback reopen failure' } -Baseline $baseline -MoveDirectory $mover | Out-Null
  throw 'expected committed-rollback reopen failure'
} catch {
  $rollbackReopenMessage=$_.Exception.Message
  if($rollbackReopenMessage -like '*expected committed-rollback reopen failure*'){throw}
}
if($rollbackReopenMessage -notlike '*rollback was restored and verified*' -or $rollbackReopenMessage -notlike '*rollback itself is complete*' -or $rollbackReopenMessage -notlike '*automatic reopen step failed or could not be confirmed*'){throw "committed rollback reopen message was ambiguous: $rollbackReopenMessage"}
if($moveCalls -ne 2 -or $successorCalls -ne 1){throw "committed rollback reopen counts move=$moveCalls successor=$successorCalls"}
$acceptedRollback=Assert-RollbackTree -Root $current -Baseline $baseline
if($acceptedRollback.TreeSha256 -ne $baseline.TreeSha256){throw 'rollback bytes did not remain exact after reopen failure'}
$committedPaths=Get-RollbackTransactionPaths -InstallRoot $current
if((Test-Path -LiteralPath $committedPaths.Marker) -or (Test-Path -LiteralPath $committedPaths.Stage) -or (Test-Path -LiteralPath $committedPaths.Quarantine)){throw 'reopen failure left rollback transaction artifacts after committed rollback'}

# A swap interruption after quarantining current bytes restores the original current install.
Remove-Item -LiteralPath $current -Recurse -Force; New-Current $current 'newer-before-swap-failure'
$moveCalls=0; $successorCalls=0
$failingMover = {
  param($s,$d)
  $script:moveCalls += 1
  if ($script:moveCalls -eq 2) { throw 'synthetic swap interruption' }
  Move-Item -LiteralPath $s -Destination $d
}
Expect-Failure { Invoke-ExplicitRollbackTransaction -RollbackArchivePath $archive -InstallRoot $current -ProcessProbe { return @() } -SleepAction { } -SuccessorLauncher { param($path) $script:successorCalls += 1 } -Baseline $baseline -MoveDirectory $failingMover } 'swap failed'
if ((Get-Content -Raw -LiteralPath (Join-Path $current 'newer.txt')) -ne 'newer-before-swap-failure') { throw 'swap failure did not restore original install' }
if ($successorCalls -ne 0) { throw 'swap failure falsely launched successor' }

# If stage->install actually completes and only then reports failure, do not claim the prior install
# was restored. Keep promoted+quarantine evidence so the next retry can finish committed rollback.
Remove-Item -LiteralPath $current -Recurse -Force; New-Current $current 'newer-before-post-move-throw'
$moveCalls=0;$successorCalls=0;$postMoveMessage=$null
$postMoveThrowMover={param($s,$d) $script:moveCalls += 1;Move-Item -LiteralPath $s -Destination $d;if($script:moveCalls -eq 2){throw [UnauthorizedAccessException]::new('synthetic post-promotion mover failure')}}
try{
  Invoke-ExplicitRollbackTransaction -RollbackArchivePath $archive -InstallRoot $current -ProcessProbe { return @() } -SleepAction { } -SuccessorLauncher { param($p) $script:successorCalls += 1 } -Baseline $baseline -MoveDirectory $postMoveThrowMover | Out-Null
  throw 'expected post-promotion mover failure'
}catch{$postMoveMessage=$_.Exception.Message;if($postMoveMessage -like '*expected post-promotion mover failure*'){throw}}
if($postMoveMessage -notlike '*marker-owned recovery evidence was retained*' -or $postMoveMessage -like '*prior installation was restored*'){throw "post-promotion failure reported false state: $postMoveMessage"}
$paths=Get-RollbackTransactionPaths -InstallRoot $current
if(-not (Test-Path -LiteralPath $paths.Marker) -or -not (Test-Path -LiteralPath $paths.Quarantine) -or (Test-Path -LiteralPath $paths.Stage)){throw 'post-promotion failure did not retain promoted recovery evidence'}
$promotedAfterThrow=Assert-RollbackTree -Root $current -Baseline $baseline
if($promotedAfterThrow.TreeSha256 -ne $baseline.TreeSha256 -or $successorCalls -ne 0 -or $moveCalls -ne 2){throw 'post-promotion failure retried, damaged promoted rollback or launched successor'}
$successorCalls=0
$finishedAfterThrow=Invoke-ExplicitRollbackTransaction -RollbackArchivePath $archive -InstallRoot $current -ProcessProbe { return @() } -SleepAction { } -SuccessorLauncher { param($p) $script:successorCalls += 1 } -Baseline $baseline
if(-not $finishedAfterThrow.RecoveredInterruptedTransaction -or $successorCalls -ne 1){throw 'post-promotion retry did not finish committed rollback'}
if((Test-Path -LiteralPath $paths.Marker) -or (Test-Path -LiteralPath $paths.Stage) -or (Test-Path -LiteralPath $paths.Quarantine)){throw 'post-promotion retry left rollback evidence'}

# Final-verification failure quarantines bad restored bytes and restores the original installation.
Remove-Item -LiteralPath $current -Recurse -Force; New-Current $current 'newer-before-final-failure'
$moveCalls=0; $successorCalls=0
$tamperingMover = {
  param($s,$d)
  $script:moveCalls += 1
  Move-Item -LiteralPath $s -Destination $d
  if ($script:moveCalls -eq 2) { [IO.File]::AppendAllText((Join-Path $d 'resources\\app.asar'),'post-swap-tamper') }
}
Expect-Failure { Invoke-ExplicitRollbackTransaction -RollbackArchivePath $archive -InstallRoot $current -ProcessProbe { return @() } -SleepAction { } -SuccessorLauncher { param($path) $script:successorCalls += 1 } -Baseline $baseline -MoveDirectory $tamperingMover } 'final verification failed'
if ((Get-Content -Raw -LiteralPath (Join-Path $current 'newer.txt')) -ne 'newer-before-final-failure') { throw 'final verification failure did not restore original install' }
if ($successorCalls -ne 0) { throw 'failed final verification falsely launched successor' }
if ((Get-Content -Raw -LiteralPath (Join-Path $userData 'keep.txt')) -ne 'keep-user-data') { throw 'failed rollback touched user data' }

# Artifact drift after verified staging but during the normal-quit wait is caught before the first
# directory move. Because current bytes are still intact, only marker-owned staging is retired.
Remove-Item -LiteralPath $current -Recurse -Force; New-Current $current 'newer-before-artifact-drift'
$waitDir=Join-Path $root 'wait-archive'; New-Item -ItemType Directory -Path $waitDir | Out-Null
$waitArchive=Join-Path $waitDir $baseline.ArchiveFile; Copy-Item -LiteralPath $archive -Destination $waitArchive
$probeCalls=0;$moveCalls=0;$mutated=$false
$probe={ $script:probeCalls += 1; if($script:probeCalls -eq 1){return [pscustomobject]@{Id=44}}; return @() }
$mover={ param($s,$d) $script:moveCalls += 1; Move-Item -LiteralPath $s -Destination $d }
Expect-Failure { Invoke-ExplicitRollbackTransaction -RollbackArchivePath $waitArchive -InstallRoot $current -ProcessProbe $probe -SleepAction { if(-not $script:mutated){ $script:mutated=$true; $s=[IO.File]::Open($waitArchive,[IO.FileMode]::Open,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None); try{$s.Position=128;$v=$s.ReadByte();$s.Position=128;$s.WriteByte(($v -bxor 1))}finally{$s.Dispose()} } } -SuccessorLauncher { param($p) } -WaitForSafeQuit -Baseline $baseline -MoveDirectory $mover } 'SHA-256 mismatch'
if($moveCalls -ne 0){throw 'artifact drift crossed rollback mutation boundary'}
if((Get-Content -Raw -LiteralPath (Join-Path $current 'newer.txt')) -ne 'newer-before-artifact-drift'){throw 'artifact drift changed current install'}
$paths=Get-RollbackTransactionPaths -InstallRoot $current
if((Test-Path -LiteralPath $paths.Marker) -or (Test-Path -LiteralPath $paths.Stage) -or (Test-Path -LiteralPath $paths.Quarantine)){throw 'artifact-drift pre-swap cleanup left owned transaction artifacts'}
Copy-Item -LiteralPath $archive -Destination $waitArchive -Force
$successorCalls=0
$recovered=Invoke-ExplicitRollbackTransaction -RollbackArchivePath $waitArchive -InstallRoot $current -ProcessProbe { return @() } -SleepAction { } -SuccessorLauncher { param($p) $script:successorCalls += 1 } -Baseline $baseline
if($recovered.TreeSha256 -ne $baseline.TreeSha256 -or $successorCalls -ne 1){throw 'clean retry did not restore after artifact was restored'}
if((Test-Path -LiteralPath $paths.Marker) -or (Test-Path -LiteralPath $paths.Stage) -or (Test-Path -LiteralPath $paths.Quarantine)){throw 'successful recovered rollback left owned transaction artifacts'}

# The same pre-swap verification failure keeps its marker/stage if cleanup silently does nothing.
Remove-Item -LiteralPath $current -Recurse -Force; New-Current $current 'newer-before-boundary-cleanup-failure'
Copy-Item -LiteralPath $archive -Destination $waitArchive -Force
$probeCalls=0;$moveCalls=0;$mutated=$false;$boundaryCleanupMessage=$null
$probe={ $script:probeCalls += 1; if($script:probeCalls -eq 1){return [pscustomobject]@{Id=45}}; return @() }
try{
  Invoke-ExplicitRollbackTransaction -RollbackArchivePath $waitArchive -InstallRoot $current -ProcessProbe $probe -SleepAction { if(-not $script:mutated){$script:mutated=$true;$s=[IO.File]::Open($waitArchive,[IO.FileMode]::Open,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None);try{$s.Position=128;$v=$s.ReadByte();$s.Position=128;$s.WriteByte(($v -bxor 1))}finally{$s.Dispose()}} } -SuccessorLauncher { param($p) } -WaitForSafeQuit -Baseline $baseline -MoveDirectory $mover -RemoveDirectory { param($p) } | Out-Null
  throw 'expected boundary cleanup failure'
}catch{$boundaryCleanupMessage=$_.Exception.Message;if($boundaryCleanupMessage -like '*expected boundary cleanup failure*'){throw}}
$paths=Get-RollbackTransactionPaths -InstallRoot $current
if($boundaryCleanupMessage -notlike '*cleanup of marker-owned staging also failed*' -or $boundaryCleanupMessage -notlike '*returned without removing the owned path*'){throw "boundary cleanup failure did not preserve both causes: $boundaryCleanupMessage"}
if($moveCalls -ne 0 -or -not (Test-Path -LiteralPath $paths.Marker) -or -not (Test-Path -LiteralPath $paths.Stage) -or (Test-Path -LiteralPath $paths.Quarantine)){throw 'boundary cleanup failure crossed mutation boundary or lost evidence'}
Copy-Item -LiteralPath $archive -Destination $waitArchive -Force
$boundaryRetry=Invoke-ExplicitRollbackTransaction -RollbackArchivePath $waitArchive -InstallRoot $current -ProcessProbe { return @() } -SleepAction { } -SuccessorLauncher { param($p) } -Baseline $baseline
if($boundaryRetry.TreeSha256 -ne $baseline.TreeSha256){throw 'boundary-cleanup retry did not converge'}
if((Test-Path -LiteralPath $paths.Marker) -or (Test-Path -LiteralPath $paths.Stage) -or (Test-Path -LiteralPath $paths.Quarantine)){throw 'boundary-cleanup retry left rollback evidence'}

# A process that reappears after the wait but before the first directory move is fenced at the
# rollback mutation boundary. The verified stage remains marker-owned and a later deliberate
# invocation can finish it exactly once once the process is absent again.
Remove-Item -LiteralPath $current -Recurse -Force; New-Current $current 'newer-before-process-reappear'
$probeCalls=0;$moveCalls=0;$successorCalls=0
$probe={ $script:probeCalls += 1; if($script:probeCalls -eq 1){return [pscustomobject]@{Id=55}}; if($script:probeCalls -eq 2){return @()}; if($script:probeCalls -eq 3){return [pscustomobject]@{Id=56}}; return @() }
$mover={ param($s,$d) $script:moveCalls += 1; Move-Item -LiteralPath $s -Destination $d }
Expect-Failure { Invoke-ExplicitRollbackTransaction -RollbackArchivePath $archive -InstallRoot $current -ProcessProbe $probe -SleepAction { } -SuccessorLauncher { param($p) $script:successorCalls += 1 } -WaitForSafeQuit -Baseline $baseline -MoveDirectory $mover } 'rollback swap boundary'
if($moveCalls -ne 0 -or $successorCalls -ne 0){throw 'reappeared app crossed rollback swap boundary'}
if((Get-Content -Raw -LiteralPath (Join-Path $current 'newer.txt')) -ne 'newer-before-process-reappear'){throw 'process reappearance changed current install'}
$paths=Get-RollbackTransactionPaths -InstallRoot $current
if(-not (Test-Path -LiteralPath $paths.Marker) -or -not (Test-Path -LiteralPath $paths.Stage)){throw 'reappeared-process rollback did not remain recoverable'}
$successorCalls=0
$resumedAfterProcess=Invoke-ExplicitRollbackTransaction -RollbackArchivePath $archive -InstallRoot $current -ProcessProbe { return @() } -SleepAction { } -SuccessorLauncher { param($p) $script:successorCalls += 1 } -Baseline $baseline
if($resumedAfterProcess.TreeSha256 -ne $baseline.TreeSha256 -or $successorCalls -ne 1){throw 'process-reappearance recovery did not finish exactly once'}

# A prior-only interruption must not become invisible if the recovery mover silently does nothing.
# The marker/quarantine remain authoritative and the next real retry restores the prior install.
Remove-Item -LiteralPath $current -Recurse -Force; New-Current $current 'newer-before-prior-only-noop-move'
$paths=Get-RollbackTransactionPaths -InstallRoot $current
Write-RollbackTransactionMarker -Paths $paths -Baseline $baseline
Move-Item -LiteralPath $current -Destination $paths.Quarantine
$priorOnlyMessage=$null
try{
  Invoke-ExplicitRollbackTransaction -RollbackArchivePath $archive -InstallRoot $current -ProcessProbe { return @() } -SleepAction { } -SuccessorLauncher { param($p) } -Baseline $baseline -MoveDirectory { param($s,$d) } | Out-Null
  throw 'expected prior-only no-op move failure'
}catch{$priorOnlyMessage=$_.Exception.Message;if($priorOnlyMessage -like '*expected prior-only no-op move failure*'){throw}}
if($priorOnlyMessage -notlike '*move returned without retiring the source directory*' -or -not (Test-Path -LiteralPath $paths.Marker) -or -not (Test-Path -LiteralPath $paths.Quarantine) -or (Test-Path -LiteralPath $paths.Install)){throw "prior-only no-op move lost recovery evidence: $priorOnlyMessage"}
Expect-Failure { Invoke-ExplicitRollbackTransaction -RollbackArchivePath $archive -InstallRoot $current -ProcessProbe { return @() } -SleepAction { } -SuccessorLauncher { param($p) } -Baseline $baseline | Out-Null } 'Recovered an interrupted rollback'
if((Get-Content -Raw -LiteralPath (Join-Path $current 'newer.txt')) -ne 'newer-before-prior-only-noop-move'){throw 'prior-only retry did not restore previous install'}
if((Test-Path -LiteralPath $paths.Marker) -or (Test-Path -LiteralPath $paths.Stage) -or (Test-Path -LiteralPath $paths.Quarantine)){throw 'prior-only retry left rollback evidence'}

# Simulate a hard process death after current->quarantine but before stage->current. The next
# invocation recognizes only its fixed marker-owned siblings and resumes the verified promotion.
Remove-Item -LiteralPath $current -Recurse -Force; New-Current $current 'newer-before-hard-interruption'
$paths=Get-RollbackTransactionPaths -InstallRoot $current
Write-RollbackTransactionMarker -Paths $paths -Baseline $baseline
Expand-RollbackArchive -ArchivePath $archive -Destination $paths.Stage
$null=Assert-RollbackTree -Root $paths.Stage -Baseline $baseline
Move-Item -LiteralPath $current -Destination $paths.Quarantine
$successorCalls=0
$resumed=Invoke-ExplicitRollbackTransaction -RollbackArchivePath $archive -InstallRoot $current -ProcessProbe { return @() } -SleepAction { } -SuccessorLauncher { param($p) $script:successorCalls += 1 } -Baseline $baseline
if($resumed.TreeSha256 -ne $baseline.TreeSha256 -or $successorCalls -ne 1){throw 'quarantined interruption did not resume deterministically'}
if((Test-Path -LiteralPath $paths.Marker) -or (Test-Path -LiteralPath $paths.Stage) -or (Test-Path -LiteralPath $paths.Quarantine)){throw 'resumed rollback left owned transaction artifacts'}

# Simulate death after promotion but before final verification. An exact promoted tree completes;
# a corrupted promoted tree restores the quarantined prior installation and reports failure.
Remove-Item -LiteralPath $current -Recurse -Force; New-Current $current 'newer-before-promoted-interruption'
$paths=Get-RollbackTransactionPaths -InstallRoot $current; Write-RollbackTransactionMarker -Paths $paths -Baseline $baseline; Expand-RollbackArchive -ArchivePath $archive -Destination $paths.Stage; Move-Item -LiteralPath $current -Destination $paths.Quarantine; Move-Item -LiteralPath $paths.Stage -Destination $current
$successorCalls=0
$completed=Invoke-ExplicitRollbackTransaction -RollbackArchivePath $archive -InstallRoot $current -ProcessProbe { return @() } -SleepAction { } -SuccessorLauncher { param($p) $script:successorCalls += 1 } -Baseline $baseline
if(-not $completed.RecoveredInterruptedTransaction -or $successorCalls -ne 1){throw 'promoted interruption did not complete deterministically'}

Remove-Item -LiteralPath $current -Recurse -Force; New-Current $current 'newer-before-bad-promoted-interruption'
$paths=Get-RollbackTransactionPaths -InstallRoot $current; Write-RollbackTransactionMarker -Paths $paths -Baseline $baseline; Expand-RollbackArchive -ArchivePath $archive -Destination $paths.Stage; Move-Item -LiteralPath $current -Destination $paths.Quarantine; Move-Item -LiteralPath $paths.Stage -Destination $current; [IO.File]::AppendAllText((Join-Path $current 'resources\\app.asar'),'interrupted-tamper')
$successorCalls=0
Expect-Failure { Invoke-ExplicitRollbackTransaction -RollbackArchivePath $archive -InstallRoot $current -ProcessProbe { return @() } -SleepAction { } -SuccessorLauncher { param($p) $script:successorCalls += 1 } -Baseline $baseline } 'Recovered an interrupted rollback'
if((Get-Content -Raw -LiteralPath (Join-Path $current 'newer.txt')) -ne 'newer-before-bad-promoted-interruption'){throw 'bad promoted recovery did not restore prior install'}
if($successorCalls -ne 0){throw 'bad promoted recovery falsely launched successor'}

# Marker-less owned-looking content and contradictory marked topology are ambiguous by design.
# Neither case is auto-deleted or guessed at, and unrelated similarly-named user content survives.
$paths=Get-RollbackTransactionPaths -InstallRoot $current
New-Item -ItemType Directory -Path $paths.Stage | Out-Null
[IO.File]::WriteAllText((Join-Path $paths.Stage 'sentinel'),'keep',[Text.UTF8Encoding]::new($false))
Expect-Failure { Invoke-ExplicitRollbackTransaction -RollbackArchivePath $archive -InstallRoot $current -ProcessProbe { throw 'probe should not run' } -SleepAction { } -SuccessorLauncher { param($p) } -Baseline $baseline } 'without the canonical marker'
if(-not (Test-Path -LiteralPath (Join-Path $paths.Stage 'sentinel'))){throw 'ambiguous marker-less stage was deleted'}
Remove-Item -LiteralPath $paths.Stage -Recurse -Force

# Wrong filesystem types are owned-looking evidence too; files or reparse roots must not be
# misclassified as an absent stage/quarantine directory.
[IO.File]::WriteAllText($paths.Quarantine,'markerless quarantine file',[Text.UTF8Encoding]::new($false))
Expect-Failure { Invoke-ExplicitRollbackTransaction -RollbackArchivePath $archive -InstallRoot $current -ProcessProbe { throw 'probe should not run' } -SleepAction { } -SuccessorLauncher { param($p) } -Baseline $baseline } 'without the canonical marker'
if(-not (Test-Path -LiteralPath $paths.Quarantine -PathType Leaf)){throw 'markerless quarantine file became invisible or was deleted'}
Remove-Item -LiteralPath $paths.Quarantine -Force

Write-RollbackTransactionMarker -Paths $paths -Baseline $baseline
[IO.File]::WriteAllText($paths.Stage,'marked stage file',[Text.UTF8Encoding]::new($false))
Expect-Failure { Invoke-ExplicitRollbackTransaction -RollbackArchivePath $archive -InstallRoot $current -ProcessProbe { throw 'probe should not run' } -SleepAction { } -SuccessorLauncher { param($p) } -Baseline $baseline } 'stage path exists but is not a directory'
if(-not (Test-Path -LiteralPath $paths.Marker) -or -not (Test-Path -LiteralPath $paths.Stage -PathType Leaf)){throw 'marked wrong-type stage evidence was not retained'}
Remove-Item -LiteralPath $paths.Stage -Force; Remove-RollbackTransactionMarker -Paths $paths

$junctionTarget=Join-Path $root 'junction-target';New-Item -ItemType Directory -Path $junctionTarget | Out-Null
Write-RollbackTransactionMarker -Paths $paths -Baseline $baseline
New-Item -ItemType Junction -Path $paths.Stage -Target $junctionTarget | Out-Null
Expect-Failure { Get-RollbackTransactionTopology -Paths $paths -Baseline $baseline | Out-Null } 'stage path is a reparse point'
Expect-Failure { Get-DirectoryFingerprint -Root $paths.Stage | Out-Null } 'reparse-point root'
if(-not (Test-Path -LiteralPath $paths.Marker) -or -not (Test-Path -LiteralPath $paths.Stage)){throw 'reparse stage evidence was not retained'}
Remove-Item -LiteralPath $paths.Stage -Force; Remove-RollbackTransactionMarker -Paths $paths
if(-not (Test-Path -LiteralPath $junctionTarget -PathType Container)){throw 'junction rejection damaged its target'}

$unrelated=Join-Path $root 'Current App.rollback-user-content'; New-Item -ItemType Directory -Path $unrelated | Out-Null; [IO.File]::WriteAllText((Join-Path $unrelated 'keep.txt'),'keep',[Text.UTF8Encoding]::new($false))
Write-RollbackTransactionMarker -Paths $paths -Baseline $baseline; New-Item -ItemType Directory -Path $paths.Stage,$paths.Quarantine | Out-Null
Expect-Failure { Invoke-ExplicitRollbackTransaction -RollbackArchivePath $archive -InstallRoot $current -ProcessProbe { throw 'probe should not run' } -SleepAction { } -SuccessorLauncher { param($p) } -Baseline $baseline } 'topology is ambiguous'
if(-not (Test-Path -LiteralPath (Join-Path $unrelated 'keep.txt'))){throw 'ambiguous rollback touched unrelated sibling content'}
Remove-Item -LiteralPath $paths.Stage,$paths.Quarantine -Recurse -Force; Remove-RollbackTransactionMarker -Paths $paths
if((Get-Content -Raw -LiteralPath (Join-Path $userData 'keep.txt')) -ne 'keep-user-data'){throw 'recovery cases touched user data'}

# Retrying explicit rollback after an already-successful exact 2.1.13 result is idempotent: the
# wrapper verifies the immutable archive + exact installed tree, then returns without process
# probing, staging or another directory move.
Remove-Item -LiteralPath $current -Recurse -Force; Copy-Tree $source $current
$noopLock='Local\\COSCustomInstall-Noop-' + [guid]::NewGuid().ToString('N')
$noOp=Invoke-CustomInstall -Rollback -RepoRoot $root -InstallRoot $current -RollbackArchivePath $archive -RollbackBaseline $baseline -OperationLockName $noopLock -ProcessProbe { throw 'already-exact rollback must not probe the app' } -MoveDirectory { param($s,$d) throw 'already-exact rollback must not move directories' }
if(-not $noOp.AlreadyExact -or $noOp.TreeSha256 -ne $baseline.TreeSha256){throw 'already-exact rollback was not idempotent'}

'rollback transaction rehearsal passed'
`, 'utf8');

      const result = spawnSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', harness], {
        encoding: 'utf8', windowsHide: true, timeout: 120_000, cwd: repoRoot
      });
      expect(result.status, result.stderr || result.stdout).toBe(0);
      expect(result.stdout).toContain('rollback transaction rehearsal passed');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 120_000);

  it('serializes mutating and qualification-read custom-install transactions across processes and releases the lock on failure', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'cos-custom-install-lock-'));
    try {
      const harness = path.join(root, 'lock.ps1');
      writeFileSync(harness, `
$ErrorActionPreference='Stop'
. ${ps(installScript)}
$root=${ps(root)}
$lockName='Local\\COSCustomInstall-Lock-' + [guid]::NewGuid().ToString('N')
$ready=Join-Path $root 'holder.ready'
function Expect-Failure([scriptblock]$Action,[string]$Needle){try{& $Action;throw "expected failure containing: $Needle"}catch{if($_.Exception.Message -notlike "*$Needle*"){throw}}}

$job=Start-Job -ScriptBlock {
  param($Name,$Ready)
  $created=$false
  $mutex=[Threading.Mutex]::new($false,$Name,[ref]$created)
  try {
    $null=$mutex.WaitOne()
    [IO.File]::WriteAllText($Ready,'ready',[Text.UTF8Encoding]::new($false))
    Start-Sleep -Seconds 30
  } finally {
    try{$mutex.ReleaseMutex()}catch{}
    $mutex.Dispose()
  }
} -ArgumentList $lockName,$ready
try {
  $deadline=(Get-Date).AddSeconds(10)
  while(-not (Test-Path -LiteralPath $ready) -and (Get-Date) -lt $deadline){Start-Sleep -Milliseconds 25}
  if(-not (Test-Path -LiteralPath $ready)){throw 'lock-holder job did not become ready'}
  $probeCalls=0
  Expect-Failure {
    Invoke-CustomInstall -QualifiedPrebuilt -WaitForSafeQuit -RepoRoot $root -ReleaseDirectory (Join-Path $root 'missing-release') -InstallRoot (Join-Path $root 'missing-install') -OperationLockName $lockName -ProcessProbe { $script:probeCalls += 1; throw 'process probe must not run while lock is held' } -SleepAction { }
  } 'already running'
  if($probeCalls -ne 0){throw 'concurrent transaction crossed operation lock'}
  # Qualification is read-only with respect to product state, but it reads latest.yml, installer
  # hashes and the embedded payload in separate steps. It must share the mutation lock so a strict
  # publisher cannot replace the canonical release between those reads and create a mixed receipt.
  Expect-Failure {
    Invoke-CustomInstall -ProposeQualification -RepoRoot $root -ReleaseDirectory (Join-Path $root 'missing-release') -OperationLockName $lockName -ProcessProbe { throw 'proposal must not probe processes' }
  } 'already running'
} finally {
  Stop-Job -Job $job -ErrorAction SilentlyContinue
  Remove-Job -Job $job -Force -ErrorAction SilentlyContinue
}

# A failure after this process acquired the lock still releases it in the canonical finally path.
$failureLock='Local\\COSCustomInstall-Failure-' + [guid]::NewGuid().ToString('N')
Expect-Failure {
  Invoke-CustomInstall -QualifiedPrebuilt -WaitForSafeQuit -RepoRoot $root -ReleaseDirectory (Join-Path $root 'missing-release') -InstallRoot (Join-Path $root 'missing-install') -OperationLockName $failureLock -ProcessProbe { throw 'process probe must not run before missing candidate failure' } -SleepAction { }
} 'metadata is missing'
$mutex=Enter-CustomInstallOperationLock -Name $failureLock
Exit-CustomInstallOperationLock -Mutex $mutex

# The read-only qualification path owns the same lock only while assembling one coherent receipt;
# an ordinary validation failure must release it just like the mutating paths do.
$proposalFailureLock='Local\\COSCustomInstall-ProposalFailure-' + [guid]::NewGuid().ToString('N')
Expect-Failure {
  Invoke-CustomInstall -ProposeQualification -RepoRoot $root -ReleaseDirectory (Join-Path $root 'missing-proposal-release') -OperationLockName $proposalFailureLock
} 'metadata is missing'
$mutex=Enter-CustomInstallOperationLock -Name $proposalFailureLock
Exit-CustomInstallOperationLock -Mutex $mutex

'custom install operation lock rehearsal passed'
`, 'utf8');

      const result = spawnSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', harness], {
        encoding: 'utf8', windowsHide: true, timeout: 120_000, cwd: repoRoot
      });
      expect(result.status, result.stderr || result.stdout).toBe(0);
      expect(result.stdout).toContain('custom install operation lock rehearsal passed');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 120_000);

  it('returns nonzero process status for representative operator failures without success or resume claims', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'cos-custom-install-exit-'));
    const runFailure = (name: string, lines: string[], contains: string[]): void => {
      const file = path.join(root, name + '.ps1');
      writeFileSync(file, lines.join('\n') + '\n', 'utf8');
      const result = spawnSync(
        'powershell.exe',
        ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', file],
        { encoding: 'utf8', windowsHide: true, timeout: 30_000, cwd: repoRoot }
      );
      const output = String(result.stdout ?? '') + '\n' + String(result.stderr ?? '');
      expect(result.status, name + ': ' + output).not.toBe(0);
      for (const needle of contains) expect(output, name).toContain(needle);
      expect(output, name).not.toContain('[custom-install] update installed.');
      expect(output, name).not.toContain('[custom-install] exact private 2.1.13 program rollback restored and verified.');
      expect(output, name).not.toContain('--resume-automation');
    };

    try {
      const common = ["$ErrorActionPreference='Stop'", '. ' + ps(installScript)];
      runFailure(
        'preflight',
        [
          ...common,
          'Invoke-CustomInstall -QualifiedPrebuilt -RepoRoot ' + ps(root) +
            " -ReleaseDirectory (Join-Path " + ps(root) + " 'missing-release')" +
            " -InstallRoot (Join-Path " + ps(root) + " 'missing-install')" +
            " -RollbackArchivePath (Join-Path " + ps(root) + " 'missing-rollback.zip')" +
            " -OperationLockName ('Local\\COSCustomInstall-Preflight-' + [guid]::NewGuid().ToString('N'))"
        ],
        ['Qualified release metadata is missing']
      );

      runFailure(
        'mutex',
        [
          ...common,
          "$lockName='Local\\COSCustomInstall-ExitMutex-' + [guid]::NewGuid().ToString('N')",
          "$ready=Join-Path " + ps(root) + " 'mutex.ready'",
          '$job=Start-Job -ScriptBlock {',
          '  param($Name,$Ready)',
          '  $created=$false',
          '  $mutex=[Threading.Mutex]::new($false,$Name,[ref]$created)',
          '  try {',
          '    $null=$mutex.WaitOne()',
          "    [IO.File]::WriteAllText($Ready,'ready',[Text.UTF8Encoding]::new($false))",
          '    Start-Sleep -Seconds 30',
          '  } finally {',
          '    try{$mutex.ReleaseMutex()}catch{}',
          '    $mutex.Dispose()',
          '  }',
          '} -ArgumentList $lockName,$ready',
          'try {',
          '  $deadline=(Get-Date).AddSeconds(10)',
          '  while(-not (Test-Path -LiteralPath $ready) -and (Get-Date) -lt $deadline){Start-Sleep -Milliseconds 25}',
          "  if(-not (Test-Path -LiteralPath $ready)){throw 'mutex holder did not become ready'}",
          '  Assert-CustomInstallOperationAvailable -Name $lockName',
          '} finally {',
          '  Stop-Job -Job $job -ErrorAction SilentlyContinue',
          '  Remove-Job -Job $job -Force -ErrorAction SilentlyContinue',
          '}'
        ],
        ['readiness is blocked', 'already running']
      );

      runFailure(
        'installer',
        [
          ...common,
          "Invoke-QualifiedInstallerTransaction -Qualified ([pscustomobject]@{InstallerPath='fixture.exe'})" +
            " -InstallRoot " + ps(root) +
            " -InstallerRunner { param($p) return 37 } -SuccessorLauncher { throw 'successor must not run' }"
        ],
        ['silent installer exited with code 37', 'installed state was not accepted', 'no resume was launched', 'Rollback is a separate deliberate action']
      );

      runFailure(
        'postinstall',
        [
          ...common,
          "Invoke-QualifiedInstallerTransaction -Qualified ([pscustomobject]@{InstallerPath='fixture.exe'})" +
            " -InstallRoot " + ps(root) +
            " -InstallerRunner { param($p) return 0 } -SuccessorLauncher { throw 'successor must not run' }"
        ],
        ['installer returned success', 'installed state was not accepted', 'No resume or companion reload was requested', 'Rollback is a separate deliberate action']
      );

      runFailure(
        'rollback-preflight',
        [
          ...common,
          'Invoke-CustomInstall -Rollback -RepoRoot ' + ps(root) +
            " -InstallRoot (Join-Path " + ps(root) + " 'missing-current')" +
            " -RollbackArchivePath (Join-Path " + ps(root) + " 'private-2.1.13-program.zip')" +
            " -OperationLockName ('Local\\COSCustomInstall-RollbackFail-' + [guid]::NewGuid().ToString('N'))" +
            " -ProcessProbe { throw 'rollback failure must occur before process probing' }"
        ],
        ['Exact rollback artifact is missing']
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 120_000);

  it('binds every non-legacy qualification and activation receipt to verified clean Git provenance', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'cos-source-provenance-'));
    try {
      const harness = path.join(root, 'source-provenance.ps1');
      writeFileSync(harness, `
$ErrorActionPreference='Stop'
. ${ps(installScript)}
$root=${ps(root)}
$repo=Join-Path $root 'repo'
New-Item -ItemType Directory -Path $repo | Out-Null
function Invoke-FixtureGit([string[]]$GitArgs) {
  $output=@(& git --no-replace-objects -C $repo @GitArgs 2>&1)
  if($LASTEXITCODE -ne 0){throw ('fixture git failed: ' + (($output|ForEach-Object{[string]$_}) -join ' '))}
  return (($output|ForEach-Object{[string]$_}) -join [Environment]::NewLine).Trim()
}
function Expect-Failure([scriptblock]$Action,[string]$Needle){
  try{& $Action;throw "expected failure containing: $Needle"}catch{if($_.Exception.Message -like '*expected failure containing:*' -or $_.Exception.Message -notlike "*$Needle*"){throw}}
}
Invoke-FixtureGit -GitArgs @('init','--quiet') | Out-Null
Invoke-FixtureGit -GitArgs @('config','user.name','Provenance Test') | Out-Null
Invoke-FixtureGit -GitArgs @('config','user.email','provenance-test@example.invalid') | Out-Null
[IO.File]::WriteAllLines((Join-Path $repo '.gitignore'), @('.env','.env.*','*.pem'), [Text.UTF8Encoding]::new($false))
[IO.File]::WriteAllText((Join-Path $repo 'package.json'), '{"version":"9.9.9"}', [Text.UTF8Encoding]::new($false))
[IO.File]::WriteAllText((Join-Path $repo 'package-lock.json'), '{"lockfileVersion":3}', [Text.UTF8Encoding]::new($false))
[IO.File]::WriteAllText((Join-Path $repo 'CUSTOM_BUILD'), 'fixture custom build', [Text.UTF8Encoding]::new($false))
[IO.File]::WriteAllText((Join-Path $repo 'source.txt'), 'reviewed source', [Text.UTF8Encoding]::new($false))
Invoke-FixtureGit -GitArgs @('add','.gitignore','package.json','package-lock.json','CUSTOM_BUILD','source.txt') | Out-Null
Invoke-FixtureGit -GitArgs @('commit','--quiet','-m','reviewed source') | Out-Null
$reviewed=Get-ReviewedGitState -RepoRoot $repo
if($reviewed.dirty){throw 'fresh fixture checkout was not clean'}
$nodeIdentity=[pscustomobject][ordered]@{version='v24.19.0';executableSha256=('1'*64)}
$npmIdentity=[pscustomobject][ordered]@{version='11.17.0';cliSha256=('2'*64);commandShimSha256=('3'*64);packageFileCount=100;packageTotalBytes=[int64]1000;packageTreeSha256=('4'*64)}
$tools=[pscustomobject][ordered]@{
  electron=[pscustomobject][ordered]@{version='44.3.0';packageJsonSha256=('3'*64);entrySha256=('4'*64);runtimeSha256=('5'*64);archiveSha256=('6'*64)}
  'electron-builder'=[pscustomobject][ordered]@{version='26.16.1';packageJsonSha256=('7'*64);entrySha256=('8'*64)}
  'electron-vite'=[pscustomobject][ordered]@{version='5.0.0';packageJsonSha256=('9'*64);entrySha256=('a'*64)}
  vite=[pscustomobject][ordered]@{version='7.3.6';packageJsonSha256=('b'*64);entrySha256=('c'*64)}
  typescript=[pscustomobject][ordered]@{version='7.0.2';packageJsonSha256=('d'*64);entrySha256=('e'*64)}
}
$hostTools=[pscustomobject][ordered]@{
  git=[pscustomobject][ordered]@{version='git version fixture';executableSha256=('f'*64)}
  tar=[pscustomobject][ordered]@{version='bsdtar fixture';executableSha256=('0'*64)}
  shell=[pscustomobject][ordered]@{version='Microsoft Windows fixture';executableSha256=('1'*64)}
}
$builderToolsets=[pscustomobject][ordered]@{
  sevenZip=[pscustomobject][ordered]@{archiveSha256=('1'*64);fileCount=4;totalBytes=[int64]100;treeSha256=('2'*64);executableSha256=('3'*64)}
  nsis=[pscustomobject][ordered]@{archiveSha256=('4'*64);fileCount=343;totalBytes=[int64]200;treeSha256=('5'*64);executableSha256=('6'*64)}
  nsisResources=[pscustomobject][ordered]@{archiveSha256=('7'*64);fileCount=22;totalBytes=[int64]300;treeSha256=('8'*64)}
}
$toolchain=[pscustomobject][ordered]@{node=$nodeIdentity;npm=$npmIdentity;tools=$tools;hostTools=$hostTools;builderToolsets=$builderToolsets}
$nodeExe=Get-TrustedHostToolPath -Name node
$digestJs="const fs=require('node:fs'),c=require('node:crypto');const v=JSON.parse(fs.readFileSync(process.argv[1],'utf8'));process.stdout.write(c.createHash('sha256').update(JSON.stringify(v)+'\\n').digest('hex'))"
$toolchainJson=$toolchain | ConvertTo-Json -Depth 20 -Compress
$toolchainInput=Join-Path $root 'toolchain-input.json';[IO.File]::WriteAllText($toolchainInput,$toolchainJson,[Text.UTF8Encoding]::new($false))
$toolchainSha=(@(& $nodeExe -e $digestJs $toolchainInput 2>&1) -join '').Trim()
if($LASTEXITCODE -ne 0 -or $toolchainSha -cnotmatch '^[0-9a-f]{64}$'){throw 'fixture toolchain digest failed'}
$provenance=[pscustomobject][ordered]@{
  schema=2;objectFormat=$reviewed.objectFormat;commit=$reviewed.commit;tree=$reviewed.tree;dirty=$false;strictBuild=$true
  packageJsonSha256=(Get-FileHashHex -Path (Join-Path $repo 'package.json'));packageLockSha256=(Get-FileHashHex -Path (Join-Path $repo 'package-lock.json'));lockfileVersion=3
  dependencies=[pscustomobject][ordered]@{fileCount=12;totalBytes=[int64]345;treeSha256=('9'*64)}
  node=$nodeIdentity;npm=$npmIdentity;tools=$tools;hostTools=$hostTools;builderToolsets=$builderToolsets;toolchainSha256=$toolchainSha
}

# The canonical package JSON is accepted; alternate schemas/ids are not.
$recordPath=Join-Path $root 'SOURCE_PROVENANCE.json'
$canonicalJs="const fs=require('node:fs');const v=JSON.parse(fs.readFileSync(process.argv[1],'utf8'));fs.writeFileSync(process.argv[2],JSON.stringify(v,null,2)+'\\n','utf8')"
$provenanceJson=$provenance | ConvertTo-Json -Depth 20 -Compress
$provenanceInput=Join-Path $root 'provenance-input.json';[IO.File]::WriteAllText($provenanceInput,$provenanceJson,[Text.UTF8Encoding]::new($false))
$null=@(& $nodeExe -e $canonicalJs $provenanceInput $recordPath 2>&1)
if($LASTEXITCODE -ne 0){throw 'fixture canonical provenance generation failed'}
$canonical=[IO.File]::ReadAllText($recordPath)
$read=Read-SourceProvenanceRecord -Path $recordPath
if($read.commit -cne $provenance.commit -or [string]$read.RecordSha256 -cnotmatch '^[0-9a-f]{64}$'){throw 'canonical schema-v2 record was not read exactly'}
$badSchema=$provenance.PSObject.Copy();$badSchema.schema=3
Expect-Failure { Assert-SourceProvenanceRecordShape -Provenance $badSchema | Out-Null } 'Unsupported source provenance schema'
$badFormat=$provenance.PSObject.Copy();$badFormat.objectFormat='md5'
Expect-Failure { Assert-SourceProvenanceRecordShape -Provenance $badFormat | Out-Null } 'Unsupported Git object format'
$badId=$provenance.PSObject.Copy();$badId.commit='abc'
Expect-Failure { Assert-SourceProvenanceRecordShape -Provenance $badId | Out-Null } 'not a valid'
[IO.File]::WriteAllText($recordPath,'{}',[Text.UTF8Encoding]::new($false))
Expect-Failure { Read-SourceProvenanceRecord -Path $recordPath | Out-Null } 'Expected source provenance schema 2'

# Existing-object, commit->tree, and clean-checkout claims are independently proved.
$missing=$provenance.PSObject.Copy();$missing.commit=('0' * (Get-GitObjectIdLength -ObjectFormat $reviewed.objectFormat))
Expect-Failure { Assert-SourceProvenanceAgainstRepository -Provenance $missing -RepoRoot $repo | Out-Null } 'not present in the local review repository'
$extra=Join-Path $repo 'extra.txt';[IO.File]::WriteAllText($extra,'other tree',[Text.UTF8Encoding]::new($false));Invoke-FixtureGit -GitArgs @('add','extra.txt') | Out-Null
$otherTree=Invoke-FixtureGit -GitArgs @('write-tree');Invoke-FixtureGit -GitArgs @('rm','--cached','-q','extra.txt') | Out-Null;Remove-Item -LiteralPath $extra
$treeMismatch=$provenance.PSObject.Copy();$treeMismatch.tree=$otherTree
Expect-Failure { Assert-SourceProvenanceAgainstRepository -Provenance $treeMismatch -RepoRoot $repo | Out-Null } 'tree mismatch'
$otherCommit=Invoke-FixtureGit -GitArgs @('commit-tree',$otherTree,'-p',$reviewed.commit,'-m','synthetic alternate source')
$other=$provenance.PSObject.Copy();$other.commit=$otherCommit;$other.tree=$otherTree
$null=Assert-SourceProvenanceAgainstRepository -Provenance $other -RepoRoot $repo
Expect-Failure { Assert-SourceProvenanceAgainstRepository -Provenance $other -RepoRoot $repo -RequireCheckoutMatch | Out-Null } 'does not match the clean checkout under review'

$dirtyClaim=$provenance.PSObject.Copy();$dirtyClaim.dirty=$true
Expect-Failure { Assert-SourceProvenanceAgainstRepository -Provenance $dirtyClaim -RepoRoot $repo | Out-Null } 'dirty=true'
[IO.File]::WriteAllText((Join-Path $repo 'source.txt'),'tracked dirt',[Text.UTF8Encoding]::new($false))
Expect-Failure { Assert-SourceProvenanceAgainstRepository -Provenance $provenance -RepoRoot $repo -RequireCheckoutMatch | Out-Null } 'checkout under qualification review is dirty'
[IO.File]::WriteAllText((Join-Path $repo 'source.txt'),'reviewed source',[Text.UTF8Encoding]::new($false))
[IO.File]::WriteAllText((Join-Path $repo 'untracked.ts'),'untracked source',[Text.UTF8Encoding]::new($false))
if(-not (Get-ReviewedGitState -RepoRoot $repo).dirty){throw 'untracked source was not dirty'};Remove-Item -LiteralPath (Join-Path $repo 'untracked.ts')
[IO.File]::WriteAllText((Join-Path $repo '.env.local'),'VITE_INFLUENCE=1',[Text.UTF8Encoding]::new($false))
if(-not (Get-ReviewedGitState -RepoRoot $repo).dirty){throw 'ignored root env input was not dirty'};Remove-Item -LiteralPath (Join-Path $repo '.env.local')
New-Item -ItemType Directory -Path (Join-Path $repo 'extension') | Out-Null
[IO.File]::WriteAllText((Join-Path $repo 'extension\\private.pem'),'ignored package input',[Text.UTF8Encoding]::new($false))
if(-not (Get-ReviewedGitState -RepoRoot $repo).dirty){throw 'ignored extension package input was not dirty'};Remove-Item -LiteralPath (Join-Path $repo 'extension') -Recurse -Force
New-Item -ItemType Directory -Path (Join-Path $repo 'src') | Out-Null
[IO.File]::WriteAllText((Join-Path $repo 'src\\ignored-source.pem'),'ignored source input',[Text.UTF8Encoding]::new($false))
if(-not (Get-ReviewedGitState -RepoRoot $repo).dirty){throw 'globally ignored source input was not dirty'};Remove-Item -LiteralPath (Join-Path $repo 'src') -Recurse -Force

$priorGitDir=$env:GIT_DIR;$env:GIT_DIR='Z:\\spoofed-git-dir'
try{$trusted=Assert-SourceProvenanceAgainstRepository -Provenance $provenance -RepoRoot $repo -RequireCheckoutMatch;if($trusted.commit -cne $reviewed.commit){throw 'GIT_DIR spoof changed provenance'}}finally{$env:GIT_DIR=$priorGitDir}

# A future package proposal must carry clean provenance and prints every source-binding receipt field.
$release=Join-Path $root 'release';New-Item -ItemType Directory -Path $release | Out-Null
$installerName='Chat-On-Steroids-Setup-x64.exe';$installer=Join-Path $release $installerName
[IO.File]::WriteAllText($installer,'future candidate bytes',[Text.UTF8Encoding]::new($false))
$size=[int64](Get-Item -LiteralPath $installer).Length;$sha512=Get-FileSha512Base64 -Path $installer;$sha256=Get-FileHashHex -Path $installer;$date='2030-01-02T03:04:05.000Z'
$latest=Join-Path $release 'latest.yml'
$latestLines=@('version: 9.9.9','files:',"  - url: $installerName","    sha512: $sha512","    size: $size","path: $installerName","sha512: $sha512","releaseDate: '$date'")
[IO.File]::WriteAllLines($latest,$latestLines,[Text.UTF8Encoding]::new($false))
$script:futurePayload=[pscustomobject]@{FileVersion='9.9.9';ProductVersion='9.9.9.0';ExtensionVersion='9.9.9';AsarPackageVersion='9.9.9';AppExecutableSha256=('d'*64);AppAsarSha256=('a'*64);ExtensionBackgroundSha256=('b'*64);CustomBuildText='fixture custom build';SourceProvenance=$read;BuildInputsVerified=$true;FileCount=7;TotalBytes=[int64]77;TreeSha256=('c'*64);UnpackedCrossCheck='absent'}
$reader={param($InstallerPath,$Root,$ReleaseDirectory) return $script:futurePayload}
$proposal=Get-CandidateQualificationProposal -RepoRoot $repo -ReleaseDirectory $release -PayloadReader $reader
if($proposal.LegacyProvenanceException -or $proposal.SourceProvenance.commit -cne $reviewed.commit -or $proposal.SourceProvenance.tree -cne $reviewed.tree){throw 'future proposal lost source provenance'}
Write-CandidateQualificationProposal -Proposal $proposal
$script:futurePayload=$script:futurePayload.PSObject.Copy();$script:futurePayload.SourceProvenance=$null
Expect-Failure { Get-CandidateQualificationProposal -RepoRoot $repo -ReleaseDirectory $release -PayloadReader $reader | Out-Null } 'has no embedded SOURCE_PROVENANCE.json'
$dirtyRead=$read.PSObject.Copy();$dirtyRead.dirty=$true
$script:futurePayload=$script:futurePayload.PSObject.Copy();$script:futurePayload.SourceProvenance=$dirtyRead
Expect-Failure { Get-CandidateQualificationProposal -RepoRoot $repo -ReleaseDirectory $release -PayloadReader $reader | Out-Null } 'dirty=true'
$otherForProposal=$read.PSObject.Copy();$otherForProposal.commit=$otherCommit;$otherForProposal.tree=$otherTree
$script:futurePayload=$script:futurePayload.PSObject.Copy();$script:futurePayload.SourceProvenance=$otherForProposal
Expect-Failure { Get-CandidateQualificationProposal -RepoRoot $repo -ReleaseDirectory $release -PayloadReader $reader | Out-Null } 'does not match the clean checkout under review'

# Qualified activation binds the pinned receipt to independently read embedded provenance.
$candidate=[pscustomobject]@{Version='9.9.9';InstallerFile=$installerName;InstallerSize=$size;InstallerSha256=$sha256;InstallerSha512=$sha512;LatestYmlSha256=(Get-FileHashHex -Path $latest);ReleaseDate=$date;AppExecutableSha256=('d'*64)}
$receipt=Get-SourceProvenanceReceiptProjection -Provenance $read
foreach($property in $receipt.PSObject.Properties){$candidate | Add-Member NoteProperty ([string]$property.Name) $property.Value}
$script:embeddedForActivation=$read
function Read-InstallerSourceProvenance { param([string]$InstallerPath,[string]$RepoRoot) return $script:embeddedForActivation }
$qualified=Assert-QualifiedPrebuiltCandidate -ReleaseDirectory $release -RepoRoot $repo -Candidate $candidate
if($qualified.SourceProvenance.commit -cne $reviewed.commit){throw 'qualified candidate dropped pinned provenance'}
$missingExecutableReceipt=$candidate.PSObject.Copy();$missingExecutableReceipt.PSObject.Properties.Remove('AppExecutableSha256')
Expect-Failure { Assert-QualifiedPrebuiltCandidate -ReleaseDirectory $release -RepoRoot $repo -Candidate $missingExecutableReceipt | Out-Null } 'executable hash receipt is missing or malformed'
$script:embeddedForActivation=$null
Expect-Failure { Assert-QualifiedPrebuiltCandidate -ReleaseDirectory $release -RepoRoot $repo -Candidate $candidate | Out-Null } 'has no embedded SOURCE_PROVENANCE.json'
$script:embeddedForActivation=$read
$altered=$candidate.PSObject.Copy();$altered.GitTree=$otherTree
Expect-Failure { Assert-QualifiedPrebuiltCandidate -ReleaseDirectory $release -RepoRoot $repo -Candidate $altered | Out-Null } 'pinned/embedded source provenance mismatch'
$alteredBuild=$candidate.PSObject.Copy();$alteredBuild.NpmPackageTreeSha256=('f'*64)
Expect-Failure { Assert-QualifiedPrebuiltCandidate -ReleaseDirectory $release -RepoRoot $repo -Candidate $alteredBuild | Out-Null } 'pinned/embedded source provenance mismatch'
$incomplete=$candidate.PSObject.Copy();$incomplete.PSObject.Properties.Remove('ToolchainSha256')
Expect-Failure { Assert-QualifiedPrebuiltCandidate -ReleaseDirectory $release -RepoRoot $repo -Candidate $incomplete | Out-Null } 'provenance receipt is incomplete'

# Post-install acceptance keeps the same receipt binding; missing/tampered installed provenance
# cannot be silently accepted after an otherwise successful installer exit.
$installedRoot=Join-Path $root 'installed-future';$installedResources=Join-Path $installedRoot 'resources';$installedExtension=Join-Path $installedResources 'extension'
function Reset-InstalledFuture {
  if(Test-Path -LiteralPath $installedRoot){Remove-Item -LiteralPath $installedRoot -Recurse -Force}
  New-Item -ItemType Directory -Path $installedExtension -Force | Out-Null
  Copy-Item -LiteralPath (Join-Path $env:SystemRoot 'System32\\cmd.exe') -Destination (Join-Path $installedRoot 'Chat On Steroids.exe')
  [IO.File]::WriteAllText((Join-Path $installedResources 'app.asar'),'future-asar',[Text.UTF8Encoding]::new($false))
  [IO.File]::WriteAllText((Join-Path $installedExtension 'background.js'),'future-companion',[Text.UTF8Encoding]::new($false))
  [IO.File]::WriteAllText((Join-Path $installedExtension 'manifest.json'),'{"version":"9.9.9"}',[Text.UTF8Encoding]::new($false))
  [IO.File]::WriteAllText((Join-Path $installedResources 'CUSTOM_BUILD'),'fixture custom build',[Text.UTF8Encoding]::new($false))
  [IO.File]::WriteAllText((Join-Path $installedResources 'SOURCE_PROVENANCE.json'),$canonical,[Text.UTF8Encoding]::new($false))
}
Reset-InstalledFuture
$installedCandidate=$candidate.PSObject.Copy();$exeInfo=(Get-Item -LiteralPath (Join-Path $installedRoot 'Chat On Steroids.exe')).VersionInfo
$installedCandidate | Add-Member NoteProperty FileVersion ([string]$exeInfo.FileVersion)
$installedCandidate | Add-Member NoteProperty ProductVersion ([string]$exeInfo.ProductVersion)
$installedCandidate.AppExecutableSha256=Get-FileHashHex -Path (Join-Path $installedRoot 'Chat On Steroids.exe')
$installedCandidate | Add-Member NoteProperty AppAsarSha256 (Get-FileHashHex -Path (Join-Path $installedResources 'app.asar'))
$installedCandidate | Add-Member NoteProperty ExtensionBackgroundSha256 (Get-FileHashHex -Path (Join-Path $installedExtension 'background.js'))
$installedCandidate | Add-Member NoteProperty CustomBuildText 'fixture custom build'
$acceptedInstalled=Assert-InstalledQualifiedBuild -InstallRoot $installedRoot -Candidate $installedCandidate
if($acceptedInstalled.Version -cne '9.9.9'){throw 'future installed provenance fixture was not accepted'}
if($acceptedInstalled.AppExecutableSha256 -cne $installedCandidate.AppExecutableSha256){throw 'installed executable receipt was not exposed'}
if($acceptedInstalled.SourceProvenanceSha256 -cne $installedCandidate.SourceProvenanceSha256 -or $acceptedInstalled.GitCommit -cne $installedCandidate.GitCommit -or $acceptedInstalled.GitTree -cne $installedCandidate.GitTree){throw 'installed source receipt was not exposed'}
Remove-Item -LiteralPath (Join-Path $installedResources 'SOURCE_PROVENANCE.json')
Expect-Failure { Assert-InstalledQualifiedBuild -InstallRoot $installedRoot -Candidate $installedCandidate | Out-Null } 'missing required source provenance'
$otherJson=$other | ConvertTo-Json -Depth 20 -Compress
$otherInput=Join-Path $root 'other-provenance-input.json';[IO.File]::WriteAllText($otherInput,$otherJson,[Text.UTF8Encoding]::new($false))
$otherCanonicalPath=Join-Path $root 'OTHER_SOURCE_PROVENANCE.json';$null=@(& $nodeExe -e $canonicalJs $otherInput $otherCanonicalPath 2>&1);$otherCanonical=[IO.File]::ReadAllText($otherCanonicalPath)
if($LASTEXITCODE -ne 0){throw 'fixture alternate canonical provenance generation failed'}
[IO.File]::WriteAllText((Join-Path $installedResources 'SOURCE_PROVENANCE.json'),$otherCanonical,[Text.UTF8Encoding]::new($false))
Expect-Failure { Assert-InstalledQualifiedBuild -InstallRoot $installedRoot -Candidate $installedCandidate | Out-Null } 'Installed/pinned source provenance mismatch'
[IO.File]::WriteAllText((Join-Path $installedResources 'SOURCE_PROVENANCE.json'),$canonical,[Text.UTF8Encoding]::new($false))
$installedExe=Join-Path $installedRoot 'Chat On Steroids.exe'
$append=[IO.File]::Open($installedExe,[IO.FileMode]::Append,[IO.FileAccess]::Write,[IO.FileShare]::None);try{$append.WriteByte(0)}finally{$append.Dispose()}
Expect-Failure { Assert-InstalledQualifiedBuild -InstallRoot $installedRoot -Candidate $installedCandidate | Out-Null } 'Installed app executable hash mismatch'

# The same identity checks are the commit fence for activation: installer success is not enough.
# Invalid installed bytes/provenance must never reach the successor or mutate the pinned receipt;
# one exact valid synthetic tree still crosses the same owner exactly once.
$beforePinned=$script:QualifiedCandidate | ConvertTo-Json -Compress -Depth 20
$qualifiedFixture=[pscustomobject]@{InstallerPath=$installer}
Reset-InstalledFuture
$installedExe=Join-Path $installedRoot 'Chat On Steroids.exe'
$append=[IO.File]::Open($installedExe,[IO.FileMode]::Append,[IO.FileAccess]::Write,[IO.FileShare]::None);try{$append.WriteByte(0)}finally{$append.Dispose()}
$runnerCalls=0;$successorCalls=0
Expect-Failure {
  Invoke-QualifiedInstallerTransaction -Qualified $qualifiedFixture -InstallRoot $installedRoot -Candidate $installedCandidate -InstallerRunner { param($p) $script:runnerCalls += 1; return 0 } -SuccessorLauncher { param($p) $script:successorCalls += 1 } | Out-Null
} 'Installed app executable hash mismatch'
if($runnerCalls -ne 1 -or $successorCalls -ne 0){throw "invalid executable activation advanced runner=$runnerCalls successor=$successorCalls"}

Reset-InstalledFuture
[IO.File]::WriteAllText((Join-Path $installedResources 'SOURCE_PROVENANCE.json'),$otherCanonical,[Text.UTF8Encoding]::new($false))
$runnerCalls=0;$successorCalls=0
Expect-Failure {
  Invoke-QualifiedInstallerTransaction -Qualified $qualifiedFixture -InstallRoot $installedRoot -Candidate $installedCandidate -InstallerRunner { param($p) $script:runnerCalls += 1; return 0 } -SuccessorLauncher { param($p) $script:successorCalls += 1 } | Out-Null
} 'Installed/pinned source provenance mismatch'
if($runnerCalls -ne 1 -or $successorCalls -ne 0){throw "invalid provenance activation advanced runner=$runnerCalls successor=$successorCalls"}

Reset-InstalledFuture
$invalidIdentity=$installedCandidate.PSObject.Copy();$invalidIdentity.PSObject.Properties.Remove('AppExecutableSha256')
$runnerCalls=0;$successorCalls=0
Expect-Failure {
  Invoke-QualifiedInstallerTransaction -Qualified $qualifiedFixture -InstallRoot $installedRoot -Candidate $invalidIdentity -InstallerRunner { param($p) $script:runnerCalls += 1; return 0 } -SuccessorLauncher { param($p) $script:successorCalls += 1 } | Out-Null
} 'Qualified candidate executable hash receipt is missing or malformed'
if($runnerCalls -ne 1 -or $successorCalls -ne 0){throw "invalid qualified identity advanced runner=$runnerCalls successor=$successorCalls"}

Reset-InstalledFuture
$runnerCalls=0;$successorCalls=0
$transactionAccepted=Invoke-QualifiedInstallerTransaction -Qualified $qualifiedFixture -InstallRoot $installedRoot -Candidate $installedCandidate -InstallerRunner { param($p) $script:runnerCalls += 1; return 0 } -SuccessorLauncher { param($p) $script:successorCalls += 1 }
if($runnerCalls -ne 1 -or $successorCalls -ne 1 -or $transactionAccepted.AppExecutableSha256 -cne $installedCandidate.AppExecutableSha256){throw 'valid synthetic activation did not cross the same owner exactly once'}
$afterPinned=$script:QualifiedCandidate | ConvertTo-Json -Compress -Depth 20
if($beforePinned -cne $afterPinned){throw 'activation transaction mutated the pinned qualification receipt'}

# The current qualified receipt is provenance-bound. The sole legacy exception remains exact frozen SHA only;
# another same-version build cannot inherit it.
$currentPinned=Get-CandidatePinnedSourceProvenance -Candidate $script:QualifiedCandidate
if($null -eq $currentPinned -or $currentPinned.GitCommit -cne $script:QualifiedCandidate.GitCommit -or $currentPinned.GitTree -cne $script:QualifiedCandidate.GitTree){throw 'current qualified receipt lost its pinned provenance'}
if($null -ne (Assert-ProposalSourceProvenance -InstallerSha256 $script:LegacyProvenanceLessInstallerSha256 -EmbeddedProvenance $null -RepoRoot $repo)){throw 'legacy exception returned provenance'}
Expect-Failure { Assert-ProposalSourceProvenance -InstallerSha256 ('1'*64) -EmbeddedProvenance $null -RepoRoot $repo | Out-Null } 'Only exact frozen installer'
Expect-Failure { Assert-ProposalSourceProvenance -InstallerSha256 $script:LegacyProvenanceLessInstallerSha256 -EmbeddedProvenance $provenance -RepoRoot $repo | Out-Null } 'unexpectedly reported source provenance'
$sameVersionRebuild=[pscustomobject]@{InstallerSha256=('1'*64)}
Expect-Failure { Get-CandidatePinnedSourceProvenance -Candidate $sameVersionRebuild | Out-Null } 'provenance receipt is incomplete'
'future source provenance rehearsal passed'
`, 'utf8');

      const result = spawnSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', harness], {
        encoding: 'utf8', windowsHide: true, timeout: 120_000, cwd: repoRoot
      });
      expect(result.status, result.stderr || result.stdout).toBe(0);
      expect(result.stdout).toContain('future source provenance rehearsal passed');
      expect(result.stdout).toMatch(/GitCommit = '[0-9a-f]{40,64}'/);
      expect(result.stdout).toMatch(/GitTree = '[0-9a-f]{40,64}'/);
      expect(result.stdout).toContain('SourceDirty = $false');
      expect(result.stdout).toContain('PackageJsonSha256 =');
      expect(result.stdout).toContain('PackageLockSha256 =');
      expect(result.stdout).toContain('DependencyTreeSha256 =');
      expect(result.stdout).toContain('NpmPackageTreeSha256 =');
      expect(result.stdout).toContain('ShellExecutableSha256 =');
      expect(result.stdout).toContain('SevenZipTreeSha256 =');
      expect(result.stdout).toContain('ToolchainSha256 =');
      expect(result.stdout).toContain('AppExecutableSha256 =');
      expect(result.stdout.match(/installed payload matches the exact qualified candidate\./g) ?? []).toHaveLength(1);
      expect(result.stdout.match(/update installed\. Chat On Steroids is reopening with the same user data\./g) ?? []).toHaveLength(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 120_000);

  it('derives strict candidates from the reviewed snapshot and gates release publication behind verification and owned cleanup', () => {
    // The publication gate runs before this script-file invocation returns. It must retain
    // dynamic access to script-scoped Git helpers; GetNewClosure moves it into a fresh module
    // where those helpers disappear even though dot-sourced fixture tests can still see them.
    expect(readFileSync(installScript, 'utf8')).not.toMatch(/\$beforeCommit\s*=\s*\{[\s\S]*?\}\.GetNewClosure\(\)/);
    const root = mkdtempSync(path.join(tmpdir(), 'cos-strict-build-transaction-'));
    try {
      const harness = path.join(root, 'strict-build-transaction.ps1');
      writeFileSync(harness, `
$ErrorActionPreference='Stop'
. ${ps(installScript)}
$root=${ps(root)}
$repo=Join-Path $root 'repo'
$release=Join-Path $root 'release'
New-Item -ItemType Directory -Path $repo,$release | Out-Null
$git=Get-TrustedHostToolPath -Name git
function Invoke-FixtureGit([string[]]$GitArgs) {
  $output=@(& $git --no-replace-objects -C $repo @GitArgs 2>&1)
  if($LASTEXITCODE -ne 0){throw ('fixture git failed: ' + (($output|ForEach-Object{[string]$_}) -join ' '))}
  return (($output|ForEach-Object{[string]$_}) -join [Environment]::NewLine).Trim()
}
function Expect-Failure([scriptblock]$Action,[string]$Needle){
  try{& $Action;throw "expected failure containing: $Needle"}catch{if($_.Exception.Message -like '*expected failure containing:*' -or $_.Exception.Message -notlike "*$Needle*"){throw}}
}
Invoke-FixtureGit -GitArgs @('init','--quiet') | Out-Null
Invoke-FixtureGit -GitArgs @('config','user.name','Strict Build Test') | Out-Null
Invoke-FixtureGit -GitArgs @('config','user.email','strict-build@example.invalid') | Out-Null
[IO.File]::WriteAllText((Join-Path $repo '.gitignore'),'node_modules/',[Text.UTF8Encoding]::new($false))
[IO.File]::WriteAllText((Join-Path $repo 'source.txt'),'reviewed source',[Text.UTF8Encoding]::new($false))
Invoke-FixtureGit -GitArgs @('add','.gitignore','source.txt') | Out-Null
Invoke-FixtureGit -GitArgs @('commit','--quiet','-m','reviewed source') | Out-Null
New-Item -ItemType Directory -Path (Join-Path $repo 'node_modules') | Out-Null
[IO.File]::WriteAllText((Join-Path $repo 'node_modules\\poison.txt'),'mutable live dependency poison',[Text.UTF8Encoding]::new($false))
$reviewed=Get-ReviewedGitState -RepoRoot $repo
if($reviewed.dirty){throw 'strict fixture repo was unexpectedly dirty'}
[IO.File]::WriteAllText((Join-Path $release 'sentinel.txt'),'old-release-sentinel',[Text.UTF8Encoding]::new($false))
$script:repoPath=$repo
$script:reviewedCommit=$reviewed.commit
$script:reviewedTree=$reviewed.tree
$script:observedSnapshot=''
$script:published=$false
$packageRunner={
  param([string]$Snapshot)
  $snapshotState=Get-ReviewedGitState -RepoRoot $Snapshot
  if($snapshotState.commit -cne $script:reviewedCommit -or $snapshotState.tree -cne $script:reviewedTree -or $snapshotState.dirty){throw 'package runner did not receive exact reviewed snapshot'}
  if(Test-Path -LiteralPath (Join-Path $Snapshot 'node_modules')){throw 'live node_modules leaked into strict source snapshot'}
  $script:observedSnapshot=[IO.File]::ReadAllText((Join-Path $Snapshot 'source.txt'))
  [IO.File]::WriteAllText((Join-Path $script:repoPath 'source.txt'),'transient live mutation',[Text.UTF8Encoding]::new($false))
  if([IO.File]::ReadAllText((Join-Path $Snapshot 'source.txt')) -cne 'reviewed source'){throw 'live mutate influenced strict snapshot bytes'}
  [IO.File]::WriteAllText((Join-Path $script:repoPath 'source.txt'),'reviewed source',[Text.UTF8Encoding]::new($false))
  New-Item -ItemType Directory -Path (Join-Path $Snapshot 'release') | Out-Null
}
$verifier={param([string]$Snapshot,[string]$SnapshotRelease) [pscustomobject]@{LegacyProvenanceException=$false;SourceProvenance=[pscustomobject]@{commit=$script:reviewedCommit}}}
$publisher={
  param([string]$From,[string]$To,[scriptblock]$CommitGate)
  if([IO.File]::ReadAllText((Join-Path $To 'sentinel.txt')) -cne 'old-release-sentinel'){throw 'destination changed before commit gate'}
  $snapshotParent=Split-Path -Parent $From
  if(-not (Test-Path -LiteralPath $snapshotParent -PathType Container)){throw 'snapshot disappeared before commit gate'}
  & $CommitGate
  if(Test-Path -LiteralPath $snapshotParent){throw 'owned snapshot remained after commit gate'}
  if([IO.File]::ReadAllText((Join-Path $To 'sentinel.txt')) -cne 'old-release-sentinel'){throw 'destination changed during commit gate'}
  $script:published=$true
  'publisher-success-stream-noise'
}
$qualified=Invoke-StrictCandidateBuild -RepoRoot $repo -ReleaseDirectory $release -ReviewedSource $reviewed -PackageRunner $packageRunner -CandidateVerifier $verifier -Publisher $publisher
if(-not $qualified -or $qualified -is [array] -or -not $script:published -or $script:observedSnapshot -cne 'reviewed source'){throw 'strict snapshot success rehearsal failed'}
if((Get-ReviewedGitState -RepoRoot $repo).dirty){throw 'mutate/revert rehearsal left live checkout dirty'}

# The trusted Node wrapper must ignore caller PATH and pre-load injection before the JS owner starts.
$oldPath=$env:PATH;$oldNodeOptions=$env:NODE_OPTIONS;$oldNodePath=$env:NODE_PATH
try{
  $env:PATH='Z:\\hostile-path-that-does-not-exist'
  $env:NODE_OPTIONS='--require Z:\\hostile-preload.js'
  $env:NODE_PATH='Z:\\hostile-node-path'
  $nodeResult=Invoke-TrustedNodeCaptured -Arguments @('-e',"process.stdout.write('trusted-node-ok')")
  if($nodeResult.ExitCode -ne 0 -or (($nodeResult.Output|ForEach-Object{[string]$_}) -join '') -cne 'trusted-node-ok'){throw 'trusted Node wrapper accepted caller loader/tool redirects'}
}finally{$env:PATH=$oldPath;$env:NODE_OPTIONS=$oldNodeOptions;$env:NODE_PATH=$oldNodePath}

# Package/dependency or compile failure cannot reach publication.
$script:publishCount=0
$failPublisher={param($From,$To,$Gate) $script:publishCount++; & $Gate}
Expect-Failure { Invoke-StrictCandidateBuild -RepoRoot $repo -ReleaseDirectory $release -ReviewedSource $reviewed -PackageRunner {param($Snapshot) throw 'fixture offline dependency failure'} -CandidateVerifier $verifier -Publisher $failPublisher | Out-Null } 'fixture offline dependency failure'
if($script:publishCount -ne 0 -or [IO.File]::ReadAllText((Join-Path $release 'sentinel.txt')) -cne 'old-release-sentinel'){throw 'package failure reached release publication'}

# Attestation/proposal verification failure cannot reach publication.
$script:publishCount=0
$prepareRelease={param($Snapshot) New-Item -ItemType Directory -Path (Join-Path $Snapshot 'release') | Out-Null}
Expect-Failure { Invoke-StrictCandidateBuild -RepoRoot $repo -ReleaseDirectory $release -ReviewedSource $reviewed -PackageRunner $prepareRelease -CandidateVerifier {param($Snapshot,$SnapshotRelease) throw 'fixture attestation verification failure'} -Publisher $failPublisher | Out-Null } 'fixture attestation verification failure'
if($script:publishCount -ne 0){throw 'attestation failure reached release publication'}

# Live source drift after the snapshot was reviewed blocks publication and the fixture restores it afterward.
$script:publishCount=0
$driftRunner={param($Snapshot) New-Item -ItemType Directory -Path (Join-Path $Snapshot 'release') | Out-Null;[IO.File]::WriteAllText((Join-Path $script:repoPath 'source.txt'),'live drift',[Text.UTF8Encoding]::new($false))}
try{Expect-Failure { Invoke-StrictCandidateBuild -RepoRoot $repo -ReleaseDirectory $release -ReviewedSource $reviewed -PackageRunner $driftRunner -CandidateVerifier $verifier -Publisher $failPublisher | Out-Null } 'Live reviewed source changed before candidate publication'}finally{[IO.File]::WriteAllText((Join-Path $repo 'source.txt'),'reviewed source',[Text.UTF8Encoding]::new($false))}
if($script:publishCount -ne 0 -or (Get-ReviewedGitState -RepoRoot $repo).dirty){throw 'live drift case published or failed to restore fixture'}

# Snapshot cleanup failure occurs inside the commit gate and cannot mutate canonical release bytes.
$script:commitMutation=$false;$script:removeCalls=0
$cleanupFailPublisher={param($From,$To,$Gate) if([IO.File]::ReadAllText((Join-Path $To 'sentinel.txt')) -cne 'old-release-sentinel'){throw 'sentinel changed before cleanup gate'};& $Gate;$script:commitMutation=$true}
$cleanupFailRemover={param($OwnedRoot) $script:removeCalls++;if($script:removeCalls -eq 1){throw 'fixture snapshot cleanup failure'};if(Test-Path -LiteralPath $OwnedRoot){Remove-Item -LiteralPath $OwnedRoot -Recurse -Force}}
Expect-Failure { Invoke-StrictCandidateBuild -RepoRoot $repo -ReleaseDirectory $release -ReviewedSource $reviewed -PackageRunner $prepareRelease -CandidateVerifier $verifier -Publisher $cleanupFailPublisher -SnapshotRemover $cleanupFailRemover | Out-Null } 'snapshot cleanup failure'
if($script:commitMutation -or $script:removeCalls -lt 1 -or [IO.File]::ReadAllText((Join-Path $release 'sentinel.txt')) -cne 'old-release-sentinel'){throw 'cleanup failure crossed release commit boundary'}

# The real publisher stages/verifies fully before its gate; a gate failure leaves old canonical bytes exact.
$sourceRelease=Join-Path $root 'source-release';$destinationRelease=Join-Path $root 'destination-release'
New-Item -ItemType Directory -Path (Join-Path $sourceRelease 'win-unpacked'),(Join-Path $destinationRelease 'win-unpacked') -Force | Out-Null
foreach($name in @('Chat-On-Steroids-Setup-x64.exe','Chat-On-Steroids-Setup-x64.exe.blockmap','latest.yml')){[IO.File]::WriteAllText((Join-Path $sourceRelease $name),('new-' + $name),[Text.UTF8Encoding]::new($false));[IO.File]::WriteAllText((Join-Path $destinationRelease $name),('old-' + $name),[Text.UTF8Encoding]::new($false))}
[IO.File]::WriteAllText((Join-Path $sourceRelease 'win-unpacked\\payload.txt'),'new-payload',[Text.UTF8Encoding]::new($false))
[IO.File]::WriteAllText((Join-Path $destinationRelease 'win-unpacked\\payload.txt'),'old-payload',[Text.UTF8Encoding]::new($false))
Expect-Failure { Publish-StrictCandidateRelease -SourceReleaseDirectory $sourceRelease -DestinationReleaseDirectory $destinationRelease -BeforeCommit { throw 'fixture commit gate refusal' } } 'fixture commit gate refusal'
if([IO.File]::ReadAllText((Join-Path $destinationRelease 'latest.yml')) -ne 'old-latest.yml' -or [IO.File]::ReadAllText((Join-Path $destinationRelease 'win-unpacked\\payload.txt')) -ne 'old-payload'){throw 'publisher changed canonical release before commit gate'}
if(@(Get-ChildItem -LiteralPath $destinationRelease -Force | Where-Object {$_.Name -like '.cos-candidate-*'}).Count -ne 0){throw 'publisher gate failure left owned staging debris'}

# A post-gate staged-byte tamper is detected after commit and rolls the entire prior release set back.
Expect-Failure {
  Publish-StrictCandidateRelease -SourceReleaseDirectory $sourceRelease -DestinationReleaseDirectory $destinationRelease -BeforeCommit {
    $incoming=@(Get-ChildItem -LiteralPath $destinationRelease -Force | Where-Object {$_.PSIsContainer -and $_.Name -like '.cos-candidate-incoming-*'})
    if($incoming.Count -ne 1){throw 'fixture could not locate the single incoming release'}
    [IO.File]::WriteAllText((Join-Path $incoming[0].FullName 'latest.yml'),'tampered-after-gate',[Text.UTF8Encoding]::new($false))
  }
} 'published hash mismatch'
if([IO.File]::ReadAllText((Join-Path $destinationRelease 'latest.yml')) -ne 'old-latest.yml' -or [IO.File]::ReadAllText((Join-Path $destinationRelease 'win-unpacked\\payload.txt')) -ne 'old-payload'){throw 'publication verification failure did not restore prior release'}
if(@(Get-ChildItem -LiteralPath $destinationRelease -Force | Where-Object {$_.Name -like '.cos-candidate-*'}).Count -ne 0){throw 'publication rollback left owned staging debris'}

# The same real publisher succeeds once the commit gate is clean and leaves no backup/incoming debris.
$script:realCommitGate=0
Publish-StrictCandidateRelease -SourceReleaseDirectory $sourceRelease -DestinationReleaseDirectory $destinationRelease -BeforeCommit { $script:realCommitGate++ }
if($script:realCommitGate -ne 1 -or [IO.File]::ReadAllText((Join-Path $destinationRelease 'latest.yml')) -ne 'new-latest.yml' -or [IO.File]::ReadAllText((Join-Path $destinationRelease 'win-unpacked\\payload.txt')) -ne 'new-payload'){throw 'verified publication did not commit exact new release'}
if(@(Get-ChildItem -LiteralPath $destinationRelease -Force | Where-Object {$_.Name -like '.cos-candidate-*'}).Count -ne 0){throw 'successful publication left owned staging debris'}

'strict build transaction rehearsal passed'
`, 'utf8');
      const result = spawnSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', harness], {
        encoding: 'utf8', windowsHide: true, timeout: 120_000, cwd: repoRoot
      });
      expect(result.status, result.stderr || result.stdout).toBe(0);
      expect(result.stdout).toContain('strict build transaction rehearsal passed');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 120_000);

  it.runIf(hasPinnedReleaseFixture)('proposes qualification from the exact installer payload without mutating the pinned receipt or touching install paths', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'cos-qualification-proposal-'));
    try {
      const reviewRoot = path.join(root, 'review');
      const clone = spawnSync('git.exe', ['clone', '--local', '--no-hardlinks', '--no-checkout', '--', repoRoot, reviewRoot], {
        encoding: 'utf8', windowsHide: true, timeout: 180_000
      });
      expect(clone.status, clone.stderr || clone.stdout).toBe(0);
      const checkout = spawnSync('git.exe', ['-C', reviewRoot, 'checkout', '--detach', pinnedGitCommit, '--'], {
        encoding: 'utf8', windowsHide: true, timeout: 180_000
      });
      expect(checkout.status, checkout.stderr || checkout.stdout).toBe(0);
      symlinkSync(path.join(repoRoot, 'node_modules'), path.join(reviewRoot, 'node_modules'), 'junction');
      const command = [
        "$ErrorActionPreference='Stop'",
        '. ' + ps(installScript),
        '$release=' + ps(releaseRoot),
        '$before=$script:QualifiedCandidate | ConvertTo-Json -Compress',
        '$proposal=Invoke-CustomInstall -ProposeQualification' +
          // Isolate this read-only fixture from real build/install transactions.
          " -OperationLockName ('Local\\COSQualificationProposal-' + [guid]::NewGuid().ToString('N'))" +
          ' -RepoRoot ' + ps(reviewRoot) +
          ' -ReleaseDirectory $release' +
          " -InstallRoot 'Z:\\\\must-not-read-install'" +
          " -RollbackArchivePath 'Z:\\\\must-not-read-rollback.zip'" +
          " -ProcessProbe { throw 'proposal must not probe processes' }" +
          " -SleepAction { throw 'proposal must not wait' }" +
          " -InstallerRunner { throw 'proposal must not invoke installer' }" +
          " -SuccessorLauncher { throw 'proposal must not launch successor' }" +
          " -ArchiveExtractor { throw 'proposal must not stage rollback' }" +
          " -MoveDirectory { throw 'proposal must not move directories' }" +
          " -RemoveDirectory { throw 'proposal must not remove directories' }",
        '$after=$script:QualifiedCandidate | ConvertTo-Json -Compress',
        "if($before -cne $after){throw 'proposal mutated pinned receipt'}",
        "foreach($name in @('Version','InstallerFile','InstallerSize','InstallerSha256','InstallerSha512','LatestYmlSha256','ReleaseDate','AppAsarSha256','ExtensionBackgroundSha256','FileVersion','ProductVersion','CustomBuildText')){if([string]$proposal.$name -cne [string]$script:QualifiedCandidate.$name){throw ('proposal field mismatch: ' + $name)}}",
        "$unpacked=Get-DirectoryFingerprint -Root (Join-Path $release 'win-unpacked')",
        "if($proposal.PayloadFileCount -ne $unpacked.FileCount -or [int64]$proposal.PayloadTotalBytes -ne [int64]$unpacked.TotalBytes -or $proposal.PayloadTreeSha256 -cne $unpacked.TreeSha256){throw 'proposal payload fingerprint does not match current package projection'}",
        "if($proposal.UnpackedCrossCheck -cne 'exact'){throw 'proposal did not prove win-unpacked equals installer payload'}",
        "if($proposal.LegacyProvenanceException){throw 'current pinned candidate unexpectedly used legacy provenance exception'}",
        "if($proposal.SourceProvenance.commit -cne $script:QualifiedCandidate.GitCommit -or $proposal.SourceProvenance.tree -cne $script:QualifiedCandidate.GitTree){throw 'proposal source identity does not match pinned reviewed candidate'}",
        "'qualification-proposal-ok'"
      ].join('; ');
      const result = spawnSync(
        'powershell.exe',
        ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', command],
        { encoding: 'utf8', windowsHide: true, timeout: 600_000, cwd: repoRoot }
      );
      expect(result.status, result.stderr || result.stdout).toBe(0);
      expect(result.stdout).toContain('QUALIFICATION PROPOSAL ONLY');
      expect(result.stdout).toContain('qualification-proposal-ok');
      expect(result.stdout).toContain("InstallerSha256 = '");
      expect(result.stdout).toContain("AppAsarSha256 = '");
      expect(result.stdout).toContain("GitCommit = '");
      expect(result.stdout).toContain("GitTree = '");

      const mismatchCommand = [
        "$ErrorActionPreference='Stop'",
        '. ' + ps(installScript),
        '$version=(Read-UnqualifiedCandidateMetadata -ReleaseDirectory ' + ps(releaseRoot) + ').Version',
        "$marker=(Get-Content -Raw -LiteralPath (Join-Path " + ps(repoRoot) + " 'CUSTOM_BUILD')).TrimEnd()",
        "$bad={param($InstallerPath,$Root,$ReleaseDirectory) [pscustomobject]@{FileVersion=$version;ProductVersion=($version+'.0');ExtensionVersion='0.0.0';AsarPackageVersion=$version;AppAsarSha256=('a'*64);ExtensionBackgroundSha256=('b'*64);CustomBuildText=$marker;FileCount=1;TotalBytes=[int64]1;TreeSha256=('c'*64);UnpackedCrossCheck='absent'}}",
        "try{Get-CandidateQualificationProposal -RepoRoot " + ps(repoRoot) + ' -ReleaseDirectory ' + ps(releaseRoot) + " -PayloadReader $bad | Out-Null; throw 'mismatch was accepted'}catch{if($_.Exception.Message -like '*mismatch was accepted*' -or $_.Exception.Message -notlike '*companion version*'){throw}}",
        "'qualification-mismatch-ok'"
      ].join('; ');
      const mismatch = spawnSync(
        'powershell.exe',
        ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', mismatchCommand],
        { encoding: 'utf8', windowsHide: true, timeout: 30_000, cwd: repoRoot }
      );
      expect(mismatch.status, mismatch.stderr || mismatch.stdout).toBe(0);
      expect(mismatch.stdout).toContain('qualification-mismatch-ok');

      const asarMismatchCommand = [
        "$ErrorActionPreference='Stop'",
        '. ' + ps(installScript),
        '$version=(Read-UnqualifiedCandidateMetadata -ReleaseDirectory ' + ps(releaseRoot) + ').Version',
        "$marker=(Get-Content -Raw -LiteralPath (Join-Path " + ps(repoRoot) + " 'CUSTOM_BUILD')).TrimEnd()",
        "$bad={param($InstallerPath,$Root,$ReleaseDirectory) [pscustomobject]@{FileVersion=$version;ProductVersion=($version+'.0');ExtensionVersion=$version;AsarPackageVersion='0.0.0';AppAsarSha256=('a'*64);ExtensionBackgroundSha256=('b'*64);CustomBuildText=$marker;FileCount=1;TotalBytes=[int64]1;TreeSha256=('c'*64);UnpackedCrossCheck='absent'}}",
        "try{Get-CandidateQualificationProposal -RepoRoot " + ps(repoRoot) + ' -ReleaseDirectory ' + ps(releaseRoot) + " -PayloadReader $bad | Out-Null; throw 'asar mismatch was accepted'}catch{if($_.Exception.Message -like '*asar mismatch was accepted*' -or $_.Exception.Message -notlike '*app.asar package version*'){throw}}",
        "'qualification-asar-mismatch-ok'"
      ].join('; ');
      const asarMismatch = spawnSync(
        'powershell.exe',
        ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', asarMismatchCommand],
        { encoding: 'utf8', windowsHide: true, timeout: 30_000, cwd: repoRoot }
      );
      expect(asarMismatch.status, asarMismatch.stderr || asarMismatch.stdout).toBe(0);
      expect(asarMismatch.stdout).toContain('qualification-asar-mismatch-ok');

      const mismatchedRelease = path.join(root, 'mismatched-release');
      const mismatchedUnpacked = path.join(mismatchedRelease, 'win-unpacked');
      mkdirSync(mismatchedUnpacked, { recursive: true });
      writeFileSync(path.join(mismatchedUnpacked, 'sentinel.txt'), 'not-the-installer-payload', 'utf8');
      const mismatchProjectionCommand = [
        "$ErrorActionPreference='Stop'",
        '. ' + ps(installScript),
        'Read-InstallerCandidatePayloadIdentity' +
          ' -InstallerPath ' + ps(path.join(releaseRoot, 'Chat-On-Steroids-Setup-x64.exe')) +
          // Reproduce the qualified installer's build inputs from its pinned reviewed source.
          // The live checkout is intentionally allowed to move on after qualification; using it
          // here lets ordinary source development fail before this fixture reaches the exact
          // win-unpacked-vs-installer projection boundary it is meant to exercise.
          ' -RepoRoot ' + ps(reviewRoot) +
          ' -ReleaseDirectory ' + ps(mismatchedRelease)
      ].join('; ');
      const mismatchProjection = spawnSync(
        'powershell.exe',
        ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', mismatchProjectionCommand],
        // This intentionally re-extracts and fingerprints the exact installer rather than
        // trusting the earlier proposal. On a loaded Windows host, Defender may serialize
        // those two independent archive scans for several minutes.
        { encoding: 'utf8', windowsHide: true, timeout: 600_000, cwd: repoRoot }
      );
      expect(mismatchProjection.status).not.toBe(0);
      expect(String(mismatchProjection.stderr) + String(mismatchProjection.stdout)).toContain(
        'win-unpacked does not match the payload embedded in the exact installer'
      );

      const fakeSevenZip = path.join(root, 'fake-7z.cmd');
      writeFileSync(
        fakeSevenZip,
        '@echo off\r\necho ----------\r\necho Path = ..\\escape.txt\r\nexit /b 0\r\n',
        'utf8'
      );
      const unsafeArchiveCommand = [
        "$ErrorActionPreference='Stop'",
        '. ' + ps(installScript),
        'Assert-SevenZipArchiveEntriesSafe' +
          ' -SevenZipPath ' + ps(fakeSevenZip) +
          " -ArchivePath 'ignored.7z'" +
          ' -DestinationRoot ' + ps(path.join(root, 'safe-destination'))
      ].join('; ');
      const unsafeArchive = spawnSync(
        'powershell.exe',
        ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', unsafeArchiveCommand],
        { encoding: 'utf8', windowsHide: true, timeout: 30_000, cwd: repoRoot }
      );
      expect(unsafeArchive.status).not.toBe(0);
      expect(String(unsafeArchive.stderr) + String(unsafeArchive.stdout)).toContain('unsafe path entry');
    } finally {
      // Real installer extraction can finish its last filesystem notification just after the
      // synchronous verifier exits. Retry only this owned temporary root instead of turning a
      // successful qualification into Windows ENOTEMPTY cleanup noise.
      rmSync(root, { recursive: true, force: true, maxRetries: 30, retryDelay: 250 });
    }
  }, 1_500_000);
});
