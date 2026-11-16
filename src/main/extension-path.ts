/**
 * Where the Chrome extension lives on this machine.
 *
 * Chrome loads an unpacked extension from a real folder, so the extension cannot live
 * inside the asar — it ships as an extraResource and is copied out verbatim by the
 * package. Development can point Chrome at the repo's own `extension/`, but a packaged
 * build first mirrors `resources/extension` into the app's stable per-user data directory.
 * That extra hop matters on Linux AppImage: `process.resourcesPath` lives in a temporary
 * mount which disappears when the app exits, while Chrome remembers the exact folder used
 * for Load unpacked. The per-user copy keeps that path stable on every desktop OS and is
 * refreshed from the package on every launch/update.
 */

import { existsSync } from 'node:fs';
import path from 'node:path';
import { app } from 'electron';
import { logInfo, logWarn } from './logger.js';

// @ts-expect-error Shared executable JavaScript owner, also used by offline release preparation.
import { materializePackagedExtension, validExtension, companionMaterializedFingerprint as sharedFingerprint } from '../../extension/materialize.mjs';
export function companionMaterializedFingerprint(dir: string | null): string | null {
  return sharedFingerprint(dir);
}

/**
 * One-use page owned by an already-paired unpacked companion.
 *
 * The extension origin is the OS-encrypted origin frozen during pairing; never guess an id or
 * inspect browser profiles. The popup spends the nonce before requesting worker-owned reload.
 * The legacy close marker stays wire-compatible; current popups retain an unconfirmed recovery
 * tab because a reload request or torn-down response channel is not loaded-successor proof.
 */
export function companionReloadUrl(origin: string | null, nonce: string): string | null {
  if (!origin || !/^chrome-extension:\/\/[a-p]{32}\/?$/.test(origin) || !/^[a-zA-Z0-9_-]{1,64}$/.test(nonce)) return null;
  const url = new URL('/popup.html', origin.endsWith('/') ? origin : `${origin}/`);
  url.searchParams.set('clf-reload', '1');
  url.searchParams.set('nonce', nonce);
  url.searchParams.set('close', '1');
  return url.toString();
}

/**
 * The folder to open for chrome://extensions → Load unpacked, or null if it is missing.
 *
 * Packaged first: in an installed build the source tree is not present at all, and in a
 * dev run process.resourcesPath points into Electron's own resources, where there is no
 * extension folder — so the checkout path is what answers there.
 */
let sharedStableExtensionRoot: string | null = null;

/** An isolated account reuses the installed companion already loaded in its Chrome profile. */
export function usePrimaryStableExtensionRoot(canonicalUserDataRoot: string): void {
  if (!path.isAbsolute(canonicalUserDataRoot)) throw new Error('Primary extension root must be absolute');
  sharedStableExtensionRoot = path.resolve(canonicalUserDataRoot);
}

export function extensionDir(): string | null {
  if (app.isPackaged) {
    const bundled = path.join(process.resourcesPath, 'extension');
    const stable = path.join(sharedStableExtensionRoot ?? app.getPath('userData'), 'extension');
    // Isolated profiles may be the only eligible running accounts. Every process
    // joins the same bounded publication lock; no personal account must be launched.
    try {
      return materializePackagedExtension(bundled, stable, { logger: { info: logInfo, warn: logWarn } });
    } catch (error) {
      // Fingerprinting itself can fail if the packaged resource is damaged. A previously
      // materialized extension remains useful and must not be hidden merely because the update
      // source is unreadable.
      const code = (error as NodeJS.ErrnoException)?.code;
      logWarn(`Browser companion package publication could not be verified (${typeof code === 'string' && /^[A-Z0-9_]{1,32}$/.test(code) ? code : 'fingerprint_or_lock_unverified'}); retaining any valid shared copy, not certifying current or loaded bytes.`);
      return validExtension(stable) ? stable : null;
    }
  }

  const candidates = [
    path.join(app.getAppPath(), 'extension'),
    path.join(process.cwd(), 'extension'),
    path.join(process.resourcesPath, 'extension')
  ];
  for (const candidate of candidates) {
    if (existsSync(path.join(candidate, 'manifest.json'))) return candidate;
  }
  return null;
}
