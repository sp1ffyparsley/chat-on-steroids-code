import { currentLanguage, ui, uiText, t, initLanguage } from './i18n.js';
import { chatgptNameLine } from './connector-name.js';
import { paintPluginRefreshReminder } from './plugin-refresh-reminder.js';
import { initUsage, refreshUsage } from './usage.js';
import { initSidebarResize } from './sidebar-resize.js';
import { initSettingsSearch } from './settings-search.js';
import { initPlugins, applyPluginsState } from './plugins.js';
import { initBrowserPreferences } from './browser-preferences.js';
import { initSetupGuide } from './setup-guide.js';
import { formatSupportReport } from '../shared/support-report.js';
/**
 * Renderer. No Node, no filesystem, no network — everything goes through window.api.
 *
 * The DOM skeleton lives in index.html; this fills it in and never rebuilds a control
 * the user might be typing into. The permission rows are the one exception: they are
 * generated from CAPABILITIES so a new capability appears without touching markup.
 *
 * Two rules the layout depends on. The window is a fixed frame, so nothing here may
 * change the height of anything outside its own scroll pane — that is why only one
 * permission group is expanded at a time. And the two live numbers tick locally every
 * second, so "verified 8s ago" keeps counting between the 15s reports from the main
 * process instead of freezing at a number that is quietly going stale.
 */

import type {
  AppApi,
  InstanceProfilesSnapshot,
  InstanceProfileView,
  SettingsPatch
} from '../preload/index.js';
import { requiresApprovedFilesystemRoot } from '../shared/capabilities.js';
import type { AppState, Capability, ChatBrowser, LogEntry, SurfaceStatus } from '../shared/types.js';
import {
  browserExtensionRequired,
  isNewer,
  RELEASES_PAGE,
  CAPABILITY_DETAILS,
  CAPABILITY_LABELS,
  capabilityTools,
  DESKTOP_CAPABILITIES,
  WRITE_CAPABILITIES
} from '../shared/types.js';
import type { SwarmState } from '../shared/session.js';
import { $, ago, el, icon, run, shortAgo, toast } from './dom.js';
import { chatApply, chatSettingsPatch, chatVisible, initChat, openChatView, playSignOutEmergencyAlarm, silenceSignOutEmergencyAlarm, refreshComposerTarget, refreshComposerDrafts } from './chat.js';
import { preserveTimelineViewport } from './timeline-scroll.js';

declare global {
  interface Window {
    api: AppApi;
  }
}

const api = window.api;
initLanguage();
initSetupGuide();

/** Same shape the platform uses; mirrored here only to grey out step 2 until it is valid. */
const TUNNEL_ID_PATTERN = /^tunnel_[0-9a-f]{32}$/;

interface Group {
  id: string;
  title: string;
  /** Sprite id from index.html. */
  icon: string;
  blurb: string;
  caps: Capability[];
}

const GROUPS: Group[] = [
  {
    id: 'read',
    title: "Look at files",
    icon: 'i-eye',
    blurb: "Read and search inside the folders you approved.",
    caps: ['browse', 'search', 'read', 'metadata']
  },
  {
    id: 'write',
    title: "Change files",
    icon: 'i-pencil',
    blurb: "Create, edit, move, delete and save ChatGPT files, inside those folders only.",
    caps: ['create', 'edit', 'move', 'deleteFile', 'saveArtifact']
  },
  {
    id: 'desktop',
    title: "See and use the desktop",
    icon: 'i-monitor',
    blurb: "Screenshots, the list of open windows, and the mouse and keyboard.",
    caps: ['screen', 'control', 'clipboardRead', 'clipboardWrite']
  },
  {
    id: 'run',
    title: "Run programs",
    icon: 'i-terminal',
    blurb: "Start commands as you. The most powerful setting here.",
    caps: ['command']
  }
];

let state: AppState | null = null;
/** Guards against saving while we are writing values into the controls. */
let applying = false;

/**
 * Applies persisted form state without erasing a value the user is currently editing.
 *
 * `state:changed` is primarily a live status push, but it carries the whole config object. A
 * focused field can therefore differ from the last persisted config for several seconds before
 * its `change` event saves it. Only that exact dirty case is protected; an idle/focused-but-clean
 * field still follows persisted state normally.
 */
function applyValue(control: HTMLInputElement | HTMLSelectElement, next: string, previous?: string): void {
  const dirty = (document.activeElement === control || requestedSettings !== null) && previous !== undefined && control.value !== previous;
  if (!dirty) control.value = next;
}

function applyChecked(control: HTMLInputElement, next: boolean, previous?: boolean): void {
  const dirty = (document.activeElement === control || requestedSettings !== null) && previous !== undefined && control.checked !== previous;
  if (!dirty) control.checked = next;
}
/** The one expanded permission group, or null. One at a time keeps the layout still. */
let openGroup: string | null = null;
/** Null follows setup completion; an explicit guide choice survives status pushes. */
let showAllSteps: boolean | null = null;
let setupProfileBusy = false;
let setupKeySave: Promise<boolean> = Promise.resolve(true);
let instanceProfiles: InstanceProfilesSnapshot | null = null;
let instanceProfilesGeneration = 0;
let instanceProfileBusy = false;
let managedInstanceId: string | null = null;
let pendingInstanceSwitchId: string | null = null;
let instanceManagerReturnFocus: HTMLElement | null = null;
let instanceCreateReturnFocus: HTMLElement | null = null;
let instanceSwitchReturnFocus: HTMLElement | null = null;
let instanceRemoveReturnFocus: HTMLElement | null = null;

type RendererReply<T> =
  | { ok: true; data: T }
  | { ok: false; error: string; code?: string; field?: string };

const INSTANCE_CONNECTION_LABEL: Record<InstanceProfileView['connection']['state'], string> = {
  disconnected: 'Disconnected',
  starting: 'Recovering',
  connected: 'Connected',
  offline: 'Waiting for Core',
  error: 'Needs attention'
};

function instancePlatformLabel(profile: Pick<InstanceProfileView, 'platform'>): string {
  if (profile.platform === 'darwin') return 'Mac';
  if (profile.platform === 'linux') return 'Linux';
  return 'Windows';
}

function instanceHealthTone(profile: InstanceProfileView): '' | 'is-live' | 'is-busy' | 'is-bad' {
  if (!profile.enabled) return '';
  if (profile.browserAuth === 'signed-out') return 'is-bad';
  if (profile.runtimeRunning && profile.browserPaired === false) return 'is-bad';
  if (profile.connection.state === 'error') return 'is-bad';
  if (profile.connection.state === 'offline') return 'is-busy';
  if (profile.connection.core.state === 'error') return 'is-bad';
  if (profile.connection.state === 'starting' || profile.connection.core.state === 'starting') return 'is-busy';
  if (profile.connection.state === 'connected' && profile.connection.core.state === 'live') return 'is-live';
  return '';
}

function instanceConnectionText(profile: InstanceProfileView): string {
  if (!profile.enabled) return t('Disabled');
  if (profile.browserAuth === 'signed-out') return `Sign in to ${profile.nickname}`;
  if (profile.runtimeRunning && !profile.active) return profile.browserPaired === false
    ? t('Running · pair browser') : t('Running in another window');
  if (profile.connection.state === 'error') return t('Needs attention');
  if (profile.connection.state === 'offline') return t('Waiting for Core');
  if (profile.connection.state === 'starting' || profile.connection.core.state === 'starting') return t('Recovering');
  if (profile.connection.core.state === 'error') return t('Needs attention');
  if (profile.connection.state === 'connected' && profile.connection.core.state === 'live') return t('Connected');
  return t(INSTANCE_CONNECTION_LABEL[profile.connection.state]);
}

/** Main owns profile lifecycle/error facts; the renderer only localizes their presentation. */
function instanceTranslatedText(source: string): string {
  const direct = t(source);
  if (direct !== source) return direct;
  const switchTarget = /^Profile switch to (.+)$/.exec(source);
  if (switchTarget) return t('Profile switch to {0}', [switchTarget[1]!]);
  if (source.includes(' · ')) return source.split(' · ').map(instanceTranslatedText).join(' · ');
  const counted = /^(\d+) (.+)$/.exec(source);
  if (counted) {
    const detail = t(counted[2]!);
    if (detail !== counted[2]) return t('{0} {1}', [counted[1]!, detail]);
  }
  return source;
}

function bindInstanceText(node: HTMLElement, source: string): void {
  ui(node, 'textContent', () => instanceTranslatedText(source));
}

function activeInstanceProfile(): InstanceProfileView | null {
  if (!instanceProfiles) return null;
  return instanceProfiles.profiles.find(profile => profile.id === instanceProfiles!.activeProfileId)
    ?? instanceProfiles.profiles.find(profile => profile.active)
    ?? null;
}

async function instanceAction<T>(
  promise: Promise<RendererReply<T>>,
  status?: HTMLElement
): Promise<T | null> {
  try {
    const reply = await promise;
    if (reply.ok) return reply.data;
    const message = instanceTranslatedText(reply.error);
    if (status) bindInstanceText(status, reply.error);
    toast(message);
    return null;
  } catch (error) {
    const source = error instanceof Error ? error.message : String(error);
    const message = instanceTranslatedText(source);
    if (status) bindInstanceText(status, source);
    toast(message);
    return null;
  }
}

function applyInstanceProfiles(snapshot: InstanceProfilesSnapshot): void {
  if (!snapshot || !Array.isArray(snapshot.profiles)) return;
  instanceProfilesGeneration++;
  instanceProfiles = snapshot;
  refreshComposerTarget();
  refreshComposerDrafts();
  if (!managedInstanceId || !snapshot.profiles.some(profile => profile.id === managedInstanceId)) {
    managedInstanceId = snapshot.profiles.find(profile => profile.id === snapshot.activeProfileId)?.id
      ?? snapshot.profiles[0]?.id
      ?? null;
  }
  paintInstanceSwitcher();
  paintInstanceManager();
  paintQueuedUpdate();
}

/**
 * Global projection of the existing lifecycle Drain used by app updates.
 *
 * The account manager retains its detailed lifecycle controls, but an update can take minutes
 * while turns, tools and workers settle. Keep that fact visible in the ordinary workspace so a
 * queued update never looks like a dead Install click or invites a duplicate request.
 */
function paintQueuedUpdate(): void {
  const drain = instanceProfiles?.drain;
  const notice = $('updateQueueNotice');
  const queued = drain?.kind === 'update' || drain?.kind === 'shutdown';
  notice.hidden = !queued;
  notice.className = `notice update-queue-notice${queued ? ` is-${drain.state}` : ''}`;
  if (!queued) {
    for (const id of ['updateInstall', 'installUpdate']) $<HTMLButtonElement>(id).disabled = false;
    setUpdateButtonLabels(false);
    return;
  }

  const external = drain.kind === 'shutdown';
  const title = drain.state === 'applying'
    ? external ? t('Ready for external updater') : t('Installing update…')
    : drain.state === 'ready'
      ? t('Update is ready to restart')
      : external ? t('Safe update shutdown queued · finishing current work') : t('Update queued · finishing current work');
  const detail = drain.detail
    ? instanceTranslatedText(drain.detail)
    : drain.pendingOperations > 0
      ? t('{0} active operation(s) still finishing. New chats and automation are on hold.', [drain.pendingOperations])
      : t('All accepted work is settling. Chat On Steroids will restart automatically when it is safe.');
  ui($('updateQueueTitle'), 'textContent', () => title);
  ui($('updateQueueDetail'), 'textContent', () => detail);
  const cancel = $<HTMLButtonElement>('updateQueueCancel');
  cancel.hidden = drain.state === 'applying';
  cancel.disabled = instanceProfileBusy;

  const active = drain.state === 'draining' || drain.state === 'ready' || drain.state === 'applying';
  for (const id of ['updateInstall', 'installUpdate']) {
    const button = $<HTMLButtonElement>(id);
    button.disabled = active;
  }
  setUpdateButtonLabels(active);
}

function setUpdateButtonLabels(queued: boolean): void {
  ui($('updateInstall'), 'textContent', () => queued ? t('Update queued') : t('Queue update'));
  const headerLabel = $('installUpdate').querySelector<HTMLElement>('span');
  if (headerLabel) ui(headerLabel, 'textContent', () => queued ? t('Update queued') : t('Queue update'));
}

function instanceMenuItems(): HTMLButtonElement[] {
  return [...$('instanceSwitcherMenu').querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)')];
}

function closeInstanceMenu(restoreFocus = false): void {
  const menu = $('instanceSwitcherMenu');
  menu.hidden = true;
  $('instanceSwitcher').setAttribute('aria-expanded', 'false');
  if (restoreFocus) $<HTMLButtonElement>('instanceSwitcher').focus();
}

function openInstanceMenu(focus: 'none' | 'first' | 'last' | 'active' = 'none'): void {
  const menu = $('instanceSwitcherMenu');
  menu.hidden = false;
  $('instanceSwitcher').setAttribute('aria-expanded', 'true');
  void refreshInstanceProfiles();
  if (focus === 'none') return;
  window.requestAnimationFrame(() => {
    const items = instanceMenuItems();
    const target = focus === 'last'
      ? items.at(-1)
      : focus === 'active'
        ? items.find(item => item.dataset.instanceId === instanceProfiles?.activeProfileId) ?? items[0]
        : items[0];
    target?.focus();
  });
}

function paintInstanceSwitcher(): void {
  const active = activeInstanceProfile();
  const name = $('instanceSwitcherName');
  const meta = $('instanceSwitcherMeta');
  const health = $('instanceSwitcherHealth');
  health.className = 'instance-health-dot';
  if (!active) {
    ui(name, 'textContent', () => t('Accounts & devices'));
    ui(meta, 'textContent', () => instanceProfiles ? t('No active profile') : t('Loading account…'));
  } else {
    name.textContent = active.nickname;
    name.translate = false;
    ui(meta, 'textContent', () => `${t(instancePlatformLabel(active))} · ${instanceConnectionText(active)}`);
    const tone = instanceHealthTone(active);
    if (tone) health.classList.add(tone);
  }
  const signInNotice = $('instanceSignInNotice');
  const signedOut = active?.browserAuth === 'signed-out';
  signInNotice.hidden = !signedOut;
  ui($('instanceSignInNoticeText'), 'textContent', () => signedOut
    ? `${active!.nickname} is signed out. Queued browser work is preserved until sign-in is verified.`
    : '');
  const signInButton = $<HTMLButtonElement>('instanceSignInNoticeButton');
  ui(signInButton, 'textContent', () => signedOut ? `Sign in to ${active!.nickname}` : '');
  signInButton.disabled = instanceProfileBusy || !signedOut;

  const menu = $('instanceSwitcherProfiles');
  const focusedId = document.activeElement instanceof HTMLElement ? document.activeElement.dataset.instanceId : null;
  const wasOpen = !$('instanceSwitcherMenu').hidden;
  const rows = (instanceProfiles?.profiles ?? []).map((profile, index) => {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'instance-switcher-option';
    row.setAttribute('role', 'menuitem');
    row.dataset.instanceId = profile.id;
    row.disabled = instanceProfileBusy || !profile.enabled;
    row.setAttribute('aria-current', String(profile.id === instanceProfiles?.activeProfileId));
    const dot = el('span', `instance-health-dot${instanceHealthTone(profile) ? ` ${instanceHealthTone(profile)}` : ''}`);
    dot.setAttribute('aria-hidden', 'true');
    const copy = el('span', 'instance-switcher-option-copy');
    copy.append(
      el('strong', '', `${index + 1}. ${profile.nickname}`),
      el('span', '', () => `${t(instancePlatformLabel(profile))} · ${instanceConnectionText(profile)} · ${profile.browserProfileDirectory}`)
    );
    const counts = el('span', 'instance-switcher-counts');
    ui(counts, 'textContent', () => profile.activeWorkers !== null && profile.queuedWorkers !== null &&
      (profile.activeWorkers > 0 || profile.queuedWorkers > 0)
      ? t('{0} active · {1} queued', [profile.activeWorkers, profile.queuedWorkers])
      : '');
    row.append(dot, copy, counts);
    row.addEventListener('click', () => {
      closeInstanceMenu();
      if (profile.active || instanceProfileBusy) return;
      void (async () => {
        instanceProfileBusy = true;
        paintInstanceSwitcher();
        try {
          const next = await instanceAction(api.launchInstanceRuntime(profile.id));
          if (next) applyInstanceProfiles(next);
        } finally {
          instanceProfileBusy = false;
          paintInstanceSwitcher();
        }
      })();
    });
    return row;
  });
  menu.replaceChildren(...rows);
  if (wasOpen && focusedId) window.requestAnimationFrame(() =>
    [...menu.querySelectorAll<HTMLButtonElement>('[data-instance-id]')]
      .find(item => item.dataset.instanceId === focusedId)?.focus());
  $<HTMLButtonElement>('instanceManageProfiles').disabled = instanceProfileBusy || !instanceProfiles?.profiles.length;
  $<HTMLButtonElement>('instanceAddProfile').disabled = instanceProfileBusy || instanceProfiles?.canManageProfiles === false;
}

