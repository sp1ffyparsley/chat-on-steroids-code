import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { connectorApps } from './connector-identity.js';
import { getConfig } from './config.js';
import { profileWorkAdmission } from './work-admission.js';
import { readDurableStrict, writeDurableNow } from './durable.js';
import { wakeBrowserWork } from './browser-wake.js';
import { logInfo, logWarn } from './logger.js';
import { surfaceDeclaredTools } from './mcp/surfaces.js';
import { PLUGIN_MAX_TOOLS } from './plugins/exposure.js';
import type { PluginPublication, PluginRefreshRequest, PluginSurface, PluginToolSchema } from '../shared/plugin-refresh.js';

const app = z.string().regex(/^asdk_app_[a-zA-Z0-9_-]{1,160}$/);
const schemaIdentity = z.string().regex(/^[0-9a-f]{64}$/);
const operatorRearmSchema = z.object({
  receipt: z.string().uuid(),
  rearmedAt: z.number().int().nonnegative(),
  schemaId: schemaIdentity,
  appId: app,
  previousAppId: app.optional(),
  attemptCount: z.number().int().min(0).max(3),
  authorizedAt: z.number().int().nonnegative().nullable()
});
const LEGACY_PLUGIN_MAX_TOOLS = 64;
const rowSchema = z.object({
  surface: z.enum(['core', 'desktop', 'plugins']),
  schemaId: z.string(),
  id: z.string().uuid(),
  appId: app.nullable(),
  connectorName: z.string().min(1).max(64).regex(/^[^\x00-\x1f\x7f]+$/).optional(),
  completedSchemaId: z.string().nullable(),
  attempted: z.boolean(),
  /** Durable click authorizations. This counter is never refunded, even when the page proves it did not click. */
  attemptCount: z.number().int().min(0).max(3).optional().default(0),
  /** Earliest time another exact stale-schema observation may authorize a retry. */
  retryNotBefore: z.number().int().nonnegative().nullable().optional().default(null),
  /** Correlates the latest authorization with receipts from its exact content operation. */
  attemptToken: z.string().uuid().nullable().optional().default(null),
  /** Explicit operator grants. Each receipt can authorize one additional click at most. */
  operatorRearms: z.array(operatorRearmSchema).max(8).optional().default([]),
  manual: z.boolean().optional().default(false),
  error: z.string().max(200).optional(),
  versionId: z.string().max(200).optional()
});
type Row = z.infer<typeof rowSchema>;
export interface PluginConnectorPresence {
  connectorName: string;
  appId: string;
}
const publications = new Map<PluginSurface, PluginPublication>();
const settling = new Map<PluginSurface, { schemaId: string; readyAt: number; timer?: ReturnType<typeof setTimeout> }>();
export interface PluginSurfaceObservation {
  surface: PluginSurface;
  observedAt: number;
  providerConnectorName: string;
  providerSchemaId: string;
  expectedConnectorName: string;
  expectedSchemaId: string;
}
const providerObservations = new Map<PluginSurface, Omit<PluginSurfaceObservation, 'expectedConnectorName'>>();
export const PLUGIN_REFRESH_DEBOUNCE_MS = 20_000;
export const PLUGIN_REFRESH_MAX_ATTEMPTS = 3;
export const PLUGIN_REFRESH_RETRY_BACKOFF_MS = [30_000, 120_000, 300_000] as const;
export const PLUGIN_REFRESH_CONFIRMED_UNCLICKED_RETRY_MS = 5_000;
export const PLUGIN_REFRESH_OPERATOR_REARM_HISTORY = 8;
let chain: Promise<unknown> = Promise.resolve();
function serial<T>(work: () => Promise<T>): Promise<T> { const result = chain.then(work, work); chain = result.catch(() => undefined); return result; }
/** Read-only projection of the last durable provider confirmations; state pushes do no I/O. */
let confirmed: Partial<Record<PluginSurface, string>> = {};
let confirmedLoaded = false;
function remember(current: Row[]): void {
  confirmed = Object.fromEntries(current.flatMap(row => row.completedSchemaId ? [[row.surface, row.completedSchemaId]] : []));
  confirmedLoaded = true;
}
async function save(current: Row[]): Promise<void> {
  await writeDurableNow('plugin-refresh', current);
  remember(current);
}
export function confirmedPluginSchemas(): Partial<Record<PluginSurface, string>> {
  if (!confirmedLoaded) {
    confirmedLoaded = true;
    void serial(rows).catch(() => { confirmedLoaded = false; });
  }
  return { ...confirmed };
}
async function readRows(): Promise<{ raw: unknown; result: Row[] }> {
  try {
    const raw = await readDurableStrict<unknown>('plugin-refresh') ?? [];
    const result = z.array(rowSchema).max(3).parse(raw);
    if (new Set(result.map(row => row.surface)).size !== result.length) {
      throw new Error('Duplicate plugin surface mapping');
    }
    return { raw, result };
  } catch {
    // A corrupt ledger and its parser diagnostics must never become fresh Refresh authority.
    throw new Error('Could not read plugin-refresh state');
  }
}
async function rows(): Promise<Row[]> {
  const { raw, result } = await readRows();
  // Legacy fail() marked discovery failures as clicks. A real claim always commits a
  // concrete appId, so null proves these rows never crossed the refresh boundary.
  let repaired = false;
  for (const [index, row] of result.entries()) {
    const stored = Array.isArray(raw) && raw[index] && typeof raw[index] === 'object' ? raw[index] as Record<string, unknown> : {};
    if (!Object.prototype.hasOwnProperty.call(stored, 'attemptCount')) {
      // A persisted claimed row is an ambiguous historical click authorization. Preserve it as
      // attempt one and require a cooldown; never infer "unclicked" from its diagnostic string.
      row.attemptCount = row.attempted && row.appId !== null ? 1 : 0;
      row.retryNotBefore = row.attemptCount > 0 ? Date.now() + PLUGIN_REFRESH_RETRY_BACKOFF_MS[0] : null;
      row.attemptToken = null;
      repaired = true;
    }
    if (row.attempted && row.appId === null) {
      row.attempted = false; row.attemptCount = 0; row.retryNotBefore = null; row.attemptToken = null; delete row.error; repaired = true;
    }
    if (!row.attempted && row.attemptCount !== 0) {
      row.attemptCount = 0; row.retryNotBefore = null; row.attemptToken = null; repaired = true;
    }
  }
  if (repaired) await save(result);
  remember(result);
  return result;
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value).filter(([, v]) => v !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
  return JSON.stringify(value);
}
const hash = (value: unknown) => createHash('sha256').update(canonical(value)).digest('hex');
const declaration = (tools: PluginToolSchema[]) => tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })).sort((a, b) => a.name.localeCompare(b.name));
function recognizable(tools: unknown, surface: PluginSurface = 'core'): tools is PluginToolSchema[] {
  // The registrar can append one local exec tool to the bounded upstream catalog.
  const surfaceLimit = surface === 'plugins' ? PLUGIN_MAX_TOOLS + 1 : Math.max(16, surfaceDeclaredTools(surface).length);
  if (!Array.isArray(tools) || (!tools.length && surface !== 'plugins') || tools.length > surfaceLimit || JSON.stringify(tools).length > 300000) return false;
  if (tools.some(tool => !tool || typeof tool.name !== 'string' || typeof tool.description !== 'string' || !tool.inputSchema || typeof tool.inputSchema !== 'object')) return false;
  return tools.every(tool => tool.inputSchema.type === 'object') && new Set(tools.map(tool => tool.name)).size === tools.length;
}
function enrollable(tools: unknown, publication: PluginPublication): boolean {
  if (!recognizable(tools, publication.surface)) return false;
  const names = (items: PluginToolSchema[]) => canonical(items.map(tool => tool.name).sort());
  if (names(tools) === names(publication.tools)) return true;
  // Older releases could publish only the first 64 external tools even when the
  // complete catalog fit within the byte budget. During first enrollment, accept
  // that stale Plugins subset (plus optional local exec) only when every installed declaration is an exact
  // declaration from the current publication. A foreign or changed tool still
  // fails closed, and completion below still requires the complete new catalog.
  const legacyCount = tools.length === LEGACY_PLUGIN_MAX_TOOLS ||
    (tools.length === LEGACY_PLUGIN_MAX_TOOLS + 1 && tools.some(tool => tool.name === 'exec'));
  if (publication.surface === 'plugins' && legacyCount && publication.tools.length > tools.length) {
    const expected = new Map(publication.tools.map(tool => [tool.name, hash(declaration([tool]))]));
    return tools.every(tool => expected.get(tool.name) === hash(declaration([tool])));
  }
  // Enabling or disabling Core capabilities can change the set before enrollment.
  // Two unchanged full declarations identify the older known surface; names alone
  // do not, and a foreign tool cannot join that evidence through a matching name.
  return publication.surface === 'core' && tools.every(tool => surfaceDeclaredTools('core').includes(tool.name) || tool.name === 'keep_astra_on_forever') &&
    tools.filter(tool => publication.tools.some(expected => hash(declaration([tool])) === hash(declaration([expected])))).length >= 2;
}
function matches(tools: unknown, expected: PluginToolSchema[], surface: PluginSurface = 'core'): boolean {
  return recognizable(tools, surface) && hash(declaration(tools)) === hash(declaration(expected));
}
function schemaChangeDetails(expectedTools: PluginToolSchema[], observedTools: PluginToolSchema[]) {
  const expected = new Map(expectedTools.map(tool => [tool.name, tool]));
  const observed = new Map(observedTools.map(tool => [tool.name, tool]));
  // A provider declaration can contain prose, paths or malformed names. Surface only bounded
  // identifiers and categories; descriptions and schema values stay in the local comparison.
  const safeName = (name: string) => /^[a-z][a-z0-9_]{0,79}$/.test(name) ? name : '[invalid-name]';
  const changes = [...new Set([...expected.keys(), ...observed.keys()])].sort().flatMap(name => {
    const wanted = expected.get(name), actual = observed.get(name);
    const fields = !wanted ? ['unexpected'] : !actual ? ['missing'] : [
      ...(wanted.description !== actual.description ? ['description'] : []),
      ...(hash(wanted.inputSchema) !== hash(actual.inputSchema) ? ['schema'] : [])
    ];
    return fields.length ? [{ name: safeName(name), fields }] : [];
  });
  return { expectedCount: expected.size, providerCount: observed.size,
    expectedNames: [...expected.keys()].sort().slice(0, 16).map(safeName),
    providerNames: [...observed.keys()].sort().slice(0, 16).map(safeName), changes };
}
function unavailableNativeRefreshReason(surface: PluginSurface, expected: PluginToolSchema[], observed: PluginToolSchema[]): string {
  const differences = schemaChangeDetails(expected, observed);
  const prefix = `${surface.toUpperCase()} schema stale (${differences.expectedCount} expected, ${differences.providerCount} loaded). No native Refresh; recreate or republish app.`;
  const labels = differences.changes.map(change => `${change.name}:${change.fields.join('+')}`);
  const shown: string[] = [];
  for (const label of labels) {
    const candidate = `${prefix} Changes: ${[...shown, label].join(', ')}`;
    if (candidate.length + (shown.length + 1 < labels.length ? 12 : 0) > 200) break;
    shown.push(label);
  }
  const omitted = labels.length - shown.length;
  const suffix = omitted ? ` (+${omitted} more)` : '';
  return `${prefix}${shown.length ? ` Changes: ${shown.join(', ')}` : ''}${suffix}`.slice(0, 200);
}
function noteProviderObservation(row: Row, input: { appId: string; connectorName: string; tools: unknown }): void {
  const publication = publications.get(row.surface);
  if (!publication || !recognizable(input.tools, row.surface)) return;
  // A stable appId is the provider connector identity after enrollment. Before enrollment the
  // exact expected name is the only safe discovery key; a random foreign plugin must not become
  // a Core mismatch merely because the browser happened to inspect it in the same settings page.
  if (row.appId ? row.appId !== input.appId : input.connectorName !== publication.connectorName) return;
  const providerSchemaId = hash(declaration(input.tools));
  const previous = providerObservations.get(row.surface);
  providerObservations.set(row.surface, {
    surface: row.surface,
    observedAt: Date.now(),
    providerConnectorName: input.connectorName.slice(0, 200),
    providerSchemaId,
    expectedSchemaId: publication.schemaId
  });
  if (providerSchemaId === publication.schemaId ||
      (previous?.providerSchemaId === providerSchemaId && previous.expectedSchemaId === publication.schemaId)) return;
  // Diagnostics reuse the existing observation lifetime: repeated polling adds no log/state
  // owner. Only bounded tool identifiers and change categories leave this comparison; never
  // schema values, descriptions, paths, connector names or provider-supplied diagnostic prose.
  const details = schemaChangeDetails(publication.tools, input.tools);
  logWarn(`plugin refresh schema mismatch surface=${row.surface} expectedSchema=${publication.schemaId.slice(0, 12)} providerSchema=${providerSchemaId.slice(0, 12)} ${JSON.stringify({
    expectedCount: details.expectedCount, providerCount: details.providerCount,
    expectedNames: details.expectedNames, providerNames: details.providerNames,
    changes: details.changes.slice(0, 16), omittedChanges: Math.max(0, details.changes.length - 16)
  })}`);
}
export function pluginSurfaceObservation(surface: PluginSurface): PluginSurfaceObservation | null {
  const observed = providerObservations.get(surface);
  const publication = publications.get(surface);
  return observed && publication ? {
    ...observed,
    expectedConnectorName: publication.connectorName,
    expectedSchemaId: publication.schemaId
  } : null;
}
/** Refresh can invalidate existing ChatGPT chats. Only a changed visible tool contract warrants it. */
export function publishPluginSurface(surface: PluginSurface, connectorName: string, _version: string, _instructions: string, tools: PluginToolSchema[]): void {
  const publication = { surface, connectorName, tools, schemaId: hash(declaration(tools)) };
  const previous = settling.get(surface);
  const changed = previous?.schemaId !== publication.schemaId;
  const restored = !publications.has(surface);
  publications.set(surface, publication);
  if (changed) {
    if (previous?.timer) clearTimeout(previous.timer);
    // Initial enrollment is immediate. Changes to an existing declaration wait for
    // the last tool-shape edit, including edits that reconnect the endpoint.
    const next = { schemaId: publication.schemaId, readyAt: previous ? Date.now() + PLUGIN_REFRESH_DEBOUNCE_MS : 0, timer: undefined as ReturnType<typeof setTimeout> | undefined };
    settling.set(surface, next);
    logInfo(`plugin refresh scheduled surface=${surface} schema=${publication.schemaId.slice(0, 12)} delayMs=${previous ? PLUGIN_REFRESH_DEBOUNCE_MS : 0}`);
    if (previous) {
      next.timer = setTimeout(() => {
        next.timer = undefined;
        logInfo(`plugin refresh due surface=${surface} schema=${publication.schemaId.slice(0, 12)} published=${publications.has(surface)}`);
        if (publications.has(surface)) wakeBrowserWork();
      }, PLUGIN_REFRESH_DEBOUNCE_MS);
      next.timer.unref();
    } else wakeBrowserWork();
  } else if (restored && previous.readyAt <= Date.now()) {
    // A reconnect can outlast the debounce. Its timer intentionally skipped the
    // absent surface; restoring that same now-due declaration must deliver the wake.
    wakeBrowserWork();
  }
}
export function unpublishPluginSurface(surface: PluginSurface): void { publications.delete(surface); }
export function pluginRefreshPublications(): PluginPublication[] { return structuredClone([...publications.values()]); }
/** Exact installed Core identity already proven by ChatGPT's plugin settings page. */
export function coreConnectorPresence(): Promise<PluginConnectorPresence | null> {
  return serial(async () => {
    const current = await rows();
    // Publication ownership is in-memory and publish/unpublish is intentionally synchronous,
    // outside the durable-row serial queue. Snapshot it only after the awaited disk read so a
    // republish during that read cannot make an old completed schema look current.
    const publication = publications.get('core');
    const row = current.find(entry => entry.surface === 'core');
    return publication && row?.appId && row.schemaId === publication.schemaId &&
      row.completedSchemaId === row.schemaId
      ? { connectorName: connectorApps().core.find(app => app.appId === row.appId)?.name ?? row.connectorName ?? publication.connectorName, appId: row.appId }
      : null;
  });
}
/** App IDs are stable connector identities. The browser must prove current installation. */
export type PluginRefreshProjection = PluginRefreshRequest & {
  /** This row may prove current declarations, but Main will not authorize another Refresh click. */
  observationOnly?: true;
  /**
   * One exact, unspent operator grant. The browser may use this only to turn over a missing
   * companion owner for this same row; Main still owns and consumes the click authorization.
   */
  operatorRearmReceipt?: string;
  operatorRearmGeneration?: number;
};

