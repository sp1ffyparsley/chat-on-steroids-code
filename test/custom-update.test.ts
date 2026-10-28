import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const script = fileURLToPath(new URL('../scripts/update-custom.ps1', import.meta.url));
const powershell = process.platform === 'win32' ? 'powershell.exe' : 'pwsh';
const available = spawnSync(powershell, ['-NoProfile', '-NonInteractive', '-Command', '$PSVersionTable.PSVersion.ToString()'], { encoding: 'utf8' }).status === 0;
const base = 'a'.repeat(40), head = 'b'.repeat(40);
const api = 'https://api.github.com/repos/totec448-spec/chat-on-steroids';

function inspect(overrides: Record<string, unknown> = {}) {
  const fixture = {
    reviewed: head, head, defaultBranch: 'main', tag: 'v2.1.46',
    comparison: { status: 'ahead', ahead_by: 1, behind_by: 0, total_commits: 1,
      commits: [{ sha: head, commit: { message: 'A useful fix' } }], files: [] }, ...overrides
  };
  // Mock the public HTTP boundary, not the inspector. Any Git/npm/build invocation fails.
  const harness = `
$global:fixture = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($env:COS_UPSTREAM_FIXTURE)) | ConvertFrom-Json
$global:calls = [Collections.Generic.List[string]]::new()
$global:gitCalls = [Collections.Generic.List[string]]::new()
function global:git {
  $line = $args -join ' '
  $global:gitCalls.Add($line)
  if ($fixture.PSObject.Properties['legacy']) {
    $global:LASTEXITCODE = 0
    if ($line -eq 'rev-parse --show-toplevel') { return '${fileURLToPath(new URL('..', import.meta.url)).replace(/[/\\]$/, '').replace(/'/g, "''")}' }
    if ($line -eq 'branch --show-current') { return $fixture.branch }
    if ($line -eq 'status --porcelain') { return ' M preserved-user-work.ts' }
  }
  throw 'Unexpected Git action in read-only inspection'
}
function global:npm { throw 'Unexpected npm action in read-only inspection' }
function global:npx { throw 'Unexpected npx action in read-only inspection' }
function global:node { throw 'Unexpected build action in read-only inspection' }
function global:Invoke-RestMethod {
  param($Uri, $Headers, $TimeoutSec, $MaximumRedirection, $ErrorAction)
  if ($TimeoutSec -le 0 -or $TimeoutSec -gt 30 -or $MaximumRedirection -ne 0 -or $Headers.ContainsKey('Authorization')) { throw 'Unbounded or credentialed request' }
  $global:calls.Add([string]$Uri)
  if ($fixture.PSObject.Properties['failAt'] -and $Uri.EndsWith([string]$fixture.failAt)) { throw 'simulated transport failure' }
  if ($Uri -eq '${api}') { return [pscustomobject]@{ default_branch = $fixture.defaultBranch } }
  if ($Uri -eq '${api}/commits/main') { return [pscustomobject]@{ sha = $fixture.head } }
  if ($Uri -eq '${api}/releases/latest') { return [pscustomobject]@{ tag_name = $fixture.tag; published_at = '2026-10-25T15:31:34Z' } }
  if ($Uri -eq ('${api}/compare/' + $fixture.reviewed + '...' + $fixture.head + '?per_page=20&page=1')) { return $fixture.comparison }
  throw 'Unexpected endpoint'
}
$arguments = @{ InspectUpstream = $true; ReviewedUpstreamCommit = $fixture.reviewed }
if ($fixture.PSObject.Properties['legacy']) { $arguments = @{} }
if ($fixture.PSObject.Properties['skipVerify']) { $arguments.SkipVerify = $true }
if ($fixture.PSObject.Properties['repositoryUrl']) { $arguments.UpstreamRepositoryUrl = $fixture.repositoryUrl }
$code = 0; $answer = $null; $failure = $null
try { $answer = (& '${script.replace(/'/g, "''")}' @arguments 6>$null | Out-String) | ConvertFrom-Json }
catch { $code = 1; $failure = $_.Exception.Message }
[pscustomobject]@{ result = $answer; calls = @($global:calls); gitCalls = @($global:gitCalls); failure = $failure } | ConvertTo-Json -Depth 30 -Compress
exit $code
`;
  const child = spawnSync(powershell, ['-NoProfile', '-NonInteractive', '-Command', harness], {
    encoding: 'utf8', timeout: 20_000, maxBuffer: 1024 * 1024,
    env: { ...process.env, COS_UPSTREAM_FIXTURE: Buffer.from(JSON.stringify(fixture)).toString('base64') }
  });
  if (child.error) throw child.error;
  return { status: child.status, ...JSON.parse(child.stdout.trim()) };
}