function selectedManagedInstance(): InstanceProfileView | null {
  if (!instanceProfiles) return null;
  return instanceProfiles.profiles.find(profile => profile.id === managedInstanceId)
    ?? activeInstanceProfile()
    ?? instanceProfiles.profiles[0]
    ?? null;
}

function paintInstanceManager(): void {
  const dialog = $<HTMLDialogElement>('instanceProfilesDialog');
  if (!dialog.open && !instanceProfiles) return;
  $<HTMLButtonElement>('instanceManagerAdd').disabled = instanceProfileBusy || instanceProfiles?.canManageProfiles === false;
  const list = $('instanceProfilesList');
  const selected = selectedManagedInstance();
  if (selected && managedInstanceId !== selected.id) managedInstanceId = selected.id;
  list.replaceChildren(...(instanceProfiles?.profiles ?? []).map((profile, index) => {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'instance-profile-row';
    row.dataset.instanceId = profile.id;
    row.setAttribute('role', 'option');
    row.setAttribute('aria-selected', String(profile.id === selected?.id));
    row.tabIndex = profile.id === selected?.id ? 0 : -1;
    const badge = el('span', 'instance-platform-badge', () => t(instancePlatformLabel(profile)));
    row.append(el('strong', '', `${index + 1}. ${profile.nickname}`), badge, el('small', '', () => `${instanceConnectionText(profile)} · ${profile.browserProfileDirectory}`));
    row.addEventListener('click', () => { managedInstanceId = profile.id; $('instanceProfilesStatus').textContent = ''; paintInstanceManager(); });
    row.addEventListener('keydown', event => {
      if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      const rows = [...list.querySelectorAll<HTMLButtonElement>('.instance-profile-row')];
      const index = rows.indexOf(row);
      const target = event.key === 'Home' ? rows[0]
        : event.key === 'End' ? rows.at(-1)
          : rows[Math.min(rows.length - 1, Math.max(0, index + (event.key === 'ArrowDown' ? 1 : -1)))];
      if (target) {
        const targetId = target.dataset.instanceId ?? null;
        managedInstanceId = targetId;
        paintInstanceManager();
        [...list.querySelectorAll<HTMLButtonElement>('[data-instance-id]')]
          .find(item => item.dataset.instanceId === targetId)?.focus();
      }
    });
    return row;
  }));

  const detail = $('instanceProfileDetail');
  detail.hidden = !selected;
  if (!selected) return;
  const canManage = instanceProfiles?.canManageProfiles !== false;
  $('instanceProfileDetailTitle').textContent = selected.nickname;
  ui($('instanceProfilePlatform'), 'textContent', () => t(instancePlatformLabel(selected)));
  const connection = $('instanceProfileConnection');
  ui(connection, 'textContent', () => instanceConnectionText(selected));
  const connectionTone = instanceHealthTone(selected);
  connection.className = `instance-connection-pill${connectionTone ? ` ${connectionTone}` : ''}`;
  connection.title = selected.connection.detail ?? '';
  const nickname = $<HTMLInputElement>('instanceProfileNickname');
  if (document.activeElement !== nickname || nickname.dataset.instanceId !== selected.id) nickname.value = selected.nickname;
  nickname.dataset.instanceId = selected.id;
  const browserInput = $<HTMLInputElement>('instanceProfileBrowser');
  const browserUnbound = selected.browserProfileDirectory === 'Current Chrome profile (legacy)';
  if (document.activeElement !== browserInput || browserInput.dataset.instanceId !== selected.id) {
    browserInput.value = browserUnbound ? '' : selected.browserProfileDirectory;
  }
  browserInput.dataset.instanceId = selected.id;
  browserInput.disabled = instanceProfileBusy || !canManage || selected.runtimePrepared || selected.runtimeRunning && !selected.active || (selected.active && !browserUnbound);
  const browserSave = $<HTMLButtonElement>('instanceProfileBrowserSave');
  browserSave.disabled = browserInput.disabled || !browserInput.value.trim() || browserInput.value.trim() === selected.browserProfileDirectory;
  browserSave.title = selected.runtimePrepared ? 'This account already has private settings and browser pairing; its Chrome binding cannot be changed from the primary window.'
    : selected.active && !browserUnbound ? 'Switch to another account before changing this browser binding.' : '';
  const tunnelInput = $<HTMLInputElement>('instanceCoreTunnel');
  const tunnelId = selected.coreTunnelId ?? '';
  if (document.activeElement !== tunnelInput || tunnelInput.dataset.instanceId !== selected.id) tunnelInput.value = tunnelId;
  tunnelInput.dataset.instanceId = selected.id;
  tunnelInput.disabled = instanceProfileBusy || !canManage || selected.runtimePrepared || selected.runtimeRunning && !selected.active;
  tunnelInput.placeholder = selected.coreTunnelId === null ? 'Check this account window' : 'tunnel_…';
  tunnelInput.title = selected.runtimePrepared
    ? 'This account owns private connector settings after first launch. Check or edit them in its own COS window.' : '';
  $<HTMLButtonElement>('instanceCoreTunnelSave').disabled = tunnelInput.disabled || tunnelInput.value.trim() === tunnelId;
  const keyInput = $<HTMLInputElement>('instanceCoreApiKey');
  if (keyInput.dataset.instanceId !== selected.id) keyInput.value = '';
  keyInput.dataset.instanceId = selected.id;
  keyInput.disabled = instanceProfileBusy || !canManage || selected.runtimePrepared || selected.runtimeRunning && !selected.active || state?.secureStorage?.available === false;
  keyInput.title = selected.runtimePrepared ? 'Edit this account’s runtime key in its own COS window after first launch.' : '';
  ui($('instanceCoreApiKeyStatus'), 'textContent', () => selected.hasRuntimeApiKey === null
    ? t('Check this account window') : selected.hasRuntimeApiKey ? t('Key stored securely') : t('No key stored'));
  $<HTMLButtonElement>('instanceCoreApiKeySave').disabled = keyInput.disabled || !keyInput.value.trim();
  $<HTMLButtonElement>('instanceCoreApiKeyClear').disabled = keyInput.disabled || !selected.hasRuntimeApiKey;
  $('instanceActiveWorkers').textContent = selected.activeWorkers === null ? '—' : String(selected.activeWorkers);
  $('instanceQueuedWorkers').textContent = selected.queuedWorkers === null ? '—' : String(selected.queuedWorkers);

  const switchButton = $<HTMLButtonElement>('instanceProfileSwitch');
  switchButton.disabled = instanceProfileBusy || !canManage || selected.active || selected.id === instanceProfiles?.activeProfileId || !selected.enabled;
  ui(switchButton, 'textContent', () => selected.active || selected.id === instanceProfiles?.activeProfileId ? t('Active profile') : t('Switch to profile'));
  const runButton = $<HTMLButtonElement>('instanceProfileRunAlongside');
  runButton.disabled = instanceProfileBusy || !canManage || selected.active || selected.runtimeMode !== 'isolated' || !selected.enabled ||
    selected.browserProfileDirectory === 'Current Chrome profile (legacy)';
  ui(runButton, 'textContent', () => selected.runtimeRunning ? t('Open account window') : t('Run alongside'));
  ui(runButton, 'title', () => selected.active ? t('This account already owns the current window.')
    : selected.runtimeMode !== 'isolated' ? t('The migrated main account runs in the primary COS window.')
      : selected.runtimeRunning ? t('Bring this running account window to the front without stopping its chats.')
      : t('Start this account in its own COS and Chrome profile without stopping current chats.'));
  $<HTMLButtonElement>('instanceProfileRename').disabled = instanceProfileBusy || !canManage || selected.runtimePrepared || selected.runtimeRunning && !selected.active || nickname.value.trim() === '';
  const enabled = $<HTMLButtonElement>('instanceProfileEnabled');
  enabled.disabled = instanceProfileBusy || !canManage || selected.runtimeRunning && !selected.active || (selected.active && selected.enabled);
  enabled.setAttribute('aria-pressed', String(selected.enabled));
  ui(enabled, 'textContent', () => selected.enabled ? t('Disable profile') : t('Enable profile'));
  ui(enabled, 'title', () => selected.active && selected.enabled ? t('Switch to another profile before disabling this one.') : '');
  const openBrowser = $<HTMLButtonElement>('instanceProfileOpenBrowser');
  openBrowser.disabled = instanceProfileBusy;
  ui(openBrowser, 'textContent', () => selected.active && selected.browserAuth === 'signed-out'
    ? `Sign in to ${selected.nickname}`
    : t('Link ChatGPT account'));
  $<HTMLButtonElement>('instanceProfileRemove').disabled = instanceProfileBusy || !canManage || selected.runtimeRunning || (instanceProfiles?.profiles.length ?? 0) <= 1;

  const pending = $('instancePendingOperations');
  pending.hidden = selected.pendingOperations.length === 0;
  ui(pending, 'textContent', () => selected.pendingOperations.length
    ? `${t('Pending operations')}: ${selected.pendingOperations.map(operation => operation.status
      ? t('{0} ({1})', [instanceTranslatedText(operation.label), instanceTranslatedText(operation.status)])
      : instanceTranslatedText(operation.label)).join(' · ')}`
    : '');

  $('instanceConnectorName').textContent = selected.connector.displayName || '—';
  $('instanceConnectorDescription').textContent = selected.connector.description || '—';
  $('instanceConnectorUrl').textContent = selected.connector.mcpUrl || '—';
  ui($('instanceConnectorStatus'), 'textContent', () => selected.connection.state === 'offline' ? t('Waiting for Core')
    : selected.connection.state === 'error' ? t('Needs attention')
      : selected.connector.status === 'live' ? t('Connected')
        : selected.connector.status === 'starting' ? t('Recovering')
          : selected.connector.status === 'error' ? t('Needs attention')
            : selected.connector.status === 'unknown' ? t('Running in another window') : t('Off'));
  ui($('instanceConnectorLastRequest'), 'textContent', () => ago(selected.connector.lastSuccessfulRequestAt));
  const connectorError = $('instanceConnectorError');
  connectorError.hidden = !selected.connector.error || selected.connection.state === 'offline';
  ui(connectorError, 'textContent', () => selected.connector.error ? instanceTranslatedText(selected.connector.error) : '');
  $<HTMLButtonElement>('instanceCopyConnectorSetup').disabled = instanceProfileBusy;
  const reconnect = $<HTMLButtonElement>('instanceReconnectConnector');
  reconnect.disabled = instanceProfileBusy || selected.id !== instanceProfiles?.activeProfileId || !selected.enabled;
  ui(reconnect, 'title', () => selected.id === instanceProfiles?.activeProfileId ? '' : t('Switch to this profile before reconnecting its connector.'));

  const drain = instanceProfiles?.drain;
  const drainBox = $('instanceDrain');
  drainBox.hidden = !drain || (drain.state === 'idle' && drain.pendingOperations === 0);
  if (drain && !drainBox.hidden) {
    ui($('instanceDrainDetail'), 'textContent', () => drain.detail
      ? instanceTranslatedText(drain.detail)
      : t('{0} pending operation(s)', [drain.pendingOperations]));
    $<HTMLButtonElement>('instanceDrainStart').hidden = drain.state !== 'idle' && drain.state !== 'error';
    $<HTMLButtonElement>('instanceDrainCancel').hidden = drain.state === 'idle' || drain.state === 'applying';
    $<HTMLButtonElement>('instanceDrainApply').hidden = drain.state !== 'ready';
    for (const button of drainBox.querySelectorAll<HTMLButtonElement>('button')) button.disabled = instanceProfileBusy;
  }
}

async function refreshInstanceProfiles(): Promise<void> {
  const generation = ++instanceProfilesGeneration;
  const next = await instanceAction(api.getInstanceProfiles());
  if (next && generation === instanceProfilesGeneration) applyInstanceProfiles(next);
}

function openInstanceManager(profileId?: string, returnFocus: HTMLElement | null = document.activeElement as HTMLElement | null): void {
  void refreshInstanceProfiles();
  if (profileId && instanceProfiles?.profiles.some(profile => profile.id === profileId)) managedInstanceId = profileId;
  else if (!managedInstanceId) managedInstanceId = instanceProfiles?.activeProfileId ?? null;
  closeInstanceMenu();
  instanceManagerReturnFocus = returnFocus;
  paintInstanceManager();
  const dialog = $<HTMLDialogElement>('instanceProfilesDialog');
  if (!dialog.open) dialog.showModal();
  void api.listInstanceBrowserProfiles().then(result => {
    if (!dialog.open || !result.ok) return;
    $<HTMLDataListElement>('instanceProfileBrowserChoices').replaceChildren(...result.data.map(directory => {
      const option = document.createElement('option');
      option.value = directory;
      return option;
    }));
  }).catch(() => undefined);
  window.requestAnimationFrame(() => dialog.querySelector<HTMLButtonElement>('.instance-profile-row[aria-selected="true"]')?.focus());
}

function openInstanceCreate(returnFocus: HTMLElement | null = document.activeElement as HTMLElement | null): void {
  closeInstanceMenu();
  instanceCreateReturnFocus = returnFocus;
  $('instanceCreateStatus').textContent = '';
  $<HTMLInputElement>('instanceCreateNickname').value = '';
  $<HTMLInputElement>('instanceCreateBrowser').value = '';
  const dialog = $<HTMLDialogElement>('instanceCreateDialog');
  dialog.showModal();
  const suggestions = $<HTMLDataListElement>('instanceCreateBrowserProfiles');
  suggestions.replaceChildren();
  void api.listInstanceBrowserProfiles().then(result => {
    if (!dialog.open || !result.ok) return;
    suggestions.replaceChildren(...result.data.map(directory => {
      const option = document.createElement('option');
      option.value = directory;
      return option;
    }));
  }).catch(() => undefined);
  $<HTMLInputElement>('instanceCreateNickname').focus();
}

async function requestInstanceSwitch(id: string, returnFocus: HTMLElement | null = document.activeElement as HTMLElement | null): Promise<void> {
  const profile = instanceProfiles?.profiles.find(row => row.id === id);
  if (!profile || profile.id === instanceProfiles?.activeProfileId || instanceProfileBusy || !profile.enabled) return;
  instanceProfileBusy = true;
  ui($('instanceProfilesStatus'), 'textContent', () => t('Checking current work before switching…'));
  paintInstanceSwitcher(); paintInstanceManager();
  try {
    const result = await instanceAction(api.switchInstanceProfile(id, 'check'), $('instanceProfilesStatus'));
    if (!result) return;
    applyInstanceProfiles(result.snapshot);
    if (result.outcome === 'switched') {
      const source = result.message ?? 'Profile switched.';
      bindInstanceText($('instanceProfilesStatus'), source);
      toast(instanceTranslatedText(source));
      closeInstanceMenu();
    } else if (result.outcome === 'needs-drain') {
      pendingInstanceSwitchId = id;
      instanceSwitchReturnFocus = returnFocus;
      bindInstanceText($('instanceSwitchMessage'), result.message ?? 'This profile can switch after its current work finishes.');
      const dialog = $<HTMLDialogElement>('instanceSwitchDialog');
      dialog.showModal();
      $<HTMLButtonElement>('instanceSwitchAfterWork').focus();
    } else {
      const source = result.message ?? (result.outcome === 'queued' ? 'Profile switch queued after current work.' : 'Profile switch is blocked.');
      bindInstanceText($('instanceProfilesStatus'), source);
      toast(instanceTranslatedText(source));
    }
  } finally {
    instanceProfileBusy = false;
    paintInstanceSwitcher(); paintInstanceManager();
  }
}

async function queueInstanceSwitchAfterWork(): Promise<void> {
  const id = pendingInstanceSwitchId;
  if (!id || instanceProfileBusy) return;
  instanceProfileBusy = true;
  try {
    const result = await instanceAction(api.switchInstanceProfile(id, 'after-work'), $('instanceProfilesStatus'));
    if (!result) return;
    applyInstanceProfiles(result.snapshot);
    const source = result.message ?? (result.outcome === 'switched' ? 'Profile switched.' : 'Profile switch queued after current work.');
    bindInstanceText($('instanceProfilesStatus'), source);
    toast(instanceTranslatedText(source));
    pendingInstanceSwitchId = null;
    $<HTMLDialogElement>('instanceSwitchDialog').close();
  } finally {
    instanceProfileBusy = false;
    paintInstanceSwitcher(); paintInstanceManager();
  }
}

// ------------------------------------------------------------------- tabs