export function pendingPluginRefreshes(options: { includeClaimed?: boolean } = {}): Promise<PluginRefreshProjection[]> {
  return serial(async () => {
    const current = await rows();
    let changed = false;
    for (const publication of publications.values()) {
      const found = current.find(row => row.surface === publication.surface);
      if (found?.schemaId === publication.schemaId) continue;
      // An intervening authorization may have changed ChatGPT's declarations without its
      // confirmation reaching us. Returning to an older local schema cannot reuse its receipt.
      const unconfirmed = found?.attempted === true && found.completedSchemaId !== found.schemaId;
      const next: Row = { surface: publication.surface, schemaId: publication.schemaId, id: randomUUID(), appId: found?.appId ?? null, ...(found?.connectorName ? { connectorName: found.connectorName } : {}), completedSchemaId: unconfirmed ? null : found?.completedSchemaId ?? null, attempted: false, attemptCount: 0, retryNotBefore: null, attemptToken: null, operatorRearms: [], manual: false };
      if (found) current[current.indexOf(found)] = next; else current.push(next);
      changed = true;
    }
    if (changed) {
      await save(current);
      logInfo(`plugin refresh pending observed ${current.filter(row => !row.manual && row.completedSchemaId !== row.schemaId).map(row => `surface=${row.surface} schema=${row.schemaId.slice(0, 12)} dueInMs=${Math.max(0, (settling.get(row.surface)?.readyAt ?? 0) - Date.now())}`).join(' ')}`);
    }
    return current.flatMap(row => {
      const publication = publications.get(row.surface);
      // An accepted click is never clicked again automatically. A queued Core input still
      // needs the same exact refresh row to remain observable, though: ChatGPT can finish an
      // asynchronous Refresh after the page's first receipt window. `includeClaimed` lets that
      // demanded owner re-open/reuse its settings page solely to observe and complete the same
      // row; claimPluginRefresh keeps a second stale-schema click fenced below.
      const latestOperatorRearm = row.operatorRearms[row.operatorRearms.length - 1];
      const operatorGrant = latestOperatorRearm?.authorizedAt === null;
      const operatorAttemptSpent = typeof latestOperatorRearm?.authorizedAt === 'number';
      const retryDue = row.attempted && row.retryNotBefore !== null && row.retryNotBefore <= Date.now();
      const demandedObservation = options.includeClaimed === true && row.appId !== null;
      const observable = !row.attempted || retryDue || operatorGrant || demandedObservation;
      // Manual/exhausted is terminal only for click authorization. A user can repair or
      // republish the provider app without changing the local schema, so the exact demanding
      // input must retain a read-only path that can observe current declarations and settle the
      // same row. `claimPluginRefresh` remains the sole click authority and refuses manual or
      // exhausted stale observations; `alreadyCurrent` is exact-schema proof, not another click.
      const observationOnly = row.manual || (!operatorGrant &&
        (row.attemptCount >= PLUGIN_REFRESH_MAX_ATTEMPTS || operatorAttemptSpent));
      return publication && (settling.get(row.surface)?.readyAt ?? 0) <= Date.now() && publication.schemaId === row.schemaId && observable &&
        (!row.manual || demandedObservation) && row.completedSchemaId !== row.schemaId
        ? [{ ...structuredClone(publication), id: row.id, appId: row.appId,
            ...(operatorGrant ? { operatorRearmReceipt: latestOperatorRearm.receipt,
              operatorRearmGeneration: row.operatorRearms.length } : {}),
            ...(observationOnly ? { observationOnly: true as const } : {}) }] : [];
    });
  });
}
type Identity = { id: string; appId: string };
function exact(current: Row[], identity: Identity): Row | undefined {
  if (!app.safeParse(identity.appId).success) return;
  return current.find(row => row.id === identity.id && publications.get(row.surface)?.schemaId === row.schemaId && (settling.get(row.surface)?.readyAt ?? 0) <= Date.now());
}
/** Commit each bounded click authorization before the browser acts. A crash never refunds it. */
export function claimPluginRefresh(input: Identity & { connectorName: string; tools: unknown; alreadyCurrent?: boolean; attemptToken?: string }): Promise<boolean> {
  return serial(async () => {
    const current = await rows(); const row = exact(current, input);
    if (!row || row.completedSchemaId === row.schemaId || !recognizable(input.tools, row.surface)) return false;
    const publication = publications.get(row.surface)!;
    noteProviderObservation(row, input);
    // Unique-name discovery is initial enrollment only. Stale definitions can still
    // identify the surface; the complete post-refresh declarations must match below.
    if (row.appId ? row.appId !== input.appId : input.connectorName !== publication.connectorName || !enrollable(input.tools, publication)) return false;
    if (current.some(other => other !== row && other.appId === input.appId)) return false;
    const isCurrent = matches(input.tools, publication.tools, row.surface);
    if (input.alreadyCurrent === true) {
      if (!isCurrent) return false;
      // This may be the original enrollment or a late observation after one already-claimed
      // Refresh finished outside the page's receipt window. In both cases the provider's exact
      // current declarations, not the old click, are the completion proof.
      row.appId = input.appId;
      if (rowSchema.shape.connectorName.safeParse(input.connectorName).success) row.connectorName = input.connectorName;
      row.completedSchemaId = row.schemaId;
      row.manual = false;
      row.retryNotBefore = null;
      row.attemptToken = null;
      delete row.error;
      await save(current);
      return true;
    }
    if (row.manual || isCurrent || !input.attemptToken || !z.string().uuid().safeParse(input.attemptToken).success) return false;
    const now = Date.now();
    const latestOperatorRearm = row.operatorRearms[row.operatorRearms.length - 1];
    if (latestOperatorRearm?.authorizedAt === null) {
      // The explicit command changed only the existing row's authority. The same companion owner
      // still has to prove this exact app/schema and claim one normal attempt token before acting.
      latestOperatorRearm.authorizedAt = now;
      row.appId = input.appId;
      row.attempted = true;
      if (rowSchema.shape.connectorName.safeParse(input.connectorName).success) row.connectorName = input.connectorName;
      row.retryNotBefore = now + PLUGIN_REFRESH_RETRY_BACKOFF_MS[PLUGIN_REFRESH_RETRY_BACKOFF_MS.length - 1]!;
      row.attemptToken = input.attemptToken;
      delete row.error;
      await save(current);
      logInfo(`plugin refresh operator attempt authorized surface=${row.surface} id=${row.id} receipt=${latestOperatorRearm.receipt}`);
      return true;
    }
    if (typeof latestOperatorRearm?.authorizedAt === 'number') {
      if (row.retryNotBefore !== null && now < row.retryNotBefore) return false;
      row.manual = true;
      row.error = 'The one operator-authorized Refresh attempt remained stale. Repair the provider app before requesting another explicit attempt.';
      await save(current);
      logWarn(`plugin refresh operator attempt exhausted surface=${row.surface} id=${row.id} receipt=${latestOperatorRearm.receipt}`);
      wakeBrowserWork();
      return false;
    }
    if (row.attemptCount >= PLUGIN_REFRESH_MAX_ATTEMPTS) {
      if (row.retryNotBefore !== null && now < row.retryNotBefore) return false;
      row.manual = true;
      row.error = `Refresh remained stale after ${PLUGIN_REFRESH_MAX_ATTEMPTS} bounded attempts. Recreate or republish this custom app before retrying.`;
      await save(current);
      logWarn(`plugin refresh exhausted surface=${row.surface} id=${row.id} attempts=${row.attemptCount}`);
      // The false result remains an explicit denial to click. Wake peers only so they re-read
      // the newly terminal durable state instead of waiting forever on an obligation that no
      // longer appears in pendingPluginRefreshes().
      wakeBrowserWork();
      return false;
    }
    if (row.retryNotBefore !== null && now < row.retryNotBefore) return false;
    row.appId = input.appId;
    row.attempted = true;
    if (rowSchema.shape.connectorName.safeParse(input.connectorName).success) row.connectorName = input.connectorName;
    row.attemptCount += 1;
    row.retryNotBefore = now + (PLUGIN_REFRESH_RETRY_BACKOFF_MS[row.attemptCount - 1] ??
      PLUGIN_REFRESH_RETRY_BACKOFF_MS[PLUGIN_REFRESH_RETRY_BACKOFF_MS.length - 1]!);
    row.attemptToken = input.attemptToken;
    delete row.error;
    await save(current); return true;
  });
}

