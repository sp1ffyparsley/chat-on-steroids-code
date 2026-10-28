import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { HELPER_SCRIPT } from '../src/main/computer/helper.js';

describe.runIf(process.platform === 'win32')('Windows browser UI provider ownership', () => {
  it('selects the current browser provider, rejects old-tab refs and fails closed on missing or ambiguous roots', () => {
    // Execute the production selection/snapshot/resolution functions. Only the
    // UIA tree boundary is replaced; no user window is activated or modified.
    const functions = HELPER_SCRIPT.slice(HELPER_SCRIPT.indexOf('function Ui-RuntimeKey('), HELPER_SCRIPT.indexOf('$script:UiActionNames ='))
      .replaceAll('[System.Windows.Automation.AutomationElement]::FromHandle([IntPtr]$id)', '(Get-TestRoot $id)')
      .replaceAll('[System.Windows.Automation.TreeWalker]::ControlViewWalker', '$script:walker');
    const script = String.raw`
$ErrorActionPreference='Stop'
function Node([int]$key,[string]$class) {
 $node=[pscustomobject]@{key=$key;Current=[pscustomobject]@{ClassName=$class;IsEnabled=$true;IsOffscreen=$false};parent=$null;children=@()}
 $node | Add-Member ScriptMethod GetRuntimeId { return @($this.key) }
 return $node
}
function Children($parent,$children) {
 $parent.children=@($children)
 foreach($child in $children){$child.parent=$parent}
}
$script:walker=[pscustomobject]@{visits=0}
$script:walker | Add-Member ScriptMethod GetFirstChild { param($node); $this.visits++; if($node.children.Count){return $node.children[0]}; return $null }
$script:walker | Add-Member ScriptMethod GetNextSibling {
 param($node); $this.visits++
 if($null -eq $node.parent){return $null}
 $siblings=$node.parent.children
 for($i=0;$i -lt $siblings.Count-1;$i++){if([object]::ReferenceEquals($siblings[$i],$node)){return $siblings[$i+1]}}
 return $null
}
$script:walker | Add-Member ScriptMethod GetParent { param($node); $this.visits++; return $node.parent }
function Get-TestRoot($id){return $script:root}
function Get-WindowRow($id){
 if($script:missingWindow -or $script:windowProcessId -eq $script:ownProcessId){return $null}
 return @{process=$script:processName;processId=$script:windowProcessId}
}
function Reject($action,[string]$pattern){
 try {& $action; throw "expected rejection matching $pattern"} catch {if($_.Exception.Message -like 'expected rejection*' -or $_.Exception.Message -notmatch $pattern){throw}}
}
` + functions + String.raw`
$script:processName='chrome'
$script:ownProcessId=99
$script:windowProcessId=10
$script:root=Node 1 'Chrome_WidgetWin_1'
$oldDocument=Node 2 'Document'
$browser=Node 3 'BrowserRootView'
$currentDocument=Node 4 'Document'
$button=Node 5 'Button'
Children $script:root @($oldDocument,$browser)
Children $browser @($currentDocument)
Children $currentDocument @($button)
if(-not [object]::ReferenceEquals((Get-UiRoot 1),$browser)){throw 'old visible legacy document won browser selection'}
$snapshot=Remember-UiSnapshot 1 (Get-UiRoot 1) @($button)
if(-not [object]::ReferenceEquals((Resolve-UiElement 1 $snapshot '5'),$button)){throw 'current element was rejected'}
# The old provider remains live after a tab switch and its flags still look usable.
Children $oldDocument @($currentDocument)
Children $browser @((Node 6 'Document'))
Reject {Resolve-UiElement 1 $snapshot '5'} 'STALE_UI_REF'
# Replacing the BrowserRootView itself also retires every ref under the old root.
Children $script:root @((Node 7 'BrowserRootView'))
Reject {Resolve-UiElement 1 $snapshot '5'} 'STALE_UI_SNAPSHOT'
Children $script:root @($oldDocument)
Reject {Get-UiRoot 1} 'UIA_FAILED'
Children $script:root @($browser,(Node 8 'BrowserRootView'))
Reject {Get-UiRoot 1} 'multiple browser UI roots'
Children $script:root (@($browser) + @(1..128 | ForEach-Object {Node (100+$_) 'Document'}))
$script:walker.visits=0
Reject {Get-UiRoot 1} 'UIA_FAILED'
if($script:walker.visits -gt 129){throw 'root selection exceeded its traversal bound'}
$script:missingWindow=$true
Reject {Get-UiRoot 1} 'unavailable or belongs to this app'
$script:missingWindow=$false
$script:windowProcessId=99
Reject {Get-UiRoot 1} 'unavailable or belongs to this app'
$script:windowProcessId=10
# Chromium-based desktop apps and native dialogs keep their own root, not a
# browser provider inferred from their implementation's window class alone.
$script:processName='fixture'
if(-not [object]::ReferenceEquals((Get-UiRoot 1),$script:root)){throw 'non-browser root changed'}
$script:processName='chrome'; $script:root.Current.ClassName='#32770'
if(-not [object]::ReferenceEquals((Get-UiRoot 1),$script:root)){throw 'native dialog root changed'}
'BROWSER_UI_OWNER_OK'
`;
    const directory = mkdtempSync(path.join(tmpdir(), 'cos-browser-uia-'));
    try {
      const file = path.join(directory, 'probe.ps1');
      writeFileSync(file, script);
      const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-File', file], { encoding: 'utf8', windowsHide: true, timeout: 20_000 });
      expect(result.status, result.stderr || result.stdout).toBe(0);
      expect(result.stdout).toContain('BROWSER_UI_OWNER_OK');
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it.each(['result', 'visit', 'time'] as const)('does not walk beyond its observation budget (%s)', mode => {
    const runtimeKey = HELPER_SCRIPT.slice(HELPER_SCRIPT.indexOf('function Ui-RuntimeKey('), HELPER_SCRIPT.indexOf('function Get-UiRoot('));
    const snapshots = HELPER_SCRIPT.slice(HELPER_SCRIPT.indexOf('$script:UiSnapshots ='), HELPER_SCRIPT.indexOf('function Resolve-UiElement('));
    const actions = HELPER_SCRIPT.slice(HELPER_SCRIPT.indexOf('function Get-UiActions('), HELPER_SCRIPT.indexOf('function Invoke-UiAction('));
    const find = HELPER_SCRIPT.slice(HELPER_SCRIPT.indexOf('function Find-UiElements('), HELPER_SCRIPT.indexOf('function Capture-Target('))
      .replaceAll('[System.Windows.Automation.TreeWalker]::ControlViewWalker', '$script:walker');
    // Only the external provider is replaced. Execute the real traversal, cache projection
    // and snapshot owner; the real WPF pattern/action test covers native interoperability.
    const script = String.raw`
$ErrorActionPreference='Stop'
Add-Type -AssemblyName UIAutomationClient,UIAutomationTypes
$script:mode='${mode}'
$script:extraCalls=0
$script:root=[pscustomobject]@{Current=[pscustomobject]@{ClassName='OwnedFixture'}}
$script:root | Add-Member ScriptMethod GetRuntimeId {return @(1)}
$script:node=[pscustomobject]@{Cached=[pscustomobject]@{
 Name='Budgeted button';AutomationId='budgeted';ControlType=[pscustomobject]@{ProgrammaticName='ControlType.Button'}
 IsEnabled=$true;IsOffscreen=$false;HasKeyboardFocus=$false;IsKeyboardFocusable=$true;IsPassword=$true
 BoundingRectangle=[pscustomobject]@{X=1;Y=1;Width=20;Height=20}
}}
$script:node | Add-Member ScriptMethod GetRuntimeId {return @(2)}
$script:node | Add-Member ScriptMethod GetCachedPropertyValue {
 param($property,$ignoreDefault)
 return $property.Id -eq [System.Windows.Automation.AutomationElement]::IsInvokePatternAvailableProperty.Id
}
function Get-UiRoot($id){return $script:root}
$script:walker=[pscustomobject]@{}
$script:walker | Add-Member ScriptMethod GetFirstChild {
 param($node,$cache)
 if([object]::ReferenceEquals($node,$script:root)) {
  if($script:mode -eq 'time'){Start-Sleep -Milliseconds 2100}
  return $script:node
 }
 $script:extraCalls++;return $null
}
$script:walker | Add-Member ScriptMethod GetNextSibling {param($node,$cache);$script:extraCalls++;return $null}
` + runtimeKey + snapshots + actions + find + String.raw`
$request=@{id=1;maxResults=1;maxVisited=1}
if($script:mode -eq 'visit'){$request.query='absent'}
$read=Find-UiElements $request
if($script:extraCalls -ne 0){throw "Provider queried beyond its budget: $script:extraCalls"}
if($script:mode -eq 'result') {
 if($read.elements.Count -ne 1 -or 'invoke' -notin $read.elements[0].actions){throw 'Actual matched action projection lost'}
} elseif($read.elements.Count -ne 0){throw 'Unobserved element claimed'}
if($read.truncated -ne $true){throw 'Partial observation was advertised as exhaustive'}
'UIA_BUDGET_OK'
`;
    const directory = mkdtempSync(path.join(tmpdir(), 'cos-browser-uia-budget-'));
    try {
      const file = path.join(directory, 'probe.ps1'); writeFileSync(file, script);
      const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-File', file],
        { encoding: 'utf8', windowsHide: true, timeout: 20_000 });
      expect(result.status, result.stderr || result.stdout).toBe(0);
      expect(result.stdout).toContain('UIA_BUDGET_OK');
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
});