function showTab(name: string): void {
  const settings = name !== 'chat';
  document.querySelector<HTMLElement>('.app')!.dataset.screen = settings ? 'settings' : 'chat';
  document.querySelector<HTMLElement>('.sidebar-brand')!.hidden = settings;
  $('workspaceSettings').hidden = settings;
  if (name === 'usage') void refreshUsage();
  if (settings && state && (state.update.checkedAt === null || Date.now() - state.update.checkedAt > 10 * 60_000)) {
    // Settings is where an outdated answer matters most. The updater deduplicates concurrent
    // checks, so opening another settings page during the same pass costs nothing extra.
    void run(api.refreshUpdate()).then(update => {
      if (!update || !state) return;
      state = { ...state, update };
      paintUpdate(state);
    });
  }
  $('tabs').hidden = !settings;
  $('backToChat').hidden = !settings;
  $('settingsFindHost').hidden = !settings;
  document.querySelector<HTMLElement>('.sidebar-sessions')!.hidden = settings;
  $('newChat').hidden = settings;
  if (name === 'settings') openChatView('settings');
  else if (name === 'chat') openChatView('timeline');

  for (const tab of document.querySelectorAll<HTMLElement>('nav button')) {
    tab.classList.toggle('is-sel', tab.dataset.tab === name);
  }
  for (const panel of document.querySelectorAll<HTMLElement>('.panel')) {
    panel.classList.toggle('is-active', panel.dataset.panel === (name === 'settings' ? 'chat' : name));
  }
  // The Chat panel is the only one that costs anything to keep fresh, so it only
  // reloads while it is on screen.
  chatVisible(name === 'chat' || name === 'settings');
  // A feed that was appended to while its panel was hidden could not be scrolled then —
  // a hidden element has no scroll height. Pin it now that it has one, so a panel always
  // opens on the newest line rather than on whatever was oldest in the buffer.
  for (const id of FEEDS) stickToNewest(id);
}

initSettingsSearch({
  open: showTab,
  settingsShown: () => document.querySelector<HTMLElement>('.app')?.dataset.screen === 'settings'
});

$('backToChat').addEventListener('click', () => showTab('chat'));
$('workspaceSettings').addEventListener('click', () => showTab('home'));
$('chatSettingsBtn').addEventListener('click', () => showTab('settings'));
$('newChat').addEventListener('click', () => showTab('chat'));
$('composerFolder').addEventListener('click', () => $('addProject').click());
let zoomFactor = 1;
let zoomEdited = false;
let zoomPending = false;
let zoomApplying = false;
let zoomTimer: number | undefined;
void api.getZoom().then(result => {
  if (zoomEdited || !result.ok || typeof result.data !== 'number' || !Number.isFinite(result.data)) return;
  zoomFactor = result.data;
  $('zoomReset').textContent = `${Math.round(zoomFactor * 100)}%`;
});

// Forty percent remains readable enough to recover through the View menu while allowing the
// dense multi-profile/session views the user asked for. IPC enforces the same hard boundary.
const normalizedZoom = (value: number): number => Math.round(Math.min(1.5, Math.max(.4, value)) * 20) / 20;

/**
 * Applies only the newest requested whole-window zoom and preserves the logical chat row.
 *
 * Rapid wheel/keyboard input used to start overlapping IPC calls, all calculated from the same
 * stale factor. Their out-of-order layouts made the transcript jump and could make ten wheel
 * ticks look like one. Keep the target local immediately, collapse each burst, then anchor the
 * timeline across the one BrowserWindow reflow that actually lands.
 */
async function flushZoom(): Promise<void> {
  if (zoomApplying) return;
  zoomApplying = true;
  try {
    while (zoomPending) {
      zoomPending = false;
      const requested = zoomFactor;
      const pane = document.getElementById('chatBody');
      const timeline = document.getElementById('timeline');
      const selectedBefore = document.querySelector<HTMLElement>('.sess.is-sel[data-id]')?.dataset.id ?? null;
      const restore = pane && timeline ? preserveTimelineViewport(pane, timeline, false) : () => undefined;
      const result = await run(api.setZoom(requested));
      if (result !== null && requested === zoomFactor) {
        zoomFactor = result;
        $('zoomReset').textContent = `${Math.round(result * 100)}%`;
      }
      // Electron resolves after accepting the factor; Chromium can finish the layout on the
      // next frame. Restore after two frames so the row, not a stale scrollTop, stays in view.
      await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
      const selectedAfter = document.querySelector<HTMLElement>('.sess.is-sel[data-id]')?.dataset.id ?? null;
      // Restore every accepted reflow in a rapid burst. Otherwise the first factor could move
      // the transcript before the second iteration captures its anchor. A real chat selection
      // change wins and is never scrolled back to the prior chat's position.
      if (selectedAfter === selectedBefore) restore();
    }
  } finally {
    zoomApplying = false;
  }
}

function zoom(next: number): void {
  zoomEdited = true;
  zoomFactor = normalizedZoom(next);
  $('zoomReset').textContent = `${Math.round(zoomFactor * 100)}%`;
  zoomPending = true;
  window.clearTimeout(zoomTimer);
  zoomTimer = window.setTimeout(() => { zoomTimer = undefined; void flushZoom(); }, 60);
}
$('zoomOut').addEventListener('click', () => zoom(zoomFactor - .1));
$('zoomIn').addEventListener('click', () => zoom(zoomFactor + .1));
$('zoomActualSize').addEventListener('click', () => zoom(1));
document.addEventListener('keydown', (event) => {
  if (!(event.ctrlKey || event.metaKey) || !['+', '=', '-', '0'].includes(event.key)) return;
  event.preventDefault(); zoom(event.key === '0' ? 1 : zoomFactor + (event.key === '-' ? -.1 : .1));
});
// Trackpads report pinch as Ctrl+wheel and mice can generate many wheel events per frame.
// Own that gesture at the window boundary so Chromium never zooms whichever nested pane happens
// to be under the pointer. A threshold turns a physical notch/pinch step into one stable target.
let zoomWheelDelta = 0;
window.addEventListener('wheel', (event) => {
  if (!(event.ctrlKey || event.metaKey)) return;
  event.preventDefault(); event.stopImmediatePropagation();
  zoomWheelDelta += event.deltaY;
  if (Math.abs(zoomWheelDelta) < 32) return;
  zoom(zoomFactor + (zoomWheelDelta < 0 ? .05 : -.05));
  zoomWheelDelta = 0;
}, { capture: true, passive: false });
$('tabs').addEventListener('click', (event) => {
  const button = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-tab]');
  if (button?.dataset.tab) showTab(button.dataset.tab);
});

// -------------------------------------------------------- accounts / devices

$('instanceSwitcher').addEventListener('click', () => {
  if ($('instanceSwitcherMenu').hidden) openInstanceMenu();
  else closeInstanceMenu();
});
$('instanceSwitcher').addEventListener('keydown', event => {
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault();
    openInstanceMenu(event.key === 'ArrowDown' ? 'active' : 'last');
  } else if (event.key === 'Escape' && !$('instanceSwitcherMenu').hidden) {
    event.preventDefault(); closeInstanceMenu(true);
  }
});
$('instanceSwitcherMenu').addEventListener('keydown', event => {
  if (event.key === 'Escape') { event.preventDefault(); closeInstanceMenu(true); return; }
  if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
  const items = instanceMenuItems();
  if (!items.length) return;
  event.preventDefault();
  const current = document.activeElement instanceof HTMLButtonElement ? items.indexOf(document.activeElement) : -1;
  const next = event.key === 'Home' ? 0
    : event.key === 'End' ? items.length - 1
      : event.key === 'ArrowDown' ? (current + 1 + items.length) % items.length
        : (current - 1 + items.length) % items.length;
  items[next]?.focus();
});
document.addEventListener('pointerdown', event => {
  if ($('instanceSwitcherMenu').hidden) return;
  const target = event.target as Node | null;
  if (target && ($('instanceSwitcherMenu').contains(target) || $('instanceSwitcher').contains(target))) return;
  closeInstanceMenu();
});

$('instanceManageProfiles').addEventListener('click', () => openInstanceManager(undefined, $<HTMLButtonElement>('instanceSwitcher')));
$('instanceAddProfile').addEventListener('click', () => openInstanceCreate($<HTMLButtonElement>('instanceSwitcher')));
$('instanceManagerAdd').addEventListener('click', () => openInstanceCreate($<HTMLButtonElement>('instanceManagerAdd')));
$('instanceProfilesClose').addEventListener('click', () => $<HTMLDialogElement>('instanceProfilesDialog').close());
$('instanceProfilesDialog').addEventListener('close', () => {
  const target = instanceManagerReturnFocus;
  instanceManagerReturnFocus = null;
  if (target?.isConnected) target.focus();
});

$('instanceCreateCancel').addEventListener('click', () => $<HTMLDialogElement>('instanceCreateDialog').close());
$('instanceCreateDialog').addEventListener('close', () => {
  const target = instanceCreateReturnFocus;
  instanceCreateReturnFocus = null;
  if (target?.isConnected) target.focus();
});
$('instanceCreateForm').addEventListener('submit', event => {
  event.preventDefault();
  void (async () => {
    if (instanceProfileBusy) return;
    const nickname = $<HTMLInputElement>('instanceCreateNickname').value.trim();
    const browserProfileDirectory = $<HTMLInputElement>('instanceCreateBrowser').value.trim();
    if (!nickname || !browserProfileDirectory) return;
    const before = new Set(instanceProfiles?.profiles.map(profile => profile.id) ?? []);
    instanceProfileBusy = true;
    ui($('instanceCreateStatus'), 'textContent', () => t('Creating profile…'));
    paintInstanceSwitcher(); paintInstanceManager();
    try {
      const next = await instanceAction(api.createInstanceProfile(nickname, browserProfileDirectory), $('instanceCreateStatus'));
      if (!next) return;
      applyInstanceProfiles(next);
      const created = next.profiles.find(profile => !before.has(profile.id))
        ?? next.profiles.find(profile => profile.nickname === nickname && profile.browserProfileDirectory === browserProfileDirectory);
      if (created) managedInstanceId = created.id;
      $('instanceCreateStatus').textContent = '';
      $<HTMLDialogElement>('instanceCreateDialog').close();
      toast(t('Profile added.'));
      if (!$<HTMLDialogElement>('instanceProfilesDialog').open) openInstanceManager(created?.id, $<HTMLButtonElement>('instanceSwitcher'));
      else paintInstanceManager();
    } finally {
      instanceProfileBusy = false;
      paintInstanceSwitcher(); paintInstanceManager();
    }
  })();
});

$('instanceProfileNickname').addEventListener('input', () => {
  $<HTMLButtonElement>('instanceProfileRename').disabled = instanceProfileBusy || !$<HTMLInputElement>('instanceProfileNickname').value.trim();
});
$('instanceProfileBrowser').addEventListener('input', () => {
  const profile = selectedManagedInstance();
  const input = $<HTMLInputElement>('instanceProfileBrowser');
  $<HTMLButtonElement>('instanceProfileBrowserSave').disabled = input.disabled || !profile ||
    !input.value.trim() || input.value.trim() === profile.browserProfileDirectory;
});
$('instanceCoreTunnel').addEventListener('input', () => {
  const profile = selectedManagedInstance();
  $<HTMLButtonElement>('instanceCoreTunnelSave').disabled = instanceProfileBusy || !profile ||
    $<HTMLInputElement>('instanceCoreTunnel').value.trim() === (profile.coreTunnelId ?? '');
});
$('instanceCoreApiKey').addEventListener('input', () => {
  $<HTMLButtonElement>('instanceCoreApiKeySave').disabled = instanceProfileBusy ||
    !$<HTMLInputElement>('instanceCoreApiKey').value.trim();
});
$('instanceCoreTunnelSave').addEventListener('click', () => {
  void (async () => {
    const profile = selectedManagedInstance();
    if (!profile || instanceProfileBusy) return;
    const tunnelId = $<HTMLInputElement>('instanceCoreTunnel').value.trim();
    if (tunnelId && !TUNNEL_ID_PATTERN.test(tunnelId)) {
      $('instanceProfilesStatus').textContent = 'Enter a valid tunnel_ ID with 32 hexadecimal characters.';
      return;
    }
    instanceProfileBusy = true;
    try {
      const next = await instanceAction(api.setInstanceCoreTunnel(profile.id, tunnelId), $('instanceProfilesStatus'));
      if (next) { applyInstanceProfiles(next); $('instanceProfilesStatus').textContent = 'Core tunnel saved for this account.'; }
    } finally { instanceProfileBusy = false; paintInstanceSwitcher(); paintInstanceManager(); }
  })();
});
for (const [buttonId, clear] of [['instanceCoreApiKeySave', false], ['instanceCoreApiKeyClear', true]] as const) {
  $(buttonId).addEventListener('click', () => {
    void (async () => {
      const profile = selectedManagedInstance();
      if (!profile || instanceProfileBusy) return;
      const input = $<HTMLInputElement>('instanceCoreApiKey');
      const value = clear ? '' : input.value.trim();
      if (!clear && !value) return;
      instanceProfileBusy = true;
      try {
        const next = await instanceAction(api.setInstanceRuntimeApiKey(profile.id, value), $('instanceProfilesStatus'));
        if (next) {
          input.value = '';
          applyInstanceProfiles(next);
          $('instanceProfilesStatus').textContent = clear ? 'Runtime key cleared.' : 'Runtime key stored securely.';
        }
      } finally { instanceProfileBusy = false; paintInstanceSwitcher(); paintInstanceManager(); }
    })();
  });
}
$('instanceProfileRename').addEventListener('click', () => {
  void (async () => {
    const profile = selectedManagedInstance();
    const nickname = $<HTMLInputElement>('instanceProfileNickname').value.trim();
    if (!profile || !nickname || instanceProfileBusy) return;
    if (nickname === profile.nickname) { ui($('instanceProfilesStatus'), 'textContent', () => t('Nickname is already up to date.')); return; }
    instanceProfileBusy = true; ui($('instanceProfilesStatus'), 'textContent', () => t('Saving nickname…')); paintInstanceManager();
    try {
      const next = await instanceAction(api.renameInstanceProfile(profile.id, nickname), $('instanceProfilesStatus'));
      if (!next) return;
      applyInstanceProfiles(next); ui($('instanceProfilesStatus'), 'textContent', () => t('Nickname saved.'));
    } finally { instanceProfileBusy = false; paintInstanceSwitcher(); paintInstanceManager(); }
  })();
});
$('instanceProfileBrowserSave').addEventListener('click', () => {
  void (async () => {
    const profile = selectedManagedInstance();
    const directory = $<HTMLInputElement>('instanceProfileBrowser').value.trim();
    if (!profile || (profile.active && profile.browserProfileDirectory !== 'Current Chrome profile (legacy)') ||
        !directory || instanceProfileBusy) return;
    instanceProfileBusy = true;
    $('instanceProfilesStatus').textContent = 'Checking and saving Chrome profile…';
    paintInstanceManager();
    try {
      const next = await instanceAction(api.setInstanceBrowserProfile(profile.id, directory), $('instanceProfilesStatus'));
      if (!next) return;
      applyInstanceProfiles(next);
      $('instanceProfilesStatus').textContent = 'Chrome profile binding saved. New Chrome launches will use this account.';
    } finally { instanceProfileBusy = false; paintInstanceSwitcher(); paintInstanceManager(); }
  })();
});
$('instanceProfileSwitch').addEventListener('click', () => {
  const profile = selectedManagedInstance();
  if (profile) void requestInstanceSwitch(profile.id, $<HTMLButtonElement>('instanceProfileSwitch'));
});
$('instanceProfileRunAlongside').addEventListener('click', () => {
  void (async () => {
    const profile = selectedManagedInstance();
    if (!profile || profile.active || instanceProfileBusy || !profile.enabled) return;
    instanceProfileBusy = true;
    $('instanceProfilesStatus').textContent = 'Starting this account without stopping current chats…';
    paintInstanceManager();
    try {
      const next = await instanceAction(api.launchInstanceRuntime(profile.id), $('instanceProfilesStatus'));
      if (next) {
        applyInstanceProfiles(next);
        $('instanceProfilesStatus').textContent = `${profile.nickname} is running in its own COS window. The current account was not stopped.`;
      }
    } finally { instanceProfileBusy = false; paintInstanceSwitcher(); paintInstanceManager(); }
  })();
});
$('instanceProfileEnabled').addEventListener('click', () => {
  void (async () => {
    const profile = selectedManagedInstance();
    if (!profile || instanceProfileBusy) return;
    instanceProfileBusy = true; ui($('instanceProfilesStatus'), 'textContent', () => profile.enabled ? t('Disabling profile…') : t('Enabling profile…')); paintInstanceManager();
    try {
      const next = await instanceAction(api.setInstanceProfileEnabled(profile.id, !profile.enabled), $('instanceProfilesStatus'));
      if (!next) return;
      applyInstanceProfiles(next); ui($('instanceProfilesStatus'), 'textContent', () => !profile.enabled ? t('Profile enabled.') : t('Profile disabled.'));
    } finally { instanceProfileBusy = false; paintInstanceSwitcher(); paintInstanceManager(); }
  })();
});
$('instanceProfileOpenBrowser').addEventListener('click', () => {
  void (async () => {
    const profile = selectedManagedInstance();
    if (!profile || instanceProfileBusy) return;
    const opened = await instanceAction(api.openInstanceProfileBrowser(profile.id), $('instanceProfilesStatus'));
    if (opened) {
      ui($('instanceProfilesStatus'), 'textContent', () => t('ChatGPT opened in this browser profile. Sign in there to link the account.'));
      toast(t('ChatGPT account link opened.'));
    }
  })();
});
$('instanceSignInNoticeButton').addEventListener('click', () => {
  void (async () => {
    const profile = activeInstanceProfile();
    if (!profile || profile.browserAuth !== 'signed-out' || instanceProfileBusy) return;
    const opened = await instanceAction(api.openInstanceProfileBrowser(profile.id));
    if (opened) toast(`ChatGPT opened for ${profile.nickname}. Sign in there; queued work will resume after positive login proof.`);
  })();
});
$('instanceCopyConnectorSetup').addEventListener('click', () => {
  void (async () => {
    const profile = selectedManagedInstance();
    if (!profile || instanceProfileBusy) return;
    const copied = await instanceAction(api.copyInstanceConnectorSetup(profile.id), $('instanceProfilesStatus'));
    if (copied) { ui($('instanceProfilesStatus'), 'textContent', () => t('Connector setup copied.')); toast(t('Connector setup copied.')); }
  })();
});
$('instanceReconnectConnector').addEventListener('click', () => {
  void (async () => {
    const profile = selectedManagedInstance();
    if (!profile || profile.id !== instanceProfiles?.activeProfileId || instanceProfileBusy) return;
    instanceProfileBusy = true; ui($('instanceProfilesStatus'), 'textContent', () => t('Reconnecting connector…')); paintInstanceManager();
    try {
      const next = await instanceAction(api.refreshInstanceConnector(), $('instanceProfilesStatus'));
      if (!next) return;
      applyInstanceProfiles(next); ui($('instanceProfilesStatus'), 'textContent', () => t('Connector refresh requested.'));
    } finally { instanceProfileBusy = false; paintInstanceSwitcher(); paintInstanceManager(); }
  })();
});