const REARM_ID_ARG = '--cos-rearm-plugin-refresh=';
const REARM_SCHEMA_ARG = '--cos-rearm-plugin-refresh-schema=';
const REARM_APP_ARG = '--cos-rearm-plugin-refresh-app=';
const REARM_RECEIPT_ARG = '--cos-rearm-plugin-refresh-receipt=';
const REPLACEMENT_APP_ARG = '--cos-rearm-plugin-refresh-replacement=';
type OperatorPluginRefreshRearm = { id: string; schemaId: string; appId: string; receipt: string; replacementAppId?: string };

/** Parse one exact account-process command without depending on Electron's argv ordering. */
export function operatorPluginRefreshRearmRequests(argv: readonly string[]): OperatorPluginRefreshRearm[] {
  const specs = [
    [REARM_ID_ARG, z.string().uuid()],
    [REARM_SCHEMA_ARG, schemaIdentity],
    [REARM_APP_ARG, app],
    [REARM_RECEIPT_ARG, z.string().uuid()]
  ] as const;
  const present = specs.map(([prefix]) => argv.filter(argument => argument.startsWith(prefix)));
  const replacements = argv.filter(argument => argument.startsWith(REPLACEMENT_APP_ARG));
  if (present.every(values => values.length === 0) && replacements.length === 0) return [];
  if (replacements.length > 1) throw new Error('plugin-refresh replacement accepts exactly one app identity');
  if (present.some(values => values.length !== 1)) {
    throw new Error('plugin-refresh rearm accepts exactly one row UUID, schema, app identity, and operation receipt per launch');
  }
  const values = specs.map(([prefix, validator], index) =>
    validator.parse(present[index]![0]!.slice(prefix.length)));
  return [{ id: values[0]!, schemaId: values[1]!, appId: values[2]!, receipt: values[3]!,
    ...(replacements.length ? { replacementAppId: app.parse(replacements[0]!.slice(REPLACEMENT_APP_ARG.length)) } : {}) }];
}

