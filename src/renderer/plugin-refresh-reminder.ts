import type { SurfaceId } from '../shared/types.js';

const ACKNOWLEDGED_SCHEMAS_KEY = 'cos.plugins.refreshReminder.acknowledgedSchemas';
const SURFACES: readonly SurfaceId[] = ['core', 'desktop', 'plugins'];
type ConnectorSchemas = Partial<Record<SurfaceId, string>>;
let acknowledgedSchemas: ConnectorSchemas = {};
try {
  const saved = JSON.parse(window.localStorage.getItem(ACKNOWLEDGED_SCHEMAS_KEY) ?? '{}') as unknown;
  if (saved && typeof saved === 'object' && !Array.isArray(saved)) {
    for (const surface of SURFACES) {
      const schemaId = (saved as Record<string, unknown>)[surface];
      if (typeof schemaId === 'string' && schemaId) acknowledgedSchemas[surface] = schemaId;
    }
  }
} catch { /* Acknowledgement still works for this window when storage is unavailable. */ }

function persistAcknowledgement(): void {
  try { window.localStorage.setItem(ACKNOWLEDGED_SCHEMAS_KEY, JSON.stringify(acknowledgedSchemas)); }
  catch { /* Keep the in-memory acknowledgement for this window. */ }
}

/** Schema changes, not version bumps, warrant a reminder. Provider-confirmed refreshes need no action.
 * The first observed schema is a silent baseline; dismissal is UI acknowledgement, never execution proof.
 */
export function paintPluginRefreshReminder(currentSchemas: ConnectorSchemas, confirmedSchemas: ConnectorSchemas = {}): void {
  const notice = document.getElementById('pluginRefreshReminder')!;
  let changed = false;
  let learnedBaseline = false;
  for (const surface of SURFACES) {
    const current = currentSchemas[surface];
    if (!current) continue;
    const acknowledged = acknowledgedSchemas[surface];
    if (confirmedSchemas[surface] === current) {
      if (acknowledged !== current) { acknowledgedSchemas[surface] = current; learnedBaseline = true; }
    } else if (!acknowledged) {
      acknowledgedSchemas[surface] = current;
      learnedBaseline = true;
    } else if (acknowledged !== current) changed = true;
  }
  if (learnedBaseline) persistAcknowledgement();
  notice.hidden = !changed;
  document.getElementById('dismissPluginRefreshReminder')!.onclick = () => {
    for (const surface of SURFACES) {
      const current = currentSchemas[surface];
      if (current) acknowledgedSchemas[surface] = current;
    }
    persistAcknowledgement();
    notice.hidden = true;
  };
}