$('instanceProfileRemove').addEventListener('click', () => {
  const profile = selectedManagedInstance();
  if (!profile || instanceProfileBusy) return;
  instanceRemoveReturnFocus = $<HTMLButtonElement>('instanceProfileRemove');
  ui($('instanceRemoveMessage'), 'textContent', () => t('Type “{0}” to confirm removal. This removes the local profile only.', [profile.nickname]));
  $<HTMLInputElement>('instanceRemoveConfirmation').value = '';
  $('instanceRemoveStatus').textContent = '';
  const dialog = $<HTMLDialogElement>('instanceRemoveDialog');
  dialog.dataset.instanceId = profile.id;
  dialog.dataset.nickname = profile.nickname;
  dialog.showModal();
  $<HTMLInputElement>('instanceRemoveConfirmation').focus();
});
$('instanceRemoveCancel').addEventListener('click', () => $<HTMLDialogElement>('instanceRemoveDialog').close());
$('instanceRemoveDialog').addEventListener('close', () => {
  const target = instanceRemoveReturnFocus;
  instanceRemoveReturnFocus = null;
  if (target?.isConnected) target.focus();
});
$('instanceRemoveForm').addEventListener('submit', event => {
  event.preventDefault();
  void (async () => {
    const dialog = $<HTMLDialogElement>('instanceRemoveDialog');
    const id = dialog.dataset.instanceId;
    const nickname = dialog.dataset.nickname ?? '';
    const confirmation = $<HTMLInputElement>('instanceRemoveConfirmation').value.trim();
    if (!id || instanceProfileBusy) return;
    if (confirmation !== nickname) { ui($('instanceRemoveStatus'), 'textContent', () => t('The nickname does not match.')); $<HTMLInputElement>('instanceRemoveConfirmation').focus(); return; }
    instanceProfileBusy = true; ui($('instanceRemoveStatus'), 'textContent', () => t('Removing profile…')); paintInstanceManager();
    try {
      const next = await instanceAction(api.removeInstanceProfile(id, confirmation), $('instanceRemoveStatus'));
      if (!next) return;
      applyInstanceProfiles(next); dialog.close(); ui($('instanceProfilesStatus'), 'textContent', () => t('Profile removed.')); toast(t('Profile removed.'));
    } finally { instanceProfileBusy = false; paintInstanceSwitcher(); paintInstanceManager(); }
  })();
});

$('instanceSwitchCancel').addEventListener('click', () => { pendingInstanceSwitchId = null; $<HTMLDialogElement>('instanceSwitchDialog').close(); });
$('instanceSwitchAfterWork').addEventListener('click', () => void queueInstanceSwitchAfterWork());
$('instanceSwitchDialog').addEventListener('close', () => {
  pendingInstanceSwitchId = null;
  const target = instanceSwitchReturnFocus;
  instanceSwitchReturnFocus = null;
  if (target?.isConnected) target.focus();
});

for (const [id, action] of [
  ['instanceDrainStart', 'start'],
  ['instanceDrainCancel', 'cancel'],
  ['instanceDrainApply', 'apply-update']
] as const) {
  $(id).addEventListener('click', () => {
    void (async () => {
      if (instanceProfileBusy) return;
      instanceProfileBusy = true; ui($('instanceProfilesStatus'), 'textContent', () => t('Updating pending profile operation…')); paintInstanceManager();
      try {
        const next = await instanceAction(api.drainInstanceProfile(action), $('instanceProfilesStatus'));
        if (!next) return;
        applyInstanceProfiles(next); ui($('instanceProfilesStatus'), 'textContent', () => t('Pending profile operation updated.'));
      } finally { instanceProfileBusy = false; paintInstanceSwitcher(); paintInstanceManager(); }
    })();
  });
}

// ------------------------------------------------------------ permissions

/**
 * Builds the permission rows once: a name that expands the group, and a switch that
 * turns the whole group on or off. Expanding scrolls the row just into view rather
 * than pushing the cards below it, because the window cannot grow.
 */
/** The head of a permission row: the expander, its title, and its switch. */
function groupShell(id: string, title: string, iconId: string, box: HTMLInputElement): HTMLElement {
  const root = el('div', 'perm');
  root.dataset.group = id;

  const main = document.createElement('button');
  main.className = 'perm-main';
  main.type = 'button';
  const text = el('span');
  text.append(el('b', '', () => t(title)), el('em', 'group-count'));
  main.append(icon('i-chev', 'ico chev'), icon(iconId), text);
  main.addEventListener('click', () => {
    openGroup = openGroup === id ? null : id;
    paintGroups();
    if (openGroup === id) root.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  });

  const sw = el('span', 'sw');
  sw.append(box, el('i'));

  const head = el('div', 'perm-head');
  head.append(main, sw);
  root.append(head);
  return root;
}

/**
 * The tools this group hands ChatGPT, named exactly as the model sees them.
 *
 * The permission copy used to carry the tool names inside its prose, which is where they
 * went stale: the surface was consolidated to `read` / `apply_patch` / `exec_command` and
 * a sentence in a different file kept describing the old one. Here the names come from
 * capabilityTools, including the host's shared Desktop method lists.
 */
function toolNames(names: readonly string[]): HTMLElement {
  const row = el('div', 'tool-names');
  for (const name of names) row.append(el('code', '', name));
  return row;
}

function buildGroups(): void {
  const permissionGroups = GROUPS.map((group) => {
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.className = 'group-box';
    ui(box, 'title', () => t("Turn everything in \"{0}\" on or off", [t(group.title)]));
    box.addEventListener('change', () => {
      for (const cap of group.caps) {
        const input = capInput(cap);
        if (!input.disabled) input.checked = box.checked;
      }
      void save();
    });
    const root = groupShell(group.id, group.title, group.icon, box);

    const tools = el('div', 'tools');
    for (const cap of group.caps) {
      const label = el('label', 'tool');
      const input = document.createElement('input');
      input.type = 'checkbox';
      input.dataset.cap = cap;
      input.addEventListener('change', () => void save());
      const body = el('span');
      body.append(el('strong', '', () => t(CAPABILITY_LABELS[cap])), el('em', '', () => t(CAPABILITY_DETAILS[cap])));
      label.append(input, body);
      tools.append(label);
    }
    tools.append(toolNames([]));

    root.append(tools);
    return root;
  });

  // Recording and sub-agents are tool surfaces exactly like the file and desktop
  // permissions — `session` and `agents` are two of the nine tools ChatGPT can discover —
  // and they used to be checkboxes buried in a settings pane behind a gear. Every switch
  // that decides what ChatGPT can reach now lives in this one list. Chat settings keeps
  // only the numbers that tune them.
  const record = document.createElement('input');
  record.type = 'checkbox';
  record.id = 'sessRecord';
  ui(record, 'title', () => t("Record this chat locally, and expose the session tool in ChatGPT"));
  record.addEventListener('change', () => void save());
  const recording = groupShell('recording', 'Session recording', 'i-steps', record);
  const recordTools = el('div', 'tools');
  for (const [name, detail] of [
    ['search', 'List recent recordings or find past and concurrent work by text.'],
    ['read', 'Read one explicit recording, continue it, or expand one short T… tool reference.']
  ] as Array<[string, string]>) {
    const row = el('div', 'tool is-static');
    const body = el('span');
    body.append(el('strong', '', name), el('em', '', () => t(detail)));
    row.append(body);
    recordTools.append(row);
  }
  recordTools.append(toolNames(['session']));
  recording.append(recordTools);

  const enabled = document.createElement('input');
  enabled.type = 'checkbox';
  enabled.id = 'homeMaEnabled';
  ui(enabled, 'title', () => t("Expose or hide the sub-agent tools in ChatGPT"));
  // The only multi-agent exposure control there is. Chat settings used to carry a second
  // checkbox for the same flag, which this one had to mirror by hand.
  enabled.addEventListener('change', () => void save());
  const agents = groupShell('agents', 'Sub-agents', 'i-bolt', enabled);

  const tools = el('div', 'tools');
  const agentTools: Array<[string, string]> = [
    ['spawn', 'Open worker ChatGPT conversations for parts of the task, on one shared context.'],
    ['message', 'Steer one worker or several at once, or report back to prime.'],
    ['status', 'See every worker, and collect messages not yet delivered on a tool result.'],
    ['finish', 'Hand the worker result back to prime and close that slot.']
  ];
  for (const [name, detail] of agentTools) {
    const row = el('div', 'tool is-static');
    const body = el('span');
    body.append(el('strong', '', name), el('em', '', () => t(detail)));
    row.append(body);
    tools.append(row);
  }
  tools.append(toolNames(['agents']));
  agents.append(tools);

  $('groups').replaceChildren(...permissionGroups, recording, agents);
}

function capInput(cap: Capability): HTMLInputElement {
  return document.querySelector<HTMLInputElement>(`[data-cap="${cap}"]`)!;
}

/** Refreshes counts, the tri-state switches, and what read-only mode has locked. */
function paintGroups(): void {
  if (!state) return;
  const { readOnly } = state.config;
  const desktopSupported = state.platform?.desktopAutomation ?? true;

  for (const group of GROUPS) {
    const root = document.querySelector<HTMLElement>(`[data-group="${group.id}"]`)!;
    root.hidden = false;
    root.classList.toggle('is-open', openGroup === group.id);

    const names = [...new Set(group.caps.flatMap((cap) => capabilityTools(cap, state!.platform?.family)))];
    if (group.id === 'desktop' && names.length > 0) names.push('exec');
    const namesRow = root.querySelector<HTMLElement>('.tool-names')!;
    if (Array.from(namesRow.children, child => child.textContent).join('\n') !== names.join('\n')) {
      namesRow.replaceChildren(...names.map(name => el('code', '', name)));
    }

    const usable = group.caps.filter((cap) => !(readOnly && WRITE_CAPABILITIES.includes(cap)) &&
      (desktopSupported || cap !== 'clipboardRead' && cap !== 'clipboardWrite'));
    const on = group.caps.filter((cap) => capInput(cap).checked);

    const box = root.querySelector<HTMLInputElement>('.group-box')!;
    box.checked = usable.length > 0 && usable.every((cap) => capInput(cap).checked);
    box.indeterminate = !box.checked && on.length > 0;
    box.disabled = usable.length === 0;

    ui(root.querySelector<HTMLElement>('.group-count')!, 'textContent', () => usable.length === 0
        ? t("off in read-only mode")
        : on.length === 0
          ? 'off'
          : on.length === group.caps.length
            ? t(on.length === 1 ? '{0} permission' : '{0} permissions', [on.length])
            : t("{0} of {1} permissions", [on.length, group.caps.length]));

    root.classList.toggle('is-on', on.length > 0);
    root.classList.toggle('is-locked', usable.length === 0);
  }

  for (const cap of WRITE_CAPABILITIES) capInput(cap).disabled = readOnly;
  for (const cap of ['clipboardRead', 'clipboardWrite'] as const) {
    capInput(cap).disabled = !desktopSupported || (readOnly && WRITE_CAPABILITIES.includes(cap));
  }

  // The two feature groups. apply() already passed both switches through the
  // focused/dirty-field guard. Recopying state here undid that protection and visibly
  // flipped a user's just-clicked toggle back when an unsolicited stale state push
  // arrived before save completed, so this only reads them.
  for (const [id, onText] of [
    ['recording', 'session tool exposed'],
    ['agents', 'agents tool exposed']
  ] as Array<[string, string]>) {
    const root = document.querySelector<HTMLElement>(`[data-group="${id}"]`);
    if (!root) continue;
    const box = root.querySelector<HTMLInputElement>('.sw input')!;
    root.classList.toggle('is-open', openGroup === id);
    root.classList.toggle('is-on', box.checked);
    ui(root.querySelector<HTMLElement>('.group-count')!, 'textContent', () => t(box.checked ? onText : 'off'));
  }
}

function paintDesktopAccess(next: AppState): void {
  const box = $('desktopAccess');
  const access = next.desktopAccess;
  const needsScreen = next.config.capabilities.screen;
  const needsAccessibility = next.config.capabilities.control && !next.config.readOnly;
  if (next.platform?.family !== 'macos' || (!needsScreen && !needsAccessibility) || !access) {
    box.hidden = true;
    return;
  }

  const missing: string[] = [];
  if (needsScreen && access.screen !== 'granted') missing.push(t("Screen Recording: {0}", [access.screen]));
  if (needsAccessibility && access.accessibility !== 'granted') {
    missing.push(t("Accessibility: {0}", [access.accessibility]));
  }
  box.hidden = missing.length === 0;
  if (box.hidden) return;

  ui($('desktopAccessTitle'), 'textContent', () => t("Desktop access needs attention"));
  ui($('desktopAccessDetail'), 'textContent', () => t("{0}. These are live verdicts from the native backend executing inside Chat On Steroids. ", [missing.join(' · ')]) +
    t("Grant the missing macOS permission, then fully quit and reopen the app."));
  $<HTMLButtonElement>('openDesktopScreen').hidden =
    !needsScreen || access.screen === 'granted';
  $<HTMLButtonElement>('openDesktopAccessibility').hidden =
    !needsAccessibility || access.accessibility === 'granted';
  $<HTMLButtonElement>('requestDesktopAccessibility').hidden =
    !needsAccessibility || access.accessibility === 'granted';
}

/**
 * How many MCP tools this app can expose in total, across both connectors.
 *
 * Taken from the surfaces the main process reports rather than recomputed from the
 * checkboxes, so this number cannot drift away from what the servers actually register.
 */
function toolsOn(next: AppState): number {
  return next.status.surfaces
    .filter((surface) => surface.available)
    .reduce((sum, surface) => sum + surface.tools.length, 0);
}

// ------------------------------------------------------------------ save

// A settings save is a full snapshot, even though the main process applies it as a patch.
// Capture each requested snapshot immediately, but derive it from the latest *requested* state
// rather than only the latest acknowledged state. Then serialize IPC delivery. This handles both
// halves of the race: a later save cannot inherit stale readOnly/theme, and the first save's reply
// cannot repaint a control before the later save has captured what the user changed there.
let settingsSaveQueue: Promise<void> = Promise.resolve();
let requestedSettings: SettingsPatch | null = null;

