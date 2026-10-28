/** One browser startup owner for explicit work and durable recovery. */
import { bridgeStatus, browserDispatchAllowed, browserWakeConnected } from './bridge.js';
import { isPreferredBrowserRunning, openInPreferredBrowser } from './browser.js';
import { getActiveInstanceRuntime, getConfig } from './config.js';

let waking: { lastSeenAt: number | null; selected: string; work: Promise<void>; failed: boolean; finished: boolean } | null = null;
function hasExactIsolatedChromeRoute(): boolean {
  try {
    const profile = getActiveInstanceRuntime().profile;
    return profile.state.mode === 'isolated' && Boolean(profile.browser.profileDirectory) &&
      profile.browser.family === 'chrome' && (getConfig().ui.chatBrowser ?? 'chrome') === 'chrome';
  } catch { return false; }
}
/** Explicit model refresh must not report a successful wake when another Chrome profile is
 * running but this account's companion cannot receive the catalog request. An isolated account
 * with an exact Chrome directory can launch that profile once instead of trusting another. */
export async function assertModelDiscoveryCanWake(): Promise<void> {
  if (browserWakeConnected()) return;
  const running = await isPreferredBrowserRunning();
  if (browserWakeConnected() || running === false || hasExactIsolatedChromeRoute()) return;
  if (running === true) throw new Error(
    'Chrome is open, but this account’s companion is not connected. Keep this account’s Chat On Steroids window running and connect Luna Forge X7 Companion in its Chrome profile'
  );
  throw new Error('Could not verify the Chrome process or this account’s companion. Check the selected Chrome profile and retry');
}
/** One browser startup per absence episode, shared by authored sends, discovery and owed recovery. */
export async function wakeBrowserUrl(url: string, retry = false, backgroundStartup = false,
  authority?: { current(): boolean }): Promise<void> {
  const current = () => browserDispatchAllowed() && (!authority || authority.current());
  if (!current()) return;
  const browser = await bridgeStatus();
  if (!current()) return;
  if (browserWakeConnected()) { waking = null; return; }
  const selected = getConfig().ui.chatBrowser ?? 'chrome';
  // A generic Chrome process may belong to another account. Only a validated isolated
  // account's exact Chrome directory may bypass the process-absence gate; its successful
  // launch is shared until the companion connects, so retries cannot create tab piles.
  const prior = waking;
  const absent = await isPreferredBrowserRunning() === false;
  const exactIsolatedRoute = hasExactIsolatedChromeRoute();
  // A settings change while the probe yielded revokes that browser's absence evidence.
  if (selected !== (getConfig().ui.chatBrowser ?? 'chrome')) return;
  // The process query yields. Off, a collected reply or a new navigation can revoke
  // the exact recovery meanwhile; a missing socket alone never proves Chrome exited.
  if (!current()) return;
  if (browserWakeConnected()) { waking = null; return; }
  if (!absent && !exactIsolatedRoute) return;
  if (retry && waking === prior && (waking?.failed || (absent && waking?.finished))) waking = null;
  // Until the extension registers, another explicit send belongs to the same startup.
  // A changed browser choice starts a distinct attempt without adopting the old family.
  // Another account's extension can probe this bridge while this Chrome profile is
  // still unpaired. That HTTP timestamp cannot authorize another profile launch.
  if (waking?.selected === selected && (exactIsolatedRoute || waking.lastSeenAt === browser.lastSeenAt)) return waking.work;
  const work = (async () => {
    // The process probe above may outlive a user Disconnect. Recheck the same Core authority at
    // the irreversible OS-open boundary so a stale wake cannot launch Chrome after Disconnect.
    if (!current()) return;
    await (backgroundStartup ? openInPreferredBrowser(url, { backgroundStartup: true }) : openInPreferredBrowser(url));
  })();
  const attempt = { lastSeenAt: browser.lastSeenAt, selected, work, failed: false, finished: false };
  waking = attempt;
  try { await work; } catch (error) { attempt.failed = true; throw error; } finally { attempt.finished = true; }
}
export function resetBrowserStartupForTests(): void { waking = null; }