export function operatorPluginRefreshRearmIds(argv: readonly string[]): string[] {
  return operatorPluginRefreshRearmRequests(argv).map(request => request.id);
}

/**
 * Grant one fresh attempt to the existing Core refresh owner.
 *
 * This is deliberately narrower than resetting the row: all automatic attempt evidence remains,
 * the explicit receipt is durable, and the grant is consumed by the next ordinary exact claim.
 * An explicitly pinned replacement requires paused, idle work and retires the old completion
 * proof. Only fresh native declarations for the replacement can enroll it.
 */
export async function rearmCorePluginRefreshByOperator(input: OperatorPluginRefreshRearm): Promise<boolean> {
  const replacing = input.replacementAppId !== undefined;
  const owner = `core-replacement:${randomUUID()}`;
  if (replacing) {
    if (!app.safeParse(input.replacementAppId).success || input.replacementAppId === input.appId ||
        !getConfig().ui.automationPaused || profileWorkAdmission.snapshot().mode !== 'open') return false;
    profileWorkAdmission.beginFinalization(owner, 'replacing exact Core enrollment');
  }
  try {
    if (replacing) {
      const { activeProfileWorkCensus } = await import('./profile-work-state.js');
      if ((await activeProfileWorkCensus()).blockers.length || !getConfig().ui.automationPaused) return false;
    }
    return await serial(async () => {
      const current = await rows();
      const matches = current.filter(row => row.id === input.id);
      const row = matches.length === 1 ? matches[0] : undefined;
      const publication = publications.get('core');
      if (!row || row.surface !== 'core' || !publication || publication.schemaId !== input.schemaId ||
          row.schemaId !== input.schemaId || row.appId !== input.appId ||
          (!replacing && (row.completedSchemaId === row.schemaId || row.manual !== true)) ||
          (replacing && row.completedSchemaId !== row.schemaId) ||
          row.operatorRearms.length >= PLUGIN_REFRESH_OPERATOR_REARM_HISTORY) return false;
      if (!z.string().uuid().safeParse(input.receipt).success ||
          (replacing && (!getConfig().ui.automationPaused || current.some(other => other !== row && other.appId === input.replacementAppId)))) return false;
      if (row.operatorRearms.some(rearm => rearm.receipt === input.receipt)) return false;
      const rearmedAt = Date.now();
      row.operatorRearms.push({
        receipt: input.receipt,
        rearmedAt,
        schemaId: input.schemaId,
        appId: input.replacementAppId ?? input.appId,
        ...(replacing ? { previousAppId: input.appId } : {}),
        attemptCount: row.attemptCount,
        authorizedAt: null
      });
      if (replacing) {
        row.appId = input.replacementAppId!;
        row.completedSchemaId = null;
        row.attemptToken = null;
        row.retryNotBefore = null;
        delete row.connectorName;
        delete row.versionId;
      }
      row.manual = false;
      delete row.error;
      await save(current);
      logInfo(`plugin refresh explicitly rearmed surface=core id=${row.id} replacement=${replacing} schema=${row.schemaId.slice(0, 12)} receipt=${input.receipt}`);
      wakeBrowserWork();
      return true;
    });
  } finally { if (replacing) profileWorkAdmission.release(owner); }
}