function save(over: { readOnly?: boolean; theme?: 'light' | 'dark' } = {}): Promise<void> {
  if (applying || !state) return Promise.resolve();

  const previous: AppState['config'] = requestedSettings
    ? { ...state.config, ...requestedSettings }
    : state.config;
  const capabilities = { ...previous.capabilities };
  for (const input of document.querySelectorAll<HTMLInputElement>('[data-cap]')) {
    const capability = input.dataset.cap as Capability;
    // Unsupported hosts hide Desktop automation while preserving any choices stored in this
    // config. A hidden disabled checkbox is presentation,
    // not a user edit: copying its forced-false value into every unrelated settings save
    // would erase those choices merely because the config was opened on another OS.
    if (!(state.platform?.desktopAutomation ?? true) && DESKTOP_CAPABILITIES.includes(capability) &&
        capability !== 'screen' && capability !== 'control') continue;
    capabilities[capability] = input.checked;
  }
  const readOnly = over.readOnly ?? previous.readOnly;
  const chatPatch = chatSettingsPatch(previous);
  const patch: SettingsPatch = {
    capabilities,
    readOnly,
    tunnel: {
      profileId: previous.tunnel.profileId,
      profileEpoch: previous.tunnel.profileEpoch,
      kind: $<HTMLSelectElement>('tunnelKind').value as 'openai' | 'cloudflared' | 'manual',
      tunnelId: $<HTMLInputElement>('tunnelId').value.trim(),
      desktopTunnelId: $<HTMLInputElement>('desktopTunnelId').value.trim(),
      pluginsTunnelId: previous.tunnel.pluginsTunnelId ?? '',
      binaryPath: $<HTMLInputElement>('binaryPath').value.trim(),
      manualPublicOrigin: $<HTMLInputElement>('manualPublicOrigin').value.trim(),
      manualPort: Number($<HTMLInputElement>('manualPort').value)
    },
    ui: {
      chatBrowser: $<HTMLSelectElement>('chatBrowser').value as ChatBrowser,
      finishTool: $<HTMLInputElement>('finishTool').checked,
      planBackend: $<HTMLSelectElement>('planBackend').value as 'chatgpt' | 'api',
      finishAction: $<HTMLSelectElement>('finishAction').value as 'notify' | 'goal',
      finishLeadMinutes: Number($<HTMLSelectElement>('finishLeadMinutes').value),
      rotateTurnMinutes: Number($<HTMLSelectElement>('rotateTurnMinutes').value),
      backgroundChats: $<HTMLInputElement>('backgroundChats').checked,
      browserOnly: $<HTMLInputElement>('browserOnly').checked,
      automationPaused: previous.ui.automationPaused ?? false,
      automationProfile: previous.ui.automationProfile ?? 'day',
      autoRefreshPlugins: $<HTMLInputElement>('autoRefreshPlugins').checked,
      signOutEmergencyAlerts: (state.platform?.family ?? 'windows') === 'windows'
        ? $<HTMLInputElement>('signOutEmergencyAlerts').checked
        : previous.ui.signOutEmergencyAlerts ?? false,
      autoConnect: $<HTMLInputElement>('autoConnect').checked,
      startAtLogin: $<HTMLInputElement>('startAtLogin').checked,
      keepAwake: $<HTMLInputElement>('keepAwake').checked,
      minimizeToTray: $<HTMLInputElement>('minimizeToTray').checked,
      developerMode: $<HTMLInputElement>('developerMode').checked,
      followOutput: $<HTMLInputElement>('followOutput').checked,
      privacyScreenshots: $<HTMLInputElement>('privacyScreenshots').checked,
      theme: over.theme ?? previous.ui.theme
    },
    ...chatPatch
  };
  requestedSettings = patch;

  const work = settingsSaveQueue.then(
    () => saveSnapshot(patch, previous),
    () => saveSnapshot(patch, previous)
  );
  settingsSaveQueue = work.then(
    () => undefined,
    () => undefined
  );
  return work;
}

async function saveSnapshot(patch: SettingsPatch, previous: AppState['config']): Promise<void> {
  const toolSurfaceChanged =
    previous.sessions.record !== patch.sessions.record ||
    previous.multiAgent.enabled !== patch.multiAgent.enabled ||
    (Object.keys(patch.capabilities) as Capability[]).some((cap) => {
      const before = previous.capabilities[cap] && !(previous.readOnly && WRITE_CAPABILITIES.includes(cap));
      const after = patch.capabilities[cap] && !(patch.readOnly && WRITE_CAPABILITIES.includes(cap));
      return before !== after;
    });
  const base: SettingsPatch = {
    capabilities: previous.capabilities,
    readOnly: previous.readOnly,
    tunnel: previous.tunnel,
    ui: previous.ui,
    sessions: previous.sessions,
    compaction: previous.compaction,
    mcp: previous.mcp ?? { instructions: '' },
    multiAgent: previous.multiAgent,
    goal: previous.goal
  };
  const next = await run(api.saveSettings(patch, base));
  if (next) {
    apply(next);
    if (previous.multiAgent.enabled && !patch.multiAgent.enabled) {
      // A cached snapshot keeps offering the `agents` tool until the connector is
      // reloaded. Say so plainly rather than letting it look sticky.
      toast(t("Multi-agent off. Reconnect the connector in ChatGPT (then start a new chat) to drop the agents tool."));
    } else if (toolSurfaceChanged) {
      toast(t("Tools changed. Start a new ChatGPT conversation to guarantee the new tool list is loaded."));
    }
  } else await refresh();
  // Do not erase the desired state of a newer queued save when an older one completes.
  if (requestedSettings === patch) requestedSettings = null;
}

// ---------------------------------------------------------------- helpers

const STATUS_TEXT: Record<AppState['status']['state'], string> = {
  disconnected: "Not connected",
  disconnecting: "Disconnecting",
  'starting-server': "Recovering",
  'connecting-tunnel': "Recovering",
  connected: "Connected",
  offline: "Waiting for Core",
  'auth-failed': "Needs attention",
  'tunnel-unavailable': "Needs attention"
};

const METHOD_HINT: Record<string, string> = {
  openai:
    "ChatGPT reaches this computer through an OpenAI tunnel. Nothing is exposed to the open internet.",
  cloudflared:
    "Creates a temporary public https address with Cloudflare. The address changes on every restart.",
  manual: "Use an existing tunnel service with a permanent HTTPS address, or leave the address blank for local only."
};

function duration(seconds: number | null): string {
  if (seconds === null) return '—';
  if (seconds < 90) return `${Math.round(seconds)}s`;
  const minutes = Math.round(seconds / 60);
  return minutes < 90 ? `${minutes}m` : `${Math.round(minutes / 60)}h`;
}

/**
 * True while the bridge is up and Disconnect is the meaningful action. Offline
 * counts: the tunnel is still alive and retrying, it just cannot reach OpenAI.
 */
function isRunning(value: AppState['status']['state']): boolean {
  return (
    value === 'connected' ||
    value === 'offline' ||
    value === 'starting-server' ||
    value === 'connecting-tunnel'
  );
}

interface SetupConnectionValues { tunnelId: string; hasApiKey: boolean }

/** What still has to happen before connecting can work, in the order of the wizard. */
function missingStep(
  next: AppState,
  values: SetupConnectionValues = { tunnelId: next.config.tunnel.tunnelId, hasApiKey: next.hasApiKey }
): { step: string; text: string } | null {
  const { config } = next;
  // This is the same capability rule as the main-process admission gate. Desktop and
  // clipboard may legitimately be rootless; enabling one must not hide a root still needed
  // by an effective file/patch/command capability on Core.
  if (config.roots.length === 0 && requiresApprovedFilesystemRoot(config)) {
    return { step: 'folder', text: t("Choose a folder to share — step 1.") };
  }
  if (config.tunnel.kind === 'openai') {
    if (!TUNNEL_ID_PATTERN.test(values.tunnelId)) {
      return { step: 'tunnel', text: t("Create a tunnel and paste its ID — step 2.") };
    }
    if (!(next.secureStorage?.available ?? true) && !values.hasApiKey) {
      return { step: 'key', text: next.secureStorage?.detail ?? t("Secure credential storage is unavailable.") };
    }
    if (!values.hasApiKey) {
      return { step: 'key', text: t("Add a restricted API key — step 3.") };
    }
  } else if (!next.resolvedBinary && config.tunnel.kind === 'cloudflared') {
    return { step: 'connect', text: t("cloudflared was not found on this computer.") };
  }
  return null;
}

/** Setup drafts are valid input for the Connect click that will persist them. */
function currentSetupMissingStep(next: AppState): { step: string; text: string } | null {
  const key = $<HTMLInputElement>('apiKey');
  return missingStep(next, {
    tunnelId: $<HTMLInputElement>('tunnelId').value.trim(),
    hasApiKey: next.hasApiKey || (next.secureStorage?.available !== false && key.value !== '')
  });
}

interface RootRenameState {
  targetName: string;
  targetPath: string;
  draft: string;
  selectionStart: number | null;
  selectionEnd: number | null;
  selectionDirection: 'forward' | 'backward' | 'none' | null;
  focused: boolean;
  committing: boolean;
}

let rootRename: RootRenameState | null = null;
let repaintingRoots = false;

/**
 * The rename editor is transient DOM, but the draft is user state. Whole-state pushes repaint
 * the folder list, so capture that state before the old input is detached and recreate the
 * editor only while the exact authoritative root still exists unchanged.
 */
function captureRootRenameInput(input: HTMLInputElement, rename: RootRenameState): void {
  if (rootRename !== rename) return;
  rename.draft = input.value;
  rename.focused = document.activeElement === input;
  if (rename.focused) {
    rename.selectionStart = input.selectionStart;
    rename.selectionEnd = input.selectionEnd;
    rename.selectionDirection = input.selectionDirection;
  }
}

function cancelRootRename(): void {
  rootRename = null;
  if (state) paintRoots(state.config.roots);
}

async function commitRootRename(input: HTMLInputElement, rename: RootRenameState): Promise<void> {
  if (rootRename !== rename || rename.committing) return;
  captureRootRenameInput(input, rename);
  const nextName = rename.draft.trim().toLowerCase();
  if (!nextName || nextName === rename.targetName) {
    cancelRootRename();
    return;
  }

  rename.committing = true;
  input.disabled = true;
  const result = await run(api.renameRoot(rename.targetName, nextName));
  // An authoritative state push can remove or rename the target while IPC is in flight. Never
  // resurrect that cancelled editor when this older request finishes.
  if (rootRename !== rename) return;
  if (result) {
    rootRename = null;
    apply(result);
    return;
  }

  // Failure is retryable user input, not a reason to throw the draft away.
  rename.committing = false;
  paintRoots(state?.config.roots ?? []);
}

function rootRow(root: AppState['config']['roots'][number]): HTMLElement {
  const row = el('div', 'root');
  const renameState =
    rootRename?.targetName === root.name && rootRename.targetPath === root.path ? rootRename : null;
  const name = el('b', '', `/${root.name}`);
  let label: HTMLElement = name;

  if (renameState) {
    const input = document.createElement('input');
    input.className = 'root-rename';
    input.value = renameState.draft;
    input.maxLength = 32;
    input.disabled = renameState.committing;
    ui(input, 'aria-label', () => t("Rename /{0}", [root.name]));
    input.addEventListener('input', () => captureRootRenameInput(input, renameState));
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        void commitRootRename(input, renameState);
      } else if (event.key === 'Escape') {
        event.preventDefault();
        cancelRootRename();
      }
    });
    input.addEventListener('blur', () => {
      // replaceChildren() may itself blur the old node in a real browser. paintRoots already
      // captured its draft/focus/caret immediately before detaching it, so treating that blur
      // as user intent would both lose focus restoration and accidentally commit on a status push.
      if (repaintingRoots) return;
      captureRootRenameInput(input, renameState);
      void commitRootRename(input, renameState);
    });
    label = input;
  }

  const rename = document.createElement('button');
  rename.className = 'btn';
  rename.type = 'button';
  ui(rename, 'title', () => t("Rename /{0}", [root.name]));
  rename.append(icon('i-pencil'));
  rename.addEventListener('click', () => {
    rootRename = {
      targetName: root.name,
      targetPath: root.path,
      draft: root.name,
      selectionStart: 0,
      selectionEnd: root.name.length,
      selectionDirection: 'none',
      focused: true,
      committing: false
    };
    paintRoots(state?.config.roots ?? []);
  });

  const remove = document.createElement('button');
  remove.className = 'btn';
  remove.type = 'button';
  ui(remove, 'title', () => t("Stop sharing /{0}", [root.name]));
  remove.append(icon('i-trash'));
  remove.addEventListener('click', async () => {
    const result = await run(api.removeRoot(root.name));
    if (result) apply(result);
  });
  const path = el('span', '', root.path);
  path.title = root.path;
  row.append(icon('i-folder'), label, path, rename, remove);
  return row;
}

function paintRoots(roots: AppState['config']['roots']): void {
  const active = document.querySelector<HTMLInputElement>('.root-rename');
  if (active && rootRename) captureRootRenameInput(active, rootRename);

  if (
    rootRename &&
    !roots.some((root) => root.name === rootRename!.targetName && root.path === rootRename!.targetPath)
  ) {
    rootRename = null;
  }

  repaintingRoots = true;
  try {
    $('rootList').replaceChildren(...roots.map(rootRow));
  } finally {
    repaintingRoots = false;
  }

  if (!rootRename?.focused) return;
  const input = document.querySelector<HTMLInputElement>('.root-rename');
  if (!input) return;
  input.focus();
  if (rootRename.selectionStart !== null && rootRename.selectionEnd !== null) {
    input.setSelectionRange(
      rootRename.selectionStart,
      rootRename.selectionEnd,
      rootRename.selectionDirection ?? undefined
    );
  }
}

// ----------------------------------------------------------------- render

/** How the one update sentence reads: nothing to do, something in progress, something wrong. */
type UpdateTone = 'ok' | 'work' | 'bad';

/** The update notification is news, and news is told once per window. */
let announced = false;

/**
 * Everything this window knows about being current, as one sentence and one tone.
 *
 * Two facts feed it and this owns neither: what the update service found (state.update, which
 * reports a `latest` only when it is genuinely newer, so nothing here compares versions), and
 * the last extension version observed by the bridge. A protocol mismatch can prevent presence,
 * so an observed older version remains actionable until a current companion reports in.
 *
 * Null is the one silence that is not an answer: GitHub has not replied yet in this run, so
 * "up to date" would be a claim nobody has checked. That is what `checkedAt` is for.
 *
 * `notice` is the narrower question of whether the header bar carries the sentence at all. That
 * bar is for what the user can act on - a version to fetch by hand, an extension to reload -
 * while the Activity line reports every state, including the good one.
 */
function updateSummary({ bridge, update, config, status }: AppState): { text: string; tone: UpdateTone; notice: boolean; extensionAction: string | null } | null {
  // Only an extension older than this app is the user's to fix. The other direction is an app
  // that has not caught up yet - normal while an update downloads - and telling that user to
  // load the bundled folder again would talk them into downgrading a working extension. The
  // app sentence already owns being behind.
  const stale =
    bridge.extensionVersion && isNewer(update.current, bridge.extensionVersion)
      ? bridge.extensionVersion
      : null;
  // A mismatched companion can fail the protocol gate before it becomes present.
  // Retain its last observed version until a matching companion actually reports in.
  const missing = !stale && bridge.running && !bridge.present && isRunning(status.state) && browserExtensionRequired(config);
  if (!stale && !missing && !update.latest && update.stage === 'idle' && !update.checkedAt) return null;

  const lines: string[] = [];
  let tone: UpdateTone = 'work';
  if (update.latest) {
    // `latest` set with a stage of `idle` is the deliberate case: a new version exists and this
    // installation - a Linux .deb, macOS, a development tree, an architecture with no artifact -
    // is not one the app can update by itself. That is when the button matters.
    lines.push(
      update.stage === 'checking'
        ? t("Checking for the latest update…")
        : update.stage === 'ready'
        ? t("Chat On Steroids {0} is downloaded and ready. Install it now, or it installs the next time you quit.", [update.latest])
        : update.stage === 'downloading'
          ? t("Chat On Steroids {0} is downloading. Keep working; you can install it when it lands.", [update.latest])
          : update.stage === 'failed'
            ? t("Chat On Steroids {0} could not be downloaded: {1}.", [update.latest, update.error ?? t("the download stopped")])
            : t("Chat On Steroids {0} is out. This installation has to be updated by hand.", [update.latest])
    );
    if (update.stage === 'failed') tone = 'bad';
  } else if (update.stage === 'failed') {
    lines.push(t("Could not check for a newer version: {0}.", [update.error ?? t("the check stopped")]));
    tone = 'bad';
  } else if (update.stage === 'checking') {
    lines.push(t("Checking for a newer version…"));
  } else if (!stale && !missing) {
    const extension = bridge.present && bridge.extensionVersion ? t(" · extension {0}", [bridge.extensionVersion]) : '';
    lines.push(t("Up to date! Chat On Steroids {0}{1}", [update.current, extension]));
    tone = 'ok';
  }
  if (stale) {
    lines.push(
      t("Update your browser extension: {0} → {1}. ", [stale, update.current]) +
        t("Reload the extension from this app’s folder, then refresh ChatGPT.")
    );
    tone = 'bad';
  }
  if (missing) { lines.push(t("Browser extension not connected. Open ChatGPT and check the companion in Setup to load models and send messages.")); tone = 'bad'; }
  return { text: lines.join(' '), tone, notice: Boolean(update.latest || stale || missing), extensionAction: stale ? t("Update extension") : missing ? t("Check extension") : null };
}

/** The header bar, the Activity line and the one notification, from that single sentence. */
function paintUpdate(next: AppState): void {
  const summary = updateSummary(next);
  const notice = $('updateNotice');
  const line = $('updateLine');
  if (!summary) {
    notice.hidden = true;
    line.hidden = true;
    $('updateExtension').hidden = true;
    return;
  }
  const { update } = next;
  ui($('updateText'), 'textContent', () => updateSummary(next)?.text ?? '');
  $('updateExtension').hidden = !summary.extensionAction;
  ui($('updateExtension'), 'textContent', () => updateSummary(next)?.extensionAction ?? t("Update extension"));
  $<HTMLButtonElement>('updateGet').hidden = !update.latest || update.stage === 'checking' || update.stage === 'downloading' || update.stage === 'ready';
  // `ready` is the only state with a verified artifact on disk, and therefore the only one in
  // which pressing Install can do anything. Both buttons ask the same question of the same fact.
  const queued = instanceProfiles?.drain?.kind === 'update' && instanceProfiles.drain.state !== 'idle';
  const installable = update.stage === 'ready';
  $<HTMLButtonElement>('updateInstall').hidden = !installable;
  $<HTMLButtonElement>('installUpdate').hidden = !installable;
  for (const id of ['updateInstall', 'installUpdate']) {
    const button = $<HTMLButtonElement>(id);
    button.disabled = queued;
  }
  setUpdateButtonLabels(queued);
  notice.hidden = !summary.notice;
  ui(line, 'textContent', () => updateSummary(next)?.text ?? '');
  line.className = `upline${summary.tone === 'ok' ? ' is-ok' : summary.tone === 'bad' ? ' is-bad' : ''}`;
  line.hidden = false;
  // One notification per window, on the first answer that is an outcome rather than progress.
  // The Activity line keeps the sentence afterwards, so repeating it as a toast on every state
  // push would be the same news arriving over and over.
  if (!announced && update.stage !== 'checking' && update.stage !== 'downloading') {
    announced = true;
    toast(summary.text);
  }
}

