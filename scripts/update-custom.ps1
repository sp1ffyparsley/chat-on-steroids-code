[CmdletBinding()]
param(
  [switch]$SkipVerify,
  [switch]$InspectUpstream,
  [string]$ReviewedUpstreamCommit,
  [string]$UpstreamRepositoryUrl = 'https://github.com/totec448-spec/chat-on-steroids'
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
Set-Location -LiteralPath $repoRoot

function Invoke-Checked {
  param([Parameter(Mandatory)][string]$File, [Parameter(Mandatory)][string[]]$Arguments)
  Write-Host "[custom-update] $File $($Arguments -join ' ')"
  & $File @Arguments
  if ($LASTEXITCODE -ne 0) { throw "$File exited with code $LASTEXITCODE" }
}

# Inspection is deliberately independent of the mutable checkout/merge path below.
# Supply the reviewed upstream SHA from the existing operator audit; inspection never
# advances that review checkpoint, creates another ledger, or qualifies an installer.
function Read-UpstreamField {
  param($Object, [string]$Name)
  if ($null -eq $Object) { return $null }
  $property = $Object.PSObject.Properties[$Name]
  if ($null -ne $property) { return $property.Value }
  return $null
}

function Invoke-UpstreamJson {
  param([string]$ApiRoot, [string]$Resource)
  try {
    Invoke-RestMethod -Uri ($ApiRoot + $Resource) -Headers @{
      Accept = 'application/vnd.github+json'
      'User-Agent' = 'ChatOnSteroids-UpstreamInspection'
    } -TimeoutSec 15 -MaximumRedirection 0 -ErrorAction Stop
  } catch {
    # Public endpoint and error type/status only: never echo response bodies,
    # environment credentials, proxy configuration or arbitrary transport messages.
    $response = Read-UpstreamField $_.Exception 'Response'
    $status = Read-UpstreamField $response 'StatusCode'
    $detail = if ($null -ne $status) { 'HTTP ' + [int]$status } else { $_.Exception.GetType().Name }
    throw "upstream-request-failed ($Resource; $detail). No update mutation was attempted."
  }
}

function Get-UpstreamPathLane {
  param([string]$File)
  if ($File -match '(?i)(?:^|/)(?:package(?:-lock)?\.json|npm-shrinkwrap\.json)$') { return 'dependencies' }
  if ($File -match '^(?:test/|.*\.(?:test|spec)\.)') { return 'tests' }
  if ($File -match '^src/main/(?:session/correlation|core-browser-evidence|mcp/(?:inbound|call-context|server))\.') { return 'attribution' }
  if ($File -match '^(?:extension/|src/main/(?:bridge|goal|session/(?:input|continuation))\.)') { return 'recovery' }
  if ($File -match '^src/renderer/') { return 'ui' }
  if ($File -match '^(?:scripts/|\.github/|.*(?:config|builder)\.[^/]+$)') { return 'build' }
  if ($File -match '^src/') { return 'runtime' }
  if ($File -match '^(?:docs/|.*\.(?:md|txt)$)') { return 'docs' }
  return 'other'
}

if ($InspectUpstream) {
  if ($SkipVerify) { throw 'InspectUpstream cannot be combined with SkipVerify; inspection runs no build or validation.' }
  if ($ReviewedUpstreamCommit -cnotmatch '^[0-9a-fA-F]{40}$') {
    throw 'ReviewedUpstreamCommit must be the exact 40-hex upstream SHA from the existing audit.'
  }
  if ($UpstreamRepositoryUrl -notmatch '^https://github\.com/totec448-spec/chat-on-steroids/?$') {
    throw 'UpstreamRepositoryUrl must be the public official https://github.com/totec448-spec/chat-on-steroids repository without credentials, query or fragment.'
  }
  $reviewed = $ReviewedUpstreamCommit.ToLowerInvariant()
  $apiRoot = 'https://api.github.com/repos/totec448-spec/chat-on-steroids'
  $repository = Invoke-UpstreamJson $apiRoot ''
  $defaultBranch = Read-UpstreamField $repository 'default_branch'
  if ($defaultBranch -isnot [string] -or $defaultBranch.Length -lt 1 -or $defaultBranch.Length -gt 200 -or $defaultBranch -match '[\x00-\x1f\x7f]') {
    throw 'upstream-response-invalid: missing or invalid default branch.'
  }
  $headResponse = Invoke-UpstreamJson $apiRoot ('/commits/' + [Uri]::EscapeDataString($defaultBranch))
  $upstreamHead = Read-UpstreamField $headResponse 'sha'
  $release = Invoke-UpstreamJson $apiRoot '/releases/latest'
  $tag = Read-UpstreamField $release 'tag_name'
  if ($upstreamHead -isnot [string] -or $upstreamHead -cnotmatch '^[0-9a-fA-F]{40}$' -or
      $tag -isnot [string] -or $tag.Length -lt 1 -or $tag.Length -gt 128 -or $tag -match '[\x00-\x1f\x7f]') {
    throw 'upstream-response-invalid: missing or invalid head/release identity.'
  }
  $upstreamHead = $upstreamHead.ToLowerInvariant()
  $report = [ordered]@{
    schema = 'cos_upstream_inspection_v1'; checkedAt = [DateTime]::UtcNow.ToString('o')
    repository = 'https://github.com/totec448-spec/chat-on-steroids'; defaultBranch = $defaultBranch
    reviewedCommit = $reviewed; head = $upstreamHead
    state = $(if ($reviewed -eq $upstreamHead) { 'unchanged' } else { 'changed' })
    latestRelease = [ordered]@{ tag = $tag; publishedAt = (Read-UpstreamField $release 'published_at') }
    mutated = $false; comparison = $null
  }
  if ($reviewed -ne $upstreamHead) {
    # GitHub's first compare page supplies at most 300 files and this requested
    # 20-commit page. Report both truncation boundaries rather than calling a
    # bounded summary a complete review. Do not fetch patches or subsequent pages.
    $comparison = Invoke-UpstreamJson $apiRoot ("/compare/$reviewed...${upstreamHead}?per_page=20&page=1")
    $status = Read-UpstreamField $comparison 'status'
    $total = Read-UpstreamField $comparison 'total_commits'
    $ahead = Read-UpstreamField $comparison 'ahead_by'
    $behind = Read-UpstreamField $comparison 'behind_by'
    if ($null -eq $comparison.PSObject.Properties['commits'] -or $null -eq $comparison.PSObject.Properties['files']) {
      throw 'upstream-response-invalid: comparison inventories are missing.'
    }
    $commits = @(Read-UpstreamField $comparison 'commits')
    $files = @(Read-UpstreamField $comparison 'files')
    foreach ($count in @($total, $ahead, $behind)) {
      if (($count -isnot [int] -and $count -isnot [long]) -or $count -lt 0 -or $count -gt [int]::MaxValue) {
        throw 'upstream-response-invalid: missing or invalid comparison counts.'
      }
    }
    if ($status -notin @('ahead', 'behind', 'diverged', 'identical') -or $commits.Count -gt 20 -or $files.Count -gt 300 -or $commits.Count -gt $total) {
      throw 'upstream-response-invalid: invalid or unbounded comparison.'
    }
    $commitRows = @($commits | ForEach-Object {
      $sha = Read-UpstreamField $_ 'sha'
      $message = Read-UpstreamField (Read-UpstreamField $_ 'commit') 'message'
      if ($sha -isnot [string] -or $sha -cnotmatch '^[0-9a-fA-F]{40}$' -or $message -isnot [string]) {
        throw 'upstream-response-invalid: invalid comparison commit.'
      }
      $subject = ($message -split '[\r\n]', 2)[0]
      [ordered]@{ sha = $sha.ToLowerInvariant(); subject = $subject.Substring(0, [Math]::Min(160, $subject.Length)) }
    })
    $lanes = [ordered]@{}; $paths = [Collections.Generic.List[object]]::new()
    foreach ($file in $files) {
      $name = Read-UpstreamField $file 'filename'
      $fileStatus = Read-UpstreamField $file 'status'
      if ($name -isnot [string] -or $name.Length -lt 1 -or $name.Length -gt 1024 -or
          $name -match '[\x00-\x1f\x7f]' -or $fileStatus -notin @('added', 'removed', 'modified', 'renamed', 'copied', 'changed', 'unchanged')) {
        throw 'upstream-response-invalid: invalid comparison path.'
      }
      $lane = Get-UpstreamPathLane $name
      if (-not $lanes.Contains($lane)) { $lanes[$lane] = 0 }
      $lanes[$lane]++
      if ($paths.Count -lt 80) {
        $row = [ordered]@{ path = $name; status = $fileStatus; lane = $lane }
        $previous = Read-UpstreamField $file 'previous_filename'
        if ($previous -is [string] -and $previous.Length -gt 0 -and $previous.Length -le 1024 -and $previous -notmatch '[\x00-\x1f\x7f]') { $row.previousPath = $previous }
        $paths.Add($row)
      }
    }
    $commitsTruncated = $total -gt $commits.Count
    $filesTruncated = $files.Count -ge 300 -or $files.Count -gt $paths.Count
    $report.comparison = [ordered]@{
      status = $status; totalCommits = $total; aheadBy = $ahead; behindBy = $behind
      observedFiles = $files.Count; commits = $commitRows; paths = @($paths.ToArray()); lanes = $lanes
      commitsTruncated = $commitsTruncated; filesTruncated = $filesTruncated
      complete = -not ($commitsTruncated -or $filesTruncated)
      scope = 'first compare page; at most 20 commits, 300 observed files and 80 displayed paths'
    }
  }
  $report | ConvertTo-Json -Depth 8 -Compress
  return
}
if ($PSBoundParameters.ContainsKey('ReviewedUpstreamCommit') -or $PSBoundParameters.ContainsKey('UpstreamRepositoryUrl')) {
  throw 'ReviewedUpstreamCommit and UpstreamRepositoryUrl require InspectUpstream.'
}

Write-Host "[custom-update] repository: $repoRoot"
$inside = (& git rev-parse --show-toplevel 2>$null)
if ($LASTEXITCODE -ne 0 -or (Resolve-Path -LiteralPath $inside).Path -ne $repoRoot) {
  throw 'This script must run from its own Git checkout.'
}
$branch = (& git branch --show-current).Trim()
if ($branch -ne 'codex/local-enhancements') {
  throw "Expected branch codex/local-enhancements, found '$branch'. Switch to the durable custom branch first."
}
if (@(& git status --porcelain).Count -ne 0) {
  throw 'The worktree has uncommitted changes. Commit or stash them before merging an upstream update.'
}

$upstreamRemote = 'upstream'
$upstreamUrl = (& git remote get-url $upstreamRemote 2>$null)
if ($LASTEXITCODE -ne 0 -or -not $upstreamUrl) {
  throw "The read-only '$upstreamRemote' remote is missing. Restore it before importing an official update."
}
Invoke-Checked git @('fetch', $upstreamRemote, 'main', '--tags', '--prune')
$stamp = (Get-Date).ToUniversalTime().ToString('yyyyMMdd-HHmmss')
$backup = "backup/pre-upstream-$stamp"
Invoke-Checked git @('branch', $backup, 'HEAD')
Write-Host "[custom-update] recovery branch created: $backup"

try {
  Invoke-Checked git @('merge', '--no-edit', "$upstreamRemote/main")
} catch {
  if (Test-Path -LiteralPath (Join-Path $repoRoot '.git/MERGE_HEAD')) {
    & git merge --abort
  }
  throw "Upstream merge stopped safely. Your prior code is on $backup. Resolve the update manually; no custom commit was discarded. $($_.Exception.Message)"
}

Invoke-Checked npm @('ci')
& node -e "require('electron')" 2>$null
if ($LASTEXITCODE -ne 0) {
  Invoke-Checked npx @('install-electron', '--no')
}
if (-not $SkipVerify) {
  Invoke-Checked npm @('run', 'verify:ci')
}

Write-Host '[custom-update] upstream merged and verified. Review and commit the merge to one clean Git commit/tree, then run scripts/install-custom.ps1. The private builder clones that exact commit into an owned detached snapshot, runs fresh lockfile-controlled npm ci --offline with checksum-bound tool inputs, and fails closed if local cache material is incomplete rather than using live node_modules or downloading. After it publishes an unqualified candidate, use scripts/install-custom.ps1 -ProposeQualification to verify the exact Setup payload plus embedded source/build attestation against the clean review checkout and reproduced toolchain; review/pin the complete proposed receipt deliberately before -QualifiedPrebuilt readiness or Apply Custom Update.cmd activation.'
