[CmdletBinding()]
param(
  [switch]$LaunchInstaller,
  [switch]$WaitForSafeQuit,
  [switch]$QualifiedPrebuilt,
  [switch]$ProposeQualification,
  [switch]$ProposeInstalledPredecessor,
  [string]$AcceptedPackageReceiptPath,
  [switch]$Rollback
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# This receipt deliberately lives in the canonical custom-install owner rather than beside the
# generated release metadata. A later same-version rebuild can overwrite both the installer and
# latest.yml, so those two files cannot prove that they are still the candidate qualified earlier.
$script:QualifiedCandidate = [pscustomobject]@{
  Version = '2.1.39'
  InstallerFile = 'Chat-On-Steroids-Setup-x64.exe'
  InstallerSize = [int64]161966317
  InstallerSha256 = '07c1d2e6703847a802fa95ca40a9ff540301395e2ad8e1180e691c6ae64169cb'
  InstallerSha512 = 'wdjIbQQ8Eh0Ytgokj8PEfk/pDupc1lh3+jcdrB074TlYTE+B7Qxuq/OZo7g3e8mLLqXmOgNcj2PkRtBj8WQv9g=='
  LatestYmlSha256 = 'b1416547f5e159cca2729894866303a4934087593c86271aefcb47bb27195b01'
  ReleaseDate = '2026-10-30T00:31:24.000Z'
  AppExecutableSha256 = 'ee27769bbc18874067b8f5090689471f5e7c15b34d6fcd16459c24d49d4de7ed'
  AppAsarSha256 = '105f194555778a57445a5ab16ca82c745ae383312c699206a1d842acc06cd6c8'
  ExtensionBackgroundSha256 = 'd6c6c4a0be9d275727f5a8d46597df4f76c24b1ea538b6cb00523047b3766b65'
  FileVersion = '2.1.39'
  ProductVersion = '2.1.39.0'
  CustomBuildText = 'Chat On Steroids local custom build. Update through scripts/update-custom.ps1 and reinstall from this checkout.'
  SourceProvenanceSha256 = 'bc5c3a82ab221c58e46c300d960f830706b3170b01274219540eb2e7293e399f'
  SourceProvenanceSchema = 2
  GitObjectFormat = 'sha1'
  GitCommit = 'c072874ffb799973585aa3f795597bf4c91c23aa'
  GitTree = '860a0d7121d010acaaf9ff7eee5bdc6323a0d3cf'
  SourceDirty = $false
  StrictBuild = $true
  PackageJsonSha256 = 'd8732af0620064ae96a51d5a63cb1e93ceaae4a037a696a0e82a21a910af7ae4'
  PackageLockSha256 = '6c654cd53e269f6c7353b625a696bfaf6d26ce9340bed9018c78a52cbb9d6232'
  LockfileVersion = 3
  DependencyFileCount = 16047
  DependencyTotalBytes = 689782328
  DependencyTreeSha256 = '18e1b630c8d7c078a063a049c0c3b022961df9a4a53ab7f395931924defa31bf'
  NodeVersion = 'v24.19.0'
  NodeExecutableSha256 = '3602f2bb1a10f2cbab4c36886218a33c1ab3db87290e73b033c46c77147d0237'
  NpmVersion = '11.17.0'
  NpmCliSha256 = '3ce7cba6f5128dd5f54c98b6a5036b0f850496878cc2e21044b675fe3c594e3e'
  NpmCommandShimSha256 = '21b46c69ad6e2f231f02a9e120f4ba6c8e75fef5a45637103002eab99f888ab8'
  NpmPackageFileCount = 1976
  NpmPackageTotalBytes = 13014927
  NpmPackageTreeSha256 = '116a442a738739b8af9478f51aecd6eff70ceefb6b8fab5d9f0240b72b91c3ba'
  ElectronVersion = '44.3.0'
  ElectronPackageJsonSha256 = '6c37c4f6769de55f46b300556dfccf732ccd101fb57e810f178346535535e9b3'
  ElectronEntrySha256 = '186a8ffa8cfea268bfef39569a145f8122d662db1ac4c022f3ef60bb4c894cc5'
  ElectronRuntimeSha256 = 'e048632e03fabc96de5e10afbebc0aa31f4e1674155ea3d270597fe7523f9d80'
  ElectronArchiveSha256 = '26bf9a617d58d81772b3d68305d59ee48272969c15083c06db634a77358a8d9d'
  ElectronBuilderVersion = '26.17.0'
  ElectronBuilderPackageJsonSha256 = '64d156a9b0bc529681a1f5cbe2d399184918a8c7c0f3fa8e5d1c87631c322577'
  ElectronBuilderEntrySha256 = '123156f270e46814973272ea1cbd132b60ecee4e2620c59c030612eeb9e4cfcf'
  ElectronViteVersion = '5.0.0'
  ElectronVitePackageJsonSha256 = '76a61d3f06a16c4b0f7de7f0915e5c251de0060a75b3259ef3da2a5125b4ecca'
  ElectronViteEntrySha256 = 'ad30ff88bd2f1e47bd97ce2de24d55897b5177ac791bb63e0ebba885cc72c444'
  ViteVersion = '7.3.6'
  VitePackageJsonSha256 = 'e5ed0f85215f871fe22a48987dcd77fcfbe14064a53c0c9f7f48186a6b7e2cf0'
  ViteEntrySha256 = 'fa03478846d229651a3c6aa64833ba2c6cbf580a798b92bd8f47c7480bafb5d8'
  TypeScriptVersion = '7.0.2'
  TypeScriptPackageJsonSha256 = '3722b30210616a13a3213ded11575ba6b2dbab10c32a5ef67afca8513e27017e'
  TypeScriptEntrySha256 = '2219f428a7e55aaf1f7ad85b9b0f0cf5078aeb76ccc9a7c6036c92d48f492ffd'
  GitExecutableVersion = 'git version 2.49.0.windows.1'
  GitExecutableSha256 = 'fec691d80fccc35fcc309fbc9f720536c1d795b8a562ec169f28c9923da9600f'
  TarExecutableVersion = 'bsdtar 3.5.2 - libarchive 3.5.2 zlib/1.2.5.f-ipp'
  TarExecutableSha256 = 'dfef7a04a700b8c9a1d6249dc995c2e91a4be7583d5b534ed4c9aec546616478'
  ShellExecutableVersion = 'Microsoft Windows [Version 10.0.19045.6466]'
  ShellExecutableSha256 = 'badf4752413cb0cbdc03fb95820ca167f0cdc63b597ccdb5ef43111180e088b0'
  SevenZipArchiveSha256 = 'be071f15bd6da2f78fe81c6ddef2009b0c4d8a51f36b780cb806c7e6df95e1b3'
  SevenZipFileCount = 4
  SevenZipTotalBytes = 883344
  SevenZipTreeSha256 = '6c301205c05337773c96d1b536629cd542c0eae0e3e4c65a25ed8af850d173f9'
  SevenZipExecutableSha256 = '223b873c50380fe9a39f1a22b6abf8d46db506e1c08d08312902f6f3cd1f7ac3'
  NsisArchiveSha256 = '9877df902530f96357d13a7a31ae2b9df67f48b11ffc9a1700a7c961574ec5fa'
  NsisFileCount = 343
  NsisTotalBytes = 7280179
  NsisTreeSha256 = '8c812a039d30cbb27b6198426b096562565f5f78519e0fb297b8fc5131c6d4f4'
  NsisExecutableSha256 = 'e277b7378931b74392015f5ad6b1d744dcd8a347baa4480350a75ebeab8d8e3d'
  NsisResourcesArchiveSha256 = '593a9a92ef958321293ac6a2ee61e64bf1bd543142a5bd6b3d310709cc924103'
  NsisResourcesFileCount = 22
  NsisResourcesTotalBytes = 2998788
  NsisResourcesTreeSha256 = '0eb6dd32d6020792e2a8a56f2b68a241c73b1ab4fda80b80360fb3350324aac4'
  ToolchainSha256 = 'f381472c32c789093053874b35b7da7eacff0685eeaa037079aa09322418638e'
}

# The already-frozen 2.1.14 installer predates embedded Git provenance. Only these exact immutable
# bytes may omit it. A rebuilt 2.1.14 (or any other candidate) has a different SHA-256 and therefore
# must satisfy the current provenance contract rather than inheriting a version-wide exception.
$script:LegacyProvenanceLessInstallerSha256 = '8d48c1f521e1186f6a8353b103c6e73839c832b84290f0fff8ef02ca6003796b'
# The already-pinned 2.1.15 receipt predates per-executable post-install hashing. Preserve only
# those exact installer bytes as the compatibility boundary; every newly qualified candidate must
# carry the executable hash read from its embedded payload so installed-binary identity is exact.
$script:LegacyExecutableHashlessInstallerSha256 = '3712bf47815ad5a328962c5b77352dd1116f3c0701ff9eb5123932362c7d8161'
$script:SourceProvenanceSchema = 2
$script:SourceProvenanceRelativePath = 'resources\SOURCE_PROVENANCE.json'

# Exact byte-for-byte snapshot of the currently installed private 2.1.13 program directory,
# captured copy-only on 2026-09-17 while the live process kept running. This is deliberately not
# rebuilt from source and does not contain Electron userData. The archive itself lives outside the
# install directory so replacing %LOCALAPPDATA%\Programs\Chat On Steroids cannot destroy rollback.
$script:RollbackBaseline = [pscustomobject]@{
  Version = '2.1.13'
  ArchiveDirectory = 'Chat On Steroids Custom Backups'
  ArchiveFile = 'private-2.1.13-program.zip'
  ArchiveSize = [int64]213217211
  ArchiveSha256 = 'cb91210097489cc19a457d3bd3953d4c9a08dc51fa33f688f15ae4bf967be9c9'
  FileCount = 305
  TotalBytes = [int64]567895292
  TreeSha256 = 'bca387f859addc518a7001d2803c028c240f5354c6ea7c9b5ce1c4f70105c78d'
  FileVersion = '2.1.13'
  ProductVersion = '2.1.13.0'
  ExeSha256 = '0ac2848d01b2903716bff0cee51ae4c065ae5e59395621e0cfa5c170e0d9dcc3'
  AppAsarSha256 = '74d5cb9cde874864775ef8a3fe93136d97985f9e29e18d8201106963469286cd'
  BundledMainSha256 = 'ddadc6b1a7fcf98500a1c28da329404f04dc842a45082348947be91a8a769d99'
  ExtensionVersion = '2.1.13'
  ExtensionBackgroundSha256 = '85afbbb62680ee32f704c40a64d4f61c8d0af5f9915174f41c6c11235cbd303e'
  CustomBuildText = 'Chat On Steroids local custom build. Update through scripts/update-custom.ps1 and reinstall from this checkout.'
}

# Exact installed predecessor accepted for this private update. The frozen 2.1.13
# archive remains the rollback authority; this record grants only the right to cross the install
# boundary from the exact previously qualified 2.1.39 program currently on this machine. It covers
# the complete installed program tree and the embedded source record, never Electron userData.
$script:InstalledUpgradeBaseline = [pscustomobject]@{
  Version = '2.1.39'
  SafeCloseForUpdate = $true
  FileCount = 291
  TotalBytes = 571507249
  TreeSha256 = '0ee50259882c014bc11dce808255603028b2a135ea536cb26b75287b27651117'
  FileVersion = '2.1.39'
  ProductVersion = '2.1.39.0'
  ExeSha256 = 'ee27769bbc18874067b8f5090689471f5e7c15b34d6fcd16459c24d49d4de7ed'
  AppAsarSha256 = '105f194555778a57445a5ab16ca82c745ae383312c699206a1d842acc06cd6c8'
  ExtensionVersion = '2.1.39'
  ExtensionBackgroundSha256 = '81100d5e0531eee79155898f964a8d1eb756e7fa30943fede19d6a0ed72eedbc'
  SourceProvenanceSha256 = '914fcf6c9af72362fb1da3831df793b14d8a53e3298363b1d74e699a0a2f6c58'
  CustomBuildText = 'Chat On Steroids local custom build. Update through scripts/update-custom.ps1 and reinstall from this checkout.'
}

function Invoke-Checked {
  param([Parameter(Mandatory)][string]$File, [Parameter(Mandatory)][string[]]$Arguments)
  Write-Host "[custom-install] $File $($Arguments -join ' ')"
  & $File @Arguments
  if ($LASTEXITCODE -ne 0) { throw "$File exited with code $LASTEXITCODE" }
}

function Get-FileHashHex {
  param(
    [Parameter(Mandatory)][string]$Path,
    [ValidateSet('SHA256', 'SHA512')][string]$Algorithm = 'SHA256'
  )
  $stream = [System.IO.File]::OpenRead($Path)
  try {
    $hasher = if ($Algorithm -eq 'SHA512') {
      [System.Security.Cryptography.SHA512]::Create()
    } else {
      [System.Security.Cryptography.SHA256]::Create()
    }
    try {
      return ([BitConverter]::ToString($hasher.ComputeHash($stream))).Replace('-', '').ToLowerInvariant()
    } finally {
      $hasher.Dispose()
    }
  } finally {
    $stream.Dispose()
  }
}

# The caller composes this checkpoint around its existing NSIS owner. A process
# exit alone never proves that protected native state was captured or verified.
function Invoke-NativeStateBackupCheckpoint {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory)][ValidateSet('capture', 'verify')][string]$Mode,
    [Parameter(Mandatory)][string]$NodePath,
    [Parameter(Mandatory)][string]$ScriptPath,
    [Parameter(Mandatory)][string]$ExpectedScriptSha256,
    [Parameter(Mandatory)][string]$SourceRoot,
    [Parameter(Mandatory)][string]$BackupRoot,
    [Parameter(Mandatory)][string]$EvidencePrefix,
    [string]$SeedRoot,
    [string]$SeedDigest,
    [string]$ExpectedManifestDigest,
    [scriptblock]$ProcessRunner
  )
  $Mode = $Mode.ToLowerInvariant()
  $fullPath = {
    param([string]$Value)
    if ([string]::IsNullOrWhiteSpace($Value) -or -not [IO.Path]::IsPathRooted($Value) -or
        $Value.Contains([char]0) -or $Value.Contains([char]10) -or $Value.Contains([char]13)) {
      throw 'Native state checkpoint requires explicit absolute paths.'
    }
    $resolved = [IO.Path]::GetFullPath($Value)
    if ($resolved.Length -gt [IO.Path]::GetPathRoot($resolved).Length) { $resolved = $resolved.TrimEnd('\', '/') }
    return $resolved
  }
  $sourceFull = & $fullPath $SourceRoot
  $backupFull = & $fullPath $BackupRoot
  $nodeFull = & $fullPath $NodePath
  $scriptFull = & $fullPath $ScriptPath
  $evidenceFull = & $fullPath $EvidencePrefix
  $manifestPath = Join-Path $backupFull 'manifest.json'
  if (-not (Test-Path -LiteralPath $sourceFull -PathType Container) -or
      $sourceFull.Equals($backupFull, [StringComparison]::OrdinalIgnoreCase) -or
      $backupFull.StartsWith($sourceFull.TrimEnd('\', '/') + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase) -or
      $sourceFull.StartsWith($backupFull.TrimEnd('\', '/') + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
    throw 'Native state checkpoint source/backup roots are missing, equal or nested.'
  }
  foreach ($file in @($nodeFull, $scriptFull)) {
    if (-not (Test-Path -LiteralPath $file -PathType Leaf) -or
        ((Get-Item -LiteralPath $file -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)) {
      throw "Native state checkpoint executable/utility must be a regular file: $file"
    }
  }
  if ($ExpectedScriptSha256 -cnotmatch '^[a-f0-9]{64}$' -or
      (Get-FileHashHex -Path $scriptFull) -cne $ExpectedScriptSha256) {
    throw 'Native state checkpoint utility SHA-256 does not match the reviewed bytes.'
  }
  if ($Mode -eq 'capture' -and (Test-Path -LiteralPath $backupFull)) {
    throw 'Native state capture backup already exists; retain and inspect its custody.'
  }
  if ($Mode -eq 'verify' -and $ExpectedManifestDigest -cnotmatch '^[a-f0-9]{64}$') {
    throw 'Native state verify requires the expected capture manifest digest.'
  }
  if (($SeedRoot -or $SeedDigest) -and ($Mode -ne 'capture' -or -not $SeedRoot -or $SeedDigest -cnotmatch '^[a-f0-9]{64}$')) {
    throw 'Native state capture seed requires both its exact root and verified digest.'
  }
  $isCount = { param($Value) ($Value -is [int] -or $Value -is [long]) -and $Value -ge 0 }
  $safeRelative = {
    param($Value)
    if ($Value -isnot [string]) { return $false }
    $portable = $Value.Replace('\', '/')
    $segments = @($portable.Split('/'))
    return -not [string]::IsNullOrWhiteSpace($portable) -and -not [IO.Path]::IsPathRooted($Value) -and
      -not $portable.StartsWith('/') -and $portable -notmatch '[:\x00\r\n]' -and
      -not ($segments -contains '' -or $segments -contains '.' -or $segments -contains '..')
  }
  $readManifest = {
    if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf) -or
        ((Get-Item -LiteralPath $manifestPath -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)) {
      throw "Native state checkpoint manifest is missing or linked: $manifestPath"
    }
    $digest = Get-FileHashHex -Path $manifestPath
    try { $manifest = Get-Content -Raw -Encoding UTF8 -LiteralPath $manifestPath | ConvertFrom-Json }
    catch { throw "Native state checkpoint manifest is unreadable: $manifestPath" }
    foreach ($name in @('format','source','backup','capturedAt','selections','rows','fileCount','totalBytes','treeSha256')) {
      if (-not $manifest -or -not $manifest.PSObject.Properties[$name]) { throw "Native state checkpoint manifest is missing $name." }
    }
    $capturedAt = [DateTimeOffset]::MinValue
    # PowerShell 7 may parse ISO JSON strings as DateTime and JSON integers as Int64.
    $validCapturedAt = $manifest.capturedAt -is [DateTime] -or $manifest.capturedAt -is [DateTimeOffset] -or
      ($manifest.capturedAt -is [string] -and [DateTimeOffset]::TryParse($manifest.capturedAt, [ref]$capturedAt))
    if (-not (& $isCount $manifest.format) -or $manifest.format -ne 1 -or
        $manifest.source -isnot [string] -or $manifest.source -cne $sourceFull -or
        $manifest.backup -isnot [string] -or $manifest.backup -cne $backupFull -or
        -not $validCapturedAt -or
        $manifest.rows -isnot [array] -or $manifest.selections -isnot [array] -or $manifest.selections.Count -eq 0 -or
        -not (& $isCount $manifest.fileCount) -or $manifest.fileCount -ne $manifest.rows.Count -or
        -not (& $isCount $manifest.totalBytes) -or $manifest.treeSha256 -cnotmatch '^[a-f0-9]{64}$') {
      throw 'Native state checkpoint manifest format, roots, counts or tree are invalid.'
    }
    $names = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
    [decimal]$bytes = 0
    $rowTree = [Security.Cryptography.SHA256]::Create()
    try {
      foreach ($row in $manifest.rows) {
        if (-not $row -or -not $row.PSObject.Properties['relative'] -or -not $row.PSObject.Properties['bytes'] -or
            -not $row.PSObject.Properties['sha256'] -or -not (& $safeRelative $row.relative) -or
            -not (& $isCount $row.bytes) -or $row.sha256 -cnotmatch '^[a-f0-9]{64}$' -or -not $names.Add($row.relative.Replace('\', '/'))) {
          throw 'Native state checkpoint manifest contains an invalid or duplicate row.'
        }
        $bytes += [decimal]$row.bytes
        # Format 1 preserves row order: normalized relative, NUL, integer bytes, NUL, SHA-256, LF.
        $frame = [Text.Encoding]::UTF8.GetBytes($row.relative.Replace('\', '/') + [char]0 +
          $row.bytes.ToString([Globalization.CultureInfo]::InvariantCulture) + [char]0 + $row.sha256 + [char]10)
        $null = $rowTree.TransformBlock($frame, 0, $frame.Length, $frame, 0)
      }
      $null = $rowTree.TransformFinalBlock([byte[]]@(), 0, 0)
      $treeDigest = ([BitConverter]::ToString($rowTree.Hash)).Replace('-', '').ToLowerInvariant()
    } finally { $rowTree.Dispose() }
    if ($treeDigest -cne $manifest.treeSha256) { throw 'Native state checkpoint manifest tree SHA-256 does not match its ordered rows.' }
    foreach ($selection in $manifest.selections) {
      if (-not $selection -or -not $selection.PSObject.Properties['relative'] -or
          -not $selection.PSObject.Properties['exists'] -or -not $selection.PSObject.Properties['directory'] -or
          -not (& $safeRelative $selection.relative) -or $selection.exists -isnot [bool] -or $selection.directory -isnot [bool]) {
        throw 'Native state checkpoint manifest contains an invalid protected selection.'
      }
    }
    if ($bytes -ne [decimal]$manifest.totalBytes -or (Get-FileHashHex -Path $manifestPath) -cne $digest) {
      throw 'Native state checkpoint manifest byte sum or manifest digest changed.'
    }
    return [pscustomobject]@{ Manifest = $manifest; Digest = $digest }
  }
  if ($Mode -eq 'verify') {
    $before = & $readManifest
    if ($before.Digest -cne $ExpectedManifestDigest) { throw 'Native state verify manifest digest changed before verification.' }
  }
  $stdoutPath = $evidenceFull + '.stdout.log'
  $stderrPath = $evidenceFull + '.stderr.log'
  if (-not (Test-Path -LiteralPath (Split-Path -Parent $evidenceFull) -PathType Container)) {
    throw 'Native state checkpoint evidence parent directory is missing.'
  }
  foreach ($file in @($stdoutPath, $stderrPath)) {
    $stream = [IO.File]::Open($file, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::Read)
    $stream.Dispose()
  }
  $nativeArguments = @($scriptFull, $Mode, $sourceFull, $backupFull)
  if ($SeedRoot) { $nativeArguments += @((& $fullPath $SeedRoot), $SeedDigest) }
  # Same CommandLineToArgvW/CRT quoting as the incumbent independent app launcher.
  $quoted = foreach ($value in $nativeArguments) {
    '"' + ([regex]::Replace([regex]::Replace($value, '(\\*)"', '$1$1\"'), '(\\+)$', '$1$1')) + '"'
  }
  $startParameters = @{ FilePath = $nodeFull; ArgumentList = $quoted; WindowStyle = 'Hidden'; Wait = $true; PassThru = $true;
    RedirectStandardOutput = $stdoutPath; RedirectStandardError = $stderrPath }
  if (-not $ProcessRunner) { $ProcessRunner = { param([hashtable]$Parameters) Start-Process @Parameters } }
  Write-Host "[custom-install] native state $Mode starting; stdout=$stdoutPath stderr=$stderrPath"
  $savedNodeEnvironment = @{}
  try {
    foreach ($key in @([Environment]::GetEnvironmentVariables('Process').Keys | Where-Object { $_ -match '^(?i:NODE_OPTIONS|NODE_PATH)$' })) {
      $savedNodeEnvironment[$key] = [Environment]::GetEnvironmentVariable($key, 'Process')
      [Environment]::SetEnvironmentVariable($key, $null, 'Process')
    }
    $process = & $ProcessRunner $startParameters
  } finally {
    foreach ($key in $savedNodeEnvironment.Keys) { [Environment]::SetEnvironmentVariable($key, $savedNodeEnvironment[$key], 'Process') }
  }
  if ($null -eq $process -or $process -is [array] -or -not $process.PSObject.Methods['Refresh'] -or
      -not $process.PSObject.Properties['ExitCode']) { throw "Native state checkpoint exit code is unavailable; inspect $stderrPath" }
  $null = $process.Refresh()
  $exitCode = $process.ExitCode
  if ($null -eq $exitCode -or -not (& $isCount $exitCode) -or $exitCode -ne 0) {
    throw "Native state checkpoint exit code was not a confirmed zero ($exitCode); inspect $stderrPath"
  }
  if ((Get-FileHashHex -Path $scriptFull) -cne $ExpectedScriptSha256) { throw 'Native state checkpoint utility SHA-256 changed during execution.' }
  $checked = & $readManifest
  if ($Mode -eq 'verify' -and $checked.Digest -cne $ExpectedManifestDigest) { throw 'Native state verify manifest digest changed during verification.' }
  $lines = @(Get-Content -Encoding UTF8 -LiteralPath $stdoutPath | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })
  try { $receipt = if ($lines.Count) { $lines[-1] | ConvertFrom-Json } else { $null } }
  catch { $receipt = $null }
  foreach ($name in @('stage','fileCount','totalBytes','treeSha256','manifestPath')) {
    if (-not $receipt -or -not $receipt.PSObject.Properties[$name]) { throw "Native state checkpoint final receipt is missing or invalid; inspect $stdoutPath" }
  }
  $stage = if ($Mode -eq 'capture') { 'closed-state-captured' } else { 'closed-state-after-install-exact' }
  if ($receipt.stage -cne $stage -or -not (& $isCount $receipt.fileCount) -or -not (& $isCount $receipt.totalBytes) -or
      $receipt.fileCount -ne $checked.Manifest.fileCount -or $receipt.totalBytes -ne $checked.Manifest.totalBytes -or
      $receipt.treeSha256 -cne $checked.Manifest.treeSha256 -or $receipt.manifestPath -cne $manifestPath -or
      ($Mode -eq 'capture' -and (-not $receipt.PSObject.Properties['manifestSha256'] -or $receipt.manifestSha256 -cne $checked.Digest))) {
    throw "Native state checkpoint final receipt does not match the manifest; inspect $stdoutPath"
  }
  if ((Get-FileHashHex -Path $manifestPath) -cne $checked.Digest) { throw 'Native state checkpoint manifest digest changed before publication.' }
  Write-Host "[custom-install] native state $Mode accepted; files=$($checked.Manifest.fileCount) bytes=$($checked.Manifest.totalBytes) manifest=$($checked.Digest)"
  return [pscustomobject]@{ Mode = $Mode; ManifestPath = $manifestPath; ManifestSha256 = $checked.Digest;
    FileCount = $checked.Manifest.fileCount; TotalBytes = $checked.Manifest.totalBytes; TreeSha256 = $checked.Manifest.treeSha256;
    StdoutPath = $stdoutPath; StderrPath = $stderrPath; ExitCode = $exitCode }
}

function Get-FileSha512Base64 {
  param([Parameter(Mandatory)][string]$Path)
  $stream = [System.IO.File]::OpenRead($Path)
  try {
    $sha = [System.Security.Cryptography.SHA512]::Create()
    try {
      return [Convert]::ToBase64String($sha.ComputeHash($stream))
    } finally {
      $sha.Dispose()
    }
  } finally {
    $stream.Dispose()
  }
}

function Get-TrustedHostToolPath {
  param([Parameter(Mandatory)][ValidateSet('node','git','tar','cmd')][string]$Name)
  $programFiles = [Environment]::GetFolderPath([Environment+SpecialFolder]::ProgramFiles)
  $programFilesX86 = [Environment]::GetFolderPath([Environment+SpecialFolder]::ProgramFilesX86)
  $localPrograms = Join-Path ([Environment]::GetFolderPath([Environment+SpecialFolder]::LocalApplicationData)) 'Programs'
  $system = [Environment]::GetFolderPath([Environment+SpecialFolder]::System)
  $candidates = switch ($Name) {
    'node' { @((Join-Path $programFiles 'nodejs\node.exe'), (Join-Path $programFilesX86 'nodejs\node.exe'), (Join-Path $localPrograms 'nodejs\node.exe')) }
    'git' { @((Join-Path $programFiles 'Git\cmd\git.exe'), (Join-Path $programFilesX86 'Git\cmd\git.exe'), (Join-Path $localPrograms 'Git\cmd\git.exe')) }
    'tar' { @((Join-Path $system 'tar.exe')) }
    'cmd' { @((Join-Path $system 'cmd.exe')) }
  }
  foreach ($candidate in $candidates) {
    if ($candidate -and (Test-Path -LiteralPath $candidate -PathType Leaf)) { return [IO.Path]::GetFullPath($candidate) }
  }
  throw "Required trusted host tool '$Name' was not found in an OS-owned/program-install location. Refusing caller PATH fallback."
}

function Invoke-TrustedNodeCaptured {
  param([Parameter(Mandatory)][string[]]$Arguments)
  $node = Get-TrustedHostToolPath -Name node
  $git = Get-TrustedHostToolPath -Name git
  $tar = Get-TrustedHostToolPath -Name tar
  $cmd = Get-TrustedHostToolPath -Name cmd
  $savedPath = [Environment]::GetEnvironmentVariable('PATH', 'Process')
  $savedComSpec = [Environment]::GetEnvironmentVariable('ComSpec', 'Process')
  $savedErrorActionPreference = $ErrorActionPreference
  $savedNodeEnv = @{}
  $nodeEnvKeys = @([Environment]::GetEnvironmentVariables('Process').Keys | ForEach-Object { [string]$_ } | Where-Object { $_ -match '^(?i:NODE_OPTIONS|NODE_PATH)$' })
  try {
    foreach ($key in $nodeEnvKeys) {
      $savedNodeEnv[$key] = [Environment]::GetEnvironmentVariable($key, 'Process')
      [Environment]::SetEnvironmentVariable($key, $null, 'Process')
    }
    [Environment]::SetEnvironmentVariable('PATH', ((@((Split-Path -Parent $node), (Split-Path -Parent $git), (Split-Path -Parent $tar)) | Select-Object -Unique) -join ';'), 'Process')
    [Environment]::SetEnvironmentVariable('ComSpec', $cmd, 'Process')
    # Windows PowerShell wraps native stderr lines as non-terminating ErrorRecords. Keep them in
    # the captured diagnostic stream, but let the native exit code—not an npm warning—decide
    # whether the trusted subprocess failed.
    $ErrorActionPreference = 'Continue'
    $output = @(& $node @Arguments 2>&1)
    return [pscustomobject]@{ ExitCode = [int]$LASTEXITCODE; Output = $output }
  } finally {
    [Environment]::SetEnvironmentVariable('PATH', $savedPath, 'Process')
    [Environment]::SetEnvironmentVariable('ComSpec', $savedComSpec, 'Process')
    $ErrorActionPreference = $savedErrorActionPreference
    foreach ($key in $nodeEnvKeys) { [Environment]::SetEnvironmentVariable($key, [string]$savedNodeEnv[$key], 'Process') }
  }
}

function Invoke-TrustedGitText {
  param(
    [Parameter(Mandatory)][string]$RepoRoot,
    [Parameter(Mandatory)][string[]]$Arguments
  )

  # Git repository/object-selection environment is not source evidence. Temporarily remove every
  # GIT_* override so GIT_DIR/GIT_WORK_TREE/GIT_INDEX_FILE/object alternates/config injection cannot
  # make this owner inspect another repository while qualifying the explicit RepoRoot.
  $saved = @{}
  $keys = @([Environment]::GetEnvironmentVariables('Process').Keys | ForEach-Object { [string]$_ } | Where-Object { $_ -match '^GIT_' })
  try {
    foreach ($key in $keys) {
      $saved[$key] = [Environment]::GetEnvironmentVariable($key, 'Process')
      [Environment]::SetEnvironmentVariable($key, $null, 'Process')
    }
    $git = Get-TrustedHostToolPath -Name git
    $output = @(& $git --no-replace-objects -C $RepoRoot @Arguments 2>&1)
    $exitCode = $LASTEXITCODE
    $text = (($output | ForEach-Object { [string]$_ }) -join "`n").Trim()
    if ($exitCode -ne 0) {
      $command = 'git ' + ($Arguments -join ' ')
      $suffix = if ([string]::IsNullOrWhiteSpace($text)) { '' } else { " $text" }
      throw "$command failed for '$RepoRoot' (exit $exitCode).$suffix"
    }
    return $text
  } finally {
    foreach ($key in $keys) {
      [Environment]::SetEnvironmentVariable($key, [string]$saved[$key], 'Process')
    }
  }
}

function Get-GitObjectIdLength {
  param([Parameter(Mandatory)][string]$ObjectFormat)
  if ($ObjectFormat -ceq 'sha1') { return 40 }
  if ($ObjectFormat -ceq 'sha256') { return 64 }
  throw "Unsupported Git object format '$ObjectFormat'."
}

function Assert-SourceProvenanceRecordShape {
  param([Parameter(Mandatory)][psobject]$Provenance)

  $expected = @(
    'schema', 'objectFormat', 'commit', 'tree', 'dirty', 'strictBuild', 'packageJsonSha256', 'packageLockSha256',
    'lockfileVersion', 'dependencies', 'node', 'npm', 'tools', 'hostTools', 'builderToolsets', 'toolchainSha256'
  )
  $names = @($Provenance.PSObject.Properties | ForEach-Object { [string]$_.Name } | Where-Object { $_ -ne 'RecordSha256' })
  if ($names.Count -ne $expected.Count -or @($expected | Where-Object { $names -notcontains $_ }).Count -gt 0) {
    throw "Source provenance schema v2 must contain exactly: $($expected -join ', ')."
  }
  if ([int]$Provenance.schema -ne $script:SourceProvenanceSchema) {
    throw "Unsupported source provenance schema '$($Provenance.schema)'; expected $script:SourceProvenanceSchema."
  }
  $objectFormat = [string]$Provenance.objectFormat
  $length = Get-GitObjectIdLength -ObjectFormat $objectFormat
  $commit = [string]$Provenance.commit
  $tree = [string]$Provenance.tree
  if ($commit -cnotmatch "^[0-9a-f]{$length}$") { throw "Source provenance commit is not a valid $objectFormat object id: '$commit'." }
  if ($tree -cnotmatch "^[0-9a-f]{$length}$") { throw "Source provenance tree is not a valid $objectFormat object id: '$tree'." }
  if ($Provenance.dirty -isnot [bool] -or $Provenance.strictBuild -isnot [bool]) {
    throw 'Source provenance dirty/strictBuild must be JSON booleans.'
  }
  foreach ($hashName in @('packageJsonSha256', 'packageLockSha256', 'toolchainSha256')) {
    if ([string]$Provenance.$hashName -cnotmatch '^[0-9a-f]{64}$') { throw "Source provenance $hashName is malformed." }
  }
  if ($Provenance.lockfileVersion -isnot [int] -and $Provenance.lockfileVersion -isnot [long]) { throw 'Source provenance lockfileVersion must be an integer.' }
  if (-not $Provenance.strictBuild) { throw 'Future qualified provenance must declare strictBuild=true.' }
  if (-not $Provenance.dependencies) { throw 'Strict source provenance is missing the dependency-tree fingerprint.' }
  foreach ($name in @('fileCount', 'totalBytes')) {
    if ($Provenance.dependencies.$name -isnot [int] -and $Provenance.dependencies.$name -isnot [long]) { throw "Source provenance dependencies.$name must be an integer." }
  }
  if ([string]$Provenance.dependencies.treeSha256 -cnotmatch '^[0-9a-f]{64}$') { throw 'Source provenance dependencies.treeSha256 is malformed.' }
  if (-not $Provenance.node -or [string]::IsNullOrWhiteSpace([string]$Provenance.node.version) -or [string]$Provenance.node.executableSha256 -cnotmatch '^[0-9a-f]{64}$') {
    throw 'Source provenance node identity is malformed.'
  }
  if (-not $Provenance.npm -or [string]::IsNullOrWhiteSpace([string]$Provenance.npm.version) -or
      [string]$Provenance.npm.cliSha256 -cnotmatch '^[0-9a-f]{64}$' -or [string]$Provenance.npm.commandShimSha256 -cnotmatch '^[0-9a-f]{64}$' -or
      $Provenance.npm.packageFileCount -isnot [int] -and $Provenance.npm.packageFileCount -isnot [long] -or
      $Provenance.npm.packageTotalBytes -isnot [int] -and $Provenance.npm.packageTotalBytes -isnot [long] -or
      [string]$Provenance.npm.packageTreeSha256 -cnotmatch '^[0-9a-f]{64}$') {
    throw 'Source provenance npm identity is malformed.'
  }
  $toolNames = @('electron', 'electron-builder', 'electron-vite', 'vite', 'typescript')
  $actualTools = @($Provenance.tools.PSObject.Properties | ForEach-Object { [string]$_.Name })
  if ($actualTools.Count -ne $toolNames.Count -or @($toolNames | Where-Object { $actualTools -notcontains $_ }).Count -gt 0) {
    throw "Source provenance tools must contain exactly: $($toolNames -join ', ')."
  }
  foreach ($toolName in $toolNames) {
    $tool = $Provenance.tools.$toolName
    if (-not $tool -or [string]::IsNullOrWhiteSpace([string]$tool.version) -or [string]$tool.packageJsonSha256 -cnotmatch '^[0-9a-f]{64}$' -or [string]$tool.entrySha256 -cnotmatch '^[0-9a-f]{64}$') {
      throw "Source provenance tool '$toolName' identity is malformed."
    }
  }
  foreach ($name in @('runtimeSha256', 'archiveSha256')) {
    if ([string]$Provenance.tools.electron.$name -cnotmatch '^[0-9a-f]{64}$') { throw "Source provenance Electron $name is malformed." }
  }
  foreach ($hostName in @('git', 'tar', 'shell')) {
    $hostTool = $Provenance.hostTools.$hostName
    if (-not $hostTool -or [string]::IsNullOrWhiteSpace([string]$hostTool.version) -or [string]$hostTool.executableSha256 -cnotmatch '^[0-9a-f]{64}$') {
      throw "Source provenance host tool '$hostName' identity is malformed."
    }
  }
  foreach ($toolsetName in @('sevenZip', 'nsis', 'nsisResources')) {
    $toolset = $Provenance.builderToolsets.$toolsetName
    if (-not $toolset -or [string]$toolset.archiveSha256 -cnotmatch '^[0-9a-f]{64}$' -or
        $toolset.fileCount -isnot [int] -and $toolset.fileCount -isnot [long] -or
        $toolset.totalBytes -isnot [int] -and $toolset.totalBytes -isnot [long] -or
        [string]$toolset.treeSha256 -cnotmatch '^[0-9a-f]{64}$') {
      throw "Source provenance builder toolset '$toolsetName' identity is malformed."
    }
  }
  foreach ($toolsetName in @('sevenZip', 'nsis')) {
    if ([string]$Provenance.builderToolsets.$toolsetName.executableSha256 -cnotmatch '^[0-9a-f]{64}$') {
      throw "Source provenance builder toolset '$toolsetName' executable identity is malformed."
    }
  }
  return $Provenance
}

function Read-SourceProvenanceRecord {
  param(
    [Parameter(Mandatory)][string]$Path,
    [string]$RepoRoot
  )
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return $null }
  $item = Get-Item -LiteralPath $Path
  if ($item.Length -lt 2 -or $item.Length -gt 32768) {
    throw "Source provenance record has an invalid size ($($item.Length) bytes): $Path"
  }
  if (-not $RepoRoot) { $RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path }
  $owner = Join-Path $RepoRoot 'scripts\package.mjs'
  if (-not (Test-Path -LiteralPath $owner -PathType Leaf)) { throw "Source provenance schema owner is missing: $owner" }
  try {
    $result = Invoke-TrustedNodeCaptured -Arguments @($owner, "--inspect-provenance=$Path")
    $output = @($result.Output)
    if ($result.ExitCode -ne 0) { throw (($output | ForEach-Object { [string]$_ }) -join "`n") }
    $parsed = (($output | ForEach-Object { [string]$_ }) -join "`n") | ConvertFrom-Json
  } catch {
    throw "Source provenance record failed canonical schema validation: $Path. $($_.Exception.Message)"
  }
  $record = Assert-SourceProvenanceRecordShape -Provenance $parsed
  $record | Add-Member NoteProperty RecordSha256 (Get-FileHashHex -Path $Path)
  return $record
}

function Get-ReviewedGitState {
  param([Parameter(Mandatory)][string]$RepoRoot)
  $topLevel = Invoke-TrustedGitText -RepoRoot $RepoRoot -Arguments @('rev-parse', '--show-toplevel')
  if ([IO.Path]::GetFullPath($topLevel).TrimEnd('\') -ne [IO.Path]::GetFullPath($RepoRoot).TrimEnd('\')) {
    throw "Provenance repository root mismatch. Expected '$RepoRoot', Git resolved '$topLevel'."
  }
  $objectFormat = Invoke-TrustedGitText -RepoRoot $RepoRoot -Arguments @('rev-parse', '--show-object-format=storage')
  $length = Get-GitObjectIdLength -ObjectFormat $objectFormat
  $commit = (Invoke-TrustedGitText -RepoRoot $RepoRoot -Arguments @('rev-parse', '--verify', 'HEAD^{commit}')).ToLowerInvariant()
  $tree = (Invoke-TrustedGitText -RepoRoot $RepoRoot -Arguments @('rev-parse', '--verify', 'HEAD^{tree}')).ToLowerInvariant()
  if ($commit -cnotmatch "^[0-9a-f]{$length}$" -or $tree -cnotmatch "^[0-9a-f]{$length}$") {
    throw 'The reviewed Git checkout returned malformed commit/tree object ids.'
  }
  $status = Invoke-TrustedGitText -RepoRoot $RepoRoot -Arguments @('status', '--porcelain=v2', '--untracked-files=all', '--ignore-submodules=none')
  $ignoredSourceInputs = Invoke-TrustedGitText -RepoRoot $RepoRoot -Arguments @('ls-files', '--others', '--ignored', '--exclude-standard', '--', '.env', '.env.*', 'src', 'scripts', 'native', 'extension', 'artwork')
  return [pscustomobject]@{
    schema = $script:SourceProvenanceSchema
    objectFormat = $objectFormat
    commit = $commit
    tree = $tree
    dirty = (-not [string]::IsNullOrWhiteSpace($status)) -or (-not [string]::IsNullOrWhiteSpace($ignoredSourceInputs))
    status = $status
    ignoredSourceInputs = $ignoredSourceInputs
  }
}

function Assert-SourceProvenanceAgainstRepository {
  param(
    [Parameter(Mandatory)][psobject]$Provenance,
    [Parameter(Mandatory)][string]$RepoRoot,
    [switch]$RequireCheckoutMatch
  )
  $record = Assert-SourceProvenanceRecordShape -Provenance $Provenance
  if ($record.dirty) { throw 'Source provenance records dirty=true; dirty packages are unqualified and cannot be activated.' }
  $topLevel = Invoke-TrustedGitText -RepoRoot $RepoRoot -Arguments @('rev-parse', '--show-toplevel')
  if ([IO.Path]::GetFullPath($topLevel).TrimEnd('\') -ne [IO.Path]::GetFullPath($RepoRoot).TrimEnd('\')) {
    throw "Provenance repository root mismatch. Expected '$RepoRoot', Git resolved '$topLevel'."
  }
  $localFormat = Invoke-TrustedGitText -RepoRoot $RepoRoot -Arguments @('rev-parse', '--show-object-format=storage')
  if ($localFormat -cne $record.objectFormat) {
    throw "Source provenance object format '$($record.objectFormat)' does not match the review repository '$localFormat'."
  }
  try {
    $type = Invoke-TrustedGitText -RepoRoot $RepoRoot -Arguments @('cat-file', '-t', $record.commit)
  } catch {
    throw "Source provenance commit $($record.commit) is not present in the local review repository. $($_.Exception.Message)"
  }
  if ($type -cne 'commit') { throw "Source provenance object $($record.commit) exists but is '$type', not a commit." }
  try {
    $treeType = Invoke-TrustedGitText -RepoRoot $RepoRoot -Arguments @('cat-file', '-t', $record.tree)
  } catch {
    throw "Source provenance tree $($record.tree) is not present in the local review repository. $($_.Exception.Message)"
  }
  if ($treeType -cne 'tree') { throw "Source provenance object $($record.tree) exists but is '$treeType', not a tree." }
  $commitTree = (Invoke-TrustedGitText -RepoRoot $RepoRoot -Arguments @('rev-parse', '--verify', "$($record.commit)^{tree}")).ToLowerInvariant()
  if ($commitTree -cne $record.tree) {
    throw "Source provenance tree mismatch. Commit $($record.commit) resolves to $commitTree, not recorded tree $($record.tree)."
  }
  if ($RequireCheckoutMatch) {
    $reviewed = Get-ReviewedGitState -RepoRoot $RepoRoot
    if ($reviewed.dirty) {
      $details = @($reviewed.status, $reviewed.ignoredSourceInputs) |
        Where-Object { -not [string]::IsNullOrWhiteSpace([string]$_) }
      throw ('The checkout under qualification review is dirty. Refusing source qualification. Git evidence: ' +
        (($details | ForEach-Object { ([string]$_).Trim() }) -join ' | '))
    }
    if ($reviewed.commit -cne $record.commit -or $reviewed.tree -cne $record.tree) {
      throw "Embedded source provenance does not match the clean checkout under review. Package=$($record.commit)/$($record.tree) checkout=$($reviewed.commit)/$($reviewed.tree)."
    }
  }
  return $record
}

function Read-UnqualifiedCandidateMetadata {
  param([Parameter(Mandatory)][string]$ReleaseDirectory)

  $latest = Join-Path $ReleaseDirectory 'latest.yml'
  if (-not (Test-Path -LiteralPath $latest -PathType Leaf)) { throw "Candidate release metadata is missing: $latest" }
  $lines = @(Get-Content -LiteralPath $latest)
  if ($lines.Count -ne 8) { throw "Candidate latest.yml has an unexpected shape. Expected 8 lines, found $($lines.Count)." }
  if ($lines[1] -cne 'files:') { throw 'Candidate latest.yml line 2 must be exactly files:.' }

  $patterns = @(
    '^version: (?<value>\d+\.\d+\.\d+)$',
    $null,
    '^  - url: (?<value>[A-Za-z0-9._-]+)$',
    '^    sha512: (?<value>[A-Za-z0-9+/]+={0,2})$',
    '^    size: (?<value>\d+)$',
    '^path: (?<value>[A-Za-z0-9._-]+)$',
    '^sha512: (?<value>[A-Za-z0-9+/]+={0,2})$',
    "^releaseDate: '(?<value>[^']+)'$"
  )
  $values = @{}
  foreach ($index in @(0, 2, 3, 4, 5, 6, 7)) {
    $match = [regex]::Match([string]$lines[$index], [string]$patterns[$index], [Text.RegularExpressions.RegexOptions]::CultureInvariant)
    if (-not $match.Success) { throw "Candidate latest.yml line $($index + 1) has an unexpected format." }
    $values[$index] = $match.Groups['value'].Value
  }

  $version = [string]$values[0]
  $installerFile = [string]$values[2]
  $declaredSha512 = [string]$values[3]
  [int64]$declaredSize = 0
  if (-not [int64]::TryParse([string]$values[4], [ref]$declaredSize) -or $declaredSize -lt 1) {
    throw 'Candidate latest.yml installer size is invalid.'
  }
  if ([string]$values[5] -cne $installerFile) { throw 'Candidate latest.yml url/path installer names disagree.' }
  if ([string]$values[6] -cne $declaredSha512) { throw 'Candidate latest.yml SHA-512 entries disagree.' }
  if ($installerFile -cne 'Chat-On-Steroids-Setup-x64.exe') {
    throw "Qualification proposal supports only the Windows x64 private installer, found '$installerFile'."
  }
  $releaseDate = [string]$values[7]
  [DateTimeOffset]$parsedReleaseDate = [DateTimeOffset]::MinValue
  if (-not [DateTimeOffset]::TryParse($releaseDate, [Globalization.CultureInfo]::InvariantCulture, [Globalization.DateTimeStyles]::RoundtripKind, [ref]$parsedReleaseDate)) {
    throw "Candidate latest.yml releaseDate is not a valid round-trip timestamp: $releaseDate"
  }

  $installer = Join-Path $ReleaseDirectory $installerFile
  if (-not (Test-Path -LiteralPath $installer -PathType Leaf)) { throw "Candidate installer is missing: $installer" }
  $item = Get-Item -LiteralPath $installer
  if ([int64]$item.Length -ne $declaredSize) {
    throw "Candidate installer size disagrees with latest.yml. Declared $declaredSize, actual $($item.Length)."
  }
  $sha512 = Get-FileSha512Base64 -Path $item.FullName
  if ($sha512 -cne $declaredSha512) { throw 'Candidate installer SHA-512 disagrees with latest.yml.' }

  return [pscustomobject]@{
    Version = $version
    InstallerFile = $installerFile
    InstallerPath = $item.FullName
    InstallerSize = [int64]$item.Length
    InstallerSha256 = Get-FileHashHex -Path $item.FullName
    InstallerSha512 = $sha512
    LatestYmlPath = (Get-Item -LiteralPath $latest).FullName
    LatestYmlSha256 = Get-FileHashHex -Path $latest
    ReleaseDate = $releaseDate
  }
}

function Read-AppAsarPackageVersion {
  param(
    [Parameter(Mandatory)][string]$AppAsarPath,
    [Parameter(Mandatory)][string]$RepoRoot
  )
  $asarModule = Join-Path $RepoRoot 'node_modules\@electron\asar'
  if (-not (Test-Path -LiteralPath (Join-Path $asarModule 'package.json') -PathType Leaf)) {
    throw "Qualification proposal cannot inspect app.asar metadata because the locked @electron/asar package is missing: $asarModule. Run npm ci; do not substitute a different parser silently."
  }
  $nodeScript = "const asar=require(process.argv[1]);const pkg=JSON.parse(asar.extractFile(process.argv[2],'package.json').toString('utf8'));const v=String(pkg.version||'');if(!/^\d+\.\d+\.\d+$/.test(v))throw new Error('app.asar package.json has no strict semver version');process.stdout.write(v);"
  $result = Invoke-TrustedNodeCaptured -Arguments @('-e', $nodeScript, $asarModule, $AppAsarPath)
  $output = @($result.Output)
  if ($result.ExitCode -ne 0) { throw "Could not read package.json from installer-contained app.asar (node exit $($result.ExitCode))." }
  $version = ($output -join '').Trim()
  if ($version -notmatch '^\d+\.\d+\.\d+$') { throw "Installer-contained app.asar package version is invalid: '$version'." }
  return $version
}

function Assert-SevenZipArchiveEntriesSafe {
  param(
    [Parameter(Mandatory)][string]$SevenZipPath,
    [Parameter(Mandatory)][string]$ArchivePath,
    [Parameter(Mandatory)][string]$DestinationRoot
  )
  $listing = @(& $SevenZipPath l '-slt' $ArchivePath)
  if ($LASTEXITCODE -ne 0) { throw "Could not inspect embedded application archive entries (7-Zip exit $LASTEXITCODE)." }
  $separator = [Array]::IndexOf($listing, '----------')
  if ($separator -lt 0) { throw 'Embedded application archive listing has no entry separator.' }

  $destination = [IO.Path]::GetFullPath($DestinationRoot).TrimEnd('\')
  $destinationPrefix = $destination + '\'
  $targets = New-Object 'System.Collections.Generic.HashSet[string]' ([StringComparer]::OrdinalIgnoreCase)
  $paths = 0
  for ($index = $separator + 1; $index -lt $listing.Count; $index += 1) {
    $line = [string]$listing[$index]
    if ($line -match '^(?:Symbolic Link|Hard Link) = ') {
      throw "Embedded application archive contains link metadata: $line"
    }
    if ($line -ceq 'Encrypted = +') {
      throw 'Embedded application archive contains an encrypted entry.'
    }
    if (-not $line.StartsWith('Path = ', [StringComparison]::Ordinal)) { continue }
    $name = $line.Substring(7)
    $portable = $name.Replace('\', '/')
    if ([string]::IsNullOrWhiteSpace($portable) -or $portable.StartsWith('/') -or $portable.StartsWith('//') -or $portable -match '^[A-Za-z]:' -or [IO.Path]::IsPathRooted($name)) {
      throw "Embedded application archive contains an absolute or drive-relative entry: $name"
    }
    $segments = @($portable.Split('/') | Where-Object { $_ -ne '' })
    if ($segments.Count -eq 0 -or $segments -contains '..' -or $segments -contains '.' -or @($segments | Where-Object { $_.Contains(':') }).Count -gt 0) {
      throw "Embedded application archive contains an unsafe path entry: $name"
    }
    $target = [IO.Path]::GetFullPath((Join-Path $destination $name))
    if (-not $target.StartsWith($destinationPrefix, [StringComparison]::OrdinalIgnoreCase)) {
      throw "Embedded application archive entry escapes the owned temp root: $name"
    }
    if (-not $targets.Add($target.TrimEnd('\'))) {
      throw "Embedded application archive contains duplicate/colliding target entries: $name"
    }
    $paths += 1
  }
  if ($paths -eq 0) { throw 'Embedded application archive contains no entries.' }
  return $paths
}

function Assert-EmbeddedAsarIntegrity {
  param(
    [Parameter(Mandatory)][string]$ExecutablePath,
    [Parameter(Mandatory)][string]$AppAsarPath,
    [Parameter(Mandatory)][string]$RepoRoot
  )
  $reseditModule = Join-Path $RepoRoot 'node_modules\resedit'
  $pickleModule = Join-Path $RepoRoot 'node_modules\chromium-pickle-js'
  foreach ($module in @($reseditModule, $pickleModule)) {
    if (-not (Test-Path -LiteralPath (Join-Path $module 'package.json') -PathType Leaf)) {
      throw "Qualification proposal cannot verify Electron ASAR integrity because a locked parser is missing: $module. Run npm ci; do not substitute a different parser silently."
    }
  }
  $nodeScript = @'
const fs = require('node:fs');
const { createHash } = require('node:crypto');
const { NtExecutable, NtExecutableResource } = require(process.argv[1]);
const { createFromBuffer } = require(process.argv[2]);
const exeBuf = fs.readFileSync(process.argv[3]);
const asarBuf = fs.readFileSync(process.argv[4]);
const resources = NtExecutableResource.from(NtExecutable.from(exeBuf));
const matches = resources.entries.filter((entry) =>
  String(entry.type) === 'INTEGRITY' && String(entry.id) === 'ELECTRONASAR'
);
if (matches.length !== 1) throw new Error('ELECTRONASAR resource count ' + matches.length + ', expected exactly 1');
const integrity = JSON.parse(Buffer.from(matches[0].bin).toString('utf8'));
if (!Array.isArray(integrity)) throw new Error('ELECTRONASAR resource is not an array');
const expected = integrity.find((entry) => entry && entry.file === 'resources\\app.asar');
if (!expected || expected.alg !== 'SHA256' || !/^[0-9a-f]{64}$/.test(String(expected.value || ''))) {
  throw new Error('ELECTRONASAR has no valid SHA256 resources\\app.asar entry');
}
if (asarBuf.length < 8) throw new Error('app.asar is too short for its header-size pickle');
const sizePickle = createFromBuffer(asarBuf.subarray(0, 8));
const headerSize = sizePickle.createIterator().readUInt32();
if (!Number.isSafeInteger(headerSize) || headerSize <= 0 || asarBuf.length < 8 + headerSize) {
  throw new Error('app.asar header is truncated or invalid (' + headerSize + ')');
}
const headerPickle = createFromBuffer(asarBuf.subarray(8, 8 + headerSize));
const header = headerPickle.createIterator().readString();
const actual = createHash('sha256').update(header).digest('hex');
if (actual !== expected.value) throw new Error('ELECTRONASAR mismatch: exe=' + expected.value + ' asar=' + actual);
process.stdout.write(actual);
'@
  $result = Invoke-TrustedNodeCaptured -Arguments @('-e', $nodeScript, $reseditModule, $pickleModule, $ExecutablePath, $AppAsarPath)
  $output = @($result.Output)
  if ($result.ExitCode -ne 0) { throw "Installer-contained EXE/app.asar integrity verification failed (node exit $($result.ExitCode))." }
  $hash = ($output -join '').Trim()
  if ($hash -notmatch '^[0-9a-f]{64}$') { throw "Electron ASAR integrity verifier returned an invalid hash: '$hash'." }
  return $hash
}

function Read-CandidatePayloadIdentity {
  param(
    [Parameter(Mandatory)][string]$Root,
    [Parameter(Mandatory)][string]$RepoRoot
  )

  $app = Join-Path $Root 'Chat On Steroids.exe'
  $appAsar = Join-Path $Root 'resources\app.asar'
  $extensionBackground = Join-Path $Root 'resources\extension\background.js'
  $extensionManifest = Join-Path $Root 'resources\extension\manifest.json'
  $customBuild = Join-Path $Root 'resources\CUSTOM_BUILD'
  $sourceProvenancePath = Join-Path $Root $script:SourceProvenanceRelativePath
  foreach ($required in @($app, $appAsar, $extensionBackground, $extensionManifest, $customBuild)) {
    if (-not (Test-Path -LiteralPath $required -PathType Leaf)) { throw "Candidate payload is missing required file: $required" }
  }
  $fingerprint = Get-DirectoryFingerprint -Root $Root
  $versionInfo = (Get-Item -LiteralPath $app).VersionInfo
  $manifest = Get-Content -Raw -LiteralPath $extensionManifest | ConvertFrom-Json
  $marker = (Get-Content -Raw -LiteralPath $customBuild).TrimEnd()
  $sourceProvenance = Read-SourceProvenanceRecord -Path $sourceProvenancePath -RepoRoot $RepoRoot
  $buildInputsVerified = $false
  if ($sourceProvenance) {
    $owner = Join-Path $RepoRoot 'scripts\package.mjs'
    $verifyResult = Invoke-TrustedNodeCaptured -Arguments @($owner, "--verify-build-inputs=$sourceProvenancePath", "--review-root=$RepoRoot")
    $verifyOutput = @($verifyResult.Output)
    if ($verifyResult.ExitCode -ne 0) {
      throw "Installer-contained build-input attestation could not be independently reproduced from the reviewed lockfile/toolchain. $((($verifyOutput | ForEach-Object { [string]$_ }) -join "`n").Trim())"
    }
    $buildInputsVerified = $true
  }
  $null = Assert-EmbeddedAsarIntegrity -ExecutablePath $app -AppAsarPath $appAsar -RepoRoot $RepoRoot
  return [pscustomobject]@{
    FileVersion = [string]$versionInfo.FileVersion
    ProductVersion = [string]$versionInfo.ProductVersion
    ExtensionVersion = [string]$manifest.version
    AsarPackageVersion = Read-AppAsarPackageVersion -AppAsarPath $appAsar -RepoRoot $RepoRoot
    AppExecutableSha256 = Get-FileHashHex -Path $app
    AppAsarSha256 = Get-FileHashHex -Path $appAsar
    ExtensionBackgroundSha256 = Get-FileHashHex -Path $extensionBackground
    CustomBuildText = $marker
    SourceProvenance = $sourceProvenance
    BuildInputsVerified = $buildInputsVerified
    FileCount = $fingerprint.FileCount
    TotalBytes = [int64]$fingerprint.TotalBytes
    TreeSha256 = $fingerprint.TreeSha256
  }
}

function Read-InstallerCandidatePayloadIdentity {
  param(
    [Parameter(Mandatory)][string]$InstallerPath,
    [Parameter(Mandatory)][string]$RepoRoot,
    [Parameter(Mandatory)][string]$ReleaseDirectory
  )

  $sevenZip = Join-Path $RepoRoot 'node_modules\electron-winstaller\vendor\7z.exe'
  if (-not (Test-Path -LiteralPath $sevenZip -PathType Leaf)) {
    throw "Qualification proposal cannot inspect the NSIS payload because the locked electron-builder 7-Zip helper is missing: $sevenZip. Run npm ci; do not substitute a different installer inspector silently."
  }
  $tempBase = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\')
  $tempRoot = Join-Path $tempBase ('cos-qualification-proposal-' + [guid]::NewGuid().ToString('N'))
  $outer = Join-Path $tempRoot 'outer'
  $payload = Join-Path $tempRoot 'payload'
  New-Item -ItemType Directory -Path $outer, $payload -Force | Out-Null
  try {
    & $sevenZip e $InstallerPath ("-o$outer") '-y' '$PLUGINSDIR\app-64.7z' | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "Could not extract the embedded NSIS payload container (7-Zip exit $LASTEXITCODE)." }
    $embedded = Join-Path $outer 'app-64.7z'
    if (-not (Test-Path -LiteralPath $embedded -PathType Leaf)) { throw 'NSIS installer does not contain the expected $PLUGINSDIR\app-64.7z payload.' }
    $null = Assert-SevenZipArchiveEntriesSafe -SevenZipPath $sevenZip -ArchivePath $embedded -DestinationRoot $payload
    & $sevenZip x $embedded ("-o$payload") '-y' | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "Could not extract the embedded application payload (7-Zip exit $LASTEXITCODE)." }
    $identity = Read-CandidatePayloadIdentity -Root $payload -RepoRoot $RepoRoot

    $unpackedPath = Join-Path $ReleaseDirectory 'win-unpacked'
    $unpackedCrossCheck = 'absent'
    if (Test-Path -LiteralPath $unpackedPath -PathType Container) {
      $unpacked = Get-DirectoryFingerprint -Root $unpackedPath
      if ($unpacked.FileCount -ne $identity.FileCount -or [int64]$unpacked.TotalBytes -ne [int64]$identity.TotalBytes -or $unpacked.TreeSha256 -cne $identity.TreeSha256) {
        throw "release\win-unpacked does not match the payload embedded in the exact installer. Refusing to propose a receipt from inconsistent package outputs."
      }
      $unpackedCrossCheck = 'exact'
    }
    return [pscustomobject]@{
      FileVersion = $identity.FileVersion
      ProductVersion = $identity.ProductVersion
      ExtensionVersion = $identity.ExtensionVersion
      AsarPackageVersion = $identity.AsarPackageVersion
      AppExecutableSha256 = $identity.AppExecutableSha256
      AppAsarSha256 = $identity.AppAsarSha256
      ExtensionBackgroundSha256 = $identity.ExtensionBackgroundSha256
      CustomBuildText = $identity.CustomBuildText
      SourceProvenance = $identity.SourceProvenance
      BuildInputsVerified = $identity.BuildInputsVerified
      FileCount = $identity.FileCount
      TotalBytes = $identity.TotalBytes
      TreeSha256 = $identity.TreeSha256
      UnpackedCrossCheck = $unpackedCrossCheck
    }
  } finally {
    $resolved = [IO.Path]::GetFullPath($tempRoot)
    $prefix = $tempBase + '\'
    if ($resolved.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase) -and (Split-Path -Leaf $resolved) -like 'cos-qualification-proposal-*') {
      try {
        Remove-Item -LiteralPath $resolved -Recurse -Force -ErrorAction Stop
      } catch {
        throw "Qualification proposal could not remove its disposable temp extraction '$resolved'. Remove it before continuing. $($_.Exception.Message)"
      }
    } else {
      throw "Refusing qualification temp cleanup outside the owned temp root: $resolved"
    }
  }
}

function Read-InstallerSourceProvenance {
  param(
    [Parameter(Mandatory)][string]$InstallerPath,
    [Parameter(Mandatory)][string]$RepoRoot
  )
  $sevenZip = Join-Path $RepoRoot 'node_modules\electron-winstaller\vendor\7z.exe'
  if (-not (Test-Path -LiteralPath $sevenZip -PathType Leaf)) {
    throw "Qualified provenance verification cannot inspect the NSIS payload because the locked electron-builder 7-Zip helper is missing: $sevenZip."
  }
  $tempBase = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\')
  $tempRoot = Join-Path $tempBase ('cos-provenance-verify-' + [guid]::NewGuid().ToString('N'))
  $outer = Join-Path $tempRoot 'outer'
  $recordRoot = Join-Path $tempRoot 'record'
  New-Item -ItemType Directory -Path $outer, $recordRoot -Force | Out-Null
  try {
    & $sevenZip e $InstallerPath ("-o$outer") '-y' '$PLUGINSDIR\app-64.7z' | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "Could not extract the embedded NSIS payload container for provenance verification (7-Zip exit $LASTEXITCODE)." }
    $embedded = Join-Path $outer 'app-64.7z'
    if (-not (Test-Path -LiteralPath $embedded -PathType Leaf)) { throw 'NSIS installer does not contain the expected $PLUGINSDIR\app-64.7z payload.' }
    $null = Assert-SevenZipArchiveEntriesSafe -SevenZipPath $sevenZip -ArchivePath $embedded -DestinationRoot $recordRoot
    $listing = @(& $sevenZip l '-slt' $embedded)
    if ($LASTEXITCODE -ne 0) { throw "Could not list installer payload for provenance verification (7-Zip exit $LASTEXITCODE)." }
    $matches = @($listing | Where-Object { ([string]$_).StartsWith('Path = ', [StringComparison]::Ordinal) } | ForEach-Object { ([string]$_).Substring(7) } | Where-Object { $_.Replace('\', '/') -ceq 'resources/SOURCE_PROVENANCE.json' })
    if ($matches.Count -eq 0) { return $null }
    if ($matches.Count -ne 1) { throw "Installer payload contains $($matches.Count) SOURCE_PROVENANCE.json entries; expected exactly one." }
    & $sevenZip e $embedded ("-o$recordRoot") '-y' $matches[0] | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "Could not extract SOURCE_PROVENANCE.json from installer payload (7-Zip exit $LASTEXITCODE)." }
    $recordPath = Join-Path $recordRoot 'SOURCE_PROVENANCE.json'
    if (-not (Test-Path -LiteralPath $recordPath -PathType Leaf)) { throw '7-Zip reported SOURCE_PROVENANCE.json but did not materialize the record.' }
    return Read-SourceProvenanceRecord -Path $recordPath -RepoRoot $RepoRoot
  } finally {
    $resolved = [IO.Path]::GetFullPath($tempRoot)
    $prefix = $tempBase + '\'
    if ($resolved.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase) -and (Split-Path -Leaf $resolved) -like 'cos-provenance-verify-*') {
      try {
        Remove-Item -LiteralPath $resolved -Recurse -Force -ErrorAction Stop
      } catch {
        throw "Qualified provenance verification could not remove disposable temp extraction '$resolved'. $($_.Exception.Message)"
      }
    } else {
      throw "Refusing provenance temp cleanup outside the owned temp root: $resolved"
    }
  }
}

function Assert-ProposalSourceProvenance {
  param(
    [Parameter(Mandatory)][string]$InstallerSha256,
    [AllowNull()][psobject]$EmbeddedProvenance,
    [Parameter(Mandatory)][string]$RepoRoot,
    [bool]$BuildInputsVerified = $false
  )
  if ($InstallerSha256 -ceq $script:LegacyProvenanceLessInstallerSha256) {
    if ($EmbeddedProvenance) {
      throw 'The exact frozen legacy installer unexpectedly reported source provenance; refusing an inconsistent legacy exception.'
    }
    return $null
  }
  if (-not $EmbeddedProvenance) {
    throw "Candidate installer $InstallerSha256 has no embedded SOURCE_PROVENANCE.json. Only exact frozen installer $script:LegacyProvenanceLessInstallerSha256 may omit Git provenance."
  }
  if (-not $BuildInputsVerified) {
    throw 'Future candidate build-input attestation was not independently reproduced from the reviewed package-lock/toolchain.'
  }
  return Assert-SourceProvenanceAgainstRepository -Provenance $EmbeddedProvenance -RepoRoot $RepoRoot -RequireCheckoutMatch
}

function Get-SourceProvenanceReceiptProjection {
  param([Parameter(Mandatory)][psobject]$Provenance)
  $record = Assert-SourceProvenanceRecordShape -Provenance $Provenance
  if ([string]$record.RecordSha256 -cnotmatch '^[0-9a-f]{64}$') { throw 'Source provenance record SHA-256 is missing or malformed.' }
  return [pscustomobject][ordered]@{
    SourceProvenanceSha256 = [string]$record.RecordSha256
    SourceProvenanceSchema = [int]$record.schema
    GitObjectFormat = [string]$record.objectFormat
    GitCommit = [string]$record.commit
    GitTree = [string]$record.tree
    SourceDirty = [bool]$record.dirty
    StrictBuild = [bool]$record.strictBuild
    PackageJsonSha256 = [string]$record.packageJsonSha256
    PackageLockSha256 = [string]$record.packageLockSha256
    LockfileVersion = [int]$record.lockfileVersion
    DependencyFileCount = [int]$record.dependencies.fileCount
    DependencyTotalBytes = [int64]$record.dependencies.totalBytes
    DependencyTreeSha256 = [string]$record.dependencies.treeSha256
    NodeVersion = [string]$record.node.version
    NodeExecutableSha256 = [string]$record.node.executableSha256
    NpmVersion = [string]$record.npm.version
    NpmCliSha256 = [string]$record.npm.cliSha256
    NpmCommandShimSha256 = [string]$record.npm.commandShimSha256
    NpmPackageFileCount = [int]$record.npm.packageFileCount
    NpmPackageTotalBytes = [int64]$record.npm.packageTotalBytes
    NpmPackageTreeSha256 = [string]$record.npm.packageTreeSha256
    ElectronVersion = [string]$record.tools.electron.version
    ElectronPackageJsonSha256 = [string]$record.tools.electron.packageJsonSha256
    ElectronEntrySha256 = [string]$record.tools.electron.entrySha256
    ElectronRuntimeSha256 = [string]$record.tools.electron.runtimeSha256
    ElectronArchiveSha256 = [string]$record.tools.electron.archiveSha256
    ElectronBuilderVersion = [string]$record.tools.'electron-builder'.version
    ElectronBuilderPackageJsonSha256 = [string]$record.tools.'electron-builder'.packageJsonSha256
    ElectronBuilderEntrySha256 = [string]$record.tools.'electron-builder'.entrySha256
    ElectronViteVersion = [string]$record.tools.'electron-vite'.version
    ElectronVitePackageJsonSha256 = [string]$record.tools.'electron-vite'.packageJsonSha256
    ElectronViteEntrySha256 = [string]$record.tools.'electron-vite'.entrySha256
    ViteVersion = [string]$record.tools.vite.version
    VitePackageJsonSha256 = [string]$record.tools.vite.packageJsonSha256
    ViteEntrySha256 = [string]$record.tools.vite.entrySha256
    TypeScriptVersion = [string]$record.tools.typescript.version
    TypeScriptPackageJsonSha256 = [string]$record.tools.typescript.packageJsonSha256
    TypeScriptEntrySha256 = [string]$record.tools.typescript.entrySha256
    GitExecutableVersion = [string]$record.hostTools.git.version
    GitExecutableSha256 = [string]$record.hostTools.git.executableSha256
    TarExecutableVersion = [string]$record.hostTools.tar.version
    TarExecutableSha256 = [string]$record.hostTools.tar.executableSha256
    ShellExecutableVersion = [string]$record.hostTools.shell.version
    ShellExecutableSha256 = [string]$record.hostTools.shell.executableSha256
    SevenZipArchiveSha256 = [string]$record.builderToolsets.sevenZip.archiveSha256
    SevenZipFileCount = [int]$record.builderToolsets.sevenZip.fileCount
    SevenZipTotalBytes = [int64]$record.builderToolsets.sevenZip.totalBytes
    SevenZipTreeSha256 = [string]$record.builderToolsets.sevenZip.treeSha256
    SevenZipExecutableSha256 = [string]$record.builderToolsets.sevenZip.executableSha256
    NsisArchiveSha256 = [string]$record.builderToolsets.nsis.archiveSha256
    NsisFileCount = [int]$record.builderToolsets.nsis.fileCount
    NsisTotalBytes = [int64]$record.builderToolsets.nsis.totalBytes
    NsisTreeSha256 = [string]$record.builderToolsets.nsis.treeSha256
    NsisExecutableSha256 = [string]$record.builderToolsets.nsis.executableSha256
    NsisResourcesArchiveSha256 = [string]$record.builderToolsets.nsisResources.archiveSha256
    NsisResourcesFileCount = [int]$record.builderToolsets.nsisResources.fileCount
    NsisResourcesTotalBytes = [int64]$record.builderToolsets.nsisResources.totalBytes
    NsisResourcesTreeSha256 = [string]$record.builderToolsets.nsisResources.treeSha256
    ToolchainSha256 = [string]$record.toolchainSha256
  }
}

function Get-CandidatePinnedSourceProvenance {
  param([Parameter(Mandatory)][psobject]$Candidate)
  $propertyNames = @(
    'SourceProvenanceSha256','SourceProvenanceSchema','GitObjectFormat','GitCommit','GitTree','SourceDirty','StrictBuild',
    'PackageJsonSha256','PackageLockSha256','LockfileVersion','DependencyFileCount','DependencyTotalBytes','DependencyTreeSha256',
    'NodeVersion','NodeExecutableSha256','NpmVersion','NpmCliSha256','NpmCommandShimSha256','NpmPackageFileCount','NpmPackageTotalBytes','NpmPackageTreeSha256',
    'ElectronVersion','ElectronPackageJsonSha256','ElectronEntrySha256',
    'ElectronRuntimeSha256','ElectronArchiveSha256','ElectronBuilderVersion','ElectronBuilderPackageJsonSha256','ElectronBuilderEntrySha256',
    'ElectronViteVersion','ElectronVitePackageJsonSha256','ElectronViteEntrySha256','ViteVersion','VitePackageJsonSha256','ViteEntrySha256',
    'TypeScriptVersion','TypeScriptPackageJsonSha256','TypeScriptEntrySha256','GitExecutableVersion','GitExecutableSha256',
    'TarExecutableVersion','TarExecutableSha256','ShellExecutableVersion','ShellExecutableSha256','SevenZipArchiveSha256','SevenZipFileCount','SevenZipTotalBytes','SevenZipTreeSha256',
    'SevenZipExecutableSha256','NsisArchiveSha256','NsisFileCount','NsisTotalBytes','NsisTreeSha256','NsisExecutableSha256',
    'NsisResourcesArchiveSha256','NsisResourcesFileCount','NsisResourcesTotalBytes','NsisResourcesTreeSha256','ToolchainSha256'
  )
  $present = @($propertyNames | Where-Object { $null -ne $Candidate.PSObject.Properties[$_] })
  if ([string]$Candidate.InstallerSha256 -ceq $script:LegacyProvenanceLessInstallerSha256) {
    if ($present.Count -eq 0) { return $null }
    throw 'The exact frozen 2.1.14 legacy receipt must remain provenance-less; do not attach unverified source claims to grandfathered bytes.'
  }
  if ($present.Count -ne $propertyNames.Count) {
    $missing = @($propertyNames | Where-Object { $null -eq $Candidate.PSObject.Properties[$_] })
    throw "Qualified candidate provenance receipt is incomplete. Missing: $($missing -join ', ')."
  }
  $projection = [ordered]@{}
  foreach ($name in $propertyNames) { $projection[$name] = $Candidate.$name }
  return [pscustomobject]$projection
}

function Assert-SourceProvenanceRecordsEqual {
  param(
    [Parameter(Mandatory)][psobject]$Expected,
    [Parameter(Mandatory)][psobject]$Actual,
    [string]$Context = 'source provenance'
  )
  $actualProjection = if ($null -ne $Actual.PSObject.Properties['schema']) { Get-SourceProvenanceReceiptProjection -Provenance $Actual } else { $Actual }
  foreach ($property in $Expected.PSObject.Properties) {
    $name = [string]$property.Name
    if ($Expected.$name -cne $actualProjection.$name) {
      throw "$Context mismatch for '$name'. Expected '$($Expected.$name)', found '$($actualProjection.$name)'."
    }
  }
}

function Get-CandidateQualificationProposal {
  param(
    [Parameter(Mandatory)][string]$RepoRoot,
    [Parameter(Mandatory)][string]$ReleaseDirectory,
    [scriptblock]$PayloadReader
  )

  $release = Read-UnqualifiedCandidateMetadata -ReleaseDirectory $ReleaseDirectory
  if (-not $PayloadReader) {
    $PayloadReader = {
      param([string]$InstallerPath, [string]$Root, [string]$Release)
      Read-InstallerCandidatePayloadIdentity -InstallerPath $InstallerPath -RepoRoot $Root -ReleaseDirectory $Release
    }
  }
  $payload = & $PayloadReader $release.InstallerPath $RepoRoot $ReleaseDirectory
  if (-not $payload) { throw 'Qualification payload inspection returned no identity.' }
  if ([string]$payload.ExtensionVersion -cne $release.Version) {
    throw "Candidate companion version $($payload.ExtensionVersion) does not match latest.yml version $($release.Version)."
  }
  if ([string]$payload.AsarPackageVersion -cne $release.Version) {
    throw "Candidate app.asar package version $($payload.AsarPackageVersion) does not match latest.yml version $($release.Version)."
  }
  if ([string]$payload.FileVersion -cne $release.Version) {
    throw "Candidate executable FileVersion $($payload.FileVersion) does not match latest.yml version $($release.Version)."
  }
  if ([string]$payload.ProductVersion -cne "$($release.Version).0") {
    throw "Candidate executable ProductVersion $($payload.ProductVersion) does not match expected $($release.Version).0."
  }
  if ([string]$payload.AppExecutableSha256 -notmatch '^[0-9a-f]{64}$') {
    throw 'Candidate payload executable SHA-256 is missing or malformed.'
  }
  $sourceMarkerPath = Join-Path $RepoRoot 'CUSTOM_BUILD'
  if (-not (Test-Path -LiteralPath $sourceMarkerPath -PathType Leaf)) { throw "Source CUSTOM_BUILD marker is missing: $sourceMarkerPath" }
  $sourceMarker = (Get-Content -Raw -LiteralPath $sourceMarkerPath).TrimEnd()
  if ([string]$payload.CustomBuildText -cne $sourceMarker) {
    throw 'Installer-contained CUSTOM_BUILD does not match the current custom source marker. Refusing to propose qualification for a stale/non-custom package.'
  }
  $sourcePackagePath = Join-Path $RepoRoot 'package.json'
  if (-not (Test-Path -LiteralPath $sourcePackagePath -PathType Leaf)) { throw "Source package.json is missing: $sourcePackagePath" }
  $sourceVersion = [string]((Get-Content -Raw -LiteralPath $sourcePackagePath | ConvertFrom-Json).version)
  if ($sourceVersion -cne $release.Version) {
    throw "Candidate version $($release.Version) does not match current source package version $sourceVersion. Refusing a stale-source qualification proposal."
  }
  $buildInputsVerified = $false
  if ($null -ne $payload.PSObject.Properties['BuildInputsVerified']) { $buildInputsVerified = [bool]$payload.BuildInputsVerified }
  $sourceProvenance = Assert-ProposalSourceProvenance -InstallerSha256 $release.InstallerSha256 -EmbeddedProvenance $payload.SourceProvenance -RepoRoot $RepoRoot -BuildInputsVerified:$buildInputsVerified

  return [pscustomobject]@{
    Version = $release.Version
    InstallerFile = $release.InstallerFile
    InstallerSize = $release.InstallerSize
    InstallerSha256 = $release.InstallerSha256
    InstallerSha512 = $release.InstallerSha512
    LatestYmlSha256 = $release.LatestYmlSha256
    ReleaseDate = $release.ReleaseDate
    AppExecutableSha256 = [string]$payload.AppExecutableSha256
    AppAsarSha256 = [string]$payload.AppAsarSha256
    ExtensionBackgroundSha256 = [string]$payload.ExtensionBackgroundSha256
    FileVersion = [string]$payload.FileVersion
    ProductVersion = [string]$payload.ProductVersion
    CustomBuildText = [string]$payload.CustomBuildText
    PayloadFileCount = [int]$payload.FileCount
    PayloadTotalBytes = [int64]$payload.TotalBytes
    PayloadTreeSha256 = [string]$payload.TreeSha256
    UnpackedCrossCheck = [string]$payload.UnpackedCrossCheck
    SourceProvenance = $sourceProvenance
    LegacyProvenanceException = ($null -eq $sourceProvenance)
  }
}

function Write-CandidateQualificationProposal {
  param([Parameter(Mandatory)][psobject]$Proposal)
  $marker = ([string]$Proposal.CustomBuildText).Replace("'", "''")
  Write-Host '[custom-install] QUALIFICATION PROPOSAL ONLY - no pinned receipt was changed and nothing was installed.' -ForegroundColor Yellow
  Write-Host '[custom-install] Review the exact package evidence below before deliberately replacing $script:QualifiedCandidate.' -ForegroundColor Yellow
  Write-Host ("[custom-install] installer payload tree: {0} files / {1} bytes / {2}; win-unpacked cross-check: {3}" -f $Proposal.PayloadFileCount, $Proposal.PayloadTotalBytes, $Proposal.PayloadTreeSha256, $Proposal.UnpackedCrossCheck)
  if ($Proposal.LegacyProvenanceException) {
    Write-Host "[custom-install] LEGACY SOURCE/BUILD EXCEPTION: exact frozen installer $($Proposal.InstallerSha256) predates embedded Git/build attestation; no other installer hash may omit it." -ForegroundColor Yellow
  } else {
    Write-Host ("[custom-install] source/build provenance verified: schema={0} format={1} commit={2} tree={3} dirty={4} strict={5}" -f $Proposal.SourceProvenance.schema, $Proposal.SourceProvenance.objectFormat, $Proposal.SourceProvenance.commit, $Proposal.SourceProvenance.tree, $Proposal.SourceProvenance.dirty, $Proposal.SourceProvenance.strictBuild) -ForegroundColor Green
    Write-Host ("[custom-install] lock/dependencies: package={0} lock={1} lockfileVersion={2} deps={3}/{4}/{5}" -f $Proposal.SourceProvenance.packageJsonSha256, $Proposal.SourceProvenance.packageLockSha256, $Proposal.SourceProvenance.lockfileVersion, $Proposal.SourceProvenance.dependencies.fileCount, $Proposal.SourceProvenance.dependencies.totalBytes, $Proposal.SourceProvenance.dependencies.treeSha256) -ForegroundColor Green
    Write-Host ("[custom-install] toolchain: node={0} npm={1} electron={2} electron-builder={3} electron-vite={4} vite={5} typescript={6} digest={7}" -f $Proposal.SourceProvenance.node.version, $Proposal.SourceProvenance.npm.version, $Proposal.SourceProvenance.tools.electron.version, $Proposal.SourceProvenance.tools.'electron-builder'.version, $Proposal.SourceProvenance.tools.'electron-vite'.version, $Proposal.SourceProvenance.tools.vite.version, $Proposal.SourceProvenance.tools.typescript.version, $Proposal.SourceProvenance.toolchainSha256) -ForegroundColor Green
  }
  Write-Host '$script:QualifiedCandidate = [pscustomobject]@{'
  Write-Host "  Version = '$($Proposal.Version)'"
  Write-Host "  InstallerFile = '$($Proposal.InstallerFile)'"
  Write-Host "  InstallerSize = [int64]$($Proposal.InstallerSize)"
  Write-Host "  InstallerSha256 = '$($Proposal.InstallerSha256)'"
  Write-Host "  InstallerSha512 = '$($Proposal.InstallerSha512)'"
  Write-Host "  LatestYmlSha256 = '$($Proposal.LatestYmlSha256)'"
  Write-Host "  ReleaseDate = '$($Proposal.ReleaseDate)'"
  Write-Host "  AppExecutableSha256 = '$($Proposal.AppExecutableSha256)'"
  Write-Host "  AppAsarSha256 = '$($Proposal.AppAsarSha256)'"
  Write-Host "  ExtensionBackgroundSha256 = '$($Proposal.ExtensionBackgroundSha256)'"
  Write-Host "  FileVersion = '$($Proposal.FileVersion)'"
  Write-Host "  ProductVersion = '$($Proposal.ProductVersion)'"
  Write-Host "  CustomBuildText = '$marker'"
  if (-not $Proposal.LegacyProvenanceException) {
    $receipt = Get-SourceProvenanceReceiptProjection -Provenance $Proposal.SourceProvenance
    foreach ($property in $receipt.PSObject.Properties) {
      $name = [string]$property.Name
      $value = $property.Value
      if ($value -is [bool]) {
        Write-Host "  $name = `$$(([string]$value).ToLowerInvariant())"
      } elseif ($value -is [int] -or $value -is [long]) {
        Write-Host "  $name = $value"
      } else {
        Write-Host "  $name = '$(([string]$value).Replace("'", "''"))'"
      }
    }
  }
  Write-Host '}'
}

function Get-InstalledPredecessorProposal {
  param(
    [Parameter(Mandatory)][string]$InstallRoot,
    [Parameter(Mandatory)][string]$RepoRoot,
    [Parameter(Mandatory)][string]$ReleaseDirectory,
    [Parameter(Mandatory)][psobject]$AcceptedPackageReceipt,
    [string]$AcceptedPackageReceiptSha256 = ''
  )

  # The package receipt is the authority; the installed tree hash is the proposed output. The
  # package payload is compared file-by-file before that output is emitted, with only the exact
  # NSIS-generated uninstaller executable permitted as an install-only file.
  $qualified = Assert-QualifiedPrebuiltCandidate -ReleaseDirectory $ReleaseDirectory -RepoRoot $RepoRoot -Candidate $AcceptedPackageReceipt
  $payload = Read-InstallerCandidatePayloadIdentity -InstallerPath $qualified.InstallerPath -RepoRoot $RepoRoot -ReleaseDirectory $ReleaseDirectory
  $packageRoot = Join-Path $ReleaseDirectory 'win-unpacked'
  if (-not (Test-Path -LiteralPath $packageRoot -PathType Container) -or [string]$payload.UnpackedCrossCheck -cne 'exact') {
    throw 'Installed predecessor proposal requires an exact win-unpacked cross-check against the qualified installer payload.'
  }

  $packageFull = [IO.Path]::GetFullPath($packageRoot).TrimEnd('\')
  $installedFull = [IO.Path]::GetFullPath($InstallRoot).TrimEnd('\')
  # Match the canonical fingerprint's ordinal path semantics. A PowerShell hashtable is
  # case-insensitive by default and would accept a case-only path substitution as identical.
  $packageFiles = [Collections.Generic.Dictionary[string,string]]::new([StringComparer]::Ordinal)
  foreach ($root in @($packageFull, $installedFull)) {
    $rootItem = Get-Item -LiteralPath $root -Force -ErrorAction Stop
    if ($rootItem.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw "Installed predecessor comparison refuses reparse-point root: $root" }
    $items = @(Get-ChildItem -LiteralPath $root -Recurse -Force -ErrorAction Stop)
    $reparse = @($items | Where-Object { $_.Attributes -band [IO.FileAttributes]::ReparsePoint })
    if ($reparse.Count -gt 0) { throw "Installed predecessor comparison refuses link/reparse entry: $($reparse[0].FullName)" }
  }
  foreach ($file in @(Get-ChildItem -LiteralPath $packageFull -Recurse -File -Force -ErrorAction Stop)) {
    $relative = $file.FullName.Substring($packageFull.Length + 1).Replace('\','/')
    if ($packageFiles.ContainsKey($relative)) { throw "Qualified package has a duplicate relative path: $relative" }
    $packageFiles[$relative] = ("{0}`t{1}" -f [int64]$file.Length,(Get-FileHashHex -Path $file.FullName))
  }
  $installedFiles = [Collections.Generic.Dictionary[string,string]]::new([StringComparer]::Ordinal)
  foreach ($file in @(Get-ChildItem -LiteralPath $installedFull -Recurse -File -Force -ErrorAction Stop)) {
    $relative = $file.FullName.Substring($installedFull.Length + 1).Replace('\','/')
    if ($installedFiles.ContainsKey($relative)) { throw "Installed predecessor has a duplicate relative path: $relative" }
    $installedFiles[$relative] = ("{0}`t{1}" -f [int64]$file.Length,(Get-FileHashHex -Path $file.FullName))
  }
  $missing = @($packageFiles.Keys | Where-Object { -not $installedFiles.ContainsKey($_) })
  $extra = @($installedFiles.Keys | Where-Object { -not $packageFiles.ContainsKey($_) -and $_ -cne 'Uninstall Chat On Steroids.exe' })
  $changed = @($packageFiles.Keys | Where-Object { $installedFiles.ContainsKey($_) -and $packageFiles[$_] -cne $installedFiles[$_] })
  if ($missing.Count -or $extra.Count -or $changed.Count) {
    throw ("Installed predecessor payload differs from qualified package. missing={0} extra={1} substituted={2}; samples: missing[{3}] extra[{4}] substituted[{5}]" -f $missing.Count,$extra.Count,$changed.Count,(@($missing | Select-Object -First 5) -join ','),(@($extra | Select-Object -First 5) -join ','),(@($changed | Select-Object -First 5) -join ','))
  }
  if (-not $installedFiles.ContainsKey('Uninstall Chat On Steroids.exe')) {
    throw 'Installed predecessor is missing the normal NSIS-generated uninstaller; refusing a predecessor proposal.'
  }
  $uninstaller = Get-Item -LiteralPath (Join-Path $installedFull 'Uninstall Chat On Steroids.exe') -Force
  if ($uninstaller.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'NSIS uninstaller is a link/reparse point; refusing predecessor proposal.' }
  $package = Assert-InstalledQualifiedBuild -InstallRoot $InstallRoot -Candidate $AcceptedPackageReceipt
  $sourcePath = Join-Path $InstallRoot $script:SourceProvenanceRelativePath
  $source = Read-SourceProvenanceRecord -Path $sourcePath
  if (-not $source) { throw 'Installed predecessor has unknown source provenance; no proposal can be made.' }
  $pinnedSource = Get-CandidatePinnedSourceProvenance -Candidate $AcceptedPackageReceipt
  if (-not $pinnedSource) { throw 'Accepted package receipt has no qualified source provenance; no proposal can be made.' }
  Assert-SourceProvenanceRecordsEqual -Expected $pinnedSource -Actual $source -Context 'Installed predecessor qualified source provenance'
  $tree = Get-DirectoryFingerprint -Root $InstallRoot

  return [pscustomobject]@{
    Status = 'exact-accepted-predecessor'
    ReadOnly = $true
    Version = [string]$AcceptedPackageReceipt.Version
    InstalledPath = [IO.Path]::GetFullPath($InstallRoot)
    TreeHashAlgorithm = 'SHA-256'
    TreeHashFrame = 'UTF-8 bytes of ordinal-sorted relative-path<TAB>file-length<TAB>file-SHA256 rows joined by LF, with no trailing LF'
    FileCount = [int]$tree.FileCount
    TotalBytes = [int64]$tree.TotalBytes
    TreeSha256 = [string]$tree.TreeSha256
    PayloadFileCount = [int]$payload.FileCount
    PayloadTotalBytes = [int64]$payload.TotalBytes
    PayloadTreeSha256 = [string]$payload.TreeSha256
    UnpackedCrossCheck = [string]$payload.UnpackedCrossCheck
    NsisUninstallerPresent = $installedFiles.ContainsKey('Uninstall Chat On Steroids.exe')
    AppExecutableSha256 = [string]$package.AppExecutableSha256
    AppAsarSha256 = [string]$package.AppAsarSha256
    ExtensionBackgroundSha256 = [string]$package.ExtensionBackgroundSha256
    SourceProvenanceSha256 = [string](Get-FileHashHex -Path $sourcePath)
    GitCommit = [string]$pinnedSource.GitCommit
    GitTree = [string]$pinnedSource.GitTree
    AcceptedPackageReceiptSha256 = $AcceptedPackageReceiptSha256
    InstallerSha256 = [string]$AcceptedPackageReceipt.InstallerSha256
    PackagePayloadMatch = 'qualified installer payload exact; NSIS uninstaller handled separately'
    Differences = [pscustomobject]@{ Missing = @(); Extra = @(); Substituted = @() }
  }
}

function Write-InstalledPredecessorProposal {
  param([Parameter(Mandatory)][psobject]$Proposal)
  Write-Host '[custom-install] INSTALLED PREDECESSOR PROPOSAL ONLY - read-only; no pin, install, process, or lifecycle state changed.' -ForegroundColor Yellow
  Write-Host ("[custom-install] version={0}; files={1}; bytes={2}; tree={3}:{4}" -f $Proposal.Version,$Proposal.FileCount,$Proposal.TotalBytes,$Proposal.TreeHashAlgorithm,$Proposal.TreeSha256)
  Write-Host ("[custom-install] tree frame: {0}" -f $Proposal.TreeHashFrame)
  Write-Host ("[custom-install] qualified payload: {0} files / {1} bytes / SHA-256 {2}; win-unpacked={3}; NSIS uninstaller present={4}" -f $Proposal.PayloadFileCount,$Proposal.PayloadTotalBytes,$Proposal.PayloadTreeSha256,$Proposal.UnpackedCrossCheck,$Proposal.NsisUninstallerPresent)
  Write-Host ("[custom-install] executable={0}; app.asar={1}; companion={2}" -f $Proposal.AppExecutableSha256,$Proposal.AppAsarSha256,$Proposal.ExtensionBackgroundSha256)
  Write-Host ("[custom-install] provenance={0}; commit={1}; tree={2}" -f $Proposal.SourceProvenanceSha256,$Proposal.GitCommit,$Proposal.GitTree)
  Write-Host ("[custom-install] accepted-receipt-sha256={0}; installer-sha256={1}" -f $Proposal.AcceptedPackageReceiptSha256,$Proposal.InstallerSha256)
  $differenceCount = @($Proposal.Differences.Missing).Count + @($Proposal.Differences.Extra).Count + @($Proposal.Differences.Substituted).Count
  Write-Host ("[custom-install] payload match: {0}; differences={1}" -f $Proposal.PackagePayloadMatch,$differenceCount)
}

function Enter-CustomInstallOperationLock {
  param([string]$Name = 'Local\ChatOnSteroidsCustomInstallTransaction')
  $createdNew = $false
  $mutex = [Threading.Mutex]::new($false, $Name, [ref]$createdNew)
  try {
    $acquired = $false
    try {
      $acquired = $mutex.WaitOne(0)
    } catch [Threading.AbandonedMutexException] {
      # The prior process died while owning the lock. Windows transfers ownership to this caller;
      # durable rollback marker/topology checks still decide whether filesystem recovery is safe.
      $acquired = $true
    }
    if (-not $acquired) {
      throw "Another Chat On Steroids custom build/install/rollback transaction is already running. Refusing concurrent mutation. Lock: $Name"
    }
    return $mutex
  } catch {
    $mutex.Dispose()
    throw
  }
}

function Exit-CustomInstallOperationLock {
  param([Parameter(Mandatory)][Threading.Mutex]$Mutex)
  try {
    $Mutex.ReleaseMutex()
  } finally {
    $Mutex.Dispose()
  }
}

function Assert-CustomInstallOperationAvailable {
  param([string]$Name = 'Local\ChatOnSteroidsCustomInstallTransaction')
  $mutex = $null
  try {
    # Readiness only needs a point-in-time proof that no mutator already owns the canonical lock.
    # Acquire and immediately release the existing mutex; do not hold it across the read-only
    # artifact/tree checks or turn readiness into a transaction of its own.
    $mutex = Enter-CustomInstallOperationLock -Name $Name
  } catch {
    throw "Qualified activation readiness is blocked because another custom transaction owns the mutation lock. $($_.Exception.Message)"
  } finally {
    if ($mutex) { Exit-CustomInstallOperationLock -Mutex $mutex }
  }
}

function Assert-AppNotRunning {
  param(
    [Parameter(Mandatory)][scriptblock]$ProcessProbe,
    [string]$Context = 'mutation',
    [switch]$LifecycleOwned
  )
  $running = @(& $ProcessProbe)
  if ($running.Count -gt 0) {
    if ($LifecycleOwned) {
      throw "Chat On Steroids became or remained running at the $Context boundary after lifecycle-owned Drain. No mutation was started; inspect or Cancel Drain in the app and retry the qualified activation deliberately."
    }
    throw "Chat On Steroids became or remained running at the $Context boundary. No mutation was started; quit it normally and retry."
  }
}

function ConvertFrom-WindowsProcessCommandLine {
  param([Parameter(Mandatory)][string]$CommandLine)
  if ([string]::IsNullOrWhiteSpace($CommandLine)) { throw 'Running Chat On Steroids process has no readable command line.' }
  if (-not ([System.Management.Automation.PSTypeName]'CosInstallCommandLineNative').Type) {
    Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class CosInstallCommandLineNative {
  [DllImport("shell32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
  public static extern IntPtr CommandLineToArgvW(string commandLine, out int argumentCount);
  [DllImport("kernel32.dll")]
  public static extern IntPtr LocalFree(IntPtr memory);
}
'@
  }
  [int]$argumentCount = 0
  $argv = [CosInstallCommandLineNative]::CommandLineToArgvW($CommandLine, [ref]$argumentCount)
  if ($argv -eq [IntPtr]::Zero -or $argumentCount -lt 1) {
    $code = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
    throw "Could not parse a running Chat On Steroids command line (Win32 error $code)."
  }
  try {
    $arguments = New-Object 'System.Collections.Generic.List[string]'
    for ($index = 0; $index -lt $argumentCount; $index += 1) {
      $pointer = [Runtime.InteropServices.Marshal]::ReadIntPtr($argv, $index * [IntPtr]::Size)
      $arguments.Add([Runtime.InteropServices.Marshal]::PtrToStringUni($pointer))
    }
    return @($arguments)
  } finally {
    $null = [CosInstallCommandLineNative]::LocalFree($argv)
  }
}

function ConvertTo-ProcessGenerationToken {
  param([Parameter(Mandatory)][object]$CreationDate)
  if ($CreationDate -is [DateTimeOffset]) {
    $instant = [DateTimeOffset]$CreationDate
  } elseif ($CreationDate -is [DateTime]) {
    $date = [DateTime]$CreationDate
    # Win32_Process.CreationDate is returned by CIM as a local DateTime. Preserve an explicit kind;
    # an unspecified CIM DateTime is also interpreted as local, matching PowerShell's CIM adapter.
    if ($date.Kind -eq [DateTimeKind]::Unspecified) {
      $date = [DateTime]::SpecifyKind($date, [DateTimeKind]::Local)
    }
    $instant = [DateTimeOffset]::new($date.ToUniversalTime())
  } else {
    throw 'Safe-close process inventory CreationDate must be a CIM DateTime value.'
  }
  [int64]$milliseconds = $instant.ToUnixTimeMilliseconds()
  if ($milliseconds -le 0 -or $milliseconds -gt [Math]::Pow(2, 53) - 1) {
    throw "Safe-close process inventory returned an invalid CreationDate generation '$CreationDate'."
  }
  return $milliseconds.ToString([Globalization.CultureInfo]::InvariantCulture)
}

function Get-StableInstalledAppProcessInventory {
  param(
    [scriptblock]$ProcessInventoryQuery,
    [scriptblock]$ProcessIdentityQuery,
    [scriptblock]$ProcessExistsProbe
  )
  if (-not $ProcessInventoryQuery) {
    $ProcessInventoryQuery = {
      @(Get-CimInstance -ClassName Win32_Process -Filter "Name='Chat On Steroids.exe'" -ErrorAction Stop |
        Select-Object Name, ProcessId, ExecutablePath, CommandLine, CreationDate)
    }
  }
  if (-not $ProcessIdentityQuery) {
    $ProcessIdentityQuery = {
      param([int]$ProcessId)
      @(Get-CimInstance -ClassName Win32_Process -Filter "ProcessId=$ProcessId" -ErrorAction Stop |
        Select-Object Name, ProcessId, ExecutablePath, CommandLine, CreationDate)
    }
  }
  if (-not $ProcessExistsProbe) {
    $ProcessExistsProbe = {
      param([int]$ProcessId)
      try {
        $process = [Diagnostics.Process]::GetProcessById($ProcessId)
      } catch [ArgumentException] {
        return $false
      }
      try {
        return [bool](-not $process.HasExited)
      } finally {
        $process.Dispose()
      }
    }
  }

  $stableRows = [Collections.Generic.List[object]]::new()
  foreach ($row in @(& $ProcessInventoryQuery)) {
    # Win32_Process can retain an exiting row after its CommandLine has already become blank. Only
    # that exact projection race gets a second look. Missing fields and malformed PIDs stay in the
    # normal resolver so they fail closed instead of acquiring a disappearance exception.
    $commandLineProperty = if ($row) { $row.PSObject.Properties['CommandLine'] } else { $null }
    if (-not $commandLineProperty -or -not [string]::IsNullOrWhiteSpace([string]$commandLineProperty.Value)) {
      $stableRows.Add($row)
      continue
    }
    [int]$processId = 0
    $processIdProperty = $row.PSObject.Properties['ProcessId']
    if (-not $processIdProperty -or
        -not [int]::TryParse([string]$processIdProperty.Value, [ref]$processId) -or
        $processId -le 0) {
      $stableRows.Add($row)
      continue
    }

    $refreshedRows = @(& $ProcessIdentityQuery $processId)
    if ($refreshedRows.Count -gt 1) {
      throw "Safe-close exact-PID re-query returned more than one row for process $processId."
    }
    if ($refreshedRows.Count -eq 0) {
      $existence = @(& $ProcessExistsProbe $processId)
      if ($existence.Count -ne 1 -or $existence[0] -isnot [bool]) {
        throw "Safe-close exact-PID existence probe returned an invalid result for process $processId."
      }
      if ([bool]$existence[0]) {
        throw "Chat On Steroids process $processId remains live but its exact process identity is unreadable. Automatic safe close was not requested."
      }
      Write-Host "[custom-install] process $processId exited during safe-close inventory; discarded its transient blank CommandLine row."
      continue
    }

    $refreshed = $refreshedRows[0]
    if (-not $refreshed) {
      throw "Safe-close exact-PID re-query returned an empty row for process $processId."
    }
    $refreshedIdProperty = $refreshed.PSObject.Properties['ProcessId']
    [int]$refreshedId = 0
    if (-not $refreshedIdProperty -or
        -not [int]::TryParse([string]$refreshedIdProperty.Value, [ref]$refreshedId) -or
        $refreshedId -ne $processId) {
      throw "Safe-close exact-PID re-query returned the wrong identity for process $processId."
    }
    $refreshedCommandLine = $refreshed.PSObject.Properties['CommandLine']
    if (-not $refreshedCommandLine -or [string]::IsNullOrWhiteSpace([string]$refreshedCommandLine.Value)) {
      throw "Chat On Steroids process $processId remains live with no readable command line. Automatic safe close was not requested."
    }
    $stableRows.Add($refreshed)
  }
  return @($stableRows.ToArray())
}

function Resolve-InstalledAppMainProcesses {
  param(
    [Parameter(Mandatory)][string]$InstallRoot,
    [Parameter(Mandatory)][AllowEmptyCollection()][object[]]$Rows
  )
  $installedApp = [IO.Path]::GetFullPath((Join-Path $InstallRoot 'Chat On Steroids.exe'))
  if (-not (Test-Path -LiteralPath $installedApp -PathType Leaf)) {
    throw "Installed Chat On Steroids executable is missing before safe-close inventory: $installedApp"
  }
  $byPid = [Collections.Generic.Dictionary[int,object]]::new()
  $byProfile = [Collections.Generic.Dictionary[string,object]]::new([StringComparer]::Ordinal)
  foreach ($row in @($Rows)) {
    if (-not $row) { throw 'Safe-close process inventory returned an empty row.' }
    foreach ($field in @('Name', 'ProcessId', 'ExecutablePath', 'CommandLine', 'CreationDate')) {
      if (-not $row.PSObject.Properties[$field]) { throw "Safe-close process inventory row is missing $field." }
    }
    if ([string]$row.Name -cne 'Chat On Steroids.exe') {
      throw "Safe-close process inventory returned an unexpected image name: '$([string]$row.Name)'."
    }
    [int]$processId = 0
    if (-not [int]::TryParse([string]$row.ProcessId, [ref]$processId) -or $processId -le 0) {
      throw "Safe-close process inventory returned an invalid process id: '$([string]$row.ProcessId)'."
    }
    $arguments = @(ConvertFrom-WindowsProcessCommandLine -CommandLine ([string]$row.CommandLine))
    if ($arguments.Count -lt 1) { throw "Chat On Steroids process $processId has an empty parsed command line." }
    try { $commandExecutable = [IO.Path]::GetFullPath($arguments[0]) }
    catch { throw "Chat On Steroids process $processId command line has an invalid executable token." }
    if (-not $commandExecutable.Equals($installedApp, [StringComparison]::OrdinalIgnoreCase)) {
      throw "Chat On Steroids process $processId command line does not name the exact installed executable. Automatic safe close was not requested."
    }
    if (@($arguments | Select-Object -Skip 1 | Where-Object { $_ -match '^--type(?:=|$)' }).Count -gt 0) {
      continue
    }
    $executablePath = [string]$row.ExecutablePath
    if ([string]::IsNullOrWhiteSpace($executablePath)) {
      throw "Chat On Steroids main process $processId has no readable executable path; automatic safe close is unavailable."
    }
    try { $resolvedExecutable = [IO.Path]::GetFullPath($executablePath) }
    catch { throw "Chat On Steroids main process $processId has an invalid executable path; automatic safe close is unavailable." }
    if (-not $resolvedExecutable.Equals($installedApp, [StringComparison]::OrdinalIgnoreCase)) {
      throw "Chat On Steroids main process $processId does not belong to the exact installed program root. Expected '$installedApp', found '$resolvedExecutable'. Automatic safe close was not requested."
    }
    try { $generationToken = ConvertTo-ProcessGenerationToken -CreationDate $row.CreationDate }
    catch { throw "Chat On Steroids main process $processId has no valid creation-time generation; automatic safe close is unavailable. $($_.Exception.Message)" }
    $runtimeArguments = @($arguments | Select-Object -Skip 1 | Where-Object { $_ -like '--cos-instance-runtime*' })
    if ($runtimeArguments.Count -gt 1) {
      throw "Chat On Steroids main process $processId has ambiguous instance-runtime arguments. Automatic safe close was not requested."
    }
    $profileId = 'local-instance'
    if ($runtimeArguments.Count -eq 1) {
      if ($runtimeArguments[0] -cnotmatch '^--cos-instance-runtime=(profile-[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?)$') {
        throw "Chat On Steroids main process $processId has a malformed instance-runtime argument. Automatic safe close was not requested."
      }
      $profileId = [string]$Matches[1]
    }
    $process = [pscustomobject]@{
      ProcessId = $processId
      ProfileId = $profileId
      GenerationToken = $generationToken
      InstalledApp = $installedApp
    }
    if ($byPid.ContainsKey($processId)) {
      $existing = $byPid[$processId]
      if ($existing.ProfileId -cne $profileId -or $existing.GenerationToken -cne $generationToken) {
        throw "Safe-close process inventory reported conflicting identities for process $processId."
      }
      continue
    }
    if ($byProfile.ContainsKey($profileId)) {
      throw "Safe-close process inventory reported more than one main process for profile '$profileId'. Automatic safe close was not requested."
    }
    $byPid.Add($processId, $process)
    $byProfile.Add($profileId, $process)
  }
  $resolved = @($byPid.Values)
  [Array]::Sort($resolved, [Comparison[object]]{
    param($left, $right)
    $profileOrder = [StringComparer]::Ordinal.Compare([string]$left.ProfileId, [string]$right.ProfileId)
    if ($profileOrder -ne 0) { return $profileOrder }
    return ([int]$left.ProcessId).CompareTo([int]$right.ProcessId)
  })
  return $resolved
}

function Test-InstalledSafeCloseCapability {
  param([Parameter(Mandatory)][psobject]$Baseline)
  $capability = $Baseline.PSObject.Properties['SafeCloseForUpdate']
  if (-not $capability -or $capability.Value -eq $false) { return $false }
  if ($capability.Value -isnot [bool] -or $capability.Value -ne $true) {
    throw 'Installed activation baseline has a malformed SafeCloseForUpdate capability declaration.'
  }
  $provenance = $Baseline.PSObject.Properties['SourceProvenanceSha256']
  if (-not $provenance -or [string]$provenance.Value -cnotmatch '^[0-9a-f]{64}$') {
    throw 'Installed activation baseline cannot enable automatic safe close without exact source provenance.'
  }
  return $true
}

function Request-InstalledAppSafeClose {
  param(
    [Parameter(Mandatory)][string]$InstallRoot,
    [Parameter(Mandatory)][scriptblock]$ProcessInventory,
    [Parameter(Mandatory)][scriptblock]$SafeCloseLauncher
  )
  $planned = @(Resolve-InstalledAppMainProcesses -InstallRoot $InstallRoot -Rows @(& $ProcessInventory))
  if ($planned.Count -eq 0) {
    return [pscustomobject]@{ RequestedProfiles = @(); AlreadyStoppedProfiles = @(); RequestCount = 0 }
  }
  $plannedByProfile = [Collections.Generic.Dictionary[string,object]]::new([StringComparer]::Ordinal)
  foreach ($process in $planned) { $plannedByProfile.Add([string]$process.ProfileId, $process) }
  $attempted = [Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
  $delivered = [Collections.Generic.List[string]]::new()
  $alreadyStopped = [Collections.Generic.List[string]]::new()
  $failures = [Collections.Generic.List[string]]::new()
  foreach ($target in $planned) {
    # Re-prove the exact PID/profile immediately before each launch. A vanished process is already
    # closed and is skipped. PID and creation time jointly fence Windows PID reuse (ABA). A
    # replacement or new account is not part of this bounded request set.
    try {
      $fresh = @(Resolve-InstalledAppMainProcesses -InstallRoot $InstallRoot -Rows @(& $ProcessInventory))
      foreach ($observed in $fresh) {
        if (-not $plannedByProfile.ContainsKey([string]$observed.ProfileId)) {
          throw "A new Chat On Steroids profile '$($observed.ProfileId)' appeared during safe-close inventory."
        }
        $plannedProcess = $plannedByProfile[[string]$observed.ProfileId]
        if ([int]$plannedProcess.ProcessId -ne [int]$observed.ProcessId) {
          throw "Chat On Steroids profile '$($observed.ProfileId)' restarted with a different PID during safe-close inventory."
        }
        if ([string]$plannedProcess.GenerationToken -cne [string]$observed.GenerationToken) {
          throw "Chat On Steroids profile '$($observed.ProfileId)' process generation changed during safe-close inventory."
        }
      }
    } catch {
      $failures.Add("inventory before $($target.ProfileId): $($_.Exception.Message)")
      break
    }
    $current = @($fresh | Where-Object {
      $_.ProfileId -ceq $target.ProfileId -and $_.ProcessId -eq $target.ProcessId -and
      $_.GenerationToken -ceq $target.GenerationToken
    })
    if ($current.Count -eq 0) {
      $alreadyStopped.Add([string]$target.ProfileId)
      continue
    }
    if (-not $attempted.Add([string]$target.ProfileId)) { continue }
    $arguments = if ($target.ProfileId -ceq 'local-instance') {
      @(
        '--safe-close-for-update=local-instance',
        "--safe-close-for-update-pid=$($target.ProcessId)",
        "--safe-close-for-update-generation=$($target.GenerationToken)"
      )
    } else {
      @(
        "--cos-instance-runtime=$($target.ProfileId)",
        "--safe-close-for-update=$($target.ProfileId)",
        "--safe-close-for-update-pid=$($target.ProcessId)",
        "--safe-close-for-update-generation=$($target.GenerationToken)"
      )
    }
    Write-Host "[custom-install] requesting lifecycle-owned safe close for $($target.ProfileId) (pid $($target.ProcessId), generation $($target.GenerationToken))"
    try {
      & $SafeCloseLauncher $target.InstalledApp $arguments $target.ProfileId $target.ProcessId $target.GenerationToken
      $delivered.Add([string]$target.ProfileId)
    } catch {
      # A launcher timeout/error can be post-delivery, so never retry it in this invocation.
      $failures.Add("$($target.ProfileId) (pid $($target.ProcessId), generation $($target.GenerationToken)): $($_.Exception.Message)")
    }
  }
  if ($failures.Count -gt 0) {
    $deliveredText = if ($delivered.Count -gt 0) { $delivered -join ', ' } else { 'none proven' }
    $stoppedText = if ($alreadyStopped.Count -gt 0) { $alreadyStopped -join ', ' } else { 'none' }
    throw "Safe-close lifecycle requests were only partially completed. Successful helper exits: $deliveredText. Already stopped before request: $stoppedText. Failed or ambiguous: $($failures -join ' | '). Installation did not proceed. Previously requested profiles may still drain and close; this script did not force-reopen them or send duplicates."
  }
  return [pscustomobject]@{
    RequestedProfiles = @($delivered.ToArray())
    AlreadyStoppedProfiles = @($alreadyStopped.ToArray())
    RequestCount = $delivered.Count
  }
}

function Get-RollbackArchivePath {
  param([psobject]$Baseline = $script:RollbackBaseline)
  return Join-Path (Join-Path $env:LOCALAPPDATA $Baseline.ArchiveDirectory) $Baseline.ArchiveFile
}

function Get-DirectoryFingerprint {
  param([Parameter(Mandatory)][string]$Root)
  if (-not (Test-Path -LiteralPath $Root -PathType Container)) { throw "Directory fingerprint root is missing: $Root" }
  $rootItem = Get-Item -LiteralPath $Root -Force -ErrorAction Stop
  if ($rootItem.Attributes -band [IO.FileAttributes]::ReparsePoint) {
    throw "Directory fingerprint refuses reparse-point root: $($rootItem.FullName)"
  }
  $full = [IO.Path]::GetFullPath($Root).TrimEnd('\')
  $items = @(Get-ChildItem -LiteralPath $full -Recurse -Force -ErrorAction Stop)
  $reparse = @($items | Where-Object { $_.Attributes -band [IO.FileAttributes]::ReparsePoint })
  if ($reparse.Count -gt 0) {
    throw "Directory fingerprint refuses reparse point: $($reparse[0].FullName)"
  }
  # Tree identities cross process, locale and machine boundaries. PowerShell Sort-Object uses
  # culture-aware string comparison, so its order is not a stable cryptographic input. Canonicalize
  # every relative path first and sort that exact string set with ordinal comparison.
  $fileByRelative = [Collections.Generic.Dictionary[string,object]]::new([StringComparer]::Ordinal)
  $relativeNames = [Collections.Generic.List[string]]::new()
  foreach ($file in @($items | Where-Object { -not $_.PSIsContainer })) {
    $relative = $file.FullName.Substring($full.Length + 1).Replace('\', '/')
    if ($fileByRelative.ContainsKey($relative)) {
      throw "Directory fingerprint found a duplicate relative path: $relative"
    }
    $fileByRelative.Add($relative, $file)
    $relativeNames.Add($relative)
  }
  $relativeNames.Sort([StringComparer]::Ordinal)
  $lines = New-Object System.Collections.Generic.List[string]
  [int64]$total = 0
  foreach ($relative in $relativeNames) {
    $file = $fileByRelative[$relative]
    $hash = Get-FileHashHex -Path $file.FullName
    $total += $file.Length
    $lines.Add("$relative`t$($file.Length)`t$hash")
  }
  $bytes = [Text.Encoding]::UTF8.GetBytes(($lines -join "`n"))
  $sha = [Security.Cryptography.SHA256]::Create()
  try {
    $tree = ([BitConverter]::ToString($sha.ComputeHash($bytes))).Replace('-', '').ToLowerInvariant()
  } finally {
    $sha.Dispose()
  }
  return [pscustomobject]@{ FileCount = $relativeNames.Count; TotalBytes = $total; TreeSha256 = $tree }
}

function Assert-RollbackArchive {
  param(
    [Parameter(Mandatory)][string]$ArchivePath,
    [psobject]$Baseline = $script:RollbackBaseline
  )
  if (-not (Test-Path -LiteralPath $ArchivePath -PathType Leaf)) { throw "Exact rollback artifact is missing: $ArchivePath" }
  $item = Get-Item -LiteralPath $ArchivePath
  if ($item.Name -cne $Baseline.ArchiveFile) {
    throw "Rollback artifact filename mismatch. Expected $($Baseline.ArchiveFile), found $($item.Name)."
  }
  if ([int64]$item.Length -ne [int64]$Baseline.ArchiveSize) {
    throw "Rollback artifact size mismatch. Expected $($Baseline.ArchiveSize), found $($item.Length)."
  }
  $sha256 = Get-FileHashHex -Path $item.FullName
  if ($sha256 -cne $Baseline.ArchiveSha256) {
    throw "Rollback artifact SHA-256 mismatch. Expected $($Baseline.ArchiveSha256), found $sha256."
  }
  return [pscustomobject]@{ ArchivePath = $item.FullName; ArchiveSize = [int64]$item.Length; ArchiveSha256 = $sha256; Version = $Baseline.Version }
}

function Assert-RollbackTree {
  param(
    [Parameter(Mandatory)][string]$Root,
    [psobject]$Baseline = $script:RollbackBaseline
  )
  $app = Join-Path $Root 'Chat On Steroids.exe'
  $appAsar = Join-Path $Root 'resources\app.asar'
  $extensionBackground = Join-Path $Root 'resources\extension\background.js'
  $extensionManifest = Join-Path $Root 'resources\extension\manifest.json'
  $customBuild = Join-Path $Root 'resources\CUSTOM_BUILD'
  $sourceProvenance = Join-Path $Root $script:SourceProvenanceRelativePath
  $expectedSourceProvenance = $Baseline.PSObject.Properties['SourceProvenanceSha256']
  $requiredFiles = @($app, $appAsar, $extensionBackground, $extensionManifest, $customBuild)
  if ($expectedSourceProvenance) { $requiredFiles += $sourceProvenance }
  foreach ($required in $requiredFiles) {
    if (-not (Test-Path -LiteralPath $required -PathType Leaf)) { throw "Rollback tree is missing required file: $required" }
  }

  $version = (Get-Item -LiteralPath $app).VersionInfo
  if ($version.FileVersion -cne $Baseline.FileVersion) { throw "Rollback app FileVersion mismatch. Expected $($Baseline.FileVersion), found $($version.FileVersion)." }
  if ($version.ProductVersion -cne $Baseline.ProductVersion) { throw "Rollback app ProductVersion mismatch. Expected $($Baseline.ProductVersion), found $($version.ProductVersion)." }
  $exeHash = Get-FileHashHex -Path $app
  if ($exeHash -cne $Baseline.ExeSha256) { throw "Rollback app executable hash mismatch. Expected $($Baseline.ExeSha256), found $exeHash." }
  $appAsarHash = Get-FileHashHex -Path $appAsar
  if ($appAsarHash -cne $Baseline.AppAsarSha256) { throw "Rollback app.asar hash mismatch. Expected $($Baseline.AppAsarSha256), found $appAsarHash." }
  $extensionHash = Get-FileHashHex -Path $extensionBackground
  if ($extensionHash -cne $Baseline.ExtensionBackgroundSha256) { throw "Rollback companion hash mismatch. Expected $($Baseline.ExtensionBackgroundSha256), found $extensionHash." }
  $manifest = Get-Content -Raw -LiteralPath $extensionManifest | ConvertFrom-Json
  if ([string]$manifest.version -cne $Baseline.ExtensionVersion) { throw "Rollback companion version mismatch. Expected $($Baseline.ExtensionVersion), found $($manifest.version)." }
  $marker = (Get-Content -Raw -LiteralPath $customBuild).TrimEnd()
  if ($marker -cne $Baseline.CustomBuildText) { throw 'Rollback CUSTOM_BUILD marker mismatch.' }
  if ($expectedSourceProvenance) {
    $sourceHash = Get-FileHashHex -Path $sourceProvenance
    if ($sourceHash -cne [string]$expectedSourceProvenance.Value) {
      throw "Installed source provenance hash mismatch. Expected $($expectedSourceProvenance.Value), found $sourceHash."
    }
  }

  $fingerprint = Get-DirectoryFingerprint -Root $Root
  if ($fingerprint.FileCount -ne $Baseline.FileCount) { throw "Rollback tree file-count mismatch. Expected $($Baseline.FileCount), found $($fingerprint.FileCount)." }
  if ([int64]$fingerprint.TotalBytes -ne [int64]$Baseline.TotalBytes) { throw "Rollback tree byte-count mismatch. Expected $($Baseline.TotalBytes), found $($fingerprint.TotalBytes)." }
  if ($fingerprint.TreeSha256 -cne $Baseline.TreeSha256) { throw "Rollback tree fingerprint mismatch. Expected $($Baseline.TreeSha256), found $($fingerprint.TreeSha256)." }
  return [pscustomobject]@{
    InstalledApp = $app
    Version = $Baseline.Version
    TreeSha256 = $fingerprint.TreeSha256
    FileCount = $fingerprint.FileCount
    TotalBytes = $fingerprint.TotalBytes
    AppAsarSha256 = $appAsarHash
    ExtensionBackgroundSha256 = $extensionHash
  }
}

function Expand-RollbackArchive {
  param(
    [Parameter(Mandatory)][string]$ArchivePath,
    [Parameter(Mandatory)][string]$Destination
  )
  if (Test-Path -LiteralPath $Destination) { throw "Rollback staging path already exists: $Destination" }
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  $destinationFull = [IO.Path]::GetFullPath($Destination).TrimEnd('\')
  $destinationPrefix = $destinationFull + '\'
  $targets = New-Object 'System.Collections.Generic.HashSet[string]' ([StringComparer]::OrdinalIgnoreCase)
  $zip = [IO.Compression.ZipFile]::OpenRead($ArchivePath)
  try {
    foreach ($entry in $zip.Entries) {
      $name = [string]$entry.FullName
      $portable = $name.Replace('\', '/')
      if ([string]::IsNullOrWhiteSpace($portable)) { throw 'Rollback archive contains an empty entry name.' }
      if ($portable.StartsWith('/') -or $portable.StartsWith('//') -or $portable -match '^[A-Za-z]:' -or [IO.Path]::IsPathRooted($name)) {
        throw "Rollback archive contains an absolute or drive-relative entry: $name"
      }
      $segments = @($portable.Split('/') | Where-Object { $_ -ne '' })
      $colonSegments = @($segments | Where-Object { $_.Contains(':') })
      if ($segments.Count -eq 0 -or $segments -contains '..' -or $colonSegments.Count -gt 0) {
        throw "Rollback archive contains an unsafe path entry: $name"
      }
      $target = [IO.Path]::GetFullPath((Join-Path $destinationFull $name))
      if (-not $target.StartsWith($destinationPrefix, [StringComparison]::OrdinalIgnoreCase)) {
        throw "Rollback archive entry escapes the staging root: $name"
      }
      if (-not $targets.Add($target.TrimEnd('\'))) {
        throw "Rollback archive contains duplicate/colliding target entries: $name"
      }
      $unixType = (($entry.ExternalAttributes -shr 16) -band 0xF000)
      $windowsReparse = (($entry.ExternalAttributes -band [int][IO.FileAttributes]::ReparsePoint) -ne 0)
      if ($unixType -eq 0xA000 -or $windowsReparse) {
        throw "Rollback archive contains a link/reparse entry: $name"
      }
    }
  } finally {
    $zip.Dispose()
  }
  New-Item -ItemType Directory -Path $Destination | Out-Null
  [IO.Compression.ZipFile]::ExtractToDirectory($ArchivePath, $Destination)
}

function Assert-QualifiedPrebuiltCandidate {
  param(
    [Parameter(Mandatory)][string]$ReleaseDirectory,
    [string]$RepoRoot,
    [psobject]$Candidate = $script:QualifiedCandidate
  )

  $latest = Join-Path $ReleaseDirectory 'latest.yml'
  $installer = Join-Path $ReleaseDirectory $Candidate.InstallerFile
  if (-not (Test-Path -LiteralPath $latest -PathType Leaf)) { throw "Qualified release metadata is missing: $latest" }
  if (-not (Test-Path -LiteralPath $installer -PathType Leaf)) { throw "Qualified installer is missing: $installer" }

  $expectedLatest = @(
    "version: $($Candidate.Version)",
    'files:',
    "  - url: $($Candidate.InstallerFile)",
    "    sha512: $($Candidate.InstallerSha512)",
    "    size: $($Candidate.InstallerSize)",
    "path: $($Candidate.InstallerFile)",
    "sha512: $($Candidate.InstallerSha512)",
    "releaseDate: '$($Candidate.ReleaseDate)'"
  )
  $actualLatest = @(Get-Content -LiteralPath $latest)
  if ($actualLatest.Count -ne $expectedLatest.Count) {
    throw "Qualified latest.yml has an unexpected shape. Expected $($expectedLatest.Count) lines, found $($actualLatest.Count)."
  }
  for ($i = 0; $i -lt $expectedLatest.Count; $i += 1) {
    if ($actualLatest[$i] -cne $expectedLatest[$i]) {
      throw "Qualified latest.yml mismatch on line $($i + 1). Refusing to install a stale or substituted release set."
    }
  }
  $latestHash = Get-FileHashHex -Path $latest
  if ($latestHash -cne $Candidate.LatestYmlSha256) {
    throw "Qualified latest.yml hash mismatch. Expected $($Candidate.LatestYmlSha256), found $latestHash."
  }

  $installerItem = Get-Item -LiteralPath $installer
  if ($installerItem.Name -cne $Candidate.InstallerFile) {
    throw "Qualified installer filename mismatch. Expected $($Candidate.InstallerFile), found $($installerItem.Name)."
  }
  if ([int64]$installerItem.Length -ne [int64]$Candidate.InstallerSize) {
    throw "Qualified installer size mismatch. Expected $($Candidate.InstallerSize), found $($installerItem.Length)."
  }
  $sha512 = Get-FileSha512Base64 -Path $installer
  if ($sha512 -cne $Candidate.InstallerSha512) {
    throw 'Qualified installer SHA-512 mismatch. The installer bytes are not the reviewed candidate.'
  }
  $sha256 = Get-FileHashHex -Path $installer
  if ($sha256 -cne $Candidate.InstallerSha256) {
    throw "Qualified installer SHA-256 mismatch. Expected $($Candidate.InstallerSha256), found $sha256."
  }
  $appExecutableHashProperty = $Candidate.PSObject.Properties['AppExecutableSha256']
  $appExecutableSha256 = if ($appExecutableHashProperty) { [string]$appExecutableHashProperty.Value } else { '' }
  if ($appExecutableSha256 -notmatch '^[0-9a-f]{64}$' -and $sha256 -cne $script:LegacyExecutableHashlessInstallerSha256) {
    throw 'Qualified candidate executable hash receipt is missing or malformed. Re-run qualification from the exact installer payload; only the exact pre-hash 2.1.15 installer may omit it.'
  }

  $pinnedSource = Get-CandidatePinnedSourceProvenance -Candidate $Candidate
  $sourceBinding = $null
  if ($sha256 -ceq $script:LegacyProvenanceLessInstallerSha256) {
    if ($pinnedSource) { throw 'Internal error: frozen legacy candidate unexpectedly has a pinned provenance record.' }
  } else {
    if (-not $RepoRoot) { $RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path }
    $embeddedSource = Read-InstallerSourceProvenance -InstallerPath $installerItem.FullName -RepoRoot $RepoRoot
    if (-not $embeddedSource) {
      throw "Qualified installer $sha256 has no embedded SOURCE_PROVENANCE.json. Only exact frozen installer $script:LegacyProvenanceLessInstallerSha256 may omit Git provenance."
    }
    $sourceBinding = Assert-SourceProvenanceAgainstRepository -Provenance $embeddedSource -RepoRoot $RepoRoot
    Assert-SourceProvenanceRecordsEqual -Expected $pinnedSource -Actual $sourceBinding -Context 'Qualified candidate pinned/embedded source provenance'
  }

  return [pscustomobject]@{
    Version = $Candidate.Version
    InstallerPath = $installerItem.FullName
    InstallerSize = [int64]$installerItem.Length
    InstallerSha256 = $sha256
    InstallerSha512 = $sha512
    SourceProvenance = $sourceBinding
    LegacyProvenanceException = ($sha256 -ceq $script:LegacyProvenanceLessInstallerSha256)
  }
}

function Assert-InstalledQualifiedBuild {
  param(
    [Parameter(Mandatory)][string]$InstallRoot,
    [psobject]$Candidate = $script:QualifiedCandidate
  )

  $installedApp = Join-Path $InstallRoot 'Chat On Steroids.exe'
  $appAsar = Join-Path $InstallRoot 'resources\app.asar'
  $extensionBackground = Join-Path $InstallRoot 'resources\extension\background.js'
  $extensionManifest = Join-Path $InstallRoot 'resources\extension\manifest.json'
  $customBuild = Join-Path $InstallRoot 'resources\CUSTOM_BUILD'
  $sourceProvenancePath = Join-Path $InstallRoot $script:SourceProvenanceRelativePath
  foreach ($required in @($installedApp, $appAsar, $extensionBackground, $extensionManifest, $customBuild)) {
    if (-not (Test-Path -LiteralPath $required -PathType Leaf)) {
      throw "Installed qualified-build verification is missing required file: $required"
    }
  }

  $versionInfo = (Get-Item -LiteralPath $installedApp).VersionInfo
  if ($versionInfo.FileVersion -cne $Candidate.FileVersion) {
    throw "Installed app FileVersion mismatch. Expected $($Candidate.FileVersion), found $($versionInfo.FileVersion)."
  }
  if ($versionInfo.ProductVersion -cne $Candidate.ProductVersion) {
    throw "Installed app ProductVersion mismatch. Expected $($Candidate.ProductVersion), found $($versionInfo.ProductVersion)."
  }
  $appExecutableHashProperty = $Candidate.PSObject.Properties['AppExecutableSha256']
  $expectedAppExecutableSha256 = if ($appExecutableHashProperty) { [string]$appExecutableHashProperty.Value } else { '' }
  $appExecutableHash = Get-FileHashHex -Path $installedApp
  if ($expectedAppExecutableSha256 -notmatch '^[0-9a-f]{64}$') {
    if ([string]$Candidate.InstallerSha256 -cne $script:LegacyExecutableHashlessInstallerSha256) {
      throw 'Qualified candidate executable hash receipt is missing or malformed. Refusing to accept installed binary identity.'
    }
  } else {
    if ($appExecutableHash -cne $expectedAppExecutableSha256) {
      throw "Installed app executable hash mismatch. Expected $expectedAppExecutableSha256, found $appExecutableHash."
    }
  }

  $appAsarHash = Get-FileHashHex -Path $appAsar
  if ($appAsarHash -cne $Candidate.AppAsarSha256) {
    throw "Installed app.asar hash mismatch. Expected $($Candidate.AppAsarSha256), found $appAsarHash."
  }
  $extensionHash = Get-FileHashHex -Path $extensionBackground
  if ($extensionHash -cne $Candidate.ExtensionBackgroundSha256) {
    throw "Installed companion hash mismatch. Expected $($Candidate.ExtensionBackgroundSha256), found $extensionHash."
  }
  $manifest = Get-Content -Raw -LiteralPath $extensionManifest | ConvertFrom-Json
  if ([string]$manifest.version -cne $Candidate.Version) {
    throw "Installed companion version mismatch. Expected $($Candidate.Version), found $($manifest.version)."
  }
  $marker = (Get-Content -Raw -LiteralPath $customBuild).TrimEnd()
  if ($marker -cne $Candidate.CustomBuildText) {
    throw 'Installed CUSTOM_BUILD marker mismatch. Refusing to report this installation as the qualified private build.'
  }
  $pinnedSource = Get-CandidatePinnedSourceProvenance -Candidate $Candidate
  if ($pinnedSource) {
    $installedSource = Read-SourceProvenanceRecord -Path $sourceProvenancePath
    if (-not $installedSource) { throw "Installed qualified build is missing required source provenance: $sourceProvenancePath" }
    Assert-SourceProvenanceRecordsEqual -Expected $pinnedSource -Actual $installedSource -Context 'Installed/pinned source provenance'
  } elseif (Test-Path -LiteralPath $sourceProvenancePath -PathType Leaf) {
    throw 'Frozen legacy qualified build unexpectedly contains SOURCE_PROVENANCE.json; refusing an ambiguous installed-state claim.'
  }

  return [pscustomobject]@{
    InstalledApp = $installedApp
    AppExecutableSha256 = $appExecutableHash
    AppAsarSha256 = $appAsarHash
    ExtensionBackgroundSha256 = $extensionHash
    SourceProvenanceSha256 = if ($pinnedSource) { [string]$Candidate.SourceProvenanceSha256 } else { $null }
    GitCommit = if ($pinnedSource) { [string]$Candidate.GitCommit } else { $null }
    GitTree = if ($pinnedSource) { [string]$Candidate.GitTree } else { $null }
    Version = [string]$manifest.version
  }
}

function Wait-ForNormalAppExit {
  param(
    [Parameter(Mandatory)][scriptblock]$ProcessProbe,
    [Parameter(Mandatory)][scriptblock]$SleepAction,
    [datetime]$Deadline = (Get-Date).AddMinutes(10)
  )

  $running = @(& $ProcessProbe)
  if ($running.Count -gt 0) {
    Write-Host ''
    Write-Host '[custom-install] the requested custom operation is waiting at the normal-Quit boundary; the app has not been interrupted.' -ForegroundColor Green
    Write-Host '[custom-install] right-click the Chat On Steroids tray icon and choose Quit.' -ForegroundColor Yellow
    Write-Host '[custom-install] this script only waits for the normal exit; it never kills the app.'
  }
  while ($running.Count -gt 0 -and (Get-Date) -lt $Deadline) {
    & $SleepAction
    $running = @(& $ProcessProbe)
  }
  if ($running.Count -gt 0) {
    throw 'Timed out waiting for a normal app quit. This invocation did not advance the requested custom operation. Run it again when ready.'
  }
}

function Wait-ForLifecycleOwnedAppExit {
  param(
    [Parameter(Mandatory)][scriptblock]$ProcessProbe,
    [Parameter(Mandatory)][scriptblock]$SleepAction,
    [Parameter(Mandatory)][psobject]$RequestSummary,
    [datetime]$Deadline = (Get-Date).AddMinutes(10)
  )

  $running = @(& $ProcessProbe)
  if ($running.Count -gt 0 -and [int]$RequestSummary.RequestCount -lt 1) {
    throw 'The lifecycle-capable inventory delivered no safe-close request, but Chat On Steroids is still running. Installation did not proceed and no direct-Quit fallback was attempted.'
  }
  if ($running.Count -gt 0) {
    Write-Host ''
    Write-Host "[custom-install] lifecycle-owned Drain was requested for: $(@($RequestSummary.RequestedProfiles) -join ', ')." -ForegroundColor Green
    Write-Host '[custom-install] wait for active work to drain and close normally. To keep the app running, choose Cancel Drain in the app and stop this wait with Ctrl+C.' -ForegroundColor Yellow
    Write-Host '[custom-install] this lifecycle path stays with the existing Drain owner; it never kills processes or sends another request.'
  }
  while ($running.Count -gt 0 -and (Get-Date) -lt $Deadline) {
    & $SleepAction
    $running = @(& $ProcessProbe)
  }
  if ($running.Count -gt 0) {
    throw 'Timed out waiting for lifecycle-owned Drain. Installation did not proceed. The app may still be draining or Drain may have been cancelled; no fallback close, duplicate request, or automatic reopen was attempted.'
  }
}

function Get-InstalledProgramFileLocks {
  param([Parameter(Mandatory)][string]$InstallRoot)

  # Closing CoS does not release another editor's Electron ASAR cache. Ask Windows for
  # existing owners before the runner captures state or NSIS tries to remove the app.
  # Restart Manager is inspection only: never call RmShutdown or terminate an owner.
  if (-not ('CosInstallRestartManagerNative' -as [type])) {
    Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
public static class CosInstallRestartManagerNative {
  [StructLayout(LayoutKind.Sequential)] public struct UniqueProcess {
    public int ProcessId;
    public System.Runtime.InteropServices.ComTypes.FILETIME StartTime;
  }
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] public struct Owner {
    public UniqueProcess Process;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst=256)] public string ApplicationName;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst=64)] public string ServiceName;
    public uint ApplicationType, AppStatus, SessionId;
    [MarshalAs(UnmanagedType.Bool)] public bool Restartable;
  }
  [DllImport("rstrtmgr.dll", CharSet=CharSet.Unicode)] static extern int RmStartSession(out uint handle, int flags, string key);
  [DllImport("rstrtmgr.dll", CharSet=CharSet.Unicode)] static extern int RmRegisterResources(uint handle, uint count, string[] files, uint apps, IntPtr processes, uint services, IntPtr serviceNames);
  [DllImport("rstrtmgr.dll")] static extern int RmGetList(uint handle, out uint needed, ref uint count, [In,Out] Owner[] owners, ref uint reasons);
  [DllImport("rstrtmgr.dll")] static extern int RmEndSession(uint handle);
  public static Owner[] Query(string[] files) {
    uint handle;
    int code = RmStartSession(out handle, 0, Guid.NewGuid().ToString("N"));
    if (code != 0) throw new Win32Exception(code, "Installed-file lock census could not start.");
    try {
      code = RmRegisterResources(handle, (uint)files.Length, files, 0, IntPtr.Zero, 0, IntPtr.Zero);
      if (code != 0) throw new Win32Exception(code, "Installed-file lock census could not register program files.");
      uint needed = 0, count = 0, reasons = 0;
      Owner[] owners = null;
      for (int attempt = 0; attempt < 3; attempt++) {
        code = RmGetList(handle, out needed, ref count, owners, ref reasons);
        if (code == 0) {
          if (count == 0) return new Owner[0];
          Array.Resize(ref owners, (int)count);
          return owners;
        }
        if (code != 234) throw new Win32Exception(code, "Installed-file lock census failed.");
        if (needed > 4096) throw new InvalidOperationException("Installed-file lock census exceeded its bounded owner inventory.");
        owners = new Owner[needed];
        count = needed;
      }
      throw new InvalidOperationException("Installed-file lock census changed repeatedly; no install was attempted.");
    } finally { RmEndSession(handle); }
  }
}
'@
  }
  $files = @(Get-ChildItem -LiteralPath $InstallRoot -File -Recurse -Force -ErrorAction Stop | ForEach-Object { $_.FullName })
  if ($files.Count -eq 0) { throw 'Installed-file lock census found no program files; installation was not attempted.' }
  foreach ($owner in [CosInstallRestartManagerNative]::Query([string[]]$files)) {
    [pscustomobject]@{
      ProcessId = $owner.Process.ProcessId
      ApplicationName = $owner.ApplicationName
      ServiceName = $owner.ServiceName
    }
  }
}

function Invoke-QualifiedInstallerTransaction {
  param(
    [Parameter(Mandatory)][psobject]$Qualified,
    [Parameter(Mandatory)][string]$InstallRoot,
    [Parameter(Mandatory)][scriptblock]$InstallerRunner,
    [Parameter(Mandatory)][scriptblock]$SuccessorLauncher,
    [psobject]$Candidate = $script:QualifiedCandidate
  )

  $fileOwners = @(Get-InstalledProgramFileLocks -InstallRoot $InstallRoot)
  if ($fileOwners.Count -gt 0) {
    $description = @($fileOwners | ForEach-Object { "$($_.ApplicationName) (PID $($_.ProcessId))" }) -join ', '
    throw "Installed program files are still held open by: $description. Save that application's work and close it normally before retrying. No capture/installer runner or successor was started; no owner was stopped."
  }
  Write-Host '[custom-install] installed-file lock census clear; installing the exact preflight-qualified candidate'
  $exitCode = [int](& $InstallerRunner $Qualified.InstallerPath)
  if ($exitCode -ne 0) {
    throw "The silent installer exited with code $exitCode. The installed state was not accepted; no resume was launched. Rollback is a separate deliberate action and was not run automatically."
  }

  # Do not trust NSIS exit status or an EXE's existence. The installed application and paired
  # companion must match the payload hashes that were qualified before shutdown.
  try {
    $installed = Assert-InstalledQualifiedBuild -InstallRoot $InstallRoot -Candidate $Candidate
  } catch {
    throw "The installer returned success, but the installed state was not accepted as the qualified $($Candidate.Version) build. No resume or companion reload was requested. Rollback is a separate deliberate action and was not run automatically. $($_.Exception.Message)"
  }
  Write-Host '[custom-install] installed payload matches the exact qualified candidate.' -ForegroundColor Green
  Write-Host "[custom-install] installed executable SHA-256: $($installed.AppExecutableSha256)"
  if ($installed.SourceProvenanceSha256) {
    Write-Host "[custom-install] installed source provenance: $($installed.SourceProvenanceSha256) (commit $($installed.GitCommit), tree $($installed.GitTree))"
  }

  try {
    & $SuccessorLauncher $installed.InstalledApp
  } catch {
    throw "The qualified $($Candidate.Version) installation was accepted and remains installed, but the automatic reopen/resume step failed or could not be confirmed. Do not rerun the installer based on this error. Rollback remains a separate deliberate action and was not run automatically. Reopen error: $($_.Exception.Message)"
  }
  Write-Host '[custom-install] update installed. Chat On Steroids is reopening with the same user data.' -ForegroundColor Green
  Write-Host '[custom-install] updated successors will reconcile stable Chrome inventory and resume only durable missing Goal/Loop work.' -ForegroundColor Green
  Write-Host '[custom-install] Chrome stays open; the paired companion reload is requested through the successor --updated startup.' -ForegroundColor Green
  return $installed
}

function Assert-LegacyRollbackStateCompatible {
  param([string]$UserDataRoot)
  # Program-only rollback leaves account stores in place. An older reader ignores the new
  # optional version-6 action reservations/budgets, so exact program hashes alone cannot
  # establish compatibility. Resolve the same registered state/queue owners as config.ts;
  # Electron's runtime/config directory is not the durable-store directory.
  if (-not $UserDataRoot) {
    if ([string]::IsNullOrWhiteSpace($env:APPDATA)) { throw 'Rollback state compatibility: the canonical application-data root is unavailable.' }
    $UserDataRoot = Join-Path $env:APPDATA 'chat-on-steroids'
  }
  if (-not [IO.Path]::IsPathRooted($UserDataRoot) -or $UserDataRoot.IndexOfAny([char[]]@(0, 10, 13)) -ge 0) {
    throw 'Rollback state compatibility: an explicit absolute application-data root is required.'
  }
  $root = [IO.Path]::GetFullPath($UserDataRoot)
  $attributesFor = {
    param([string]$Path)
    try { return [IO.File]::GetAttributes($Path) }
    catch {
      $cause = $_.Exception
      while ($cause.InnerException) { $cause = $cause.InnerException }
      if ($cause -is [IO.FileNotFoundException] -or $cause -is [IO.DirectoryNotFoundException]) { return $null }
      throw 'Rollback state compatibility: a selected account path could not be inspected; preserve its custody.'
    }
  }
  $directoryExists = {
    param([string]$Path)
    $attributes = & $attributesFor $Path
    if ($null -eq $attributes) { return $false }
    if (($attributes -band [IO.FileAttributes]::ReparsePoint) -or -not ($attributes -band [IO.FileAttributes]::Directory)) {
      throw "Rollback state compatibility: selected account directory is not a regular directory: $Path"
    }
    return $true
  }
  if (-not (& $directoryExists $root)) { return }
  $durableRoots = [Collections.Generic.List[string]]::new()
  $durableRoots.Add($root) # Legacy owner, including installations predating the registry.
  $sessionStoreRoots = [Collections.Generic.List[string]]::new()
  $sessionStoreRoots.Add($root)
  $instances = Join-Path $root 'instances'
  $readOwnerJson = {
    param([string]$Path, [hashtable]$ReadBudget = $null)
    $attributes = & $attributesFor $Path
    if ($null -eq $attributes) { return $null }
    if (($attributes -band [IO.FileAttributes]::ReparsePoint) -or ($attributes -band [IO.FileAttributes]::Directory)) {
      throw 'Selected owner configuration is not a regular file.'
    }
    $stream = $null
    try {
      $stream = [IO.File]::Open($Path, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
      if ($stream.Length -gt 8MB) {
        if ($ReadBudget) { $ReadBudget.Exceeded = $true }
        throw 'Owner configuration exceeds bounded read limit.'
      }
      if ($ReadBudget) {
        if ($ReadBudget.Bytes + $stream.Length -gt 64MB) { $ReadBudget.Exceeded = $true; throw 'Cumulative metadata read budget exceeded.' }
        $ReadBudget.Bytes += $stream.Length
      }
      $bytes = [byte[]]::new([int]$stream.Length)
      $offset = 0
      while ($offset -lt $bytes.Length) {
        $read = $stream.Read($bytes, $offset, $bytes.Length - $offset)
        if ($read -eq 0) { throw 'Owner configuration changed during read.' }
        $offset += $read
      }
      if ($stream.ReadByte() -ne -1) { throw 'Owner configuration grew during read.' }
      $text = [Text.UTF8Encoding]::new($false, $true).GetString($bytes)
      # ConvertFrom-Json/function output may unwrap a singleton root array. Require the
      # actual JSON object delimiter before parsing, independently of either shell's output.
      if ($text.Length -eq 0 -or $text[0] -eq [char]0xfeff -or
          -not $text.TrimStart([char[]]@(32,9,10,13)).StartsWith('{')) { throw 'Owner configuration is not a UTF-8 JSON object.' }
      $value = $text | ConvertFrom-Json
      if ($value -isnot [pscustomobject]) { throw 'Owner configuration must be an object.' }
      return $value
    } finally { if ($stream) { $stream.Dispose() } }
  }
  # The registry permits custom nested state roots below instances/. A bounded prefix trie
  # recognizes only those registered routes; it never walks native/session state below a leaf.
  $prefixes = [Collections.Generic.Dictionary[string,Collections.Generic.HashSet[string]]]::new([StringComparer]::OrdinalIgnoreCase)
  $prefixes.Add($instances, [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase))
  $queueOwners = [Collections.Generic.Dictionary[string,string]]::new([StringComparer]::OrdinalIgnoreCase)
  $queueOwners.Add($root, '')
  $sessionOwners = [Collections.Generic.Dictionary[string,string]]::new([StringComparer]::OrdinalIgnoreCase)
  $sessionOwners.Add($root, '')
  try {
    $config = & $readOwnerJson (Join-Path $root 'config.json')
    $registryProperty = if ($config) { $config.PSObject.Properties['instances'] } else { $null }
    if ($registryProperty) {
      $registry = $registryProperty.Value
      if ($registry -isnot [pscustomobject] -or
          ($registry.schemaVersion -isnot [int] -and $registry.schemaVersion -isnot [long]) -or $registry.schemaVersion -ne 1 -or
          $registry.profiles -isnot [array] -or $registry.profiles.Count -lt 1 -or $registry.profiles.Count -gt 32 -or
          $registry.activeInstanceId -isnot [string]) { throw 'Malformed instance registry.' }
      $device = & $readOwnerJson (Join-Path $root 'device-identity.json')
      $uuid = '^[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12}$'
      if (-not $device -or ($device.schemaVersion -isnot [int] -and $device.schemaVersion -isnot [long]) -or
          $device.schemaVersion -ne 1 -or $device.platform -cne 'win32' -or $device.id -isnot [string] -or $device.id -cnotmatch $uuid) {
        throw 'Local device routing identity is missing or malformed.'
      }
      $ids = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
      $stateRoots = [Collections.Generic.List[string]]::new()
      $queueIds = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
      $sessionIds = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
      $activeFound = $false
      $logicalId = '^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$'
      foreach ($profile in $registry.profiles) {
        if ($profile -isnot [pscustomobject] -or $profile.id -isnot [string] -or $profile.id -cnotmatch $logicalId -or
            -not $ids.Add($profile.id) -or $profile.platform -cnotin @('win32','darwin','linux') -or
            $profile.deviceId -isnot [string] -or $profile.deviceId -cnotmatch $uuid -or
            $profile.state -isnot [pscustomobject] -or $profile.state.mode -cnotin @('legacy','isolated') -or
            $profile.state.root -isnot [string] -or $profile.state.root.Length -eq 0 -or $profile.state.root.Length -gt 4096 -or
            $profile.namespaces -isnot [pscustomobject]) { throw 'Malformed registered account route.' }
        foreach ($owner in @('sessions','queue','logs','health')) {
          $namespace = $profile.namespaces.PSObject.Properties[$owner]
          if (-not $namespace -or $namespace.Value -isnot [string] -or $namespace.Value -cnotmatch $logicalId) {
            throw 'Malformed registered owner namespace.'
          }
        }
        $local = $profile.platform -ceq 'win32' -and $profile.deviceId -ieq $device.id
        if ($profile.id -ceq $registry.activeInstanceId) {
          if (-not $local -or ($profile.PSObject.Properties['enabled'] -and $profile.enabled -eq $false)) { throw 'Active account is not a local enabled owner.' }
          $activeFound = $true
        }
        if (-not $local) { continue } # Never follow another machine's portable paths.
        if (-not [IO.Path]::IsPathRooted($profile.state.root) -or $profile.state.root.IndexOfAny([char[]]@(0,10,13)) -ge 0) { throw 'Account state root must be absolute.' }
        $stateRoot = [IO.Path]::GetFullPath($profile.state.root).TrimEnd('\','/')
        if (-not $queueIds.Add($profile.namespaces.queue)) { throw 'Registered queue owners collide.' }
        if (-not $sessionIds.Add($profile.namespaces.sessions)) { throw 'Registered session owners collide.' }
        foreach ($prior in $stateRoots) {
          if ($stateRoot.Equals($prior,[StringComparison]::OrdinalIgnoreCase) -or
              ($profile.state.mode -ceq 'isolated' -and -not $prior.Equals($root,[StringComparison]::OrdinalIgnoreCase) -and
               ($stateRoot.StartsWith($prior+'\',[StringComparison]::OrdinalIgnoreCase) -or $prior.StartsWith($stateRoot+'\',[StringComparison]::OrdinalIgnoreCase)))) { throw 'Registered state owners collide.' }
        }
        $stateRoots.Add($stateRoot)
        if ($profile.state.mode -ceq 'legacy') {
          if (-not $stateRoot.Equals($root.TrimEnd('\','/'),[StringComparison]::OrdinalIgnoreCase)) { throw 'Legacy owner moved outside the canonical root.' }
          $queueOwners[$root] = $profile.namespaces.queue
          $sessionOwners[$root] = $profile.namespaces.sessions
        } else {
          if (-not $stateRoot.StartsWith($instances.TrimEnd('\','/')+'\',[StringComparison]::OrdinalIgnoreCase)) { throw 'Isolated state owner escaped the instances root.' }
          $parts = $stateRoot.Substring($instances.TrimEnd('\','/').Length + 1).Split([char]'\')
          if ($parts.Count -gt 64) { throw 'Account path exceeds bounded route depth.' }
          $parent = $instances
          foreach ($part in $parts) {
            if (-not $prefixes.ContainsKey($parent)) { $prefixes.Add($parent,[Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)) }
            $null = $prefixes[$parent].Add($part)
            $parent = Join-Path $parent $part
          }
          $queueOwners.Add($stateRoot, $profile.namespaces.queue)
          $sessionOwners.Add($stateRoot, $profile.namespaces.sessions)
        }
      }
      if (-not $activeFound) { throw 'Active account is absent from the registry.' }
    }
    $entries = 0
    foreach ($parent in $prefixes.Keys) {
      if (-not (& $directoryExists $parent)) { continue }
      foreach ($entry in [IO.Directory]::EnumerateFileSystemEntries($parent)) {
        if (++$entries -gt 4096 -or -not $prefixes[$parent].Contains([IO.Path]::GetFileName($entry))) { throw 'Unregistered or excessive account state routes require review.' }
        $null = & $directoryExists $entry
      }
    }
    foreach ($stateRoot in $queueOwners.Keys) {
      if (-not (& $directoryExists $stateRoot)) { continue }
      $namespaces = Join-Path $stateRoot 'namespaces'
      if (-not (& $directoryExists $namespaces)) { continue }
      foreach ($kind in @('queue','sessions')) {
        $owners = if ($kind -ceq 'queue') { $queueOwners } else { $sessionOwners }
        $container = Join-Path $namespaces $kind
        if (-not (& $directoryExists $container)) { continue }
        foreach ($namespace in [IO.Directory]::EnumerateFileSystemEntries($container)) {
          if (++$entries -gt 4096 -or -not $owners[$stateRoot] -or
              [IO.Path]::GetFileName($namespace) -cne $owners[$stateRoot]) { throw 'Unknown or excessive owner namespaces require review.' }
          $null = & $directoryExists $namespace
          if ($kind -ceq 'queue') { $durableRoots.Add($namespace) } else { $sessionStoreRoots.Add($namespace) }
        }
      }
    }
  } catch { throw 'Rollback state compatibility: account configuration or its registered state/queue/session namespaces are unreadable, malformed, linked or ambiguous; no older reader may start.' }
  $checked = 0
  foreach ($durableRoot in $durableRoots) {
    $state = Join-Path $durableRoot 'state'
    if (-not (& $directoryExists $state)) { continue }
    $ledger = Join-Path $state 'bridge-commands.json'
    $attributes = & $attributesFor $ledger
    if ($null -eq $attributes) { continue }
    if (($attributes -band [IO.FileAttributes]::ReparsePoint) -or ($attributes -band [IO.FileAttributes]::Directory)) {
      throw "Rollback state compatibility: bridge-commands is not a regular file: $ledger"
    }
    $stream = $null
    try {
      # Refuse writers/replacement while reading; cap actual reads, not only metadata. Never
      # inspect session bodies or recurse through the much larger native-state archive.
      $stream = [IO.File]::Open($ledger, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
      if ($stream.Length -gt 64MB) { throw 'ledger exceeds bounded read limit' }
      $bytes = [byte[]]::new([int]$stream.Length)
      $offset = 0
      while ($offset -lt $bytes.Length) {
        $read = $stream.Read($bytes, $offset, $bytes.Length - $offset)
        if ($read -eq 0) { throw 'ledger changed while reading' }
        $offset += $read
      }
      if ($stream.ReadByte() -ne -1) { throw 'ledger grew while reading' }
      $text = [Text.UTF8Encoding]::new($false, $true).GetString($bytes)
      if ($text.Length -eq 0 -or $text[0] -eq [char]0xfeff -or
          -not $text.TrimStart([char[]]@(32,9,10,13)).StartsWith('{')) { throw 'ledger is not a UTF-8 JSON object' }
      $saved = $text | ConvertFrom-Json
      if ($saved -isnot [pscustomobject]) { throw 'invalid ledger root' }
      $version = $saved.PSObject.Properties['version']
      $commands = $saved.PSObject.Properties['commands']
      if (-not $version -or ($version.Value -isnot [int] -and $version.Value -isnot [long]) -or
          $version.Value -lt 1 -or $version.Value -gt 6 -or -not $commands -or $commands.Value -isnot [array]) {
        throw 'unsupported or malformed ledger shape'
      }
      foreach ($field in @('recoveryClaims', 'repairTurnBudgets')) {
        $property = $saved.PSObject.Properties[$field]
        if ($property -and ($property.Value -isnot [array] -or $property.Value.Count -gt 0)) {
          throw 'new or malformed action custody requires its current reader'
        }
      }
      $checked++
    } catch {
      throw "Rollback state compatibility: bridge-commands is unreadable, malformed or retains action custody unsupported by the older reader: $ledger. Keep the current program/stores and reconcile with the current reader; no ledger was changed."
    } finally { if ($stream) { $stream.Dispose() } }
  }
  # Frozen 2.1.13 predates private native scope checkpoints, including v1. Inspect BOTH
  # metadata files independently: a missing/damaged v2 primary must not be replaced by an
  # apparently safe old v1 backup. This conservative OLD-reader gate does not change normal
  # qualified upgrades; even a legitimate first-write/no-backup pair may require reconciliation.
  $metadataOwners = [Collections.Generic.List[object]]::new()
  $metadataBudget = @{ Bytes = [int64]0; Exceeded = $false; Entries = 0 }
  $addMetadataOwner = {
    param([string]$Directory, [string]$SessionId)
    if ($metadataOwners.Count -ge 5000) { $metadataBudget.Exceeded = $true; throw 'Session metadata owner capacity exceeded.' }
    $null = & $directoryExists $Directory
    $metadataOwners.Add([pscustomobject]@{ Directory = $Directory; SessionId = $SessionId })
  }
  $collectSessionOwner = {
    param([string]$Directory, [string]$SessionId)
    & $addMetadataOwner $Directory $SessionId
    # Undo can bring these metadata-only recovery folders back into an active session.
    # Only their known direct level is inspected; events/assets/messages are never opened.
    foreach ($entry in [IO.Directory]::EnumerateFileSystemEntries($Directory)) {
      if (++$metadataBudget.Entries -gt 100000) { $metadataBudget.Exceeded = $true; throw 'Metadata discovery capacity exceeded.' }
      $name = [IO.Path]::GetFileName($entry)
      if (-not $name.StartsWith('.late-metadata-', [StringComparison]::Ordinal)) { continue }
      if ($name -cnotmatch '^\.late-metadata-[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$') { throw 'Unknown late metadata recovery owner.' }
      & $addMetadataOwner $entry $SessionId
      foreach ($file in [IO.Directory]::EnumerateFileSystemEntries($entry)) {
        if (++$metadataBudget.Entries -gt 100000) { $metadataBudget.Exceeded = $true; throw 'Metadata discovery capacity exceeded.' }
        if ([IO.Path]::GetFileName($file) -cnotin @('meta.json','meta.backup.json')) { throw 'Unknown metadata-only recovery path.' }
      }
    }
  }
  try {
    foreach ($storeRoot in $sessionStoreRoots) {
      $sessions = Join-Path $storeRoot 'sessions'
      if (-not (& $directoryExists $sessions)) { continue }
      foreach ($entry in [IO.Directory]::EnumerateFileSystemEntries($sessions)) {
        if (++$metadataBudget.Entries -gt 100000) { $metadataBudget.Exceeded = $true; throw 'Metadata discovery capacity exceeded.' }
        $id = [IO.Path]::GetFileName($entry)
        if ($id -ceq '.deleted-sessions') {
          $null = & $directoryExists $entry
          foreach ($deleted in [IO.Directory]::EnumerateFileSystemEntries($entry)) {
            if (++$metadataBudget.Entries -gt 100000) { $metadataBudget.Exceeded = $true; throw 'Metadata discovery capacity exceeded.' }
            $deletedId = [IO.Path]::GetFileName($deleted)
            if ($deletedId -notmatch '^[0-9a-z-]{8,64}$') { throw 'Unknown deleted session owner.' }
            & $collectSessionOwner $deleted $deletedId
          }
        } elseif ($id -match '^[0-9a-z-]{8,64}$') {
          & $collectSessionOwner $entry $id
        } else { throw 'Unknown session metadata owner path.' }
      }
    }
    foreach ($owner in $metadataOwners) {
      foreach ($name in @('meta.json','meta.backup.json')) {
        $metadata = & $readOwnerJson (Join-Path $owner.Directory $name) $metadataBudget
        if (-not $metadata -or -not $metadata.PSObject.Properties['id'] -or
            $metadata.PSObject.Properties['id'].Name -cne 'id' -or $metadata.id -cne $owner.SessionId) { throw 'Missing or foreign session metadata pair.' }
        $private = $metadata.PSObject.Properties['__nativeCompletionFences']
        if (-not $private) { continue }
        $checkpoint = $private.Value
        if ($private.Name -cne '__nativeCompletionFences' -or $checkpoint -isnot [pscustomobject] -or
            @($checkpoint.PSObject.Properties).Count -ne 2 -or
            @($checkpoint.PSObject.Properties.Name) -cnotcontains 'version' -or @($checkpoint.PSObject.Properties.Name) -cnotcontains 'slots' -or
            ($checkpoint.version -isnot [int] -and $checkpoint.version -isnot [long]) -or $checkpoint.version -ne 1 -or
            $checkpoint.slots -isnot [pscustomobject] -or @($checkpoint.slots.PSObject.Properties).Count -ne 0) {
          throw 'Private native scope custody is unsupported by the frozen reader.'
        }
      }
    }
  } catch {
    if ($metadataBudget.Exceeded) { throw 'Rollback state compatibility: session metadata capacity exceeded (5000 owners, 8 MiB/file, 64 MiB cumulative reads); preserve the current reader and all stores.' }
    throw 'Rollback state compatibility: session metadata pair is missing, malformed, unreadable, linked, unknown or retains native scope custody unsupported by frozen 2.1.13; preserve both metadata files and the current reader.'
  }
  Write-Host "[custom-install] rollback state compatibility: $checked command ledgers and $($metadataOwners.Count) session metadata owners checked; no unsupported action/scope custody was accepted."
}

function Invoke-RollbackSuccessor {
  param(
    [Parameter(Mandatory)][scriptblock]$SuccessorLauncher,
    [Parameter(Mandatory)][string]$InstalledApp,
    [Parameter(Mandatory)][string]$Version,
    [string]$UserDataRoot
  )
  Assert-LegacyRollbackStateCompatible -UserDataRoot $UserDataRoot
  try {
    & $SuccessorLauncher $InstalledApp
  } catch {
    throw "The exact private $Version rollback was restored and verified, but the automatic reopen step failed or could not be confirmed. The rollback itself is complete; do not rerun rollback solely because of this reopen error. Reopen error: $($_.Exception.Message)"
  }
}

function Get-RollbackTransactionPaths {
  param([Parameter(Mandatory)][string]$InstallRoot)
  $installFull = [IO.Path]::GetFullPath($InstallRoot).TrimEnd('\')
  $parent = [IO.Path]::GetDirectoryName($installFull)
  $leaf = [IO.Path]::GetFileName($installFull)
  if (-not $parent -or -not $leaf) { throw "Cannot derive rollback transaction paths from installation: $installFull" }
  return [pscustomobject]@{
    Install = $installFull
    Stage = Join-Path $parent "$leaf.rollback-stage"
    Quarantine = Join-Path $parent "$leaf.rollback-quarantine"
    Marker = Join-Path $parent "$leaf.rollback-transaction.json"
  }
}

function Write-RollbackTransactionMarker {
  param(
    [Parameter(Mandatory)][psobject]$Paths,
    [Parameter(Mandatory)][psobject]$Baseline
  )
  if (Test-Path -LiteralPath $Paths.Marker) { throw "Rollback transaction marker already exists: $($Paths.Marker)" }
  $payload = [ordered]@{
    version = 1
    installRoot = [IO.Path]::GetFullPath($Paths.Install).TrimEnd('\')
    stageRoot = [IO.Path]::GetFullPath($Paths.Stage).TrimEnd('\')
    quarantineRoot = [IO.Path]::GetFullPath($Paths.Quarantine).TrimEnd('\')
    archiveSha256 = [string]$Baseline.ArchiveSha256
    treeSha256 = [string]$Baseline.TreeSha256
  }
  $bytes = [Text.UTF8Encoding]::new($false).GetBytes(($payload | ConvertTo-Json -Compress))
  $stream = [IO.File]::Open($Paths.Marker, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
  try {
    $stream.Write($bytes, 0, $bytes.Length)
    $stream.Flush($true)
  } finally {
    $stream.Dispose()
  }
}

function Read-RollbackTransactionMarker {
  param(
    [Parameter(Mandatory)][psobject]$Paths,
    [Parameter(Mandatory)][psobject]$Baseline
  )
  if (-not (Test-Path -LiteralPath $Paths.Marker)) { return $null }
  if (-not (Test-Path -LiteralPath $Paths.Marker -PathType Leaf)) {
    throw "Rollback transaction marker path exists but is not an ordinary file; fail closed without deleting anything: $($Paths.Marker)"
  }
  $markerItem = Get-Item -LiteralPath $Paths.Marker -Force -ErrorAction Stop
  if ($markerItem.Attributes -band [IO.FileAttributes]::ReparsePoint) {
    throw "Rollback transaction marker is a reparse point; fail closed without deleting anything: $($Paths.Marker)"
  }
  try {
    $marker = Get-Content -Raw -LiteralPath $Paths.Marker | ConvertFrom-Json
  } catch {
    throw "Rollback transaction marker is unreadable or malformed; fail closed without deleting anything: $($Paths.Marker). $($_.Exception.Message)"
  }
  $expectedInstall = [IO.Path]::GetFullPath($Paths.Install).TrimEnd('\')
  $expectedStage = [IO.Path]::GetFullPath($Paths.Stage).TrimEnd('\')
  $expectedQuarantine = [IO.Path]::GetFullPath($Paths.Quarantine).TrimEnd('\')
  if ([int]$marker.version -ne 1 -or
      [IO.Path]::GetFullPath([string]$marker.installRoot).TrimEnd('\') -cne $expectedInstall -or
      [IO.Path]::GetFullPath([string]$marker.stageRoot).TrimEnd('\') -cne $expectedStage -or
      [IO.Path]::GetFullPath([string]$marker.quarantineRoot).TrimEnd('\') -cne $expectedQuarantine -or
      [string]$marker.archiveSha256 -cne [string]$Baseline.ArchiveSha256 -or
      [string]$marker.treeSha256 -cne [string]$Baseline.TreeSha256) {
    throw "Rollback transaction marker identity does not match the canonical transaction; fail closed without deleting anything: $($Paths.Marker)"
  }
  return $marker
}

function Remove-RollbackTransactionMarker {
  param([Parameter(Mandatory)][psobject]$Paths)
  if (Test-Path -LiteralPath $Paths.Marker) {
    if (-not (Test-Path -LiteralPath $Paths.Marker -PathType Leaf)) {
      throw "Rollback transaction marker cleanup refused a non-file path: $($Paths.Marker)"
    }
    $markerItem = Get-Item -LiteralPath $Paths.Marker -Force -ErrorAction Stop
    if ($markerItem.Attributes -band [IO.FileAttributes]::ReparsePoint) {
      throw "Rollback transaction marker cleanup refused a reparse point: $($Paths.Marker)"
    }
    Remove-Item -LiteralPath $Paths.Marker -Force -ErrorAction Stop
    if (Test-Path -LiteralPath $Paths.Marker) {
      throw "Rollback transaction marker cleanup returned without removing the marker: $($Paths.Marker)"
    }
  }
}

function Remove-RollbackOwnedDirectory {
  param(
    [Parameter(Mandatory)][string]$Path,
    [Parameter(Mandatory)][scriptblock]$RemoveDirectory,
    [Parameter(Mandatory)][string]$Context
  )
  if (Test-Path -LiteralPath $Path) {
    $item = Get-Item -LiteralPath $Path -Force -ErrorAction Stop
    if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) {
      throw "$Context cleanup refuses a reparse-point owned path: $Path"
    }
    & $RemoveDirectory $Path
  }
  if (Test-Path -LiteralPath $Path) {
    throw "$Context cleanup returned without removing the owned path: $Path"
  }
}

function Move-RollbackOwnedDirectory {
  param(
    [Parameter(Mandatory)][string]$Source,
    [Parameter(Mandatory)][string]$Destination,
    [Parameter(Mandatory)][scriptblock]$MoveDirectory,
    [Parameter(Mandatory)][string]$Context,
    [scriptblock]$ProcessProbe
  )
  if (-not (Test-Path -LiteralPath $Source -PathType Container)) {
    throw "$Context source directory is missing: $Source"
  }
  $sourceItem = Get-Item -LiteralPath $Source -Force -ErrorAction Stop
  if ($sourceItem.Attributes -band [IO.FileAttributes]::ReparsePoint) {
    throw "$Context source is a reparse point: $Source"
  }
  if (Test-Path -LiteralPath $Destination) {
    throw "$Context destination already exists: $Destination"
  }
  # Windows scanners can briefly deny a directory rename. Retry only a positively unchanged
  # pre-move tree, never an exception after the move (or a replacement/colliding directory).
  # The process proof is mandatory for retry, including recovery moves; unknown ownership fails
  # closed. This adds no delay or retry to normal qualified installation or unclassified errors.
  $sourceCreated = $sourceItem.CreationTimeUtc.Ticks
  $sourceProof = if ($ProcessProbe) { Get-DirectoryFingerprint -Root $Source } else { $null }
  $sameSource = {
    try {
      if ((Test-Path -LiteralPath $Destination) -or -not (Test-Path -LiteralPath $Source -PathType Container)) { return $false }
      $current = Get-Item -LiteralPath $Source -Force -ErrorAction Stop
      if (($current.Attributes -band [IO.FileAttributes]::ReparsePoint) -or $current.CreationTimeUtc.Ticks -ne $sourceCreated) { return $false }
      $proof = Get-DirectoryFingerprint -Root $Source
      return $proof.FileCount -eq $sourceProof.FileCount -and
        [int64]$proof.TotalBytes -eq [int64]$sourceProof.TotalBytes -and
        $proof.TreeSha256 -ceq $sourceProof.TreeSha256
    } catch { return $false }
  }
  $retryDelays = @(100, 250, 500, 1000, 2000)
  $retry = 0
  while ($true) {
    try {
      & $MoveDirectory $Source $Destination
      break
    } catch {
      $moveFailure = $_
      $transient = $false
      for ($exception = $moveFailure.Exception; $null -ne $exception; $exception = $exception.InnerException) {
        if ((($exception -is [UnauthorizedAccessException] -or $exception -is [IO.IOException]) -and
            (($exception.HResult -band 0xFFFF) -in @(5, 32, 33))) -or
            ($exception -is [ComponentModel.Win32Exception] -and $exception.NativeErrorCode -in @(5, 32, 33))) {
          $transient = $true
        }
      }
      if (-not $ProcessProbe -or -not $transient -or $retry -ge $retryDelays.Count -or -not (& $sameSource)) { throw $moveFailure }
      $delay = $retryDelays[$retry]
      Write-Host "[custom-install] $Context encountered a Windows access/sharing refusal; rechecking the unchanged source before retry $($retry + 1)/$($retryDelays.Count) in ${delay}ms: $Source" -ForegroundColor Yellow
      Start-Sleep -Milliseconds $delay
      if (-not (& $sameSource)) { throw $moveFailure }
      Assert-AppNotRunning -ProcessProbe $ProcessProbe -Context "$Context retry"
      if (-not (& $sameSource)) { throw $moveFailure }
      $retry += 1
    }
  }
  if (Test-Path -LiteralPath $Source) {
    throw "$Context move returned without retiring the source directory: $Source"
  }
  if (-not (Test-Path -LiteralPath $Destination -PathType Container)) {
    throw "$Context move returned without creating the destination directory: $Destination"
  }
  $destinationItem = Get-Item -LiteralPath $Destination -Force -ErrorAction Stop
  if ($destinationItem.Attributes -band [IO.FileAttributes]::ReparsePoint) {
    throw "$Context move created a reparse-point destination: $Destination"
  }
}

function Throw-RollbackStagingFailure {
  param(
    [Parameter(Mandatory)][psobject]$Paths,
    [Parameter(Mandatory)][scriptblock]$RemoveDirectory,
    [Parameter(Mandatory)][string]$PrimaryError,
    [Parameter(Mandatory)][string]$Context
  )
  try {
    Remove-RollbackOwnedDirectory -Path $Paths.Stage -RemoveDirectory $RemoveDirectory -Context "$Context stage"
  } catch {
    throw "$Context before the installed program was touched, and marker-owned stage cleanup also failed. marker='$($Paths.Marker)' stage='$($Paths.Stage)'. Primary error: $PrimaryError Cleanup error: $($_.Exception.Message)"
  }
  try {
    Remove-RollbackTransactionMarker -Paths $Paths
  } catch {
    throw "$Context before the installed program was touched. The stage was cleaned, but marker cleanup failed. marker='$($Paths.Marker)'. Primary error: $PrimaryError Cleanup error: $($_.Exception.Message)"
  }
  throw "$Context before the installed program was touched. $PrimaryError"
}

function Get-RollbackTransactionTopology {
  param(
    [Parameter(Mandatory)][psobject]$Paths,
    [Parameter(Mandatory)][psobject]$Baseline
  )
  $marker = Read-RollbackTransactionMarker -Paths $Paths -Baseline $Baseline
  $installExists = Test-Path -LiteralPath $Paths.Install
  $stageExists = Test-Path -LiteralPath $Paths.Stage
  $quarantineExists = Test-Path -LiteralPath $Paths.Quarantine
  $install = Test-Path -LiteralPath $Paths.Install -PathType Container
  $stage = Test-Path -LiteralPath $Paths.Stage -PathType Container
  $quarantine = Test-Path -LiteralPath $Paths.Quarantine -PathType Container
  foreach ($entry in @(
    [pscustomobject]@{ Exists = $installExists; IsDirectory = $install; Path = $Paths.Install; Label = 'installation' },
    [pscustomobject]@{ Exists = $stageExists; IsDirectory = $stage; Path = $Paths.Stage; Label = 'stage' },
    [pscustomobject]@{ Exists = $quarantineExists; IsDirectory = $quarantine; Path = $Paths.Quarantine; Label = 'quarantine' }
  )) {
    if ($entry.Exists -and $entry.IsDirectory) {
      $item = Get-Item -LiteralPath $entry.Path -Force -ErrorAction Stop
      if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) {
        throw "Rollback $($entry.Label) path is a reparse point; fail closed without deleting or moving anything: $($entry.Path)"
      }
    }
  }
  if (-not $marker) {
    $owned = @()
    if ($stageExists) { $owned += $Paths.Stage }
    if ($quarantineExists) { $owned += $Paths.Quarantine }
    if ($owned.Count -gt 0) {
      throw "Rollback-owned-looking sibling artifacts exist without the canonical marker; fail closed without deleting or guessing: $($owned -join ', ')"
    }
    if ($installExists -and -not $install) {
      throw "Rollback installation path exists but is not a directory; fail closed without deleting or guessing: $($Paths.Install)"
    }
    return [pscustomobject]@{ State = 'none'; Install = $install; Stage = $false; Quarantine = $false }
  }
  if ($installExists -and -not $install) {
    throw "Marked rollback installation path exists but is not a directory; fail closed without deleting anything: $($Paths.Install)"
  }
  if ($stageExists -and -not $stage) {
    throw "Marked rollback stage path exists but is not a directory; fail closed without deleting anything: $($Paths.Stage)"
  }
  if ($quarantineExists -and -not $quarantine) {
    throw "Marked rollback quarantine path exists but is not a directory; fail closed without deleting anything: $($Paths.Quarantine)"
  }
  if ($install -and $stage -and -not $quarantine) { return [pscustomobject]@{ State = 'staged'; Install = $true; Stage = $true; Quarantine = $false } }
  if (-not $install -and $stage -and $quarantine) { return [pscustomobject]@{ State = 'quarantined'; Install = $false; Stage = $true; Quarantine = $true } }
  if ($install -and -not $stage -and $quarantine) { return [pscustomobject]@{ State = 'promoted'; Install = $true; Stage = $false; Quarantine = $true } }
  if (-not $install -and -not $stage -and $quarantine) { return [pscustomobject]@{ State = 'prior-only'; Install = $false; Stage = $false; Quarantine = $true } }
  if ($install -and -not $stage -and -not $quarantine) { return [pscustomobject]@{ State = 'marker-only'; Install = $true; Stage = $false; Quarantine = $false } }
  throw "Rollback transaction topology is ambiguous; fail closed without deleting or moving anything. marker='$($Paths.Marker)' install=$install stage=$stage quarantine=$quarantine stagePath='$($Paths.Stage)' quarantinePath='$($Paths.Quarantine)'"
}

function Invoke-ExplicitRollbackTransaction {
  param(
    [Parameter(Mandatory)][string]$RollbackArchivePath,
    [Parameter(Mandatory)][string]$InstallRoot,
    [string]$UserDataRoot,
    [Parameter(Mandatory)][scriptblock]$ProcessProbe,
    [Parameter(Mandatory)][scriptblock]$SleepAction,
    [Parameter(Mandatory)][scriptblock]$SuccessorLauncher,
    [switch]$WaitForSafeQuit,
    [psobject]$Baseline = $script:RollbackBaseline,
    [scriptblock]$ArchiveExtractor,
    [scriptblock]$MoveDirectory,
    [scriptblock]$RemoveDirectory
  )

  if (-not $ArchiveExtractor) {
    $ArchiveExtractor = { param([string]$Archive, [string]$Destination) Expand-RollbackArchive -ArchivePath $Archive -Destination $Destination }
  }
  if (-not $MoveDirectory) {
    # Move-Item rewrites native directory errors as generic COR_E_IO and loses the Win32
    # sharing/access code. Directory.Move preserves it and refuses an occupied destination.
    $MoveDirectory = { param([string]$Source, [string]$Destination) [IO.Directory]::Move($Source, $Destination) }
  }
  if (-not $RemoveDirectory) {
    $RemoveDirectory = { param([string]$Path) Remove-Item -LiteralPath $Path -Recurse -Force }
  }

  $paths = Get-RollbackTransactionPaths -InstallRoot $InstallRoot
  if (-not (Test-Path -LiteralPath ([IO.Path]::GetDirectoryName($paths.Install)) -PathType Container)) {
    throw "Rollback install parent is missing: $([IO.Path]::GetDirectoryName($paths.Install))"
  }
  $topology = Get-RollbackTransactionTopology -Paths $paths -Baseline $Baseline
  $stageReady = $false
  $finishPromoted = $false
  $restorePrior = $false
  $alreadyQuarantined = $false

  if ($topology.State -eq 'none') {
    # Rehash immediately before staging so an archive changed after the caller's initial check
    # cannot seed a different transaction. Publish the one durable owner marker before extraction;
    # a process death during extraction is then distinguishable from unrelated sibling content.
    $rollbackProof = Assert-RollbackArchive -ArchivePath $RollbackArchivePath -Baseline $Baseline
    Write-RollbackTransactionMarker -Paths $paths -Baseline $Baseline
    try {
      & $ArchiveExtractor $rollbackProof.ArchivePath $paths.Stage
      $null = Assert-RollbackTree -Root $paths.Stage -Baseline $Baseline
      $stageReady = $true
    } catch {
      $stagingError = $_.Exception.Message
      Throw-RollbackStagingFailure -Paths $paths -RemoveDirectory $RemoveDirectory -PrimaryError $stagingError -Context 'Rollback staging failed'
    }
  } elseif ($topology.State -eq 'staged') {
    try {
      $null = Assert-RollbackTree -Root $paths.Stage -Baseline $Baseline
      $stageReady = $true
    } catch {
      $stageVerificationError = $_.Exception.Message
      # Current install still occupies its canonical path and no quarantine exists, so this can
      # only be our interrupted/partial staging. Retire exactly the marker-owned stage and rebuild
      # it from the still-pinned archive under the same durable marker; no installed bytes are touched.
      try {
        Remove-RollbackOwnedDirectory -Path $paths.Stage -RemoveDirectory $RemoveDirectory -Context 'Rollback interrupted-stage'
      } catch {
        throw "Rollback interrupted staging could not be retired for retry. marker='$($paths.Marker)' stage='$($paths.Stage)'. Verification error: $stageVerificationError Cleanup error: $($_.Exception.Message)"
      }
      $rollbackProof = Assert-RollbackArchive -ArchivePath $RollbackArchivePath -Baseline $Baseline
      try {
        & $ArchiveExtractor $rollbackProof.ArchivePath $paths.Stage
        $null = Assert-RollbackTree -Root $paths.Stage -Baseline $Baseline
        $stageReady = $true
      } catch {
        $restagingError = $_.Exception.Message
        Throw-RollbackStagingFailure -Paths $paths -RemoveDirectory $RemoveDirectory -PrimaryError $restagingError -Context 'Rollback restaging failed'
      }
    }
  } elseif ($topology.State -eq 'quarantined') {
    try {
      $null = Assert-RollbackTree -Root $paths.Stage -Baseline $Baseline
      $stageReady = $true
      $alreadyQuarantined = $true
    } catch {
      # The prior installation is intact in marker-owned quarantine, while no canonical install
      # exists. Recover the prior install instead of guessing about an invalid/missing stage.
      $restorePrior = $true
    }
  } elseif ($topology.State -eq 'prior-only') {
    $restorePrior = $true
  } elseif ($topology.State -eq 'promoted') {
    try {
      $null = Assert-RollbackTree -Root $paths.Install -Baseline $Baseline
      $finishPromoted = $true
    } catch {
      $restorePrior = $true
    }
  } elseif ($topology.State -eq 'marker-only') {
    try {
      $null = Assert-RollbackTree -Root $paths.Install -Baseline $Baseline
      # Rollback already reached a verified canonical tree and only marker cleanup was interrupted.
      $finishPromoted = $true
    } catch {
      # Marker publication can precede extraction. With no stage/quarantine and the prior install
      # still present, keep that same durable marker while recreating the stage.
      $rollbackProof = Assert-RollbackArchive -ArchivePath $RollbackArchivePath -Baseline $Baseline
      try {
        & $ArchiveExtractor $rollbackProof.ArchivePath $paths.Stage
        $null = Assert-RollbackTree -Root $paths.Stage -Baseline $Baseline
        $stageReady = $true
      } catch {
        $restagingError = $_.Exception.Message
        Throw-RollbackStagingFailure -Paths $paths -RemoveDirectory $RemoveDirectory -PrimaryError $restagingError -Context 'Rollback restaging failed'
      }
    }
  }

  if ($WaitForSafeQuit) {
    Wait-ForNormalAppExit -ProcessProbe $ProcessProbe -SleepAction $SleepAction
  } else {
    $running = @(& $ProcessProbe)
    if ($running.Count -gt 0) {
      throw 'Chat On Steroids is still running. Quit it normally before explicit rollback, or rerun with -WaitForSafeQuit.'
    }
  }

  if ($restorePrior) {
    # Recovery of the quarantined pre-rollback install does not depend on the rollback ZIP. It is
    # the deterministic escape hatch even if the frozen artifact itself became unavailable after
    # an earlier process died mid-swap.
    if (-not (Test-Path -LiteralPath $paths.Quarantine -PathType Container)) {
      throw "Interrupted rollback cannot recover because the marker-owned prior installation is missing: $($paths.Quarantine)"
    }
    Assert-AppNotRunning -ProcessProbe $ProcessProbe -Context 'rollback recovery'
    if (Test-Path -LiteralPath $paths.Install -PathType Container) {
      if (Test-Path -LiteralPath $paths.Stage) {
        throw "Interrupted rollback recovery is ambiguous because both canonical install and stage exist: '$($paths.Install)', '$($paths.Stage)'. Nothing was deleted."
      }
      Move-RollbackOwnedDirectory -Source $paths.Install -Destination $paths.Stage -MoveDirectory $MoveDirectory -Context 'Rollback recovery parking current install' -ProcessProbe $ProcessProbe
    }
    if (-not (Test-Path -LiteralPath $paths.Install -PathType Container)) {
      Move-RollbackOwnedDirectory -Source $paths.Quarantine -Destination $paths.Install -MoveDirectory $MoveDirectory -Context 'Rollback recovery restoring prior install' -ProcessProbe $ProcessProbe
    }
    Remove-RollbackOwnedDirectory -Path $paths.Stage -RemoveDirectory $RemoveDirectory -Context 'Rollback recovery parked-stage'
    Remove-RollbackTransactionMarker -Paths $paths
    throw "Recovered an interrupted rollback by restoring the prior installation at '$($paths.Install)'. No rollback success was reported; invoke -Rollback again deliberately to retry."
  }

  if ($finishPromoted) {
    # A process died after promotion (or after quarantine cleanup but before marker cleanup).
    # Reverify the canonical tree, retire only this marker's quarantine, then finish exactly once.
    $restored = Assert-RollbackTree -Root $paths.Install -Baseline $Baseline
    Assert-AppNotRunning -ProcessProbe $ProcessProbe -Context 'rollback completion'
    Assert-LegacyRollbackStateCompatible -UserDataRoot $UserDataRoot
    Remove-RollbackOwnedDirectory -Path $paths.Quarantine -RemoveDirectory $RemoveDirectory -Context 'Rollback completion quarantine'
    Remove-RollbackTransactionMarker -Paths $paths
    Invoke-RollbackSuccessor -SuccessorLauncher $SuccessorLauncher -InstalledApp $restored.InstalledApp -Version $Baseline.Version -UserDataRoot $UserDataRoot
    return [pscustomobject]@{
      Version = $restored.Version
      TreeSha256 = $restored.TreeSha256
      ArchiveSha256 = $Baseline.ArchiveSha256
      InstalledApp = $restored.InstalledApp
      RecoveredInterruptedTransaction = $true
    }
  }

  if (-not $stageReady) { throw 'Rollback transaction reached mutation boundary without a verified staged baseline.' }

  # Close the quit-window TOCTOU gap: the archive and staged bytes must still match immediately
  # before the first program-directory mutation. No second extraction is performed.
  try {
    $rollbackProof = Assert-RollbackArchive -ArchivePath $RollbackArchivePath -Baseline $Baseline
    $null = Assert-RollbackTree -Root $paths.Stage -Baseline $Baseline
  } catch {
    $boundaryMessage = $_.Exception.Message
    if ($alreadyQuarantined) {
      try {
        if (-not (Test-Path -LiteralPath $paths.Install) -and (Test-Path -LiteralPath $paths.Quarantine)) {
          Move-RollbackOwnedDirectory -Source $paths.Quarantine -Destination $paths.Install -MoveDirectory $MoveDirectory -Context 'Rollback boundary recovery restoring prior install' -ProcessProbe $ProcessProbe
        }
        Remove-RollbackOwnedDirectory -Path $paths.Stage -RemoveDirectory $RemoveDirectory -Context 'Rollback boundary recovery stage'
        Remove-RollbackTransactionMarker -Paths $paths
      } catch {
        throw "Rollback mutation-boundary verification failed and the interrupted transaction could not restore its prior installation. marker='$($paths.Marker)' quarantine='$($paths.Quarantine)' stage='$($paths.Stage)'. Verification error: $boundaryMessage Recovery error: $($_.Exception.Message)"
      }
      throw "Rollback mutation-boundary verification failed; the prior installation was restored and no rollback success was reported. $boundaryMessage"
    }
    try {
      Remove-RollbackOwnedDirectory -Path $paths.Stage -RemoveDirectory $RemoveDirectory -Context 'Rollback mutation-boundary stage'
      Remove-RollbackTransactionMarker -Paths $paths
    } catch {
      throw "Rollback mutation-boundary verification failed before installed bytes changed, but cleanup of marker-owned staging also failed. marker='$($paths.Marker)' stage='$($paths.Stage)'. Verification error: $boundaryMessage Cleanup error: $($_.Exception.Message)"
    }
    throw "Rollback mutation-boundary verification failed before installed bytes changed. Marker-owned staging was retired. $boundaryMessage"
  }
  if (-not $alreadyQuarantined -and -not (Test-Path -LiteralPath $paths.Install -PathType Container)) {
    throw "Current installation is missing before rollback swap: $($paths.Install)"
  }
  Assert-AppNotRunning -ProcessProbe $ProcessProbe -Context 'rollback swap'
  Assert-LegacyRollbackStateCompatible -UserDataRoot $UserDataRoot

  try {
    if (-not $alreadyQuarantined) {
      Move-RollbackOwnedDirectory -Source $paths.Install -Destination $paths.Quarantine -MoveDirectory $MoveDirectory -Context 'Rollback quarantine move' -ProcessProbe $ProcessProbe
    }
    try {
      Move-RollbackOwnedDirectory -Source $paths.Stage -Destination $paths.Install -MoveDirectory $MoveDirectory -Context 'Rollback promotion move' -ProcessProbe $ProcessProbe
    } catch {
      $swapMessage = $_.Exception.Message
      $priorRestored = $false
      if (-not (Test-Path -LiteralPath $paths.Install) -and (Test-Path -LiteralPath $paths.Quarantine)) {
        try {
          Move-RollbackOwnedDirectory -Source $paths.Quarantine -Destination $paths.Install -MoveDirectory $MoveDirectory -Context 'Rollback swap recovery restoring prior install' -ProcessProbe $ProcessProbe
          Remove-RollbackOwnedDirectory -Path $paths.Stage -RemoveDirectory $RemoveDirectory -Context 'Rollback swap recovery stage'
          Remove-RollbackTransactionMarker -Paths $paths
          $priorRestored = $true
        } catch {
          throw "Rollback swap failed and immediate recovery could not restore the prior installation. Canonical marker='$($paths.Marker)' quarantine='$($paths.Quarantine)' stage='$($paths.Stage)'. Swap error: $swapMessage Recovery error: $($_.Exception.Message)"
        }
      }
      if ($priorRestored) {
        throw "Rollback swap failed; the prior installation was restored before reporting failure. $swapMessage"
      }
      throw "Rollback swap was interrupted and marker-owned recovery evidence was retained. marker='$($paths.Marker)' quarantine='$($paths.Quarantine)' stage='$($paths.Stage)' install='$($paths.Install)'. Swap error: $swapMessage"
    }

    try {
      $restored = Assert-RollbackTree -Root $paths.Install -Baseline $Baseline
    } catch {
      $verifyMessage = $_.Exception.Message
      try {
        if (Test-Path -LiteralPath $paths.Stage) {
          throw "Marker-owned stage unexpectedly exists after promotion: $($paths.Stage)"
        }
        Move-RollbackOwnedDirectory -Source $paths.Install -Destination $paths.Stage -MoveDirectory $MoveDirectory -Context 'Rollback final-verification parking rejected install' -ProcessProbe $ProcessProbe
        Move-RollbackOwnedDirectory -Source $paths.Quarantine -Destination $paths.Install -MoveDirectory $MoveDirectory -Context 'Rollback final-verification restoring prior install' -ProcessProbe $ProcessProbe
        Remove-RollbackOwnedDirectory -Path $paths.Stage -RemoveDirectory $RemoveDirectory -Context 'Rollback final-verification rejected stage'
        Remove-RollbackTransactionMarker -Paths $paths
      } catch {
        throw "Rollback final verification failed and immediate recovery could not restore the prior installation. Canonical marker='$($paths.Marker)' quarantine='$($paths.Quarantine)' stage='$($paths.Stage)'. Verification error: $verifyMessage Recovery error: $($_.Exception.Message)"
      }
      throw "Rollback final verification failed; the prior installation was restored and no rollback success was reported. $verifyMessage"
    }

    Assert-LegacyRollbackStateCompatible -UserDataRoot $UserDataRoot
    Remove-RollbackOwnedDirectory -Path $paths.Quarantine -RemoveDirectory $RemoveDirectory -Context 'Rollback committed quarantine'
    Remove-RollbackTransactionMarker -Paths $paths
    Invoke-RollbackSuccessor -SuccessorLauncher $SuccessorLauncher -InstalledApp $restored.InstalledApp -Version $Baseline.Version -UserDataRoot $UserDataRoot
    Write-Host '[custom-install] exact private 2.1.13 program rollback restored and verified.' -ForegroundColor Green
    Write-Host '[custom-install] user data was not rolled back; inspected command ledgers contain no new action custody unsupported by the older reader.' -ForegroundColor Green
    return [pscustomobject]@{
      Version = $restored.Version
      TreeSha256 = $restored.TreeSha256
      ArchiveSha256 = $rollbackProof.ArchiveSha256
      InstalledApp = $restored.InstalledApp
      RecoveredInterruptedTransaction = $false
    }
  } catch {
    throw
  }
}

function Assert-OwnedStrictBuildRoot {
  param([Parameter(Mandatory)][string]$Path)
  $tempBase = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\')
  $resolved = [IO.Path]::GetFullPath($Path).TrimEnd('\')
  if (-not $resolved.StartsWith($tempBase + '\', [StringComparison]::OrdinalIgnoreCase) -or (Split-Path -Leaf $resolved) -notlike 'cos-strict-build-*') {
    throw "Refusing strict-build cleanup outside the owned temp namespace: $resolved"
  }
  return $resolved
}

function Publish-StrictCandidateRelease {
  param(
    [Parameter(Mandatory)][string]$SourceReleaseDirectory,
    [Parameter(Mandatory)][string]$DestinationReleaseDirectory,
    [scriptblock]$BeforeCommit
  )
  $installerName = 'Chat-On-Steroids-Setup-x64.exe'
  $requiredFiles = @($installerName, "$installerName.blockmap", 'latest.yml')
  foreach ($name in $requiredFiles) {
    $source = Join-Path $SourceReleaseDirectory $name
    if (-not (Test-Path -LiteralPath $source -PathType Leaf)) { throw "Strict candidate publication source is missing: $source" }
  }
  $sourceUnpacked = Join-Path $SourceReleaseDirectory 'win-unpacked'
  if (-not (Test-Path -LiteralPath $sourceUnpacked -PathType Container)) { throw "Strict candidate publication source is missing: $sourceUnpacked" }
  $sourceHashes = @{}
  foreach ($name in $requiredFiles) { $sourceHashes[$name] = Get-FileHashHex -Path (Join-Path $SourceReleaseDirectory $name) }
  $sourceUnpackedFingerprint = Get-DirectoryFingerprint -Root $sourceUnpacked

  New-Item -ItemType Directory -Path $DestinationReleaseDirectory -Force | Out-Null
  $incoming = Join-Path $DestinationReleaseDirectory ('.cos-candidate-incoming-' + [guid]::NewGuid().ToString('N'))
  $backup = Join-Path $DestinationReleaseDirectory ('.cos-candidate-backup-' + [guid]::NewGuid().ToString('N'))
  $commitNames = @($requiredFiles + 'win-unpacked')
  $backedUp = @()
  $committed = @()
  $commitStarted = $false
  $leaveBackup = $false
  New-Item -ItemType Directory -Path $incoming | Out-Null
  try {
    foreach ($name in $requiredFiles) { Copy-Item -LiteralPath (Join-Path $SourceReleaseDirectory $name) -Destination (Join-Path $incoming $name) }
    Copy-Item -LiteralPath $sourceUnpacked -Destination (Join-Path $incoming 'win-unpacked') -Recurse
    foreach ($name in $requiredFiles) {
      $incomingHash = Get-FileHashHex -Path (Join-Path $incoming $name)
      if ($incomingHash -cne [string]$sourceHashes[$name]) { throw "Strict candidate incoming copy hash mismatch for $name." }
    }
    $incomingUnpacked = Get-DirectoryFingerprint -Root (Join-Path $incoming 'win-unpacked')
    if ($incomingUnpacked.FileCount -ne $sourceUnpackedFingerprint.FileCount -or
        [int64]$incomingUnpacked.TotalBytes -ne [int64]$sourceUnpackedFingerprint.TotalBytes -or
        $incomingUnpacked.TreeSha256 -cne $sourceUnpackedFingerprint.TreeSha256) {
      throw 'Strict candidate incoming win-unpacked copy does not match the verified source release.'
    }

    if ($BeforeCommit) { & $BeforeCommit }

    New-Item -ItemType Directory -Path $backup | Out-Null
    $commitStarted = $true
    foreach ($name in $commitNames) {
      $current = Join-Path $DestinationReleaseDirectory $name
      if (Test-Path -LiteralPath $current) {
        Move-Item -LiteralPath $current -Destination (Join-Path $backup $name) -ErrorAction Stop
        $backedUp += $name
      }
    }
    foreach ($name in $commitNames) {
      Move-Item -LiteralPath (Join-Path $incoming $name) -Destination (Join-Path $DestinationReleaseDirectory $name) -ErrorAction Stop
      $committed += $name
    }

    foreach ($name in $requiredFiles) {
      $publishedHash = Get-FileHashHex -Path (Join-Path $DestinationReleaseDirectory $name)
      if ($publishedHash -cne [string]$sourceHashes[$name]) { throw "Strict candidate published hash mismatch for $name." }
    }
    $publishedUnpacked = Get-DirectoryFingerprint -Root (Join-Path $DestinationReleaseDirectory 'win-unpacked')
    if ($publishedUnpacked.FileCount -ne $sourceUnpackedFingerprint.FileCount -or
        [int64]$publishedUnpacked.TotalBytes -ne [int64]$sourceUnpackedFingerprint.TotalBytes -or
        $publishedUnpacked.TreeSha256 -cne $sourceUnpackedFingerprint.TreeSha256) {
      throw 'Strict candidate published win-unpacked tree does not match the verified source release.'
    }
    try {
      Remove-Item -LiteralPath $backup -Recurse -Force -ErrorAction Stop
      $backup = $null
    } catch {
      $leaveBackup = $true
      Write-Warning "Strict candidate publication committed exact verified bytes, but old-release backup cleanup was deferred: $backup. $($_.Exception.Message)"
    }
  } catch {
    $publicationFailure = $_
    if ($commitStarted) {
      $restoreFailures = @()
      foreach ($name in @($committed | Select-Object -Unique)) {
        $published = Join-Path $DestinationReleaseDirectory $name
        try { if (Test-Path -LiteralPath $published) { Remove-Item -LiteralPath $published -Recurse -Force -ErrorAction Stop } } catch { $restoreFailures += "remove ${name}: $($_.Exception.Message)" }
      }
      foreach ($name in @($backedUp | Select-Object -Unique)) {
        $saved = Join-Path $backup $name
        $destination = Join-Path $DestinationReleaseDirectory $name
        try { if (Test-Path -LiteralPath $saved) { Move-Item -LiteralPath $saved -Destination $destination -ErrorAction Stop } } catch { $restoreFailures += "restore ${name}: $($_.Exception.Message)" }
      }
      if ($restoreFailures.Count -gt 0) {
        $leaveBackup = $true
        throw "Strict candidate publication failed and rollback could not fully restore the previous release. Publication error: $($publicationFailure.Exception.Message) Rollback errors: $($restoreFailures -join '; ') Recovery backup: $backup"
      }
    }
    throw $publicationFailure
  } finally {
    try { if (Test-Path -LiteralPath $incoming) { Remove-Item -LiteralPath $incoming -Recurse -Force -ErrorAction Stop } } catch { Write-Warning "Strict candidate incoming cleanup was deferred: $incoming. $($_.Exception.Message)" }
    try { if ($backup -and -not $leaveBackup -and (Test-Path -LiteralPath $backup)) { Remove-Item -LiteralPath $backup -Recurse -Force -ErrorAction Stop } } catch { Write-Warning "Strict candidate backup cleanup was deferred: $backup. $($_.Exception.Message)" }
  }
}

function Assert-StrictBuildStorage {
  param(
    [Parameter(Mandatory)][string]$SnapshotPath,
    [Parameter(Mandatory)][string]$ReleaseDirectory,
    [scriptblock]$StorageProbe
  )
  # Operational admission allowances, not measured peak usage or a disk reservation. The
  # incumbent device-wide install mutex serializes our builders; unrelated writers can still
  # consume space. Keep read-only inspection, activation readiness and cleanup outside this gate.
  if (-not $StorageProbe) {
    $StorageProbe = {
      param([string]$Path)
      # Windows PowerShell's legacy native binder strips embedded double quotes
      # from -e source. Single-quoted JS literals survive both supported binders.
      $code = 'const fs=require(''node:fs''),path=require(''node:path'');let p=path.resolve(process.argv[1]);while(!fs.existsSync(p)){const parent=path.dirname(p);if(parent===p)throw Error(''volume unavailable'');p=parent;}p=fs.realpathSync(p);const s=fs.statfsSync(p,{bigint:true}),v=fs.statSync(p,{bigint:true});console.log(JSON.stringify({Volume:String(v.dev),AvailableBytes:String(s.bavail*s.bsize)}));'
      $read = Invoke-TrustedNodeCaptured -Arguments @('-e', $code, $Path)
      if ($read.ExitCode -ne 0) { throw "STORAGE_HEADROOM_UNKNOWN: cannot inspect build volume for '$Path'. No build started." }
      try { return ((@($read.Output) -join "`n") | ConvertFrom-Json) }
      catch { throw "STORAGE_HEADROOM_UNKNOWN: invalid volume observation for '$Path'. No build started." }
    }
  }
  $volumes = @{}
  foreach ($target in @(
    [pscustomobject]@{ Path = $SnapshotPath; Budget = 3GB },
    [pscustomobject]@{ Path = $ReleaseDirectory; Budget = 1GB }
  )) {
    $row = & $StorageProbe $target.Path
    $available = 0L
    if (-not $row -or -not $row.PSObject.Properties['Volume'] -or
        [string]::IsNullOrWhiteSpace([string]$row.Volume) -or
        -not $row.PSObject.Properties['AvailableBytes'] -or
        -not [long]::TryParse([string]$row.AvailableBytes, [ref]$available) -or $available -lt 0) {
      throw "STORAGE_HEADROOM_UNKNOWN: invalid caller-available capacity for '$($target.Path)'. No build started."
    }
    $volume = [string]$row.Volume
    if (-not $volumes.ContainsKey($volume)) {
      $volumes[$volume] = [pscustomobject]@{ Available = $available; Budget = 0L; Path = $target.Path }
    }
    $volumes[$volume].Available = [Math]::Min($volumes[$volume].Available, $available)
    $volumes[$volume].Budget += $target.Budget
  }
  foreach ($volume in $volumes.Values) {
    $required = 4GB + $volume.Budget
    if ($volume.Available -lt $required) {
      throw "STORAGE_HEADROOM_INSUFFICIENT: build path '$($volume.Path)' available=$($volume.Available) required=$required bytes (4GiB retained headroom plus build/publication allowances). No clone, package or install was started. Reclaim verified disposable space before retrying."
    }
    Write-Host "[custom-install] storage admission: path=$($volume.Path) available=$($volume.Available) required=$required bytes; observation only, not reserved space."
  }
}

function Remove-OwnedStrictBuildSnapshot {
  param([Parameter(Mandatory)][string]$Path)
  $owned = Assert-OwnedStrictBuildRoot -Path $Path
  if ((Split-Path -Leaf $owned) -notmatch '^cos-strict-build-[0-9a-f]{32}$') {
    throw "Refusing strict-build cleanup without an exact generated snapshot name: $owned"
  }
  if (-not (Test-Path -LiteralPath $owned)) { return }
  # Check without following a directory link. A residual snapshot is never an opportunity to
  # recurse into another checkout, installed runtime or archive through a reparse point.
  $rootItem = Get-Item -LiteralPath $owned -Force -ErrorAction Stop
  if ($rootItem -isnot [IO.DirectoryInfo]) { throw "Strict-build cleanup expected a directory: $owned" }
  $pending = [Collections.Generic.Stack[IO.FileSystemInfo]]::new()
  $pending.Push($rootItem)
  while ($pending.Count -gt 0) {
    $item = $pending.Pop()
    if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw "Linked strict-build cleanup target retained: $($item.FullName)" }
    if ($item -is [IO.DirectoryInfo]) {
      foreach ($child in $item.EnumerateFileSystemInfos()) { $pending.Push($child) }
    }
  }
  Remove-Item -LiteralPath $owned -Recurse -Force -ErrorAction Stop
  if (Test-Path -LiteralPath $owned) { throw "Strict-build snapshot cleanup did not establish absence: $owned" }
}

function Invoke-StrictCandidateBuild {
  param(
    [Parameter(Mandatory)][string]$RepoRoot,
    [Parameter(Mandatory)][string]$ReleaseDirectory,
    [Parameter(Mandatory)][psobject]$ReviewedSource,
    [scriptblock]$SnapshotCreator,
    [scriptblock]$PackageRunner,
    [scriptblock]$CandidateVerifier,
    [scriptblock]$Publisher,
    [scriptblock]$SnapshotRemover
  )
  $snapshotRoot = Join-Path ([IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\')) ('cos-strict-build-' + [guid]::NewGuid().ToString('N'))
  $snapshotRoot = Assert-OwnedStrictBuildRoot -Path $snapshotRoot
  $primaryFailure = $null
  $cleanupState = [pscustomobject]@{ SnapshotCleaned = $false }
  if (-not $SnapshotRemover) {
    $SnapshotRemover = {
      param([string]$OwnedRoot)
      Remove-OwnedStrictBuildSnapshot -Path $OwnedRoot
    }
  }
  try {
    if (-not $SnapshotCreator) {
      $SnapshotCreator = {
        param([string]$SourceRoot, [string]$Destination, [string]$Commit)
        $git = Get-TrustedHostToolPath -Name git
        & $git --no-replace-objects clone --local --no-hardlinks --no-checkout -- $SourceRoot $Destination
        if ($LASTEXITCODE -ne 0) { throw "git clone for strict source snapshot exited with code $LASTEXITCODE" }
        & $git --no-replace-objects -C $Destination checkout --detach $Commit --
        if ($LASTEXITCODE -ne 0) { throw "git checkout for strict source snapshot exited with code $LASTEXITCODE" }
      }
    }
    $null = & $SnapshotCreator $RepoRoot $snapshotRoot $ReviewedSource.commit

    $snapshotState = Get-ReviewedGitState -RepoRoot $snapshotRoot
    if ($snapshotState.dirty -or $snapshotState.commit -cne $ReviewedSource.commit -or $snapshotState.tree -cne $ReviewedSource.tree -or $snapshotState.objectFormat -cne $ReviewedSource.objectFormat) {
      throw "Strict source snapshot does not equal the reviewed Git identity. Expected=$($ReviewedSource.commit)/$($ReviewedSource.tree), found=$($snapshotState.commit)/$($snapshotState.tree), dirty=$($snapshotState.dirty)."
    }
    $gitlinks = Invoke-TrustedGitText -RepoRoot $snapshotRoot -Arguments @('ls-tree', '-r', 'HEAD')
    if (@($gitlinks -split "`n" | Where-Object { $_ -match '^160000\s+commit\s' }).Count -gt 0) {
      throw 'Strict private candidate build does not support unmaterialized Git submodules.'
    }

    if (-not $PackageRunner) {
      $PackageRunner = {
        param([string]$Snapshot)
        $node = Get-TrustedHostToolPath -Name node
        $git = Get-TrustedHostToolPath -Name git
        $tar = Get-TrustedHostToolPath -Name tar
        $cmd = Get-TrustedHostToolPath -Name cmd
        $savedPath = $env:PATH
        $savedComSpec = $env:ComSpec
        $savedNodeEnv = @{}
        $nodeEnvKeys = @([Environment]::GetEnvironmentVariables('Process').Keys | ForEach-Object { [string]$_ } | Where-Object { $_ -match '^(?i:NODE_OPTIONS|NODE_PATH)$' })
        try {
          foreach ($key in $nodeEnvKeys) {
            $savedNodeEnv[$key] = [Environment]::GetEnvironmentVariable($key, 'Process')
            [Environment]::SetEnvironmentVariable($key, $null, 'Process')
          }
          $env:PATH = (@((Split-Path -Parent $node), (Split-Path -Parent $git), (Split-Path -Parent $tar)) | Select-Object -Unique) -join ';'
          $env:ComSpec = $cmd
          & $node (Join-Path $Snapshot 'scripts\package.mjs') --strict --platform win32 --arch x64 | Out-Host
          if ($LASTEXITCODE -ne 0) { throw "Strict package owner exited with code $LASTEXITCODE" }
        } finally {
          $env:PATH = $savedPath
          $env:ComSpec = $savedComSpec
          foreach ($key in $nodeEnvKeys) { [Environment]::SetEnvironmentVariable($key, [string]$savedNodeEnv[$key], 'Process') }
        }
      }
    }
    $null = & $PackageRunner $snapshotRoot

    $snapshotRelease = Join-Path $snapshotRoot 'release'
    if (-not $CandidateVerifier) {
      $CandidateVerifier = {
        param([string]$Snapshot, [string]$SnapshotRelease)
        Get-CandidateQualificationProposal -RepoRoot $Snapshot -ReleaseDirectory $SnapshotRelease
      }
    }
    $verificationOutput = @(& $CandidateVerifier $snapshotRoot $snapshotRelease)
    if ($verificationOutput.Count -ne 1) {
      throw "Strict future candidate verification must return exactly one proposal, received $($verificationOutput.Count)."
    }
    $verifiedCandidate = $verificationOutput[0]
    if (-not $verifiedCandidate -or $null -eq $verifiedCandidate.PSObject.Properties['SourceProvenance'] -or
        $null -eq $verifiedCandidate.PSObject.Properties['LegacyProvenanceException'] -or
        $verifiedCandidate.LegacyProvenanceException) {
      throw 'Strict future candidate verification did not produce a nonlegacy source/build-attested proposal.'
    }

    $live = Get-ReviewedGitState -RepoRoot $RepoRoot
    if ($live.dirty -or $live.commit -cne $ReviewedSource.commit -or $live.tree -cne $ReviewedSource.tree -or $live.objectFormat -cne $ReviewedSource.objectFormat) {
      throw "Live reviewed source changed before candidate publication. Expected=$($ReviewedSource.commit)/$($ReviewedSource.tree), found=$($live.commit)/$($live.tree), dirty=$($live.dirty). Live release remains untouched."
    }
    if (-not $Publisher) {
      $Publisher = {
        param([string]$From, [string]$To, [scriptblock]$CommitGate)
        Publish-StrictCandidateRelease -SourceReleaseDirectory $From -DestinationReleaseDirectory $To -BeforeCommit $CommitGate
      }
    }
    $beforeCommit = {
      $null = & $SnapshotRemover $snapshotRoot
      $cleanupState.SnapshotCleaned = $true
      $currentLive = Get-ReviewedGitState -RepoRoot $RepoRoot
      if ($currentLive.dirty -or $currentLive.commit -cne $ReviewedSource.commit -or $currentLive.tree -cne $ReviewedSource.tree -or $currentLive.objectFormat -cne $ReviewedSource.objectFormat) {
        throw "Live reviewed source changed at the candidate publication commit gate. Expected=$($ReviewedSource.commit)/$($ReviewedSource.tree), found=$($currentLive.commit)/$($currentLive.tree), dirty=$($currentLive.dirty). Live release remains untouched."
      }
    }
    $null = & $Publisher $snapshotRelease $ReleaseDirectory $beforeCommit
    if (-not $cleanupState.SnapshotCleaned) {
      throw 'Strict candidate publisher returned without executing the required pre-commit snapshot cleanup gate.'
    }
    return $verifiedCandidate
  } catch {
    $primaryFailure = $_
  } finally {
    if (-not $cleanupState.SnapshotCleaned) {
      try {
        $null = & $SnapshotRemover $snapshotRoot
        $cleanupState.SnapshotCleaned = $true
      } catch {
        $cleanupMessage = $_.Exception.Message
        if ($primaryFailure) {
          throw "Strict candidate build failed and owned snapshot cleanup also failed. Build error: $($primaryFailure.Exception.Message) Cleanup error: $cleanupMessage Snapshot: $snapshotRoot"
        }
        throw "Strict candidate build did not publish because owned snapshot cleanup failed. Snapshot: $snapshotRoot Error: $cleanupMessage"
      }
    }
  }
  if ($primaryFailure) { throw $primaryFailure }
}

function Start-IndependentInstalledApp {
  param([Parameter(Mandatory)][string]$Executable, [string[]]$Arguments = @(), [switch]$ReceiptOnly)
  # Production lifetime must belong to Windows, not the terminal/agent's kill-on-close
  # process tree. Start-Process and Node detached/unref do not escape a Windows Job.
  # WMI creates the process through the local OS provider; no service/task is installed.
  if (-not [IO.Path]::IsPathRooted($Executable) -or
      -not (Test-Path -LiteralPath $Executable -PathType Leaf)) {
    throw "Independent app launch requires an existing absolute executable: $Executable"
  }
  $quoted = foreach ($value in @($Executable) + $Arguments) {
    if ($null -eq $value -or $value.Contains([char]0)) { throw 'Invalid app launch argument.' }
    # CommandLineToArgvW/CRT quoting: double backslashes before quotes and closing quote.
    '"' + ([regex]::Replace([regex]::Replace($value, '(\\*)"', '$1$1\"'), '(\\+)$', '$1$1')) + '"'
  }
  $startup = New-CimInstance -ClassName Win32_ProcessStartup -ClientOnly -Property @{ ShowWindow = [uint16]0 }
  $created = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{
    CommandLine = ($quoted -join ' ')
    CurrentDirectory = [IO.Path]::GetDirectoryName($Executable)
    ProcessStartupInformation = $startup
  }
  if ($created.ReturnValue -ne 0 -or -not $created.ProcessId) {
    throw "Independent app launch failed (Win32_Process.Create result=$($created.ReturnValue)); check local WMI permissions/service. No fallback child launch was attempted."
  }
  Write-Host "[custom-install] Windows-owned app launch accepted: pid=$($created.ProcessId). This is not a chat delivery receipt."
  if ($ReceiptOnly) { return [int]$created.ProcessId }
  # Missing PID here is ambiguous launch/early exit, not authority to duplicate a Send.
  return Get-Process -Id $created.ProcessId -ErrorAction Stop
}

function Invoke-CustomInstall {
  [CmdletBinding()]
  param(
    [switch]$LaunchInstaller,
    [switch]$WaitForSafeQuit,
    [switch]$QualifiedPrebuilt,
    [switch]$ProposeQualification,
    [switch]$ProposeInstalledPredecessor,
    [string]$AcceptedPackageReceiptPath,
    [switch]$Rollback,
    [string]$RepoRoot,
    [string]$ReleaseDirectory,
    [string]$InstallRoot,
    [string]$RollbackArchivePath,
    [string]$UserDataRoot,
    [scriptblock]$ProcessProbe,
    [scriptblock]$SafeCloseProcessInventory,
    [scriptblock]$SafeCloseLauncher,
    [scriptblock]$SleepAction,
    [scriptblock]$InstallerRunner,
    [scriptblock]$SuccessorLauncher,
    [scriptblock]$ArchiveExtractor,
    [scriptblock]$MoveDirectory,
    [scriptblock]$RemoveDirectory,
    [psobject]$RollbackBaseline = $script:RollbackBaseline,
    [psobject]$InstalledUpgradeBaseline = $null,
    [string]$OperationLockName = 'Local\ChatOnSteroidsCustomInstallTransaction'
  )

  if ($env:OS -ne 'Windows_NT') { throw 'This installer workflow is Windows-specific. Use the matching npm dist command on macOS or Linux.' }
  if (($ProposeQualification -or $ProposeInstalledPredecessor) -and ($LaunchInstaller -or $WaitForSafeQuit -or $QualifiedPrebuilt -or $Rollback -or ($ProposeQualification -and $ProposeInstalledPredecessor))) {
    throw 'Proposal modes are standalone non-mutating inspection modes. Do not combine either proposal with build, activation, readiness or rollback switches, or combine the two proposals.'
  }
  if ($Rollback -and $QualifiedPrebuilt) { throw 'Choose either qualified update activation or explicit rollback, not both.' }
  if ($Rollback -and $LaunchInstaller) { throw '-LaunchInstaller is only for the qualified update path; rollback has its own explicit transaction.' }
  if ($LaunchInstaller -and $WaitForSafeQuit) { throw 'Choose either -LaunchInstaller or -WaitForSafeQuit, not both.' }
  if (($LaunchInstaller -or $WaitForSafeQuit) -and -not $QualifiedPrebuilt -and -not $Rollback) {
    throw 'Activation requires -QualifiedPrebuilt. Build a new candidate separately, qualify its exact bytes, then activate only that receipt-bound candidate.'
  }
  if (-not $RepoRoot) { $RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path }
  if (-not $PSBoundParameters.ContainsKey('InstalledUpgradeBaseline') -and
      -not $PSBoundParameters.ContainsKey('RollbackBaseline')) {
    $InstalledUpgradeBaseline = $script:InstalledUpgradeBaseline
  }
  if (-not $ReleaseDirectory) { $ReleaseDirectory = Join-Path $RepoRoot 'release' }
  if (-not $InstallRoot) { $InstallRoot = Join-Path $env:LOCALAPPDATA 'Programs\Chat On Steroids' }
  if (-not $ProcessProbe) { $ProcessProbe = { @(Get-Process -Name 'Chat On Steroids' -ErrorAction SilentlyContinue) } }
  if (-not $SafeCloseProcessInventory) {
    $SafeCloseProcessInventory = {
      @(Get-StableInstalledAppProcessInventory)
    }
  }
  if (-not $SafeCloseLauncher) {
    $SafeCloseLauncher = {
      param([string]$InstalledApp, [string[]]$Arguments, [string]$ProfileId, [int]$TargetProcessId, [string]$TargetGeneration)
      # Arguments are produced only from the strict profile-id parser above; never compose a shell
      # command. The safe-close-capable payload consumes the command on both second-instance and
      # cold-start paths, so a target-exit race cannot launch a replacement account workspace.
      $request = Start-Process -FilePath $InstalledApp -ArgumentList $Arguments -WindowStyle Hidden -PassThru
      if (-not $request.WaitForExit(15000)) {
        throw "Safe-close request for profile '$ProfileId' did not exit within 15 seconds. It was not killed and no duplicate request was launched."
      }
      if ($request.ExitCode -ne 0) {
        throw "Safe-close request for profile '$ProfileId' exited with code $($request.ExitCode). No duplicate request was launched."
      }
    }
  }
  if (-not $SleepAction) { $SleepAction = { Start-Sleep -Milliseconds 250 } }
  if (-not $InstallerRunner) {
    $InstallerRunner = {
      param([string]$InstallerPath)
      # `--updated` preserves update/uninstall semantics. Deliberately omit `--force-run`: the
      # assisted NSIS template otherwise starts the app during a silent install, before we can
      # verify the installed bytes. This script owns the successor launch after verification.
      $process = Start-Process -FilePath $InstallerPath -ArgumentList @('/S', '--updated') -WindowStyle Hidden -Wait -PassThru
      return [int]$process.ExitCode
    }
  }
  if (-not $SuccessorLauncher) {
    $SuccessorLauncher = {
      param([string]$InstalledApp)
      # Updated startup owns companion reload plus stable Chrome inventory reconciliation.
      # A bulk resume here races that inventory and reopens tabs which already survived.
      # Keep one bounded liveness proof here: an OS-broker launch only proves that Windows
      # accepted the launch. During a measured same-version activation, the first hidden successor
      # exited before it established the app singleton, while the identical launch a moment later
      # stayed healthy. Retry that exact launch once; two early exits are an actionable reopen
      # failure, not a successful update with a silently missing UI.
      function Start-VerifiedSuccessor {
        param([string[]]$Arguments, [string]$Label)
        $successor = Start-IndependentInstalledApp -Executable $InstalledApp -Arguments $Arguments
        if (-not $successor.WaitForExit(5000)) { return }
        $firstExit = $successor.ExitCode
        Start-Sleep -Milliseconds 1250
        $retry = Start-IndependentInstalledApp -Executable $InstalledApp -Arguments $Arguments
        if ($retry.WaitForExit(8000)) {
          throw "Updated Chat On Steroids $Label exited during both bounded reopen attempts (exit codes $firstExit and $($retry.ExitCode))."
        }
      }

      Start-VerifiedSuccessor -Arguments @('--updated', '--background') -Label 'primary profile'

      # The primary config is the canonical account registry. Reopen every enabled isolated
      # account that the user deliberately prepared, each through its own Electron userData lock.
      # Chrome itself stays open; each successor reloads only its paired companion and reconciles
      # the tabs that survived. A malformed/missing registry fails closed after the primary is
      # already alive instead of silently pretending the other account windows were restored.
      $configPath = Join-Path $env:APPDATA 'chat-on-steroids\config.json'
      if (-not (Test-Path -LiteralPath $configPath -PathType Leaf)) {
        throw "Updated primary profile reopened, but the account registry is missing: $configPath"
      }
      try { $registry = Get-Content -Raw -LiteralPath $configPath | ConvertFrom-Json }
      catch { throw "Updated primary profile reopened, but the account registry could not be read: $($_.Exception.Message)" }
      $profiles = @($registry.instances.profiles | Where-Object {
        # Older prepared account records predate the explicit `enabled` field. Absence means
        # enabled, exactly as the runtime registry parser treats it; Set-StrictMode must not turn
        # that valid legacy shape into a post-install fleet-reopen failure.
        $enabledProperty = $_.PSObject.Properties['enabled']
        $idProperty = $_.PSObject.Properties['id']
        $stateProperty = $_.PSObject.Properties['state']
        $modeProperty = if ($stateProperty -and $stateProperty.Value) {
          $stateProperty.Value.PSObject.Properties['mode']
        } else { $null }
        (-not $enabledProperty -or $enabledProperty.Value -ne $false) -and
        $modeProperty -and [string]$modeProperty.Value -eq 'isolated' -and
        $idProperty -and [string]$idProperty.Value -match '^profile-[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$'
      })
      foreach ($profile in $profiles) {
        $profileId = [string]$profile.id
        # Registration is intentionally metadata-only. Only the native account-open owner
        # prepares its private runtime; an update must neither create it nor launch an account
        # whose cold startup would reject the missing config before acquiring its singleton.
        $runtimeConfig = Join-Path (Split-Path -Parent $configPath) "instances\$profileId\runtime\config.json"
        if (-not (Test-Path -LiteralPath $runtimeConfig -PathType Leaf)) {
          Write-Host "[custom-install] profile $profileId is registered but not prepared; leaving setup intact without launching it."
          continue
        }
        Start-VerifiedSuccessor -Arguments @("--cos-instance-runtime=$profileId", '--updated', '--background') -Label "profile $profileId"
      }
    }
  }

  $operationLock = $null
  # Qualification does not mutate product/runtime state, but its receipt is assembled from
  # multiple reads of the canonical release set (latest.yml, installer hashes, embedded payload).
  # Serialize those reads with publication/install/rollback so a concurrent strict publisher
  # cannot replace the release between them and produce a mixed-generation pin proposal.
  $needsOperationLock = $ProposeQualification -or $ProposeInstalledPredecessor -or $Rollback -or $LaunchInstaller -or $WaitForSafeQuit -or (-not $QualifiedPrebuilt)
  if ($needsOperationLock) {
    $operationLock = Enter-CustomInstallOperationLock -Name $OperationLockName
  }

  try {
    Write-Host "[custom-install] repository: $RepoRoot"
    if ($ProposeQualification) {
      $proposal = Get-CandidateQualificationProposal -RepoRoot $RepoRoot -ReleaseDirectory $ReleaseDirectory
      Write-CandidateQualificationProposal -Proposal $proposal
      return $proposal
    }
    if ($ProposeInstalledPredecessor) {
      if (-not (Test-Path -LiteralPath $InstallRoot -PathType Container)) { throw "Installed predecessor root is missing: $InstallRoot" }
      if ([string]::IsNullOrWhiteSpace($AcceptedPackageReceiptPath)) {
        throw 'Installed predecessor proposal requires -AcceptedPackageReceiptPath naming an explicitly accepted qualified package/source receipt; the live tree alone is not authority.'
      }
      if (-not (Test-Path -LiteralPath $AcceptedPackageReceiptPath -PathType Leaf)) { throw "Accepted package/source receipt is missing: $AcceptedPackageReceiptPath" }
      try {
        $acceptedReceiptBytes = [IO.File]::ReadAllBytes($AcceptedPackageReceiptPath)
        $acceptedReceiptText = [Text.UTF8Encoding]::new($false, $true).GetString($acceptedReceiptBytes)
        # PowerShell 7 otherwise coerces ISO release dates to DateTime and loses the exact
        # metadata bytes. Windows PowerShell 5 keeps strings and has no DateKind parameter.
        $jsonOptions = @{}
        if ((Get-Command ConvertFrom-Json).Parameters.ContainsKey('DateKind')) { $jsonOptions.DateKind = 'String' }
        $acceptedPackage = ConvertFrom-Json -InputObject $acceptedReceiptText @jsonOptions
      }
      catch { throw "Accepted package/source receipt is not valid JSON: $($_.Exception.Message)" }
      foreach ($name in @('Version','InstallerFile','InstallerSize','InstallerSha256','InstallerSha512','LatestYmlSha256','ReleaseDate','AppExecutableSha256','AppAsarSha256','ExtensionBackgroundSha256','FileVersion','ProductVersion','CustomBuildText','SourceProvenanceSha256','GitCommit','GitTree')) {
        if ($null -eq $acceptedPackage.PSObject.Properties[$name]) { throw "Accepted package/source receipt is missing required field '$name'." }
      }
      $receiptSha = [Security.Cryptography.SHA256]::Create()
      try {
        $acceptedReceiptSha256 = ([BitConverter]::ToString($receiptSha.ComputeHash($acceptedReceiptBytes))).Replace('-', '').ToLowerInvariant()
      } finally { $receiptSha.Dispose() }
      $proposal = Get-InstalledPredecessorProposal -InstallRoot $InstallRoot -RepoRoot $RepoRoot -ReleaseDirectory $ReleaseDirectory -AcceptedPackageReceipt $acceptedPackage -AcceptedPackageReceiptSha256 $acceptedReceiptSha256
      Write-InstalledPredecessorProposal -Proposal $proposal
      return $proposal
    }
    if (-not $RollbackArchivePath) { $RollbackArchivePath = Get-RollbackArchivePath -Baseline $RollbackBaseline }

  if ($Rollback) {
    # Normal explicit rollback begins with the same immutable archive proof as before. If a prior
    # process died after the canonical install was already moved/promoted, the marker-owned
    # transaction is allowed to recover its quarantine even if that archive subsequently vanished;
    # recovery of the prior install must not depend on unrelated frozen-media availability.
    $paths = Get-RollbackTransactionPaths -InstallRoot $InstallRoot
    $topology = Get-RollbackTransactionTopology -Paths $paths -Baseline $RollbackBaseline
    if ($topology.State -notin @('quarantined', 'prior-only', 'promoted')) {
      $rollbackProof = Assert-RollbackArchive -ArchivePath $RollbackArchivePath -Baseline $RollbackBaseline
      Write-Host "[custom-install] rollback artifact: $($rollbackProof.ArchivePath)" -ForegroundColor Green
      Write-Host "[custom-install] rollback sha256: $($rollbackProof.ArchiveSha256)"
      if ($topology.State -eq 'none' -and (Test-Path -LiteralPath $InstallRoot -PathType Container)) {
        try {
          $alreadyExact = Assert-RollbackTree -Root $InstallRoot -Baseline $RollbackBaseline
          Write-Host '[custom-install] exact private 2.1.13 rollback baseline is already installed; no swap is needed.' -ForegroundColor Green
          return [pscustomobject]@{
            Version = $alreadyExact.Version
            TreeSha256 = $alreadyExact.TreeSha256
            ArchiveSha256 = $rollbackProof.ArchiveSha256
            InstalledApp = $alreadyExact.InstalledApp
            AlreadyExact = $true
          }
        } catch {
          # Not already the exact rollback baseline. Continue into the explicit staged transaction.
        }
      }
    } else {
      Write-Host "[custom-install] recovering interrupted rollback transaction: $($topology.State)" -ForegroundColor Yellow
    }
    return Invoke-ExplicitRollbackTransaction -RollbackArchivePath $RollbackArchivePath -InstallRoot $InstallRoot -UserDataRoot $UserDataRoot -ProcessProbe $ProcessProbe -SleepAction $SleepAction -SuccessorLauncher $SuccessorLauncher -WaitForSafeQuit:$WaitForSafeQuit -Baseline $RollbackBaseline -ArchiveExtractor $ArchiveExtractor -MoveDirectory $MoveDirectory -RemoveDirectory $RemoveDirectory
  }

  if ($QualifiedPrebuilt) {
    # Candidate verification is intentionally first. A mismatch must fail before any process
    # probe, quit request/wait, installer invocation or successor launch.
    $qualified = Assert-QualifiedPrebuiltCandidate -ReleaseDirectory $ReleaseDirectory -RepoRoot $RepoRoot
    Write-Host "[custom-install] qualified prebuilt: $($qualified.InstallerPath)" -ForegroundColor Green
    Write-Host "[custom-install] sha256: $($qualified.InstallerSha256)"
    $rollbackProof = Assert-RollbackArchive -ArchivePath $RollbackArchivePath -Baseline $RollbackBaseline
    Write-Host "[custom-install] exact rollback PROGRAM ARTIFACT ready: $($rollbackProof.ArchivePath). Account-data compatibility is checked separately before an older reader may activate." -ForegroundColor Green
    Write-Host "[custom-install] rollback sha256: $($rollbackProof.ArchiveSha256)"
    $rollbackPaths = Get-RollbackTransactionPaths -InstallRoot $InstallRoot
    $rollbackTopology = Get-RollbackTransactionTopology -Paths $rollbackPaths -Baseline $RollbackBaseline
    if ($rollbackTopology.State -ne 'none') {
      throw "Qualified activation is blocked by an interrupted explicit rollback transaction ('$($rollbackTopology.State)'). Recover it with -Rollback before activating 2.1.14. marker='$($rollbackPaths.Marker)' stage='$($rollbackPaths.Stage)' quarantine='$($rollbackPaths.Quarantine)'"
    }
    # The rollback archive proves what can be restored; the live install must independently prove
    # it is still the exact private 2.1.13 baseline that snapshot captured. This full-tree read is
    # intentionally before the first process probe/quit instruction and is never auto-regenerated.
    $installedBaselineKind = 'rollback baseline'
    $installedBaselineAuthority = $RollbackBaseline
    try {
      $installedBaseline = Assert-RollbackTree -Root $InstallRoot -Baseline $RollbackBaseline
    } catch {
      $rollbackBaselineFailure = $_.Exception.Message
      if (-not $InstalledUpgradeBaseline) { throw }
      try {
        $installedBaseline = Assert-RollbackTree -Root $InstallRoot -Baseline $InstalledUpgradeBaseline
        $installedBaselineKind = 'qualified predecessor'
        $installedBaselineAuthority = $InstalledUpgradeBaseline
      } catch {
        throw "Installed program matches neither accepted activation baseline. Rollback baseline: $rollbackBaselineFailure Qualified predecessor: $($_.Exception.Message)"
      }
    }
    Write-Host "[custom-install] installed private $installedBaselineKind`: $($installedBaseline.TreeSha256)" -ForegroundColor Green
    if (-not $LaunchInstaller -and -not $WaitForSafeQuit) {
      Assert-CustomInstallOperationAvailable -Name $OperationLockName
      Write-Host '[custom-install] qualified activation readiness passed: candidate, rollback, installed baseline, rollback topology and transaction lock are clean.' -ForegroundColor Green
      return $qualified
    }

    $usedLifecycleSafeClosePath = $false
    if ($WaitForSafeQuit) {
      if (Test-InstalledSafeCloseCapability -Baseline $installedBaselineAuthority) {
        $usedLifecycleSafeClosePath = $true
        $safeCloseSummary = Request-InstalledAppSafeClose -InstallRoot $InstallRoot -ProcessInventory $SafeCloseProcessInventory -SafeCloseLauncher $SafeCloseLauncher
        Wait-ForLifecycleOwnedAppExit -ProcessProbe $ProcessProbe -SleepAction $SleepAction -RequestSummary $safeCloseSummary
      } else {
        Write-Host '[custom-install] installed predecessor has no provenance-bound safe-close command; waiting for its normal manual Quit without launching a helper.' -ForegroundColor Yellow
        Wait-ForNormalAppExit -ProcessProbe $ProcessProbe -SleepAction $SleepAction
      }
    } else {
      Assert-AppNotRunning -ProcessProbe $ProcessProbe -Context 'qualified activation preflight'
    }
    # The normal-quit window can be long. Rehash both immutable authorities immediately before
    # installer invocation so a post-preflight replacement cannot cross the mutation boundary.
    $qualified = Assert-QualifiedPrebuiltCandidate -ReleaseDirectory $ReleaseDirectory -RepoRoot $RepoRoot
    $rollbackProof = Assert-RollbackArchive -ArchivePath $RollbackArchivePath -Baseline $RollbackBaseline
    Write-Host '[custom-install] candidate and rollback artifact revalidated at install boundary.' -ForegroundColor Green
    Assert-AppNotRunning -ProcessProbe $ProcessProbe -Context 'qualified installer' -LifecycleOwned:$usedLifecycleSafeClosePath
    return Invoke-QualifiedInstallerTransaction -Qualified $qualified -InstallRoot $InstallRoot -InstallerRunner $InstallerRunner -SuccessorLauncher $SuccessorLauncher
  }

    $reviewedSource = Get-ReviewedGitState -RepoRoot $RepoRoot
    if ($reviewedSource.dirty) {
      throw 'The worktree has tracked and/or untracked changes. Build a new candidate only from a completely clean, committed, recoverable custom tree.'
    }
    Write-Host "[custom-install] clean source: $($reviewedSource.objectFormat) commit=$($reviewedSource.commit) tree=$($reviewedSource.tree)" -ForegroundColor Green
    if (-not (Test-Path -LiteralPath (Join-Path $RepoRoot 'CUSTOM_BUILD'))) {
      throw 'CUSTOM_BUILD marker is missing; refusing to create an update-overwritable package.'
    }
    Assert-StrictBuildStorage -SnapshotPath ([IO.Path]::GetTempPath()) -ReleaseDirectory $ReleaseDirectory
    $verified = Invoke-StrictCandidateBuild -RepoRoot $RepoRoot -ReleaseDirectory $ReleaseDirectory -ReviewedSource $reviewedSource
    $installer = Join-Path $ReleaseDirectory $script:QualifiedCandidate.InstallerFile
    if (-not (Test-Path -LiteralPath $installer -PathType Leaf)) { throw "Expected installer was not created: $installer" }
    Write-Host "[custom-install] new candidate built: $installer" -ForegroundColor Green
    Write-Host "[custom-install] source/build attestation: $($verified.SourceProvenance.commit) / $($verified.SourceProvenance.dependencies.treeSha256)" -ForegroundColor Green
    Write-Host '[custom-install] it was not installed. Qualify the exact new release bytes before changing the pinned qualified receipt or activating it.' -ForegroundColor Yellow
  } finally {
    if ($operationLock) { Exit-CustomInstallOperationLock -Mutex $operationLock }
  }
}

if ($MyInvocation.InvocationName -ne '.') {
  Invoke-CustomInstall @PSBoundParameters
}