function paintSetupProfiles(next: AppState): void {
  const tunnel = next.config.tunnel;
  const select = $<HTMLButtonElement>('setupProfile');
  const menu = $('setupProfileMenu');
  const profiles = [{ id: tunnel.profileId ?? 'default', name: tunnel.profileName ?? t('Default') }, ...(next.config.setupProfiles ?? [])];
  const signature = JSON.stringify(profiles);
  if (select.dataset.profiles !== signature) {
    menu.replaceChildren(...profiles.map(profile => {
      const row = el('div', 'setup-profile-option');
      const choose = document.createElement('button');
      choose.type = 'button'; choose.className = 'btn'; choose.textContent = profile.name;
      choose.translate = false;
      choose.dataset.profileId = profile.id;
      choose.setAttribute('aria-pressed', String(profile.id === (tunnel.profileId ?? 'default')));
      choose.addEventListener('click', () => void changeSetupProfile('select', profile.id));
      const remove = document.createElement('button');
      remove.type = 'button'; remove.className = 'btn'; remove.dataset.removeProfileId = profile.id;
      ui(remove, 'title', () => t('Delete profile: {0}', [profile.name]));
      ui(remove, 'aria-label', () => t('Delete profile: {0}', [profile.name]));
      remove.append(icon('i-trash'));
      remove.addEventListener('click', () => void changeSetupProfile('remove', profile.id));
      row.append(choose, remove); return row;
    }));
    select.dataset.profiles = signature;
  }
  $('setupProfileCurrent').textContent = profiles[0]!.name;
  select.disabled = setupProfileBusy;
  for (const button of menu.querySelectorAll<HTMLButtonElement>('button')) {
    button.disabled = setupProfileBusy || (button.dataset.removeProfileId !== undefined && profiles.length === 1);
  }
  $<HTMLButtonElement>('setupProfileAdd').disabled = setupProfileBusy || profiles.length >= 12;
  $<HTMLInputElement>('setupProfileName').disabled = setupProfileBusy;
  for (const id of ['tunnelId', 'desktopTunnelId']) $<HTMLInputElement>(id).disabled = setupProfileBusy;
  $<HTMLInputElement>('apiKey').disabled = setupProfileBusy || next.secureStorage?.available === false;
  $<HTMLButtonElement>('removeApiKey').disabled = setupProfileBusy || next.secureStorage?.available === false;
}

async function changeSetupProfile(action: 'add' | 'select' | 'remove', id?: string): Promise<void> {
  if (!state || setupProfileBusy) return;
  const nameInput = $<HTMLInputElement>('setupProfileName');
  const name = nameInput.value.trim();
  if (action === 'add' && !name) { nameInput.focus(); return; }
  setupProfileBusy = true; paintSetupProfiles(state);
  try {
    await settingsSaveQueue;
    if (!(await setupKeySave)) return;
    const next = await run(action === 'add' ? api.addSetupProfile(name)
      : action === 'remove' ? api.removeSetupProfile(id!) : api.selectSetupProfile(id!));
    if (!next) return;
    requestedSettings = null;
    $<HTMLInputElement>('apiKey').value = '';
    if (action === 'add') {
      if (nameInput.value.trim() === name) nameInput.value = '';
      $<HTMLDialogElement>('setupProfileDialog').close();
    }
    $('setupProfileMenu').hidePopover();
    showAllSteps = null;
    apply(next);
  } finally {
    setupProfileBusy = false;
    if (state) paintSetupProfiles(state);
  }
}
$('setupProfileAdd').addEventListener('click', () => {
  $<HTMLDialogElement>('setupProfileDialog').showModal();
  $('setupProfileName').focus();
});
$('setupProfileCancel').addEventListener('click', () => $<HTMLDialogElement>('setupProfileDialog').close());
$('setupProfileForm').addEventListener('submit', event => { event.preventDefault(); void changeSetupProfile('add'); });

function paintSetupFields(): void {
  for (const id of ['tunnelId', 'apiKey']) {
    const input = $<HTMLInputElement>(id);
    const stored = id === 'apiKey' && state?.hasApiKey === true;
    input.classList.toggle('is-empty', !stored && input.value.trim() === '');
    input.setAttribute('aria-required', String(!stored));
  }
  if (state) paintConnectButtons(state);
}

/** Keep both connection controls honest while valid values are still focused drafts. */
function paintConnectButtons(next: AppState): void {
  const running = isRunning(next.status.state);
  const disconnecting = next.status.state === 'disconnecting';
  const missing = currentSetupMissingStep(next);
  for (const id of ['connectBtn', 'wizConnect']) {
    const button = $<HTMLButtonElement>(id);
    button.disabled = disconnecting || (!running && missing !== null);
    button.title = !disconnecting && !running && missing ? missing.text : '';
  }
}

function apply(next: AppState): void {
  // An older key/status response must not restore a profile retired by a newer switch.
  if ((next.config.tunnel.profileEpoch ?? 0) < (state?.config.tunnel.profileEpoch ?? 0)) return;
  applyPluginsState(next);
  const previousState = state;
  state = next;
  applying = true;
  const { config, status } = next;

  const connected = status.state === 'connected';
  const offline = status.state === 'offline';
  const disconnecting = status.state === 'disconnecting';
  const busy = disconnecting || status.state === 'starting-server' || status.state === 'connecting-tunnel';
  const failed = status.state === 'auth-failed' || status.state === 'tunnel-unavailable';
  const running = isRunning(status.state);
  const missing = currentSetupMissingStep(next);

  // ---- theme
  const dark = config.ui.theme === 'dark';
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  $('themeIcon').setAttribute('href', dark ? '#i-sun' : '#i-moon');
  ui($('themeBtn'), 'title', () => dark ? t("Switch to light mode") : t("Switch to dark mode"));

  // ---- header
  const live = $('live');
  live.className = `live connection-capsule-status${
    connected ? ' is-connected' : offline ? ' is-offline' : busy ? ' is-busy' : failed ? ' is-error' : ''
  }`;
  ui($('liveState'), 'textContent', () => t(STATUS_TEXT[status.state]));

  const id = config.tunnel.tunnelId;
  ui($('headerSub'), 'textContent', () => config.tunnel.kind === 'openai'
      ? TUNNEL_ID_PATTERN.test(id)
        ? `${id.slice(0, 11)}…${id.slice(-4)}`
        : t("No tunnel yet")
      : (status.publicUrl ?? status.localUrl ?? config.tunnel.kind));

  const connectBtn = $<HTMLButtonElement>('connectBtn');
  connectBtn.classList.toggle('is-running', running);
  ui($('connectLabel'), 'textContent', () => disconnecting ? t('Disconnecting…') : running ? t("Disconnect") : t("Connect"));
  connectBtn.disabled = disconnecting || (!running && missing !== null);
  connectBtn.title = !disconnecting && !running && missing ? missing.text : '';

  // ---- out of date, app or extension
  paintUpdate(next);
  paintPluginRefreshReminder(next.connectorSchemas ?? {}, next.confirmedConnectorSchemas ?? {});

  // ---- health numbers and facts
  paintClock();
  $('facts').replaceChildren(...facts(next));

  // ---- permissions
  $('readOnlyBtn').classList.toggle('is-on', config.readOnly);
  for (const input of document.querySelectorAll<HTMLInputElement>('[data-cap]')) {
    const cap = input.dataset.cap as Capability;
    const supported = (next.platform?.desktopAutomation ?? true) || !DESKTOP_CAPABILITIES.includes(cap) ||
      cap === 'screen' || cap === 'control';
    applyChecked(input, supported && config.capabilities[cap], previousState?.config.capabilities[cap]);
  }
  applyChecked(
    $<HTMLInputElement>('homeMaEnabled'),
    config.multiAgent.enabled,
    previousState?.config.multiAgent.enabled
  );
  // Recording is a tool switch like the rest of this list, so it goes through the same
  // dirty-field guard rather than being assigned outright from the Chat panel.
  applyChecked(
    $<HTMLInputElement>('sessRecord'),
    config.sessions.record,
    previousState?.config.sessions.record
  );
  paintGroups();
  paintDesktopAccess(next);

  // ---- folders
  paintRoots(config.roots);
  $('rootsEmpty').hidden = config.roots.length > 0;
  const sharedFolders = config.instances?.sharedFolderAccess?.enabled === true;
  const shareFoldersButton = $<HTMLButtonElement>('shareAccountFolders');
  shareFoldersButton.disabled = instanceProfiles?.canManageProfiles === false;
  shareFoldersButton.setAttribute('aria-pressed', String(sharedFolders));
  ui(shareFoldersButton, 'textContent', () => sharedFolders ? t('Stop sharing folders across accounts') : t('Share folders across accounts'));
  ui($('shareAccountFoldersHint'), 'textContent', () => instanceProfiles?.canManageProfiles === false
    ? t('Manage the shared folder list in the primary account window. Credentials and account settings remain separate.')
    : sharedFolders
      ? t('Shared on this computer. New accounts inherit this exact list; removals take effect on their next local tool call.')
      : t('One folder list for current and future accounts on this computer. Other computers keep their own local paths.'));

  // ---- nav badge
  $('setupBadge').hidden = missing === null;

  // ---- wizard
  applyValue(
    $<HTMLSelectElement>('tunnelKind'),
    config.tunnel.kind,
    previousState?.config.tunnel.kind
  );
  ui($('methodHint'), 'textContent', () => t(METHOD_HINT[config.tunnel.kind] ?? ''));
  applyValue($<HTMLInputElement>('tunnelId'), config.tunnel.tunnelId, previousState?.config.tunnel.tunnelId);
  applyValue(
    $<HTMLInputElement>('desktopTunnelId'),
    config.tunnel.desktopTunnelId,
    previousState?.config.tunnel.desktopTunnelId
  );
  applyValue($<HTMLInputElement>('binaryPath'), config.tunnel.binaryPath, previousState?.config.tunnel.binaryPath);
  $('manualRouteFields').hidden = config.tunnel.kind !== 'manual';
  applyValue($<HTMLInputElement>('manualPublicOrigin'), config.tunnel.manualPublicOrigin ?? '', previousState?.config.tunnel.manualPublicOrigin ?? '');
  applyValue($<HTMLInputElement>('manualPort'), String(config.tunnel.manualPort ?? 0), String(previousState?.config.tunnel.manualPort ?? 0));
  applyValue($<HTMLSelectElement>('chatBrowser'), config.ui.chatBrowser ?? 'chrome', previousState?.config.ui.chatBrowser ?? 'chrome');
  $<HTMLSelectElement>('planBackend').value = config.ui.planBackend ?? 'chatgpt';
  applyChecked($<HTMLInputElement>('finishTool'), config.ui.finishTool === true, previousState?.config.ui.finishTool);
  applyValue($<HTMLSelectElement>('finishAction'), config.ui.finishAction ?? 'notify', previousState?.config.ui.finishAction);
  applyValue($<HTMLSelectElement>('finishLeadMinutes'), String(config.ui.finishLeadMinutes ?? 5), String(previousState?.config.ui.finishLeadMinutes ?? 5));
  const rotationInterval = $<HTMLSelectElement>('rotateTurnMinutes');
  const rotationMinutes = String(config.ui.rotateTurnMinutes ?? 30);
  if (![...rotationInterval.options].some(option => option.value === rotationMinutes))
    rotationInterval.add(new Option(t('{0} minutes', [rotationMinutes]), rotationMinutes));
  applyValue(rotationInterval, rotationMinutes, String(previousState?.config.ui.rotateTurnMinutes ?? 30));
  applyChecked($<HTMLInputElement>('backgroundChats'), config.ui.backgroundChats === true, previousState?.config.ui.backgroundChats);
  applyChecked($<HTMLInputElement>('browserOnly'), config.ui.browserOnly === true, previousState?.config.ui.browserOnly);
  applyChecked($<HTMLInputElement>('autoRefreshPlugins'), config.ui.autoRefreshPlugins === true, previousState?.config.ui.autoRefreshPlugins);
  const signOutEmergencySupported = (next.platform?.family ?? 'windows') === 'windows';
  $('signOutEmergencyAlertsSetting').hidden = !signOutEmergencySupported;
  $<HTMLInputElement>('signOutEmergencyAlerts').disabled = !signOutEmergencySupported;
  applyChecked(
    $<HTMLInputElement>('signOutEmergencyAlerts'),
    config.ui.signOutEmergencyAlerts === true,
    previousState?.config.ui.signOutEmergencyAlerts
  );
  $('startAtLoginRow').hidden = next.loginStartupAvailable !== true;
  $<HTMLInputElement>('startAtLogin').disabled = next.loginStartupAvailable !== true;
  applyChecked($<HTMLInputElement>('startAtLogin'), config.ui.startAtLogin === true, previousState?.config.ui.startAtLogin);
  applyChecked($<HTMLInputElement>('keepAwake'), config.ui.keepAwake !== false, previousState ? previousState.config.ui.keepAwake !== false : undefined);
  applyChecked($<HTMLInputElement>('autoConnect'), config.ui.autoConnect, previousState?.config.ui.autoConnect);
  applyChecked($<HTMLInputElement>('developerMode'), config.ui.developerMode === true, previousState?.config.ui.developerMode);
  applyChecked($<HTMLInputElement>('followOutput'), config.ui.followOutput !== false, previousState?.config.ui.followOutput);
  applyChecked(
    $<HTMLInputElement>('minimizeToTray'),
    config.ui.minimizeToTray,
    previousState?.config.ui.minimizeToTray
  );
  applyChecked(
    $<HTMLInputElement>('privacyScreenshots'),
    config.ui.privacyScreenshots,
    previousState?.config.ui.privacyScreenshots
  );
  $('privacyScreenshotsSetting').hidden = !(next.platform?.desktopAutomation ?? true);
  if (next.platform?.family === 'macos') {
    ui($('backgroundRunningCopy'), 'textContent', () => t("Leave it running while you use the connector. It stays available from the menu bar and Dock when you close the window."));
    ui($('minimizeToTrayCopy'), 'textContent', () => t("Hide the window to the menu bar when closed"));
  } else {
    ui($('backgroundRunningCopy'), 'textContent', () => t("Leave it running while you use the connector. It stays in the tray when you close the window."));
    ui($('minimizeToTrayCopy'), 'textContent', () => t("Keep running in the tray when closed"));
  }

  const openai = config.tunnel.kind === 'openai';
  const browserRequired = browserExtensionRequired(config);
  step('tunnel').hidden = !openai;
  step('key').hidden = !openai;
  step('browser').hidden = !browserRequired;
  // Only this method needs a tunnel per connector. Cloudflare and manual publish the
  // whole address, so both connectors already ride the one tunnel on their own paths.
  const desktopSurface = status.surfaces.find((surface) => surface.id === 'desktop');
  $('desktopTunnelField').hidden = !openai || !desktopSurface?.available;

  ui($('wizFolders'), 'textContent', () => config.roots.length === 0 ? t("None yet") : config.roots.map((r) => `/${r.name}`).join('  '));
  const secureStorageAvailable = next.secureStorage?.available ?? true;
  const apiKey = $<HTMLInputElement>('apiKey');
  ui(apiKey, 'placeholder', () => next.hasApiKey ? t("•••••••• stored") : 'sk-…');
  apiKey.disabled = !secureStorageAvailable;
  paintSetupFields();
  paintSetupProfiles(next);
  ui($('apiKeyState'), 'textContent', () => !secureStorageAvailable
    ? (next.secureStorage?.detail ?? t("Secure credential storage is unavailable."))
    : next.hasApiKey
      ? t("A key is stored with secure OS credential storage. Type a new one to replace it, or use Remove stored API key.")
      : t("Stored with secure OS credential storage. It is never shown again and never leaves this app."));
  $('apiKeyState').classList.toggle('is-warn', !secureStorageAvailable);
  $<HTMLButtonElement>('removeApiKey').disabled = !next.hasApiKey || !secureStorageAvailable;

  const wizConnect = $<HTMLButtonElement>('wizConnect');
  ui(wizConnect, 'textContent', () => disconnecting ? t('Disconnecting…') : running ? t("Disconnect") : t("Connect"));
  wizConnect.disabled = connectBtn.disabled;
  ui($('wizStatus'), 'textContent', () => running || failed || disconnecting ? status.detail || t(STATUS_TEXT[status.state]) : '');

  $('chatgptConn').replaceChildren(
    openai
      ? frag("For the connection, choose ", "Tunnel", " and pick the tunnel you made in step 2.")
      : frag("For the connection, paste the URL below into ", "MCP server URL", '.')
  );

  // Says plainly whether the connector has ever reached this app, because a
  // FORBIDDEN inside one ChatGPT conversation is not the same as a broken setup.
  // The middle case is the one that costs hours: ChatGPT connects and reads the tool
  // list, but the model is never allowed to call anything — Developer mode is off.
  // Every connector this app is publishing that ChatGPT has never reached. Computed here
  // because it decides three things at once: the summary line, whether step 5 counts as
  // done, and whether the cards stay on screen after the wizard tidies itself away.
  const unverified = status.surfaces.filter((surface) => surface.available && surface.lastRequestAt === null);
  const chatgptNote = $('wizChatgpt');
  chatgptNote.classList.toggle(
    'is-warn',
    status.lastRequestAt !== null && (status.lastToolCallAt === null || unverified.length > 0)
  );
  ui(chatgptNote, 'textContent', () => status.lastRequestAt === null
      ? t("ChatGPT has not called this app yet.")
      : status.lastToolCallAt === null
        ? t("ChatGPT connected {0} but has never run a tool. Check Developer mode in ChatGPT → Settings → Security and login.", [ago(status.lastRequestAt)])
        : unverified.length > 0
          ? // One connector working is not the whole setup. Naming the missing one is the
            // difference between "something is off" and knowing what to go and create.
            t("ChatGPT ran a tool {0}, but {1} has never been called — create it in ChatGPT to use it.", [ago(status.lastToolCallAt), unverified
              .map((surface) => `“${surface.connectorName}”`)
              .join(' and ')])
          : t("ChatGPT ran a tool {0} — the whole chain works.", [ago(status.lastToolCallAt)]));

  const cards = $('connectorCards');
  // A connector the user has switched on but never created in ChatGPT is unfinished setup,
  // so its card must survive the tidy collapse instead of disappearing behind "Show all
  // steps" — otherwise a half-done Desktop setup reads as a complete one.
  cards.classList.toggle('has-unfinished', unverified.length > 0);
  const desktopExpanded = cards.querySelector<HTMLDetailsElement>('details')?.open ?? false;
  cards.replaceChildren(...connectorCards(next, desktopExpanded));

  // Step marks: everything before the first unfinished step counts as done.
  const order = ['folder', 'tunnel', 'key', 'connect', 'chatgpt', 'browser'];
  const done = new Set<string>();
  if (config.roots.length > 0 || missingStep(next)?.step !== 'folder') done.add('folder');
  if (!openai || TUNNEL_ID_PATTERN.test(config.tunnel.tunnelId)) done.add('tunnel');
  if (!openai || next.hasApiKey) done.add('key');
  if (connected) done.add('connect');
  // The only honest proof step 5 is finished: ChatGPT has actually called the connectors
  // this app cannot work without. Judged per surface, because a Core request says nothing
  // about whether the Desktop connector was ever created. An optional connector never
  // blocks completion — a user may enable clipboard access and still not want a second
  // connector — but it is reported separately below rather than quietly counted as done.
  const requiredUnverified = status.surfaces.some(
    (surface) => surface.available && !surface.optional && surface.lastRequestAt === null
  );
  if (status.lastRequestAt !== null && !requiredUnverified) done.add('chatgpt');
  // Pairing is durable authorization, not liveness. A token surviving an app restart says
  // only that this extension is allowed to connect; setup is complete when a required browser
  // has actually checked in during this process. If no enabled feature needs the browser,
  // this optional step is hidden and deliberately cannot block the wizard.
  if (!browserRequired || next.bridge.present) done.add('browser');
  const current = order.find((name) => !done.has(name)) ?? null;
  for (const name of order) {
    const node = step(name);
    node.classList.toggle('is-done', done.has(name));
    node.classList.toggle('is-current', name === current);
  }

  // Setup that is finished should stop reading like a to-do list: the instructions
  // collapse away so the page fits without scrolling, and come back on request.
  const allDone = current === null;
  const tidy = showAllSteps === null ? allDone : !showAllSteps;
  $('wizard').classList.toggle('is-tidy', tidy);
  const expand = $<HTMLButtonElement>('wizExpand');
  expand.hidden = false;
  expand.setAttribute('aria-expanded', String(!tidy));
  ui(expand, 'textContent', () => tidy ? t("Show setup guide") : t("Hide setup guide"));

  const needsBinary = config.tunnel.kind !== 'manual';
  ui($('binaryState'), 'textContent', () => !needsBinary
    ? t("Not needed for this method.")
    : next.resolvedBinary
      ? t("Using {0}", [next.resolvedBinary])
      : t("Not found. Install it, or choose the file with Browse."));
  const source = next.runtimeSource;
  const sourceSummary = source
    ? t("Running source · commit {0} · tree {1} · {2}", [
        source.commit.slice(0, 12),
        source.tree.slice(0, 12),
        t(source.dirty ? "dirty" : "clean")
      ])
    : t("Running source · unavailable");
  const activityPrivacy = next.bundledTunnelVersion
    ? t("Recent activity only — no file contents, no credentials. Bundled tunnel-client {0}.", [next.bundledTunnelVersion])
    : t("Recent activity only. File contents and credentials are never recorded.");
  ui($('versionLine'), 'textContent', () => `${sourceSummary} · ${activityPrivacy}`);

  chatApply(next, previousState?.config);

  applying = false;
}