describe.skipIf(!available)('read-only custom upstream inspection', () => {
  it('checks unchanged upstream in a dirty, nonstandard checkout without Git or builds', () => {
    const answer = inspect();
    expect(answer.status).toBe(0);
    expect(answer.result).toMatchObject({ state: 'unchanged', reviewedCommit: head, head, latestRelease: { tag: 'v2.1.46' } });
    expect(answer.result.checkedAt).toMatch(/^\d{4}-\d\d-\d\dT/);
    expect(answer.calls).toEqual([api, `${api}/commits/main`, `${api}/releases/latest`]);
    expect(answer.gitCalls).toEqual([]);
  });

  it('classifies changed paths and explicitly limits commits and paths', () => {
    const commits = Array.from({ length: 20 }, (_, index) => ({ sha: index.toString(16).padStart(40, '0'), commit: { message: `Fix ${index}\nprivate-looking remainder is not printed` } }));
    const files = Array.from({ length: 300 }, (_, index) => ({ filename: index === 0 ? 'src/main/session/correlation.ts' : index === 1 ? 'extension/content.js' : index === 2 ? 'package-lock.json' : `test/fix-${index}.test.ts`, status: 'modified' }));
    const answer = inspect({ reviewed: base, comparison: { status: 'ahead', ahead_by: 25, behind_by: 0, total_commits: 25, commits, files } });
    expect(answer.status).toBe(0);
    expect(answer.result).toMatchObject({ state: 'changed', comparison: { status: 'ahead', totalCommits: 25, observedFiles: 300, commitsTruncated: true, filesTruncated: true, complete: false } });
    expect(answer.result.comparison.commits).toHaveLength(20);
    expect(answer.result.comparison.paths.length).toBeLessThanOrEqual(80);
    expect(answer.result.comparison.lanes).toMatchObject({ attribution: 1, recovery: 1, dependencies: 1, tests: 297 });
    expect(JSON.stringify(answer.result)).not.toContain('private-looking remainder');
  });

  it('reports complete small comparison without claiming merge or installation', () => {
    const answer = inspect({ reviewed: base, comparison: { status: 'ahead', ahead_by: 1, behind_by: 0, total_commits: 1,
      commits: [{ sha: head, commit: { message: 'A small fix' } }],
      files: [{ filename: 'src/renderer/settings.ts', status: 'renamed', previous_filename: 'src/renderer/old-settings.ts' }] } });
    expect(answer.status).toBe(0);
    expect(answer.result.comparison).toMatchObject({ complete: true, commitsTruncated: false, filesTruncated: false, lanes: { ui: 1 } });
    expect(answer.result.comparison.paths[0]).toEqual({ path: 'src/renderer/settings.ts', status: 'renamed', previousPath: 'src/renderer/old-settings.ts', lane: 'ui' });
    expect(answer.result.mutated).toBe(false);
  });

  it.each([
    { reviewed: 'main; npm install' },
    { repositoryUrl: 'https://example.com/totec448-spec/chat-on-steroids' },
    { repositoryUrl: 'https://github.com/totec448-spec/chat-on-steroids?token=secret' },
    { skipVerify: true }
  ])('refuses invalid inspection arguments before any request: %j', override => {
    const answer = inspect(override);
    expect(answer.status).toBe(1);
    expect(answer.calls).toEqual([]);
  });

  it('fails honestly when live release retrieval fails instead of returning unchanged', () => {
    const answer = inspect({ failAt: '/releases/latest' });
    expect(answer.status).toBe(1);
    expect(answer.result?.state).not.toBe('unchanged');
    expect(answer.failure).toContain('upstream-request-failed');
  });

  it('rejects malformed comparison metadata without turning it into a complete review', () => {
    const answer = inspect({ reviewed: base, comparison: { status: 'ahead', ahead_by: -1, behind_by: 0, total_commits: 1, commits: [], files: [] } });
    expect(answer.status).toBe(1);
    expect(answer.failure).toContain('upstream-response-invalid');
  });

  it('rejects an absent file inventory instead of treating it as an empty complete diff', () => {
    const answer = inspect({ reviewed: base, comparison: { status: 'ahead', ahead_by: 1, behind_by: 0, total_commits: 1,
      commits: [{ sha: head, commit: { message: 'An incomplete response' } }] } });
    expect(answer.status).toBe(1);
    expect(answer.failure).toContain('upstream-response-invalid');
  });

  it('preserves the legacy wrong-branch refusal before merge or network access', () => {
    const answer = inspect({ legacy: true, branch: 'another-branch' });
    expect(answer.status).toBe(1);
    expect(answer.failure).toContain('Expected branch codex/local-enhancements');
    expect(answer.gitCalls).toEqual(['rev-parse --show-toplevel', 'branch --show-current']);
    expect(answer.calls).toEqual([]);
  });

  it('preserves the legacy dirty-worktree refusal before fetch or merge', () => {
    const answer = inspect({ legacy: true, branch: 'codex/local-enhancements' });
    expect(answer.status).toBe(1);
    expect(answer.failure).toContain('worktree has uncommitted changes');
    expect(answer.gitCalls).toEqual(['rev-parse --show-toplevel', 'branch --show-current', 'status --porcelain']);
    expect(answer.calls).toEqual([]);
  });
});