/** Terminalize an unspent grant when its one fenced companion-owner turnover cannot be created. */
export function failOperatorPluginRefreshOwner(input: {
  id: string;
  receipt: string;
  generation: number;
  error: string;
}): Promise<boolean> {
  return serial(async () => {
    if (!z.string().uuid().safeParse(input.id).success || !z.string().uuid().safeParse(input.receipt).success ||
        !Number.isSafeInteger(input.generation) || input.generation <= 0) return false;
    const current = await rows();
    const row = current.find(candidate => candidate.id === input.id && candidate.surface === 'core');
    const latest = row?.operatorRearms[row.operatorRearms.length - 1];
    if (!row || row.completedSchemaId === row.schemaId || row.operatorRearms.length !== input.generation ||
        latest?.receipt !== input.receipt || latest.schemaId !== row.schemaId || latest.appId !== row.appId ||
        latest.authorizedAt !== null || row.manual) return false;
    row.manual = true;
    row.error = input.error.slice(0, 200);
    await save(current);
    logWarn(`plugin refresh operator owner turnover failed closed surface=core id=${row.id} receipt=${latest.receipt}`);
    wakeBrowserWork();
    return true;
  });
}

export async function processOperatorPluginRefreshRearms(
  argv: readonly string[],
  rearm: (input: OperatorPluginRefreshRearm) => Promise<boolean> = rearmCorePluginRefreshByOperator
): Promise<{ requested: number; rearmed: number; refused: string[] }> {
  const requests = operatorPluginRefreshRearmRequests(argv);
  let rearmed = 0;
  const refused: string[] = [];
  for (const request of requests) {
    if (await rearm(request)) rearmed += 1;
    else refused.push(request.id);
  }
  return { requested: requests.length, rearmed, refused };
}
/**
 * Records a changed provider snapshot that this ChatGPT workspace cannot refresh in place.
 *
 * This is intentionally neither a completed refresh nor an attempted click. The same schema stays
 * visible as requiring manual recreation/republishing, but automatic browser maintenance stops
 * reopening its settings page. A later local schema change creates a fresh row and may be tried
 * again normally.
 */