const SURFACE_STATE_TEXT: Record<SurfaceStatus['state'], string> = {
  off: "Not published",
  starting: "Connecting…",
  live: "Published",
  error: "Needs attention"
};

/** One copyable value with its own button, so nothing has to be retyped by hand. */
function copyRow(label: string | (() => string), value: string, what: string): HTMLElement {
  const field = el('div', 'field');
  const input = document.createElement('input');
  input.type = 'text';
  input.readOnly = true;
  input.spellcheck = false;
  input.value = value;
  const button = el('button', 'btn btn-solid');
  (button as HTMLButtonElement).type = 'button';
  button.append(icon('i-copy'), uiText(() => t("Copy")));
  button.addEventListener('click', async () => {
    const copied = await run(api.writeClipboard(value));
    if (copied) toast(t('{0} copied', [t(what)]));
  });
  const row = el('div', 'row-inline');
  row.append(input, button);
  field.append(el('label', '', label), row);
  return field;
}

/**
 * One card per connector, with the exact strings to paste into ChatGPT.
 *
 * The name and the description are offered as copyable text rather than described in
 * prose, because both are load-bearing: ChatGPT matches on the name to address the
 * connector and reads the description to decide whether to load its tools at all. A
 * connector called "my pc" with a description the user invented is one the model may
 * never reach for, and that failure looks exactly like the app being broken.
 */
function connectorCards(next: AppState, desktopExpanded: boolean): HTMLElement[] {
  const { status, config } = next;
  return status.surfaces
    .filter((surface) => surface.id !== 'plugins')
    .map((surface) => {
    const optional = surface.id === 'desktop';
    const waitingForCore = status.state === 'offline' && surface.state === 'error';
    const presentationState: SurfaceStatus['state'] = waitingForCore ? 'starting' : surface.state;
    const card = optional ? document.createElement('details') : el('div');
    card.className = `connector is-${presentationState}`;
    if (optional) (card as HTMLDetailsElement).open = desktopExpanded;

    const head = optional ? document.createElement('summary') : el('div');
    head.className = 'connector-head';
    head.append(
      el('h4', '', surface.connectorName),
      el('span', `tag${surface.optional ? ' is-optional' : ''}`, () => t(surface.optional ? 'optional' : 'required')),
      el('span', `pill is-${presentationState}`, () => t(waitingForCore ? 'Waiting for Core' : SURFACE_STATE_TEXT[presentationState]))
    );
    card.append(head, el('p', 'hint', () => t(surface.cardSummary)));
    if (chatgptNameLine(surface)) card.append(el('p', 'hint', () => chatgptNameLine(surface) ?? ''));

    if (!surface.available) {
      card.append(el('p', 'hint', surface.detail));
      return card;
    }

    card.append(copyRow(() => t("Name"), surface.connectorName, 'Name'));
    card.append(copyRow(() => t("Description"), surface.description, 'Description'));

    // On the OpenAI method the connector is picked from a list of tunnels instead of
    // pasted as a URL, so showing a loopback address there would only mislead.
    const url =
      surface.publicUrl ?? (config.tunnel.kind === 'manual' && !config.tunnel.manualPublicOrigin ? surface.localUrl : null);
    if (url) {
      card.append(copyRow(() => t("MCP server URL"), url, 'URL'));
      card.append(
        el('p', 'hint', () => t("Anyone with this URL can use your enabled tools. Do not share it."))
      );
    } else if (config.tunnel.kind === 'openai') {
      card.append(
        el(
          'p',
          'hint',
          () => (surface.id === 'desktop' && !config.tunnel.desktopTunnelId) || (surface.id === 'plugins' && !config.tunnel.pluginsTunnelId)
            ? t("Pick this connector’s own tunnel — paste its ID in step 2 first.")
            : t("Choose Tunnel, then pick this connector’s tunnel.")
        )
      );
    }

    if (surface.detail && surface.state === 'error') card.append(el('p', waitingForCore ? 'hint' : 'hint is-warn', surface.detail));

    // Published is only half the story. "Live" says this app is serving the connector;
    // it says nothing about whether the user ever created it in ChatGPT, and with two
    // connectors a single app-wide "ChatGPT called us" line cannot tell them apart.
    if (surface.state === 'live') {
      card.append(
        surface.lastRequestAt === null
          ? el('p', 'hint is-warn', () => t("Not created in ChatGPT yet — ChatGPT has never called this connector."))
          : el(
              'p',
              'hint',
              () => surface.lastToolCallAt === null
                ? t("ChatGPT connected {0} but has not run one of its tools yet.", [ago(surface.lastRequestAt)])
                : t("ChatGPT ran one of its tools {0}.", [ago(surface.lastToolCallAt)])
            )
      );
    }

    if (surface.tools.length > 0) {
      card.append(el('p', 'hint', () => t("Tools: {0}", [surface.tools.join(', ')])));
    }
    return card;
    });
}

/**
 * The Health card's plain-fact list: what is actually happening in the background,
 * in the order you would ask about it. A field the tunnel could not report shows a
 * dash rather than a plausible-looking number.
 */