export function requireManualPluginRefresh(input: Identity & { connectorName: string; tools: unknown; error: string }): Promise<boolean> {
  return serial(async () => {
    const current = await rows(); const row = exact(current, input);
    if (!row || row.manual || row.completedSchemaId === row.schemaId || !recognizable(input.tools, row.surface)) return false;
    const publication = publications.get(row.surface)!;
    noteProviderObservation(row, input);
    if (row.appId ? row.appId !== input.appId : input.connectorName !== publication.connectorName || !enrollable(input.tools, publication)) return false;
    if (current.some(other => other !== row && other.appId === input.appId) || matches(input.tools, publication.tools, row.surface)) return false;
    // A later exact stale-schema observation can discover that Refresh disappeared or became
    // disabled after an earlier authorization. Preserve the consumed attempts and their latest
    // correlation token; this is a terminal provider-capability verdict, not a retry refund.
    row.appId = input.appId;
    row.manual = true;
    row.error = input.error.startsWith('Connector schema differs, but ChatGPT exposes no Refresh control.')
      ? unavailableNativeRefreshReason(row.surface, publication.tools, input.tools)
      : input.error.slice(0, 200);
    await save(current);
    logWarn(`plugin refresh requires manual action surface=${row.surface}: ${row.error}`);
    return true;
  });
}
export function completePluginRefresh(input: Identity & { tools: unknown; versionId?: string }): Promise<boolean> {
  return serial(async () => {
    const current = await rows(); const row = exact(current, input);
    if (!row || row.manual || !row.attempted || row.appId !== input.appId || !matches(input.tools, publications.get(row.surface)!.tools, row.surface)) return false;
    row.completedSchemaId = row.schemaId; delete row.error;
    if (input.versionId) row.versionId = input.versionId.slice(0, 200);
    await save(current); return true;
  });
}
export function failPluginRefresh(input: { id: string; error: string; appId?: string; attemptToken?: string; confirmedUnclicked?: boolean }): Promise<boolean> {
  return serial(async () => {
    const current = await rows(); const row = current.find(row => row.id === input.id);
    if (!row || publications.get(row.surface)?.schemaId !== row.schemaId || row.completedSchemaId === row.schemaId) return false;
    // Rearming a claimed row requires a live, exact receipt from the same content operation.
    // Error strings are diagnostic only: a later observation can overwrite them after a real
    // click, and a missing receipt must therefore remain fail-closed.
    const latestOperatorRearm = row.operatorRearms[row.operatorRearms.length - 1];
    const claimed = row.attemptCount > 0 || typeof latestOperatorRearm?.authorizedAt === 'number';
    if (claimed && (!row.attempted || row.appId === null || input.appId !== row.appId ||
        row.attemptToken === null || input.attemptToken !== row.attemptToken)) return false;
    if (input.confirmedUnclicked === true && !claimed) return false;
    // Only claimPluginRefresh records an attempted click. Pre-claim failures remain
    // diagnostic errors, distinct from an ambiguous post-click outcome. Existing
    // maintenance may reobserve the same owned page until a claim actually succeeds.
    row.error = input.error.slice(0, 200);
    if (input.confirmedUnclicked === true) {
      // The authorization remains consumed. This receipt only shortens its wait because the
      // exact owner proved button.click() was never invoked; it can never create an infinite loop.
      const shortened = Date.now() + PLUGIN_REFRESH_CONFIRMED_UNCLICKED_RETRY_MS;
      row.retryNotBefore = row.retryNotBefore === null ? shortened : Math.min(row.retryNotBefore, shortened);
      logWarn(`plugin refresh confirmed unclicked surface=${row.surface} id=${row.id} attempts=${row.attemptCount}`);
    }
    await save(current); return true;
  });
}
export function resetPluginRefreshForTests(): void { confirmed = {}; confirmedLoaded = false; for (const row of settling.values()) if (row.timer) clearTimeout(row.timer); settling.clear(); publications.clear(); providerObservations.clear(); chain = Promise.resolve(); }