function facts(next: AppState): HTMLElement[] {
  const { status, config } = next;
  const rows: [string, () => string, boolean?][] = [];
  const health = status.health;

  if (isRunning(status.state)) {
    rows.push(['Route to OpenAI', () => health?.route ?? t('Starting…')]);
    rows.push([
      'Poll errors',
      () => health?.pollErrors === null || health?.pollErrors === undefined
        ? '—'
        : String(health.pollErrors),
      (health?.pollErrors ?? 0) > 0
    ]);
    const probe = health?.probe ?? null;
    rows.push([
      'Tunnel → this app',
      () => probe ?? t('Checking…'),
      probe !== null && probe !== 'ok' && probe !== 'success' && probe !== 'healthy'
    ]);
    rows.push(['Tunnel uptime', () => duration(health?.uptimeSeconds ?? null)]);
    // Requests but no tool call is what an account with Developer mode switched off
    // looks like from here, and it is invisible in every other number on this card.
    if (status.lastRequestAt !== null) {
      rows.push([
        'ChatGPT ran a tool',
        () => status.lastToolCallAt === null ? t("never — check Developer mode") : ago(status.lastToolCallAt),
        status.lastToolCallAt === null
      ]);
    }
    if (health?.clientVersion) rows.push(['Tunnel client', () => health.clientVersion!]);
    if (status.localUrl) rows.push(['Local server', () => status.localUrl!.replace(/^https?:\/\//, '')]);
  } else {
    rows.push(['Route to OpenAI', () => t('not running')]);
  }

  rows.push([
    'Tools across Core + Desktop',
    () => t(config.roots.length === 1 ? '{0} total · {1} folder' : '{0} total · {1} folders', [toolsOn(next), config.roots.length])
  ]);

  return rows.map(([label, value, bad]) => {
    const row = el('div', 'fact');
    const code = el('code', bad ? 'is-bad' : '', value);
    // The row is cut to fit, so the full value has to stay reachable somehow.
    ui(code, 'title', value);
    row.append(el('span', '', () => t(label)), code);
    return row;
  });
}

/**
 * Repaints only what ages: the two numbers and the header note. Runs every second so
 * "verified 8s ago" keeps counting between reports instead of freezing.
 */
function paintClock(): void {
  if (!state) return;
  const { status } = state;
  const running = isRunning(status.state);
  const connected = status.state === 'connected';

  const handshake = $('bigHandshake');
  handshake.textContent = shortAgo(status.handshakeAt);
  handshake.className = connected ? '' : status.state === 'offline' ? 'is-bad' : 'is-cold';

  const request = $('bigRequest');
  request.textContent = shortAgo(status.lastRequestAt);
  request.className = status.lastRequestAt === null ? 'is-cold' : '';

  ui($('liveNote'), 'textContent', () => running
    ? status.handshakeAt === null
      ? t("no handshake yet")
      : t("verified {0}", [ago(status.handshakeAt)])
    : '');
}

window.setInterval(paintClock, 1000);

function step(name: string): HTMLElement {
  return document.querySelector<HTMLElement>(`[data-step="${name}"]`)!;
}

/** Builds "text <strong>bold</strong> text" without touching innerHTML. */
function frag(before: string, bold: string, after: string): DocumentFragment {
  const f = document.createDocumentFragment();
  f.append(uiText(() => t(before)), el('strong', '', () => t(bold)), uiText(() => t(after)));
  return f;
}

// ------------------------------------------------------------------- log

/**
 * Anything the user might have to act on, counted so problems are never buried.
 *
 * Counted from the rows the feed still holds, not from everything that ever arrived.
 * The feed keeps 500 lines and drops the rest, so a running total drifted away from
 * what the Problems filter could actually show: "4 problems" above an empty list,
 * which reads as the filter being broken rather than as the rows having aged out.
 */
function paintProblems(): void {
  const problems = $('fullFeed').querySelectorAll('p.bad').length;
  for (const id of ['homeProblems', 'logProblems']) {
    const badge = $(id);
    badge.hidden = problems === 0;
    ui(badge, 'textContent', () => t(problems === 1 ? '{0} problem' : '{0} problems', [problems]));
  }
}

/**
 * Splits a log line into a short subject and the rest, so the eye can scan the left
 * column. "tunnel: no such host" and "request POST /mcp → 200" both work.
 */
function splitMessage(message: string): [string, string] {
  const colon = message.indexOf(': ');
  if (colon > 0 && colon <= 24) return [message.slice(0, colon), message.slice(colon + 2)];
  const space = message.indexOf(' ');
  if (space > 0 && space <= 24) return [message.slice(0, space), message.slice(space + 1)];
  return [message, ''];
}

function logRow(entry: LogEntry): HTMLElement {
  const [what, rest] = splitMessage(entry.message);
  const line = el('p', entry.level === 'info' ? '' : 'bad');
  if (entry.agent) line.dataset.agent = entry.agent;
  const time = document.createElement('time');
  // Existing rows follow a UI-language change alongside newly appended rows.
  ui(time, 'textContent', () => new Date(entry.time).toLocaleTimeString(currentLanguage()));
  line.append(time, el('span', 'what', what), el('span', 'rest', rest));
  return line;
}

const FEEDS = ['homeFeed', 'fullFeed'];

/**
 * Whether each feed is following the newest line.
 *
 * Remembered rather than measured on every append, because a feed inside a panel that is
 * not on screen has no geometry to measure: `clientHeight` and `scrollHeight` are both 0,
 * every arriving line looks like it was appended at the bottom, and the pin is written as
 * `scrollTop = 0`. That is exactly what the Activity panel did — every line of a session
 * arrived while Home was showing, so opening Activity landed on the oldest line in the
 * buffer and stayed there. A feed is pinned until the user scrolls it up themselves, and
 * scrolling back to the bottom re-pins it.
 */
const pinned = new Map<string, boolean>(FEEDS.map((id) => [id, true]));

function atBottom(view: HTMLElement): boolean {
  return view.scrollTop + view.clientHeight >= view.scrollHeight - 24;
}

/** Reading scroll height can force layout. Hidden feeds are pinned when shown instead. */
function stickToNewest(id: string): void {
  if (pinned.get(id) === false) return;
  const view = $(id);
  if (!view.closest('.panel')?.classList.contains('is-active')) return;
  view.scrollTop = view.scrollHeight;
}

for (const id of FEEDS) {
  // Only a real user scroll may unpin. `scroll` also fires for the programmatic pin
  // above, which is harmless: that one always lands at the bottom and re-pins.
  $(id).addEventListener('scroll', () => {
    const view = $(id);
    // A hidden panel reports zeroes; never let that be read as "scrolled away".
    if (view.clientHeight === 0) return;
    pinned.set(id, atBottom(view));
  });
}

function addLogLine(entry: LogEntry): void {
  let evicted = false;
  for (const id of FEEDS) {
    const view = $(id);
    const row = logRow(entry);
    // Home always shows everything; only the Activity panel has the agent filter.
    if (id === 'fullFeed' && agentFilter !== null) row.hidden = entry.agent !== agentFilter;
    view.append(row);
    while (view.childElementCount > 500) {
      if (id === 'fullFeed' && view.firstElementChild?.classList.contains('bad')) evicted = true;
      view.firstElementChild?.remove();
    }
    stickToNewest(id);
  }
  // After the eviction above, so the badge counts what is there rather than what arrived.
  // A quiet run of 500 info lines retires old problems just as surely as a new one adds
  // to them, so both directions have to repaint.
  if (entry.level !== 'info' || evicted) paintProblems();
}

$('logFilter').addEventListener('click', (event) => {
  const button = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-filter]');
  if (!button) return;
  for (const other of $('logFilter').querySelectorAll('button')) {
    other.classList.toggle('is-sel', other === button);
  }
  $('fullFeed').classList.toggle('only-bad', button.dataset.filter === 'bad');
  // Hiding most of the rows changes what "the bottom" is, so re-pin rather than leaving
  // the view parked at an offset that now belongs to a line the filter removed.
  stickToNewest('fullFeed');
});

/**
 * Agent filter for the Activity panel.
 *
 * Only exists while a swarm is running: with no workers there is nothing to separate,
 * and the plain single view is the one people already know. null means "All".
 */
let agentFilter: string | null = null;

function applyAgentFilter(): void {
  for (const row of $('fullFeed').querySelectorAll<HTMLElement>('p')) {
    row.hidden = agentFilter !== null && (row.dataset.agent ?? null) !== agentFilter;
  }
}

function paintAgentFilter(swarm: SwarmState): void {
  const box = $('logAgentFilter');
  if (!swarm.running) {
    box.hidden = true;
    box.replaceChildren();
    if (agentFilter !== null) {
      agentFilter = null;
      applyAgentFilter();
    }
    return;
  }
  // Prime first, then workers in creation order — the order the broker reports them.
  const choices: Array<{ id: string | null; label: string }> = [{ id: null, label: t("All") }];
  for (const agent of swarm.agents) choices.push({ id: agent.id, label: agent.label || agent.id });
  if (agentFilter !== null && !swarm.agents.some((agent) => agent.id === agentFilter)) {
    agentFilter = null;
  }
  box.replaceChildren(
    ...choices.map((choice) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = choice.label;
      button.classList.toggle('is-sel', choice.id === agentFilter);
      button.addEventListener('click', () => {
        agentFilter = choice.id;
        paintAgentFilter(swarm);
        applyAgentFilter();
      });
      return button;
    })
  );
  box.hidden = false;
  applyAgentFilter();
}

// --------------------------------------------------------------- wiring

async function addFolder(): Promise<void> {
  const next = await run(api.addRoot());
  if (next) apply(next);
}

async function addWorkspaceFolders(): Promise<void> {
  const next = await run(api.addWorkspaceFolders());
  if (next) apply(next);
}

$('shareAccountFolders').addEventListener('click', () => {
  const button = $<HTMLButtonElement>('shareAccountFolders');
  if (button.disabled || !state) return;
  const enabled = state.config.instances?.sharedFolderAccess?.enabled !== true;
  button.disabled = true;
  void (async () => {
    try {
      const next = await run(api.setSharedFolderAccess(enabled));
      if (next) apply(next);
    } finally { button.disabled = instanceProfiles?.canManageProfiles === false; }
  })();
});

/** Whether a drag carries files at all, which is the only kind the Folders card accepts. */
function dragHasFiles(event: DragEvent): boolean {
  return Array.from(event.dataTransfer?.types ?? []).includes('Files');
}

/** Every dropped entry is offered as a folder; the main process says no to anything else. */
async function dropFolders(event: DragEvent): Promise<void> {
  const files = Array.from(event.dataTransfer?.files ?? []);
  for (const file of files) {
    const next = await run(api.addRootPath(file));
    if (next) apply(next);
  }
}

async function toggleConnection(): Promise<void> {
  if (!state || state.status.state === 'disconnecting') return;
  if (!isRunning(state.status.state) && !(await persistSetupDraftsForConnection())) {
    const missing = state ? missingStep(state) : null;
    if (missing) { showTab('setup'); step(missing.step).scrollIntoView({ block: 'center', behavior: 'smooth' }); }
    return;
  }
  if (!state) return;
  // Mirrors the button label exactly, so a click always does what it says.
  const next = await run(isRunning(state.status.state) ? api.disconnect() : api.connect());
  if (next) apply(next);
}

/** Runs the main-process self-test and lists a line per link in the chain. */
async function runChecks(): Promise<void> {
  const button = $<HTMLButtonElement>('runChecks');
  button.disabled = true;
  ui($('runChecksLabel'), 'textContent', () => t("Checking…"));
  try {
    const result = await run(api.runDiagnostics());
    if (!result) return;
    $('checksSummary').textContent = result.summary;
    $('checkList').replaceChildren(
      ...result.checks.map((check) => {
        const li = el(
          'li',
          check.status === 'pass'
            ? 'check is-ok'
            : check.status === 'fail'
              ? 'check is-bad'
              : `check is-${check.status}`
        );
        const mark = el(
          'span',
          'check-mark',
          check.status === 'pass' ? '✓' : check.status === 'fail' ? '!' : check.status === 'skipped' ? '–' : '…'
        );
        const body = el('div');
        body.append(el('strong', '', check.name), el('p', '', check.detail));
        li.append(mark, body);
        return li;
      })
    );
    $('checksBox').hidden = false;
    $('checksBox').scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  } finally {
    button.disabled = false;
    ui($('runChecksLabel'), 'textContent', () => t("Run checks"));
  }
}

$('runChecks').addEventListener('click', () => void runChecks());
$('requestDesktopAccessibility').addEventListener('click', async () => {
  const button = $<HTMLButtonElement>('requestDesktopAccessibility');
  button.disabled = true;
  try {
    const next = await run(api.requestDesktopAccessibility());
    if (next) apply(next);
  } finally {
    button.disabled = false;
  }
});
$('closeChecks').addEventListener('click', () => {
  $('checksBox').hidden = true;
});

let purgingAllSessions = false;
$('purgeAllSessions').addEventListener('click', async () => {
  if (purgingAllSessions) return;
  const confirmation = window.prompt(
    t('This permanently deletes every local Chat On Steroids chat, sub-agent, unattributed or tool-only record, Trash item, and sidebar folder. ChatGPT website conversations are not deleted. Type DELETE ALL to continue.')
  );
  if (confirmation === null) return;
  if (confirmation !== 'DELETE ALL') {
    toast(t('Nothing was deleted. Type DELETE ALL exactly.'));
    return;
  }

  purgingAllSessions = true;
  const button = $<HTMLButtonElement>('purgeAllSessions');
  const status = $('purgeAllSessionsStatus');
  button.disabled = true;
  ui(button, 'textContent', () => t('Deleting…'));
  ui(status, 'textContent', () => t('Stopping work and deleting local records…'));
  try {
    const result = await run(api.purgeAllSessions(confirmation));
    if (!result) {
      ui(status, 'textContent', () => t('Delete failed. No unconfirmed work was retried.'));
      return;
    }
    ui(status, 'textContent', () =>
      t('Deleted {0} active records, {1} Trash records, and {2} folders.', [
        result.activeRemoved,
        result.trashRemoved,
        result.foldersRemoved
      ])
    );
    toast(t('All local Chat On Steroids records were deleted.'));
  } finally {
    purgingAllSessions = false;
    button.disabled = false;
    ui(button, 'textContent', () => t('Delete everything…'));
  }
});

$('themeBtn').addEventListener('click', () => {
  if (!state) return;
  // A save can still be waiting on main-process lifecycle work. Toggle from the latest
  // requested value, not merely the last acknowledged state, or two quick clicks both choose
  // the same target and behave like one click.
  const current = requestedSettings?.ui.theme ?? state.config.ui.theme;
  const next = current === 'dark' ? 'light' : 'dark';
  // Applied immediately so the click feels instant; the save confirms it.
  document.documentElement.dataset.theme = next;
  void save({ theme: next });
});

$('readOnlyBtn').addEventListener('click', () => {
  if (!state) return;
  const current = requestedSettings?.readOnly ?? state.config.readOnly;
  void save({ readOnly: !current });
});

$('addFolder').addEventListener('click', () => void addFolder());
$('addWorkspaceFolders').addEventListener('click', () => void addWorkspaceFolders());
$('wizAddFolder').addEventListener('click', () => void addFolder());
$('wizManageFolders').addEventListener('click', () => {
  showTab('home');
  $('foldersCard').scrollIntoView({ block: 'nearest' });
  $('addFolder').focus({ preventScroll: true });
});

// Dropping a file anywhere on an Electron window otherwise navigates the whole window to
// it. Only the Folders card accepts drops, and everything else swallows them.
window.addEventListener('dragover', (event) => event.preventDefault());
window.addEventListener('drop', (event) => event.preventDefault());
{
  const card = $('foldersCard');
  card.addEventListener('dragover', (event) => {
    if (!dragHasFiles(event)) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'link';
    card.classList.add('drop-target');
  });
  card.addEventListener('dragleave', (event) => {
    if (!card.contains(event.relatedTarget as Node | null)) card.classList.remove('drop-target');
  });
  card.addEventListener('drop', (event) => {
    event.preventDefault();
    card.classList.remove('drop-target');
    if (dragHasFiles(event)) void dropFolders(event);
  });
}

$('wizExpand').addEventListener('click', () => {
  showAllSteps = $('wizard').classList.contains('is-tidy');
  if (state) apply(state);
});
$('updateGet').addEventListener('click', () => void run(api.openLink(RELEASES_PAGE)));

/**
 * Drain current work, then install the update that is already downloaded.
 *
 * The app quits to do it — that is the only moment an installer can replace files nothing is
 * holding open — so say so before it happens rather than leaving a window that vanishes on a
 * click looking like a crash. Both buttons are the same action; either can be the one pressed.
 */
function installUpdate(): void {
  if ((instanceProfiles?.drain?.kind === 'update' || instanceProfiles?.drain?.kind === 'shutdown') && instanceProfiles.drain.state !== 'idle') return;
  toast(t("Update queued. Chat On Steroids pauses new work, finishes current work, then closes and starts again as the new version."));
  void (async () => {
    const next = await instanceAction(api.installUpdate());
    if (next) applyInstanceProfiles(next);
  })();
}

$('updateInstall').addEventListener('click', installUpdate);
$('installUpdate').addEventListener('click', installUpdate);
$('updateQueueCancel').addEventListener('click', () => {
  void (async () => {
    if (instanceProfileBusy || (instanceProfiles?.drain?.kind !== 'update' && instanceProfiles?.drain?.kind !== 'shutdown')) return;
    instanceProfileBusy = true;
    paintQueuedUpdate();
    try {
      const next = await instanceAction(api.drainInstanceProfile('cancel'));
      if (next) {
        applyInstanceProfiles(next);
        toast(t('Queued update cancelled. New work is allowed again.'));
      }
    } finally {
      instanceProfileBusy = false;
      paintInstanceSwitcher();
      paintInstanceManager();
      paintQueuedUpdate();
    }
  })();
});
$('safeCloseForUpdate').addEventListener('click', () => {
  const button = $<HTMLButtonElement>('safeCloseForUpdate');
  if (button.disabled) return;
  button.disabled = true;
  toast(t('Safe close requested. New work is paused; active work may finish before the app saves state and closes for the external updater.'));
  void (async () => {
    try {
      const next = await instanceAction(api.drainInstanceProfile('shutdown'));
      if (next) applyInstanceProfiles(next);
    } finally {
      button.disabled = false;
    }
  })();
});
$('connectBtn').addEventListener('click', () => void toggleConnection());
$('wizConnect').addEventListener('click', () => void toggleConnection());

$('pickBinary').addEventListener('click', async () => {
  const next = await run(api.pickBinary());
  if (next) apply(next);
});


for (const id of ['copyLog', 'copyLogText']) {
  $(id).addEventListener('click', async () => {
    const text = await run(api.getLogText());
    if (text === null) return;
    const copied = await run(api.writeClipboard(text));
    if (copied) toast('Activity copied');
  });
}

// Reports contain bounded categories and counts, never authored text or raw logs.
let copyingSupportReport = false;
for (const id of ['copySupportReport', 'copySupportReportActivity']) {
  document.getElementById(id)?.addEventListener('click', () => {
    if (copyingSupportReport) return;
    copyingSupportReport = true;
    const buttons = ['copySupportReport', 'copySupportReportActivity']
      .map(value => document.getElementById(value) as HTMLButtonElement | null);
    for (const button of buttons) if (button) { button.disabled = true; button.setAttribute('aria-busy', 'true'); }
    void (async () => {
      const report = await run(api.collectSupportReport());
      if (!report) return;
      if (await run(api.writeClipboard(formatSupportReport(report))))
        toast(report.collection === 'partial' ? 'Diagnostics copied · some checks unavailable' : 'Diagnostics copied');
    })().catch(() => toast('Unable to format diagnostics. Collect a fresh report.')).finally(() => {
      copyingSupportReport = false;
      for (const button of buttons) if (button) { button.disabled = false; button.removeAttribute('aria-busy'); }
    });
  });
}

$('copyLogJson').addEventListener('click', async () => {
  const text = await run(api.getLogJson());
  if (text === null) return;
  const copied = await run(api.writeClipboard(text));
  if (copied) toast('Activity JSON copied');
});

// The API key is written on blur so it is not saved keystroke by keystroke.
for (const id of ['tunnelId', 'apiKey']) $(id).addEventListener('input', paintSetupFields);
function storeSetupApiKeyDraft(): Promise<boolean> {
  const input = $<HTMLInputElement>('apiKey');
  const submitted = input.value;
  if (submitted === '') return Promise.resolve(true);
  const owner = state?.config.tunnel.profileId;
  setupKeySave = (async () => {
    const next = await run(api.setApiKey(submitted, owner));
    if (next) {
    // Do not erase a newer value typed while safeStorage/IPC was still resolving the previous
    // blur. On failure keep the submitted value too, so the user can retry instead of losing it.
      if (state?.config.tunnel.profileId === owner) {
        if (input.value === submitted) input.value = '';
        apply(next);
      }
      toast('API key stored');
    }
    return next !== null;
  })();
  return setupKeySave;
}
$('apiKey').addEventListener('blur', () => { void storeSetupApiKeyDraft(); });

/** Persist valid Setup drafts before Connect; blur/change are only conveniences. */
async function persistSetupDraftsForConnection(): Promise<boolean> {
  if (!state) return false;
  await settingsSaveQueue;
  if (!state) return false;
  if ($<HTMLInputElement>('tunnelId').value.trim() !== state.config.tunnel.tunnelId) await save();
  await settingsSaveQueue;
  if (!state || $<HTMLInputElement>('tunnelId').value.trim() !== state.config.tunnel.tunnelId) return false;
  // Blur immediately before click may already own this write; drain it, then store a newer draft.
  await setupKeySave;
  if ($<HTMLInputElement>('apiKey').value !== '' && !(await storeSetupApiKeyDraft())) return false;
  await setupKeySave;
  return state !== null && missingStep(state) === null;
}

$('removeApiKey').addEventListener('click', async () => {
  const next = await run(api.setApiKey('', state?.config.tunnel.profileId));
  if (next) {
    apply(next);
    toast('API key removed');
  }
});

for (const id of [
  'autoConnect',
  'startAtLogin',
  'keepAwake',
  'minimizeToTray',
  'developerMode',
  'followOutput',
  'privacyScreenshots',
  'tunnelKind',
  'manualPublicOrigin',
  'manualPort',
  'tunnelId',
  'desktopTunnelId'
]) {
  $(id).addEventListener('change', () => void save());
}

document.addEventListener('click', (event) => {
  const link = (event.target as HTMLElement).closest<HTMLElement>('[data-link]');
  if (link?.dataset.link) void run(api.openLink(link.dataset.link));
});

$('bridgeDownload').addEventListener('click', () => void run(api.downloadExtension()));
$('updateExtension').addEventListener('click', () => {
  showAllSteps = true;
  if (state) apply(state);
  showTab('setup');
  step('browser').hidden = false;
  step('browser').scrollIntoView({ block: 'center', behavior: 'smooth' });
});

api.onStateChanged(apply);
api.onLogEntry(addLogLine);
api.onSwarmChanged(paintAgentFilter);
api.onInstanceProfilesChanged(applyInstanceProfiles);
api.onSignOutEmergency?.(notice => { void playSignOutEmergencyAlarm(notice.profileId, notice.profileName); });
api.onSignOutEmergencyCleared?.(notice => { silenceSignOutEmergencyAlarm(notice.profileId); });

async function refresh(): Promise<void> {
  const next = await run(api.getState());
  if (next) apply(next);
}

buildGroups();
initSidebarResize();
initUsage();
initPlugins(apply);
initBrowserPreferences();
initChat({ save: () => save(), state: () => state, account: activeInstanceProfile });

void (async () => {
  void refreshInstanceProfiles();
  await refresh();
  // A first run has nothing set up, so open on the wizard rather than an empty Home.
  showTab(state && missingStep(state)?.step === 'folder' ? 'setup' : 'chat');
  const entries = await run(api.getLog());
  for (const entry of entries ?? []) addLogLine(entry);
  const swarm = await run(api.getSwarm());
  if (swarm) paintAgentFilter(swarm);
})();
