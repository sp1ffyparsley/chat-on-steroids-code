import { REASONING_EFFORTS } from '../shared/session.js';
/**
 * Non-secret settings, stored as one small JSON file in the app's userData folder.
 * No database: there are at most a handful of roots and a dozen booleans.
 *
 * Everything read from disk is re-validated, because a hand-edited or corrupted file
 * must not be able to widen permissions or smuggle in a root that was never approved.
 */

import { promises as fs } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { z } from 'zod';
import { manualPublicOriginSchema, manualPortSchema } from '../shared/external-tunnel.js';
import {
  CAPABILITIES,
  CHAT_BROWSERS,
  DEFAULT_CAPABILITIES,
  GOAL_MODES,
  GOAL_PROVIDERS,
  GOAL_REASONING_LEVELS,
  MAX_MULTI_AGENT_WORKERS,
  WRITE_CAPABILITIES,
  type Capabilities,
  DESKTOP_CAPABILITIES,
  type ArtifactSettings,
  type CompactionSettings,
  type Config,
  type GoalSettings,
  type MultiAgentSettings,
  type ProviderAdapterSettings,
  type Root,
  type SessionSettings
} from '../shared/types.js';
import {
  DEFAULT_GOAL_MODEL,
  DEFAULT_GOAL_LOOP_SYSTEM_PROMPT,
  DEFAULT_GOAL_OBJECTIVE_SYSTEM_PROMPT,
  DEFAULT_GOAL_SYSTEM_PROMPT,
  MAX_GOAL_SYSTEM_PROMPT_CHARS,
  SUPERSEDED_GOAL_LOOP_SYSTEM_PROMPTS,
  SUPERSEDED_GOAL_OBJECTIVE_SYSTEM_PROMPTS,
  SUPERSEDED_GOAL_SYSTEM_PROMPTS
} from '../shared/goal.js';
import { logError, logInfo, logWarn } from './logger.js';
import { refreshKeepAwake } from './keep-awake.js';
import { replaceFileAtomically } from './atomic-file.js';
import { RESERVED_ROOT_NAMES, nativePathIdentity, uniqueRootName, validateNewRoot } from './sandbox.js';
import { capabilitiesForPlatform } from './platform.js';
import {
  DEVICE_IDENTITY_FILE,
  loadDeviceIdentity,
  loadOrCreateDeviceIdentity,
  type DeviceIdentity
} from './device-identity.js';
import {
  deriveInstanceOwnerPaths,
  InstanceProfileError,
  instancePlatform,
  instanceProfileRegistrySchema,
  localApprovedRoots,
  migrateLegacyInstanceRegistry,
  parseInstanceRegistry,
  newInstanceConnectorAlias,
  newInstanceConnectorBrand,
  projectConnectorNames,
  reconcileActiveApprovedFolders,
  reconcileSharedApprovedFolders,
  normalizedLocalPath,
  resolveActiveInstance,
  sharedAccountPreferencesSchema,
  sharedAccountPreferencesEnvelopeSchema,
  type SharedAccountPreferences,
  type ActiveInstanceRuntime,
  type InstanceProfile,
  type InstanceProfileRegistry,
  type InstanceOwnerPaths,
  type InstanceRuntimeIdentity
} from '../shared/instance-profile.js';
import { initSecretsPath } from './secrets.js';
import { activateSetupProfile, addInactiveSetupProfile } from './setup-profiles.js';
import type { DeferredProfileSwitch } from './profile-lifecycle.js';
import { assertCanonicalAccountRouting } from './instance-process.js';
import { SKILLS_DIRECTORY_NAME, skillsDirectory } from './skills.js';

/**
 * Defaults for the newer sections, in one place so the schema and defaultConfig()
 * cannot drift apart.
 *
 * Recording starts ON. Everything the app is actually for — the readable timeline, Compact
 * & resume, and agent attribution — reads the recorded history, so an install that starts
 * with it off is an install where the main features silently do nothing. It writes only to
 * this app's own data folder and uploads nothing. Note this changes the default for *new*
 * configs only: an existing config already carries an explicit `record`, and a user who
 * turned it off keeps it off.
 *
 * Existing configs still keep every explicit permission choice. Fresh installs are different:
 * the Home screen is meant to start fully usable, so every tool permission and the agents
 * surface begin enabled. The migration defaults below remain conservative so an upgrade never
 * widens an older config merely because a field did not exist when that config was written.
 */
/**
 * Where the pressure meter turns amber and red.
 *
 * These are measured in *this app's* units — `estimateTokens`, four characters to a token,
 * over the events it kept — and not in whatever ChatGPT counts. The two are not the same
 * number and never will be: the app cannot see the system prompt, the memory, the file
 * attachments or the model's own reasoning, and ChatGPT's counter is private.
 *
 * So the thresholds are calibrated against observed behaviour rather than a published
 * context window. The first pair (180k/200k) was set from the published figure, and a real
 * session then ran past 400k of these units before ChatGPT would take no more — meaning the
 * meter had been demanding a compaction since roughly the halfway mark, for hours, on a
 * chat that was fine. A warning that cries wolf at half the real capacity is a warning
 * people learn to click past, which costs more than having no warning at all.
 *
 * 300k/400k put the amber line where there was still comfortable room to compact and the
 * red line at the point that had actually been seen to fail. In use that was still early:
 * chats sat amber and compacted themselves well before anything was wrong with them, and a
 * threshold that fires on a conversation that is fine costs a fresh chat every time. The
 * window is 400k now, at the figure the ceiling has actually been observed near, and the
 * red line follows it a third further on.
 *
 * All of it remains a setting, because the real ceiling moves with the account, the model
 * and the size of what is attached.
 */
const DEFAULT_CONTEXT_WINDOW = 400_000;
const DEFAULT_SESSIONS: SessionSettings = {
  record: true,
  retainDays: 30,
  advisoryTokens: DEFAULT_CONTEXT_WINDOW,
  // Derived, never typed. The Chat panel writes `limit = threshold × 4/3` on every save,
  // so a default that did not already satisfy that relation would be a state the UI cannot
  // produce: the red line would move the first time anyone opened the panel and saved.
  limitTokens: Math.round((DEFAULT_CONTEXT_WINDOW * 4) / 3)
};

/**
 * The 1.7.1 recalibration, applied once to configs that never chose their own numbers.
 *
 * Raising a default only helps a fresh install: every existing config was written with the
 * old figures spelled out, so it would keep the too-early warning forever. A stored pair
 * that is *exactly* the old defaults was never a decision — it is what the app wrote for
 * itself — so it moves. Anything else the user typed, and it stays put.
 */
const OLD_TOKEN_DEFAULTS = [
  { advisoryTokens: 180_000, limitTokens: 200_000 },
  { advisoryTokens: 300_000, limitTokens: 400_000 }
];
const DEFAULT_COMPACTION: CompactionSettings = {
  // On, at the advisory line.
  //
  // Automatic compaction is edge-triggered since 1.8: an old chat that merely opens above
  // this number does nothing. That is what makes the advisory line usable as the trigger —
  // the crossing turn still finishes and still writes its handoff, rather than the app
  // waiting for a chat that is already over the line and compacting it on sight.
  auto: true,
  autoTokens: DEFAULT_SESSIONS.advisoryTokens
};
/**
 * Default bound for `download_artifact`.
 *
 * 20 MiB covers generated images, PDFs and small archives without letting one call
 * fill the disk or blow the MCP result budget. Enforced before, during and after
 * the stream (see artifact-fetch/artifact-target), so a lying Content-Length helps nothing.
 */
const DEFAULT_ARTIFACTS: ArtifactSettings = {
  maxFileBytes: 20 * 1024 * 1024
};
/** Source-only provider work stays inert until a future product surface explicitly opts in. */
const DEFAULT_PROVIDER_ADAPTERS: ProviderAdapterSettings = {
  antigravity: { enabled: false }
};

/**
 * The goal loop's defaults.
 *
 * Off until explicitly enabled, with ChatGPT as the default response source.
 * API provider/model settings apply only when API is selected; saved choices remain exact.
 */
/**
 * The shipped Goal baseline. Keep the exact OpenRouter model id here rather than a provider
 * fallback or a local alias: changing providers after one failed request would also change the
 * protocol behaviour the Goal loop is validating. Existing user-selected models remain stored
 * verbatim; this value is only the fresh/repair default.
 */
export { DEFAULT_GOAL_MODEL } from '../shared/goal.js';
const DEFAULT_GOAL: GoalSettings = {
  continuationPolicy: 'strict',
  backend: 'chatgpt',
  loopBackend: 'chatgpt',
  impulseMinutes: 0,
  includeToolCalls: false,
  helperModel: 'gpt-6-thinking',
  helperReasoning: 'high',
  enabled: false,
  // The mode a fresh install runs the moment somebody flips the switch. Goal, because it is
  // the one that can end by itself: a loop that never stops is a deliberate choice, not a
  // default anybody should discover by turning something on.
  mode: 'goal',
  // Default for the optional API backend only; ChatGPT does not read this block.
  provider: { kind: 'openrouter', baseUrl: '' },
  model: DEFAULT_GOAL_MODEL,
  reasoning: 'default',
  prompt: DEFAULT_GOAL_SYSTEM_PROMPT,
  objectivePrompt: DEFAULT_GOAL_OBJECTIVE_SYSTEM_PROMPT,
  loopPrompt: DEFAULT_GOAL_LOOP_SYSTEM_PROMPT
};
const DEFAULT_MULTI_AGENT: MultiAgentSettings = {
  enabled: false,
  // A ceiling, not a target. The agents tool tells the model to use only the independently useful
  // workers for the task, while a broad task may scale up to six without another settings edit.
  maxWorkers: MAX_MULTI_AGENT_WORKERS,
  // Upstream does not impose an account-wide scheduler gate. Keep the custom conservative
  // scheduler available without silently slowing existing or newly upgraded installations.
  limitAutomaticChats: false,
  maxActiveChats: 3,
  rotationBatchSize: 5,
  rotationMinutes: 30,
  rotationForegroundSlots: 2,
  rateLimitCooldownMinutes: 1,
  sleepingRuntimeMinutes: 15,
  allowUnattributedCalls: false,
  // Off: Goal/Loop chats are always recovered, and reopening anything else — a worker, a prime,
  // a plain chat that once called a tool — is the user's choice to make.
  recoverAgentTabs: false
};
/** Fresh-install exposure. Kept separate from migration defaults on purpose. */
const ALL_FIRST_LAUNCH_CAPABILITIES: Capabilities = Object.fromEntries(
  CAPABILITIES.map((capability) => [capability, true])
) as Capabilities;
// Unattributed calls start permitted on a fresh install for the same reason recording does:
// the ambiguity fences refuse work when the extension cannot *prove* the caller, and a new
// install is exactly where that evidence path is least likely to be healthy yet. Off, the
// first thing a user sees is CALLER_IDENTITY_REQUIRED; on, the work runs and its activity is
// still labelled Unattributed rather than guessed onto a chat. This relaxes only the fences —
// a positively known dormant/retired/ended worker is refused either way. `DEFAULT_MULTI_AGENT`
// keeps `false` so an upgrade never relaxes an older config merely because the field was
// absent when that config was written.
const FIRST_LAUNCH_MULTI_AGENT: MultiAgentSettings = {
  ...DEFAULT_MULTI_AGENT,
  enabled: true,
  defaultModel: 'gpt-6-thinking',
  defaultReasoning: 'high',
  allowUnattributedCalls: true
};

const rootSchema = z.object({
  name: z
    .string()
    .min(1)
    .max(32)
    .regex(/^[a-z0-9][a-z0-9._-]*$/, 'Root names are lowercase letters, digits, dot, dash, underscore'),
  path: z.string().min(1).max(4096)
});

/**
 * Repairs root names from older/hand-edited configs without ever publishing an ambiguous
 * virtual namespace. Reserved names and duplicates are renamed deterministically in input
 * order, preserving the first usable spelling and suffixing later collisions.
 */
function uniqueStoredRoots(roots: Root[]): Root[] {
  const used = new Set<string>();
  const nextFree = (wanted: string): string => {
    const reserved = RESERVED_ROOT_NAMES.has(wanted);
    const base = reserved ? `${wanted}-folder` : wanted;
    let candidate = base.slice(0, 32);
    for (let suffix = 2; RESERVED_ROOT_NAMES.has(candidate) || used.has(candidate); suffix++) {
      const tail = `-${suffix}`;
      candidate = `${base.slice(0, Math.max(1, 32 - tail.length))}${tail}`;
    }
    return candidate;
  };
  return roots.map((root) => {
    const name = nextFree(root.name);
    used.add(name);
    return name === root.name ? root : { ...root, name };
  });
}

/**
 * Migrates configs written before the tools were consolidated.
 *
 * `powershell` and `command` used to be one tool each and are now the single
 * `exec_command`, so a user who had granted only PowerShell keeps the ability they
 * chose. `deleteFolder` is dropped rather than folded into `deleteFile`: they were never
 * the same permission, and quietly turning one into the other would widen what the user
 * approved. Both keys are removed afterwards so the file stops carrying dead permissions.
 */
function migrateCapabilities(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value;
  const caps = { ...(value as Record<string, unknown>) };
  if (caps['powershell'] === true) caps['command'] = true;
  delete caps['powershell'];
  delete caps['deleteFolder'];
  return caps;
}

/**
 * 2.1.14 briefly accepted seven/eight workers even though the product ceiling moved to six.
 * Those two integers are known-valid legacy settings, not evidence that the whole profile is
 * malformed. Clamp only that old accepted range before strict schema validation; larger,
 * fractional or otherwise invalid values still fail through the ordinary settings path.
 */
function migrateLegacyWorkerCeiling(value: unknown): { value: unknown; changed: boolean } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { value, changed: false };
  const root = value as Record<string, unknown>;
  const multiAgent = root['multiAgent'];
  if (!multiAgent || typeof multiAgent !== 'object' || Array.isArray(multiAgent)) return { value, changed: false };
  const raw = (multiAgent as Record<string, unknown>)['maxWorkers'];
  if (!Number.isSafeInteger(raw) || (raw as number) <= MAX_MULTI_AGENT_WORKERS || (raw as number) > 8) {
    return { value, changed: false };
  }
  return {
    value: { ...root, multiAgent: { ...(multiAgent as Record<string, unknown>), maxWorkers: MAX_MULTI_AGENT_WORKERS } },
    changed: true
  };
}

// Missing capability keys are filled from safe defaults so adding a new optional
// permission in an update never resets an existing user's folders/tunnel settings.
const capabilitiesSchema = z
  .preprocess(
    migrateCapabilities,
    z.object(
      Object.fromEntries(CAPABILITIES.map((c) => [c, z.boolean().optional()])) as Record<
        (typeof CAPABILITIES)[number],
        z.ZodOptional<z.ZodBoolean>
      >
    )
  )
  .transform((caps) => ({ ...DEFAULT_CAPABILITIES, ...caps }) as Capabilities);

/**
 * The user's own MCP instructions.
 *
 * Empty by default, and deliberately so: the connector instructions are how the app explains
 * its own tools, and inventing text on the user's behalf there would put words the app cannot
 * honour in front of the model.
 */
export const MAX_MCP_INSTRUCTIONS_CHARS = 4000;
const DEFAULT_MCP = { instructions: '' } as const;

const configSchema = z.object({
  instances: instanceProfileRegistrySchema.optional(),
  // Top-level optional extension is backward-readable by predecessors' plain Config objects.
  sharedAccountPreferences: sharedAccountPreferencesEnvelopeSchema.optional(),
  // A config written by hand — or by a build before `/skills` was reserved — must not be
  // able to claim a reserved virtual root. Renamed rather than rejected: a single bad root
  // name is not a reason to throw away the whole config and every other approved folder.
  roots: z
    .array(rootSchema)
    .max(32)
    .transform(uniqueStoredRoots),
  capabilities: capabilitiesSchema,
  readOnly: z.boolean(),
  tunnel: z.object({
    profileId: z.string().min(1).max(64).optional(),
    profileName: z.string().trim().min(1).max(80).optional(),
    profileEpoch: z.number().int().nonnegative().optional(),
    kind: z.enum(['openai', 'cloudflared', 'manual']),
    tunnelId: z.string().max(128),
    // Optional with an empty default, so a config written before the connector split
    // loads unchanged and simply has no Desktop tunnel yet — which is also the correct
    // state for it, since the user has not created that connector in ChatGPT either.
    desktopTunnelId: z.string().max(128).optional().default(''),
    pluginsTunnelId: z.string().max(128).optional().default(''),
    binaryPath: z.string().max(4096),
    manualPublicOrigin: manualPublicOriginSchema.optional(),
    manualPort: manualPortSchema.optional(),
    manualEndpointRevision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional()
  }),
  setupProfiles: z.array(z.object({
    id: z.string().min(1).max(64), name: z.string().trim().min(1).max(80),
    tunnelId: z.string().max(128), desktopTunnelId: z.string().max(128), pluginsTunnelId: z.string().max(128)
  })).max(31).refine(rows => new Set(rows.map(row => row.id)).size === rows.length, 'Duplicate setup profile').optional(),
  ui: z.object({
    chatBrowser: z.enum(CHAT_BROWSERS).optional().default('chrome'),
    developerMode: z.boolean().optional(),
    followOutput: z.boolean().optional().default(true),
    finishTool: z.boolean().optional(),
    planBackend: z.enum(['chatgpt', 'api']).optional(),
    finishAction: z.enum(['notify', 'goal']).optional(),
    finishLeadMinutes: z.number().int().min(3).max(5).optional(),
    rotateTurnMinutes: z.number().int().min(0).max(120).optional().default(30).catch(30),
    backgroundChats: z.boolean().optional().default(true),
    browserOnly: z.boolean().optional().default(false),
    automationPaused: z.boolean().optional().default(false),
    automationProfile: z.enum(['day', 'overnight', 'rotation']).optional().default('day'),
    autoRefreshPlugins: z.boolean().optional().default(false),
    signOutEmergencyAlerts: z.boolean().optional().default(false),
    tabsToKeepOpen: z.number().int().min(1).max(50).optional(),
    minimizeToTray: z.boolean(),
    autoConnect: z.boolean(),
    startAtLogin: z.boolean().optional().default(false),
    keepAwake: z.boolean().optional().default(true),
    privacyScreenshots: z.boolean().optional().default(false),
    // Dark is the design the app is drawn for, and a config written before the theme
    // existed has no stored answer to override — so it is the default rather than the
    // fallback. An explicit `light` is somebody's own choice and is never touched.
    theme: z.enum(['light', 'dark']).optional().default('dark')
  }),
  noticeState: z.object({
    signOutEmergency: z.object({
      id: z.string().uuid(),
      profileId: z.string().min(1).max(64),
      observedAt: z.number().int().nonnegative(),
      receipt: z.string().regex(/^[A-Za-z0-9]{30}$/).optional(),
      cancelRequested: z.boolean().optional()
    }).optional()
  }).optional(),
  // Whole sections are optional, so a config written by an older build keeps working
  // and simply gains the new features switched off. The default object is spelled out
  // rather than left as {} because zod 4 returns a default as-is instead of parsing it.
  sessions: z
    .object({
      record: z.boolean().optional().default(DEFAULT_SESSIONS.record),
      retainDays: z.number().int().min(0).max(3650).optional().default(DEFAULT_SESSIONS.retainDays),
      advisoryTokens: z
        .number()
        .int()
        .min(10_000)
        .max(4_000_000)
        .optional()
        .default(DEFAULT_SESSIONS.advisoryTokens),
      limitTokens: z.number().int().min(10_000).max(4_000_000).optional().default(DEFAULT_SESSIONS.limitTokens)
    })
    .optional()
    .default({ ...DEFAULT_SESSIONS }),
  compaction: z
    .object({
      auto: z.boolean().optional().default(DEFAULT_COMPACTION.auto),
      // The floor is high enough that the threshold cannot be set somewhere a fresh chat
      // is already past, which would compact every conversation the moment it started.
      autoTokens: z
        .number()
        .int()
        .min(10_000)
        .max(4_000_000)
        .optional()
        .default(DEFAULT_COMPACTION.autoTokens)
    })
    .optional()
    .default({ ...DEFAULT_COMPACTION }),
  multiAgent: z
    .object({
      enabled: z.boolean().optional().default(DEFAULT_MULTI_AGENT.enabled),
    defaultModel: z.string().max(80).optional(),
      defaultReasoning: z.enum(['', ...REASONING_EFFORTS]).optional(),
      maxWorkers: z.number().int().min(1).max(MAX_MULTI_AGENT_WORKERS).optional().default(DEFAULT_MULTI_AGENT.maxWorkers),
      limitAutomaticChats: z.boolean().optional().default(DEFAULT_MULTI_AGENT.limitAutomaticChats),
      maxActiveChats: z.number().int().min(1).max(16).optional().default(DEFAULT_MULTI_AGENT.maxActiveChats),
      rotationBatchSize: z.number().int().min(1).max(16).optional().default(DEFAULT_MULTI_AGENT.rotationBatchSize),
      rotationMinutes: z.number().int().min(5).max(1440).optional().default(DEFAULT_MULTI_AGENT.rotationMinutes),
      rotationForegroundSlots: z.number().int().min(0).max(3).optional().default(DEFAULT_MULTI_AGENT.rotationForegroundSlots),
      rateLimitCooldownMinutes: z.number().int().min(1).max(30).optional().default(DEFAULT_MULTI_AGENT.rateLimitCooldownMinutes),
      sleepingRuntimeMinutes: z.number().int().min(1).max(1440).optional().default(DEFAULT_MULTI_AGENT.sleepingRuntimeMinutes),
      allowUnattributedCalls: z.boolean().optional().default(DEFAULT_MULTI_AGENT.allowUnattributedCalls),
      recoverAgentTabs: z.boolean().optional().default(DEFAULT_MULTI_AGENT.recoverAgentTabs)
    })
    .optional()
    .default({ ...DEFAULT_MULTI_AGENT }),
  artifacts: z
    .object({
      maxFileBytes: z
        .number()
        .int()
        .min(1)
        .max(256 * 1024 * 1024)
        .optional()
        .default(DEFAULT_ARTIFACTS.maxFileBytes)
    })
    .optional()
    .default({ ...DEFAULT_ARTIFACTS }),
  providerAdapters: z
    .object({
      antigravity: z
        .object({ enabled: z.boolean().optional().default(false) })
        .optional()
        .default({ ...DEFAULT_PROVIDER_ADAPTERS.antigravity })
    })
    .optional()
    .default({ antigravity: { ...DEFAULT_PROVIDER_ADAPTERS.antigravity } })
    .catch({ antigravity: { ...DEFAULT_PROVIDER_ADAPTERS.antigravity } }),
  // An empty model id is repaired rather than rejected: the id is free text from a
  // provider listing that changes weekly, and a config that lost it must still load with
  // every root and permission in it intact.
  goal: z
    .object({
      impulseMinutes: z.number().int().min(0).max(60).optional().default(0).catch(0),
      includeToolCalls: z.boolean().optional().default(false),
      enabled: z.boolean().optional().default(DEFAULT_GOAL.enabled),
      backend: z.enum(['api', 'chatgpt', 'templates']).optional().default('chatgpt'),
      loopBackend: z.enum(['api', 'chatgpt']).optional().default('chatgpt'),
      continuationPolicy: z.enum(['strict', 'settled-turn']).optional().default('strict').catch('strict'),
      helperModel: z.string().trim().min(1).max(80).optional().default(DEFAULT_GOAL.helperModel!).catch(DEFAULT_GOAL.helperModel!),
      helperReasoning: z.enum(REASONING_EFFORTS).optional().default(DEFAULT_GOAL.helperReasoning!).catch(DEFAULT_GOAL.helperReasoning!),
      // Repaired rather than rejected for the same reason `reasoning` below is: a config
      // written by a version that knows one more mode than this one must not send every root
      // and permission in the file through conservative recovery over a single word.
      mode: z.enum(GOAL_MODES).optional().default(DEFAULT_GOAL.mode).catch(DEFAULT_GOAL.mode),
      provider: z
        .object({
          // Repaired rather than rejected like `mode` above: a config written by a version
          // that knows one more provider than this one must not invalidate every root and
          // permission in the file over a single word.
          kind: z.enum(GOAL_PROVIDERS).optional().default('openrouter').catch('openrouter'),
          // Stored verbatim and validated at draft time: a URL cannot be repaired the way an
          // enum can, and silently rewriting it would point a key at a host nobody chose.
          baseUrl: z.string().max(2048).optional().default('')
        })
        .optional()
        .default({ ...DEFAULT_GOAL.provider }),
      model: z
        .string()
        .max(160)
        .optional()
        .default(DEFAULT_GOAL.model)
        .transform((model) => (model.trim() === '' ? DEFAULT_GOAL.model : model.trim())),
      // Repaired for the same reason, and one this section is specifically exposed to: the
      // set of levels is a provider's vocabulary, so a config written by a version that
      // knows one more of them than this one does is a config this app will meet. Rejecting
      // it would send the whole file — every root, every permission — through conservative
      // recovery over a word in one field nobody would miss.
      reasoning: z
        .enum(GOAL_REASONING_LEVELS)
        .optional()
        .default(DEFAULT_GOAL.reasoning)
        .catch(DEFAULT_GOAL.reasoning),
      // Existing configs predate the editor, and a hand-edited blank prompt must not turn
      // Goal Mode into an unconstrained continuation model. Both adopt the strong default.
      prompt: z
        .string()
        .max(MAX_GOAL_SYSTEM_PROMPT_CHARS)
        .optional()
        .default(DEFAULT_GOAL.prompt)
        .transform((prompt) => (prompt.trim() === '' ? DEFAULT_GOAL.prompt : prompt.trim()))
        .catch(DEFAULT_GOAL.prompt),
      // Repaired exactly like `prompt` above, and for the same reason: a config predating the
      // second editor, or hand-edited to blank, must not leave the goal driver running with no
      // instruction at all. Both fall back to the shipped default rather than to emptiness.
      objectivePrompt: z
        .string()
        .max(MAX_GOAL_SYSTEM_PROMPT_CHARS)
        .optional()
        .default(DEFAULT_GOAL.objectivePrompt)
        .transform((prompt) =>
          prompt.trim() === '' ? DEFAULT_GOAL.objectivePrompt : prompt.trim()
        )
        .catch(DEFAULT_GOAL.objectivePrompt),
      // The third editor, repaired exactly like the two above. Loop is the mode that cannot
      // stop on its own, so an empty instruction here would be an unconstrained model typing
      // into somebody's chat forever — the one shape this section must never load in.
      loopPrompt: z
        .string()
        .max(MAX_GOAL_SYSTEM_PROMPT_CHARS)
        .optional()
        .default(DEFAULT_GOAL.loopPrompt)
        .transform((prompt) => (prompt.trim() === '' ? DEFAULT_GOAL.loopPrompt : prompt.trim()))
        .catch(DEFAULT_GOAL.loopPrompt)
    })
    .optional()
    .default({ ...DEFAULT_GOAL, backend: 'chatgpt', loopBackend: 'chatgpt', continuationPolicy: 'strict', impulseMinutes: 0,
      includeToolCalls: false, helperModel: DEFAULT_GOAL.helperModel!, helperReasoning: DEFAULT_GOAL.helperReasoning! }),
  mcp: z
    .object({
      // Repaired rather than rejected, like the Goal prompts above: this is free text a person
      // typed, and one over-long or malformed field must not send the whole config — every
      // root, every permission — through conservative recovery.
      instructions: z
        .string()
        .optional()
        .default(DEFAULT_MCP.instructions)
        .transform((value) => value.slice(0, MAX_MCP_INSTRUCTIONS_CHARS).trim())
        .catch(DEFAULT_MCP.instructions)
    })
    .optional()
    .default({ ...DEFAULT_MCP })
    .catch({ ...DEFAULT_MCP })
}).superRefine((config, context) => {
  const envelope = config.sharedAccountPreferences, policy = config.instances?.sharedFolderAccess;
  if (envelope && (!policy || envelope.platform !== policy.platform || envelope.deviceId !== policy.deviceId || envelope.revision !== policy.revision))
    context.addIssue({ code: 'custom', path: ['sharedAccountPreferences'], message: 'Shared preferences are not bound to the current local folder-policy revision.' });
});

/** Read-only migration of the uninstalled nested prototype; no sibling or raw-runtime write. */
function migrateSharedAccountPreferences(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const config = value as Record<string, unknown>;
  const registry = config.instances && typeof config.instances === 'object' && !Array.isArray(config.instances)
    ? config.instances as Record<string, unknown> : null;
  const policy = registry?.sharedFolderAccess && typeof registry.sharedFolderAccess === 'object' && !Array.isArray(registry.sharedFolderAccess)
    ? registry.sharedFolderAccess as Record<string, unknown> : null;
  let migrated = config;
  if (policy && Object.prototype.hasOwnProperty.call(policy, 'commonPreferences')) {
    const parsed = sharedAccountPreferencesEnvelopeSchema.safeParse({ version: 1, platform: policy.platform,
      deviceId: policy.deviceId, revision: policy.revision, preferences: policy.commonPreferences });
    const existing = config.sharedAccountPreferences === undefined ? null : sharedAccountPreferencesEnvelopeSchema.safeParse(config.sharedAccountPreferences);
    if (!parsed.success || existing && (!existing.success || JSON.stringify(existing.data) !== JSON.stringify(parsed.data)))
      throw new InstanceProfileError('malformed_profile', 'Invalid or conflicting shared preference snapshots require explicit reconciliation; no settings were changed.');
    const { commonPreferences: _prototype, ...compatiblePolicy } = policy;
    migrated = { ...config, sharedAccountPreferences: parsed.data, instances: { ...registry, sharedFolderAccess: compatiblePolicy } };
  }
  if (migrated.sharedAccountPreferences !== undefined) {
    const parsed = sharedAccountPreferencesEnvelopeSchema.safeParse(migrated.sharedAccountPreferences);
    if (!parsed.success || !policy || parsed.data.platform !== policy.platform || parsed.data.deviceId !== policy.deviceId || parsed.data.revision !== policy.revision)
      throw new InstanceProfileError('malformed_profile', 'Shared preferences are not a valid current local folder-policy snapshot; no settings were changed.');
  }
  return migrated;
}

/**
 * Fresh-install Desktop exposure differs by host. Windows starts the Desktop group on. Other
 * hosts start it **off** so adding cross-platform browser tools does not silently widen an
 * existing first-run permission policy. A user may explicitly enable browser screen/control on
 * Linux; native clipboard remains masked there, and macOS native automation still needs System
 * Settings consent. Stored choices survive platform moves.
 */
function firstLaunchCapabilities(platform: NodeJS.Platform, release?: string): Capabilities {
  const capabilities = capabilitiesForPlatform({ ...ALL_FIRST_LAUNCH_CAPABILITIES }, platform, release);
  if (platform !== 'win32') for (const capability of DESKTOP_CAPABILITIES) capabilities[capability] = false;
  return capabilities;
}

export function defaultConfig(platform: NodeJS.Platform = process.platform, release?: string): Config {
  return {
    roots: [],
    capabilities: firstLaunchCapabilities(platform, release),
    readOnly: false,
    tunnel: { kind: 'openai', tunnelId: '', desktopTunnelId: '', binaryPath: '' },
    ui: { minimizeToTray: true, autoConnect: false, startAtLogin: false, keepAwake: true, privacyScreenshots: false, theme: 'dark', autoRefreshPlugins: false, signOutEmergencyAlerts: false, backgroundChats: true, automationPaused: false, automationProfile: 'day', followOutput: true, rotateTurnMinutes: 30 },
    sessions: { ...DEFAULT_SESSIONS },
    compaction: { ...DEFAULT_COMPACTION },
    multiAgent: { ...FIRST_LAUNCH_MULTI_AGENT },
    artifacts: { ...DEFAULT_ARTIFACTS },
    providerAdapters: { antigravity: { ...DEFAULT_PROVIDER_ADAPTERS.antigravity } },
    goal: { ...DEFAULT_GOAL },
    mcp: { ...DEFAULT_MCP }
  };
}

/**
 * Recovery for a config file that exists but cannot be trusted.
 *
 * A missing file is a real first launch and intentionally gets the fully-enabled defaults
 * above. A malformed/corrupt existing file is different: treating damage as consent would
 * widen filesystem/desktop/process access merely because parsing failed. Keep that path on
 * the historical narrow capability set and read-only mode until the user saves settings again.
 */
function conservativeRecoveryConfig(): Config {
  return {
    ...defaultConfig(),
    capabilities: { ...DEFAULT_CAPABILITIES },
    readOnly: true,
    multiAgent: { ...DEFAULT_MULTI_AGENT },
    // A config file that could not be trusted is not consent to have a second model typing
    // into the user's chat, whatever the unreadable file said.
    goal: { ...DEFAULT_GOAL }
  };
}

/**
 * Repairs feature combinations that cannot work, without silently widening privacy settings.
 *
 * Goal Mode reads the local session transcript to decide whether another user turn is needed;
 * `/goal/draft` explicitly refuses a chat with no recorded session. Enabling recording behind
 * the user's back would be a privacy surprise, so the only safe repair is to keep recording off
 * and turn Goal off with it. Keeping this at the config boundary covers renderer, extension and
 * hand-edited/older config writers alike.
 */
function enforceFeatureDependencies(config: Config): Config {
  if (config.sessions.record || !config.goal.enabled) return config;
  return { ...config, goal: { ...config.goal, enabled: false } };
}

/**
 * Moves any exactly-as-shipped Goal prompt, from any past version, onto the current default.
 *
 * All three prompts — the gate, the driver and the loop — are editable and persisted, so
 * changing a source constant alone would leave an existing untouched install on the old
 * behaviour forever. Exact equality is the fence: any user customization, even a one-character
 * change, is preserved verbatim. Each list is walked rather than compared against one
 * predecessor, so an install that skipped a release still migrates instead of being stranded on
 * a default two generations old.
 */
function adoptCurrentGoalPrompt(config: Config): Config {
  const goal = { ...config.goal };
  if (SUPERSEDED_GOAL_SYSTEM_PROMPTS.includes(goal.prompt)) goal.prompt = DEFAULT_GOAL_SYSTEM_PROMPT;
  if (SUPERSEDED_GOAL_OBJECTIVE_SYSTEM_PROMPTS.includes(goal.objectivePrompt)) {
    goal.objectivePrompt = DEFAULT_GOAL_OBJECTIVE_SYSTEM_PROMPT;
  }
  if (SUPERSEDED_GOAL_LOOP_SYSTEM_PROMPTS.includes(goal.loopPrompt)) {
    goal.loopPrompt = DEFAULT_GOAL_LOOP_SYSTEM_PROMPT;
  }
  return { ...config, goal };
}

let configPath = '';
let configRoot = '';
let instanceDeviceRoot = '';
let developmentLegacyBridgePort: number | null = null;
const LEGACY_CONFIG_RECOVERY_COPY = 'config.pre-instance-profile-recovery.json';
let current: Config = defaultConfig();
let localDevice: DeviceIdentity | null = null;
let activeInstance: ActiveInstanceRuntime | null = null;
// Every UI mutation ultimately lands in the same tiny JSON file. Keep those
// read-modify-write transactions strictly ordered so two fast checkbox/root changes
// cannot race on config.json.tmp or overwrite each other's newer state.
let mutationQueue: Promise<void> = Promise.resolve();
/**
 * Connection owns the live Core declaration; config owns the approved-root projection.
 * Register one process-local handoff so a real namespace change republishes through that
 * existing owner instead of leaving ChatGPT's exact schema fingerprint frozen until restart.
 */
let approvedRootPublicationRefresh: (() => void) | null = null;

export function configureApprovedRootPublicationRefresh(listener: (() => void) | null): void {
  approvedRootPublicationRefresh = listener;
}

function notifyApprovedRootPublicationRefresh(previousCount: number, nextCount: number): void {
  logInfo(`approved folder namespace changed roots=${previousCount}->${nextCount}; refreshing the Core tool declaration`);
  try {
    approvedRootPublicationRefresh?.();
  } catch (error) {
    // The folder grant is already durable. Do not report its save as failed after publication
    // presentation throws; retain the exact saved namespace and leave a bounded diagnostic so
    // the ordinary connection/apply-settings owner can republish it without reminting access.
    logError(`Core tool declaration refresh failed after approved folders changed: ${(error as Error).message}; reconnect or apply connection settings to retry publication`);
  }
}

export function initConfigPath(userDataDir: string, canonicalUserDataRoot = userDataDir, developmentBridgePort: number | null = null): void {
  const normalized = (value: string): string => {
    const resolved = path.resolve(value);
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
  };
  const rootChanged = (configRoot !== '' && normalized(configRoot) !== normalized(userDataDir)) ||
    (instanceDeviceRoot !== '' && normalized(instanceDeviceRoot) !== normalized(canonicalUserDataRoot));
  if (rootChanged) current = defaultConfig();
  configRoot = userDataDir;
  instanceDeviceRoot = canonicalUserDataRoot;
  developmentLegacyBridgePort = developmentBridgePort;
  configPath = path.join(userDataDir, 'config.json');
  // Instance/device preflight uses the existing encrypted secret owner in the same local root.
  // Keeping this initialization here makes every config caller use that owner without inventing
  // a second profile-secret path. The main bootstrap may call it again with the same root.
  initSecretsPath(userDataDir);
  localDevice = null;
  activeInstance = null;
}

/**
 * Private development userData is a different local bridge identity, not a second endpoint
 * for the installed `local-instance` account. The only caller allowed to arm this is the
 * unpackaged development bootstrap after validating COS_DEV_USER_DATA and its bridge port.
 * Derive an opaque stable ID from that private root, not from the changeable port; no path
 * escapes over /hello and restarting the same dev runtime retains its pairing identity.
 */
export function developmentBrowserBridgeInstanceId(): string | null {
  if (developmentLegacyBridgePort === null) return null;
  const root = path.resolve(configRoot);
  const stableRoot = process.platform === 'win32' ? root.toLowerCase() : root;
  return `dev-${createHash('sha256').update(stableRoot).digest('hex').slice(0, 24)}`;
}

async function instanceRuntimeIdentity(allowCreate: boolean): Promise<InstanceRuntimeIdentity> {
  if (!configRoot) throw new Error('initConfigPath() must name the application data directory first');
  // Config's broad pure/Node test suites do not run inside Electron's main process, where
  // safeStorage exists. Device/secret ownership has its own adapter tests; this deterministic
  // identity keeps those ordinary Node callers focused on config semantics. Every real Electron
  // main process — development and packaged — has process.type === 'browser' and must take the
  // OS-bound path below. No environment variable can opt a product launch out of verification.
  if ((process as NodeJS.Process & { type?: string }).type !== 'browser') {
    localDevice ??= {
      schemaVersion: 1,
      id: '00000000-0000-4000-8000-000000000001',
      platform: instancePlatform(process.platform),
      createdAt: '2000-01-01T00:00:00.000Z'
    };
    return { platform: localDevice.platform, deviceId: localDevice.id, userDataRoot: instanceDeviceRoot };
  }
  localDevice ??= allowCreate
    ? await loadOrCreateDeviceIdentity(instanceDeviceRoot, process.platform, { allowCreate: true })
    : await loadDeviceIdentity(instanceDeviceRoot);
  return { platform: localDevice.platform, deviceId: localDevice.id, userDataRoot: instanceDeviceRoot };
}

async function hasProfileEraDeviceIdentity(): Promise<boolean> {
  if (!instanceDeviceRoot) return false;
  try {
    await fs.access(path.join(instanceDeviceRoot, DEVICE_IDENTITY_FILE));
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

/**
 * The historical loader could run conservatively from an unreadable pre-profile config without
 * rewriting it. Profile migration has to persist a registry, so preserve the exact old bytes
 * before that first recovery write. The fixed single copy is deliberately bounded; if a
 * different damaged file appears later, fail closed rather than overwrite either piece of
 * recovery evidence.
 */
async function preserveLegacyRecoveryConfig(raw: string): Promise<void> {
  const recoveryPath = path.join(configRoot, LEGACY_CONFIG_RECOVERY_COPY);
  try {
    await fs.writeFile(recoveryPath, raw, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
      throw new InstanceProfileError(
        'malformed_profile',
        `The unreadable legacy settings could not be preserved at ${recoveryPath}: ${(error as Error).message}. No migration was written.`
      );
    }
    const existing = await fs.readFile(recoveryPath, 'utf8');
    if (existing !== raw) {
      throw new InstanceProfileError(
        'malformed_profile',
        `A different unreadable legacy settings file is already preserved at ${recoveryPath}. Move or restore it explicitly before retrying; neither file was overwritten.`
      );
    }
  }
}

function canonicalizeInstances(
  config: Config,
  runtime: InstanceRuntimeIdentity
): { config: Config; active: ActiveInstanceRuntime; changed: boolean } {
  const activeTunnelProfile = config.tunnel.profileId ?? 'default';
  let registry = config.instances
    ? parseInstanceRegistry(config.instances)
    : migrateLegacyInstanceRegistry(config.roots, runtime, { tunnelProfileRef: activeTunnelProfile });
  const policy = registry.sharedFolderAccess;
  const sharing = policy?.enabled && policy.platform === runtime.platform && policy.deviceId === runtime.deviceId;
  const roots = sharing ? validatedSharedRoots(policy.roots) : config.roots;
  registry = sharing
    ? reconcileSharedApprovedFolders(registry, runtime)
    : reconcileActiveApprovedFolders(registry, roots, runtime);
  let changed = false;
  if (developmentLegacyBridgePort !== null) {
    const activeProfile = registry.profiles.find(profile => profile.id === registry.activeInstanceId);
    if (activeProfile?.state.mode === 'legacy' && activeProfile.bridge.port !== developmentLegacyBridgePort) {
      registry = parseInstanceRegistry({
        ...registry,
        profiles: registry.profiles.map(profile => profile.id === activeProfile.id
          ? { ...profile, bridge: { ...profile.bridge, port: developmentLegacyBridgePort! } }
          : profile)
      });
      changed = true;
    }
  }
  const active = resolveActiveInstance(registry, runtime, roots);
  if (active.profile.tunnelProfileRef !== activeTunnelProfile) {
    throw new InstanceProfileError(
      'malformed_profile',
      `Active instance ${active.profile.id} expects setup profile ${active.profile.tunnelProfileRef}, but Config currently selects ${activeTunnelProfile}. Select the matching setup explicitly instead of silently crossing tunnel identities.`
    );
  }
  const setupProfiles = new Map<string, {
    tunnelId: string;
    desktopTunnelId: string;
    pluginsTunnelId: string;
  }>();
  setupProfiles.set(activeTunnelProfile, {
    tunnelId: config.tunnel.tunnelId,
    desktopTunnelId: config.tunnel.desktopTunnelId,
    pluginsTunnelId: config.tunnel.pluginsTunnelId ?? ''
  });
  for (const setup of config.setupProfiles ?? []) {
    if (setupProfiles.has(setup.id)) {
      throw new InstanceProfileError(
        'malformed_profile',
        `Setup profile id ${setup.id} is duplicated. Rename or remove the duplicate before selecting an instance.`
      );
    }
    setupProfiles.set(setup.id, setup);
  }
  const tunnelOwners = new Map<string, { instanceId: string; surface: 'Core' | 'Desktop' | 'Plugins' }>();
  for (const profile of registry.profiles) {
    const setup = setupProfiles.get(profile.tunnelProfileRef);
    if (!setup) {
      throw new InstanceProfileError(
        'malformed_profile',
        `Instance ${profile.id} references missing setup profile ${profile.tunnelProfileRef}. Import or create that local setup profile before activating the instance.`
      );
    }
    for (const [surface, rawId] of [
      ['Core', setup.tunnelId],
      ['Desktop', setup.desktopTunnelId],
      ['Plugins', setup.pluginsTunnelId]
    ] as const) {
      const tunnelId = rawId.trim();
      if (!tunnelId) continue;
      const key = tunnelId.toLowerCase();
      const prior = tunnelOwners.get(key);
      if (prior) {
        throw new InstanceProfileError(
          'tunnel_collision',
          `Tunnel id ${tunnelId} is assigned to ${prior.instanceId} ${prior.surface} and ${profile.id} ${surface}. Give every instance connector its own explicit tunnel id.`
        );
      }
      tunnelOwners.set(key, { instanceId: profile.id, surface });
    }
  }
  return { config: { ...config, roots, instances: registry }, active, changed };
}

function isPrimaryConfigOwner(): boolean {
  const normalize = (value: string): string => process.platform === 'win32'
    ? path.resolve(value).toLowerCase() : path.resolve(value);
  return normalize(configRoot) === normalize(instanceDeviceRoot);
}

function validatedSharedRoots(roots: readonly Root[]): Root[] {
  const parsed = roots.map(root => rootSchema.parse(root));
  if (JSON.stringify(uniqueStoredRoots(parsed)) !== JSON.stringify(parsed)) {
    throw new InstanceProfileError('mapping_binding_invalid', 'Shared folders contain reserved or duplicate root aliases. Fix the primary folder list rather than silently renaming an access grant.');
  }
  return parsed;
}

function sameRootSet(left: readonly Root[], right: readonly Root[], runtime: InstanceRuntimeIdentity): boolean {
  const byName = new Map(right.map(root => [root.name, normalizedLocalPath(root.path, runtime.platform)]));
  return left.length === right.length && byName.size === right.length && left.every(root =>
    byName.get(root.name) === normalizedLocalPath(root.path, runtime.platform));
}

/**
 * One read-only canonical catalog for sibling discovery and shared-access reconciliation.
 * The isolated process keeps its own settings/tunnel/secrets; this read never replaces them.
 */
async function readCanonicalConfigFor(config: Config, runtime: InstanceRuntimeIdentity): Promise<Config> {
  if (isPrimaryConfigOwner()) return config;
  const target = path.join(instanceDeviceRoot, 'config.json');
  const info = await fs.lstat(target);
  if (!info.isFile() || info.isSymbolicLink() || info.size > 2 * 1024 * 1024) {
    throw new InstanceProfileError('malformed_profile', 'The primary account settings are not a bounded regular file. Shared access and account routing could not be verified.');
  }
  const parsed = configSchema.parse(migrateSharedAccountPreferences(JSON.parse((await fs.readFile(target, 'utf8')).replace(/^\uFEFF/, ''))));
  const canonical = canonicalizeInstances(parsed, runtime).config;
  const actual = config.instances?.profiles.find(profile => profile.id === config.instances?.activeInstanceId);
  const expected = canonical.instances?.profiles.find(profile => profile.id === actual?.id);
  if (!actual || !expected) {
    throw new InstanceProfileError('missing_active_instance', 'This account is absent from the canonical profile registry. No shared access was granted.');
  }
  assertCanonicalAccountRouting(actual, expected);
  return canonical;
}

/** Validated current primary catalog; never an account switch or a secret-store read. */
export async function readCanonicalInstanceConfig(): Promise<Config> {
  return readCanonicalConfigFor(current, await instanceRuntimeIdentity(false));
}

/** Prepared accounts retain private tunnel settings; the primary setup catalog is insufficient. */
export async function assertActiveSecureTunnelIsolation(settings: Config['tunnel'] = current.tunnel): Promise<void> {
  if (settings.kind !== 'openai') return;
  const active = getActiveInstanceRuntime().profile;
  const canonical = await readCanonicalInstanceConfig();
  const identities = (tunnel: Pick<Config['tunnel'], 'tunnelId' | 'desktopTunnelId' | 'pluginsTunnelId'>) =>
    [tunnel.tunnelId, tunnel.desktopTunnelId, tunnel.pluginsTunnelId ?? ''].map(id => id.trim().toLowerCase()).filter(Boolean);
  const wanted = identities(settings);
  logInfo(`secure tunnel isolation check started account=${active.id} surfaces=${wanted.length}`);
  if (new Set(wanted).size !== wanted.length) throw new InstanceProfileError('tunnel_collision',
    'This account assigns the same Secure MCP tunnel to multiple surfaces. Use distinct tunnel identities.');
  for (const peer of canonical.instances!.profiles) {
    if (peer.id === active.id) continue;
    const owners = getLocalInstanceOwnerPaths(peer.id, canonical.instances!);
    if (!owners) continue;
    let tunnel: Pick<Config['tunnel'], 'tunnelId' | 'desktopTunnelId' | 'pluginsTunnelId'> | undefined =
      peer.tunnelProfileRef === (canonical.tunnel.profileId ?? 'default') ? canonical.tunnel :
        canonical.setupProfiles?.find(setup => setup.id === peer.tunnelProfileRef);
    if (peer.state.mode === 'isolated') {
      const file = path.join(owners.stateRoot, 'runtime', 'config.json');
      let stat;
      try { stat = await fs.lstat(file); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      if (stat) {
        for (const directory of [owners.stateRoot, path.dirname(file)]) {
          const info = await fs.lstat(directory);
          if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Cannot verify a sibling account runtime directory. Secure MCP connection was refused.');
        }
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 2_000_000)
          throw new Error('Cannot verify bounded sibling account settings. Secure MCP connection was refused.');
        const text = await fs.readFile(file, 'utf8');
        if (Buffer.byteLength(text) > 2_000_000) throw new Error('Sibling account settings exceed the verification limit.');
        let config: Config;
        try { config = configSchema.parse(migrateSharedAccountPreferences(JSON.parse(text.replace(/^\uFEFF/, '')))); }
        catch { throw new Error('Cannot parse sibling account settings. Secure MCP connection was refused; inspect that account locally.'); }
        const bound = config.instances?.profiles.find(profile => profile.id === peer.id);
        if (config.instances?.activeInstanceId !== peer.id || !bound ||
            (config.tunnel.profileId ?? 'default') !== peer.tunnelProfileRef)
          throw new Error('Sibling account settings have an unverified profile binding. Secure MCP connection was refused.');
        assertCanonicalAccountRouting(bound, peer);
        tunnel = config.tunnel;
      }
    }
    if (!tunnel) throw new Error('A sibling account has no verified tunnel setup. Secure MCP connection was refused.');
    if (identities(tunnel).some(id => wanted.includes(id))) {
      logWarn(`secure tunnel isolation collision account=${active.id} peer=${peer.id}; connection refused`);
      throw new InstanceProfileError('tunnel_collision',
        `Secure MCP tunnel identity conflicts with account ${peer.id}. Keep the existing route until each account has its own native tunnel.`);
    }
  }
  logInfo(`secure tunnel isolation check completed account=${active.id}`);
}

function projectCanonicalSharedAccess(config: Config, canonical: Config, runtime: InstanceRuntimeIdentity, freshFromDisk = false): Config {
  if (isPrimaryConfigOwner()) return config;
  const policy = canonical.instances?.sharedFolderAccess;
  const previousPolicy = config.instances?.sharedFolderAccess;
  if (!policy) {
    if (previousPolicy) throw new InstanceProfileError('malformed_profile', 'The canonical shared-folder policy disappeared. Restore it or explicitly turn sharing off; historical private access was not restored.');
    return config;
  }
  if (policy.platform !== runtime.platform || policy.deviceId !== runtime.deviceId) return config;
  if (previousPolicy && policy.revision < previousPolicy.revision) {
    throw new InstanceProfileError('mapping_binding_invalid', 'The canonical shared-folder revision moved backwards. Restore current settings before using filesystem tools.');
  }
  // An old reader can strip the optional envelope, or a child can miss the Off boundary.
  // Live projected values are not a private baseline. Only loadConfig may rehydrate that
  // baseline from this account's disk; reject ingress/writes rather than persist stale authority.
  if (!freshFromDisk && previousPolicy?.enabled &&
      config.sharedAccountPreferences && !canonical.sharedAccountPreferences) {
    throw new InstanceProfileError('malformed_profile', 'Shared preference authority disappeared while this account was using shared settings. Reload settings or restart this account to read its saved private baseline, or explicitly reconfigure shared settings in the primary account; no preferences were changed.');
  }
  const profile = canonical.instances!.profiles.find(entry => entry.id === config.instances!.activeInstanceId)!;
  // Off freezes the last shared set exactly once. A later private root choice is intentional,
  // but a pre-sharing private config must not bring old roots back at the disable boundary.
  const adoptRoots = policy.enabled || previousPolicy?.revision !== policy.revision;
  const roots = adoptRoots ? validatedSharedRoots(localApprovedRoots(profile, runtime)) : config.roots;
  // Off freezes the last shared snapshot once at its canonical boundary, like roots.
  // Subsequent explicit private edits at that same disabled revision remain private.
  const preferences = adoptRoots ? canonical.sharedAccountPreferences?.preferences : undefined;
  return {
    ...config,
    ...(preferences ? {
      ui: { ...config.ui, ...preferences.ui,
        privacyScreenshots: config.ui.privacyScreenshots === true || preferences.ui.privacyScreenshots },
      sessions: { ...config.sessions, ...preferences.sessions },
      compaction: { ...config.compaction, ...preferences.compaction },
      multiAgent: { ...config.multiAgent, ...preferences.multiAgent },
      artifacts: { ...config.artifacts, ...preferences.artifacts }
    } : {}),
    roots,
    sharedAccountPreferences: canonical.sharedAccountPreferences,
    instances: {
      ...config.instances!,
      sharedFolderAccess: policy,
      profiles: config.instances!.profiles.map(entry => entry.id === profile.id && adoptRoots
        ? { ...entry, approvedFolders: profile.approvedFolders }
        : entry)
    }
  };
}

async function refreshSharedFolderAccessNow(): Promise<Config> {
  if (isPrimaryConfigOwner()) return current;
  const runtime = await instanceRuntimeIdentity(false);
  const canonical = await readCanonicalConfigFor(current, runtime);
  const projected = projectCanonicalSharedAccess(current, canonical, runtime);
  const reconciled = canonicalizeInstances(projected, runtime);
  const previousRootCount = current.roots.length;
  const previousKeepAwake = current.ui.keepAwake !== false;
  const rootsChanged = !sameRootSet(current.roots, reconciled.config.roots, runtime);
  const changed = rootsChanged ||
    current.instances?.sharedFolderAccess?.revision !== reconciled.config.instances?.sharedFolderAccess?.revision;
  current = reconciled.config;
  activeInstance = reconciled.active;
  if (previousKeepAwake !== (current.ui.keepAwake !== false)) refreshKeepAwake();
  if (changed) logInfo(`shared folder access refreshed revision=${current.instances?.sharedFolderAccess?.revision ?? 0} roots=${current.roots.length}`);
  if (rootsChanged) notifyApprovedRootPublicationRefresh(previousRootCount, current.roots.length);
  return current;
}

/** Existing ingress/state owners call this before use; no polling or writes to live sibling JSON. */
export function refreshSharedFolderAccess(): Promise<Config> {
  const operation = mutationQueue.then(refreshSharedFolderAccessNow);
  mutationQueue = operation.then(() => undefined, () => undefined);
  return operation;
}

/** Recheck the exact captured namespace at an awaited filesystem mutation's actual-use boundary. */
export async function assertCurrentApprovedRoots(capturedRoots: readonly Root[]): Promise<void> {
  await refreshSharedFolderAccess();
  const policy = current.instances?.sharedFolderAccess;
  // Standalone file adapters supply their own approved namespace. Without a machine
  // sharing policy, this additional fence has no authority to replace that namespace.
  if (!policy) return;
  const runtime = await instanceRuntimeIdentity(false);
  if (!policy || policy.platform !== runtime.platform || policy.deviceId !== runtime.deviceId) return;
  const managedSkills = skillsDirectory();
  const captured = capturedRoots.filter(root => !(root.name === SKILLS_DIRECTORY_NAME && managedSkills &&
    normalizedLocalPath(root.path, runtime.platform) === normalizedLocalPath(managedSkills, runtime.platform)));
  if (!sameRootSet(captured, current.roots, runtime)) {
    throw new InstanceProfileError('mapping_binding_invalid', 'Approved folders changed while this operation was waiting. No filesystem mutation was authorized with the stale namespace; read the current folder list and retry only the unfinished operation.');
  }
}

/** Explicit user opt-in. The primary alone owns the machine grant and its revision. */
export function setSharedFolderAccess(enabled: boolean): Promise<Config> {
  if (!isPrimaryConfigOwner()) return Promise.reject(new Error('Shared folder access must be changed in the primary account window.'));
  return updateConfig(async config => {
    const runtime = await instanceRuntimeIdentity(false);
    if (!config.instances) throw new Error('Instance profile registry is not initialized');
    const previous = config.instances.sharedFolderAccess;
    const sameMachine = previous?.platform === runtime.platform && previous.deviceId === runtime.deviceId;
    if (!sameMachine && !enabled) return config;
    if (sameMachine && previous.enabled === enabled) return config;
    return { ...config, instances: { ...config.instances, sharedFolderAccess: {
      enabled, platform: runtime.platform, deviceId: runtime.deviceId,
      revision: (sameMachine ? previous.revision : 0) + 1,
      roots: validatedSharedRoots(config.roots)
    } }, ...(sameMachine && !enabled && config.sharedAccountPreferences ? { sharedAccountPreferences: {
      ...config.sharedAccountPreferences, revision: previous.revision + 1
    } } : { sharedAccountPreferences: undefined }) };
  }).then(config => {
    logInfo(`shared folder access ${enabled ? 'enabled' : 'disabled'} revision=${config.instances?.sharedFolderAccess?.revision ?? 0} roots=${config.roots.length}`);
    return config;
  });
}

/** Capture only the strict reusable preference contract; account-owned fields never enter it. */
function sharedAccountPreferences(config: Config): SharedAccountPreferences {
  const { theme = 'dark', developerMode, followOutput = true, minimizeToTray, backgroundChats = true,
    tabsToKeepOpen, privacyScreenshots = false, keepAwake = true } = config.ui;
  const { advisoryTokens, limitTokens } = config.sessions;
  const { maxWorkers, limitAutomaticChats, maxActiveChats, rotationBatchSize, rotationMinutes,
    rotationForegroundSlots, sleepingRuntimeMinutes } = config.multiAgent;
  return sharedAccountPreferencesSchema.parse({ version: 1,
    ui: { theme, developerMode, followOutput, minimizeToTray, backgroundChats, tabsToKeepOpen, privacyScreenshots, keepAwake },
    sessions: { advisoryTokens, limitTokens }, compaction: config.compaction,
    multiAgent: { maxWorkers, limitAutomaticChats, maxActiveChats, rotationBatchSize, rotationMinutes,
      rotationForegroundSlots, sleepingRuntimeMinutes }, artifacts: config.artifacts });
}

export interface SharedAccountSettingsRequest {
  action: 'enable' | 'disable' | 'inspect';
  drives: string[];
  dryRun: boolean;
}

export interface SharedAccountSettingsReceipt {
  version: 1;
  action: SharedAccountSettingsRequest['action'];
  dryRun: boolean;
  changed: boolean;
  profileId: string;
  platform: InstanceRuntimeIdentity['platform'];
  deviceId: string;
  revision: number;
  projectedRevision: number;
  sharedFoldersEnabled: boolean;
  commonPreferencesEnabled: boolean;
  storedRoots: Root[];
  projectedRoots: Root[];
  storedPreferences: SharedAccountPreferences | null;
  projectedPreferences: SharedAccountPreferences;
  canonicalProfileRoots: Array<{ profileId: string; roots: Root[] }>;
  plannedRevision: number | null;
  plannedRoots: Root[] | null;
}

/** Explicit local-primary operator control, never exposed as a model or network tool. */
export async function configureSharedAccountSettings(request: SharedAccountSettingsRequest): Promise<SharedAccountSettingsReceipt> {
  const parsed = z.object({ action: z.enum(['enable', 'disable', 'inspect']),
    drives: z.array(z.string().max(4096)).max(32), dryRun: z.boolean() }).strict().safeParse(request);
  if (!parsed.success || parsed.data.action !== 'enable' && parsed.data.drives.length > 0)
    throw new Error('Invalid shared-account settings control; no account was changed.');
  request = parsed.data;
  if (request.action !== 'inspect' && !isPrimaryConfigOwner())
    throw new Error('Shared account settings require the primary account runtime; no account was changed.');
  if (request.action === 'inspect') await refreshSharedFolderAccess();
  const runtime = await instanceRuntimeIdentity(false);
  logInfo(`shared account settings start action=${request.action} dryRun=${request.dryRun} drives=${request.drives.length}`);
  let changed = false;
  let result = current;
  let preview: Config | null = null;
  const prepare = async (config: Config): Promise<Config> => {
    if (!config.instances) throw new Error('Instance profile registry is not initialized.');
    const roots = [...config.roots];
    const requested = new Set<string>();
    for (const drive of request.drives) {
      if (typeof drive !== 'string' || (runtime.platform === 'win32' ? !/^[a-z]:\\$/i.test(drive) : drive !== '/'))
        throw new Error('Whole-drive access requires exact absolute filesystem roots (for example C:\\ or H:\\); no account was changed.');
      const key = nativePathIdentity(drive);
      if (requested.has(key)) throw new Error('Duplicate whole-drive approval; no account was changed.');
      requested.add(key);
      const exactIndex = roots.findIndex(root => nativePathIdentity(root.path) === key);
      const real = await validateNewRoot(drive, exactIndex < 0 ? roots : roots.filter((_, index) => index !== exactIndex),
        { allowFilesystemRoot: true });
      if (!roots.some(root => nativePathIdentity(root.path) === nativePathIdentity(real)))
        roots.push({ name: uniqueRootName(real, roots), path: real });
    }
    if (request.action === 'inspect') return config;
    if (request.action === 'enable' && roots.length === 0) throw new Error('Approve at least one exact folder or drive before sharing account access.');
    const previous = config.instances.sharedFolderAccess;
    if (previous && (previous.platform !== runtime.platform || previous.deviceId !== runtime.deviceId))
      throw new Error('Shared account settings belong to another device; approve this computer separately.');
    if (request.action === 'disable' && !previous) return config;
    const preferences = request.action === 'enable' ? sharedAccountPreferences(config) : config.sharedAccountPreferences?.preferences;
    const enabled = request.action === 'enable';
    changed = previous?.enabled !== enabled || !sameRootSet(previous?.roots ?? [], roots, runtime) ||
      JSON.stringify(config.sharedAccountPreferences?.preferences) !== JSON.stringify(preferences);
    if (!changed) return config;
    return { ...config, roots, instances: { ...config.instances, sharedFolderAccess: {
      enabled, platform: runtime.platform, deviceId: runtime.deviceId,
      revision: (previous?.revision ?? 0) + 1, roots: validatedSharedRoots(roots),
    } }, ...(preferences ? { sharedAccountPreferences: { version: 1, platform: runtime.platform,
      deviceId: runtime.deviceId, revision: (previous?.revision ?? 0) + 1, preferences } } : {}) };
  };
  try {
    if (request.dryRun || request.action === 'inspect') {
      const inspected = current;
      preview = await prepare(inspected);
      result = inspected;
    } else result = await updateConfig(prepare);
    const canonical = request.action === 'inspect' ? await readCanonicalConfigFor(result, runtime) : result;
    const policy = canonical.instances?.sharedFolderAccess;
    const receipt: SharedAccountSettingsReceipt = { version: 1, action: request.action, dryRun: request.dryRun,
      changed, profileId: result.instances!.activeInstanceId, platform: runtime.platform, deviceId: runtime.deviceId,
      revision: policy?.revision ?? 0, sharedFoldersEnabled: policy?.enabled === true,
      projectedRevision: result.instances?.sharedFolderAccess?.revision ?? 0,
      commonPreferencesEnabled: policy?.enabled === true && !!canonical.sharedAccountPreferences,
      storedRoots: policy?.roots.map(root => ({ ...root })) ?? [], projectedRoots: result.roots.map(root => ({ ...root })),
      storedPreferences: canonical.sharedAccountPreferences?.preferences ?? null, projectedPreferences: sharedAccountPreferences(result),
      canonicalProfileRoots: canonical.instances!.profiles.filter(profile => profile.platform === runtime.platform && profile.deviceId === runtime.deviceId)
        .map(profile => ({ profileId: profile.id, roots: localApprovedRoots(profile, runtime) })),
      plannedRevision: request.dryRun ? preview?.instances?.sharedFolderAccess?.revision ?? 0 : null,
      plannedRoots: request.dryRun ? preview?.roots.map(root => ({ ...root })) ?? [] : null };
    logInfo(`shared account settings complete revision=${receipt.revision} roots=${receipt.projectedRoots.length} changed=${changed}`);
    return receipt;
  } catch (error) {
    logError(`Shared account settings failed before completion: ${error instanceof Error ? error.message : String(error)}`);
    throw error;
  }
}

async function writeConfigFile(next: Config): Promise<void> {
  const tmp = `${configPath}.tmp`;
  await fs.mkdir(path.dirname(configPath), { recursive: true });
  await fs.writeFile(tmp, JSON.stringify(next, null, 2), 'utf8');
  try {
    await replaceFileAtomically(tmp, configPath, 'Settings');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    logError(`Settings atomic publish failed (${code ?? 'unknown error'}); check free disk space, antivirus, or another process holding config.json`);
    throw error;
  }
}

/**
 * Adapted from Maxim's upstream b6b9f162: a future browser/theme choice must not
 * discard the rest of the account. Only these preference enums may fall back;
 * malformed privacy, automation, model, permission or identity fields still use
 * the existing conservative/refusal path. Keep the exact original via its owner.
 */
function withoutUnreadablePreferences(value: unknown): { config: Config; dropped: string[] } | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const draft = structuredClone(value) as Record<string, unknown>;
  const ui = draft.ui;
  if (!ui || typeof ui !== 'object' || Array.isArray(ui)) return null;
  const preferences = ui as Record<string, unknown>;
  const dropped = new Set<string>();
  for (let pass = 0; pass < 3; pass++) {
    const parsed = configSchema.safeParse(draft);
    if (parsed.success) return dropped.size ? { config: parsed.data, dropped: [...dropped] } : null;
    for (const issue of parsed.error.issues) {
      const [section, key] = issue.path;
      if (issue.code !== 'invalid_value' || issue.path.length !== 2 || section !== 'ui' ||
          (key !== 'chatBrowser' && key !== 'theme') || typeof preferences[key] !== 'string') return null;
      delete preferences[key];
      dropped.add(`ui.${key}`);
    }
  }
  return null;
}

export async function loadConfig(): Promise<Config> {
  let persistMigration = false;
  let allowIdentityCreation = false;
  let legacyRecoverySource: string | null = null;
  let candidate: Config | null = null;
  try {
    const raw = await fs.readFile(configPath, 'utf8');
    let decoded: unknown;
    try {
      // Upstream #1174: Windows editors may prefix UTF-8 JSON with a BOM. Preserve the
      // custom profile validation and fail-closed recovery/backup owner below.
      decoded = migrateSharedAccountPreferences(JSON.parse(raw.replace(/^\uFEFF/, '')));
    } catch (error) {
      if (error instanceof InstanceProfileError) throw error;
      if (await hasProfileEraDeviceIdentity()) {
        throw new InstanceProfileError(
          'malformed_profile',
          'Settings JSON is malformed and this installation already owns instance profiles. Restore a valid config instead of silently replacing local identity, paths, or pairing references.'
        );
      }
      legacyRecoverySource = raw;
      throw new SyntaxError('Settings JSON is malformed');
    }
    const hasInstanceRegistry = Boolean(decoded && typeof decoded === 'object' && !Array.isArray(decoded) &&
      Object.prototype.hasOwnProperty.call(decoded, 'instances'));
    if (hasInstanceRegistry) {
      parseInstanceRegistry((decoded as Record<string, unknown>)['instances']);
    }
    const workerCeilingMigration = migrateLegacyWorkerCeiling(decoded);
    decoded = workerCeilingMigration.value;
    let parsed = configSchema.safeParse(decoded);
    const salvaged = parsed.success ? null : withoutUnreadablePreferences(decoded);
    if (salvaged) {
      // Reuse the bounded exact-raw recovery copy before publishing a repaired
      // config. A conflicting existing backup refuses instead of losing bytes.
      legacyRecoverySource = raw;
      parsed = { success: true, data: salvaged.config } as typeof parsed;
      logWarn(`Settings retained; unknown preference choices use defaults: ${salvaged.dropped.join(', ')}`);
    }
    if (!parsed.success) {
      if (await hasProfileEraDeviceIdentity()) {
        throw new InstanceProfileError(
          'malformed_profile',
          `Profile-era settings are malformed: ${parsed.error.issues[0]?.message ?? 'invalid data'}. Restore or explicitly import/rebind them instead of silently recreating an instance.`
        );
      }
      logError('Settings file was invalid and has been reset to defaults');
      legacyRecoverySource = raw;
      candidate = conservativeRecoveryConfig();
      // This is pre-profile recovery, not permission to repair an existing registry. The
      // registry case already failed above before any local identity mutation.
      allowIdentityCreation = !hasInstanceRegistry;
      persistMigration = true;
    } else {
      const needsIdentityMigration = workerCeilingMigration.changed || parsed.data.instances === undefined;
      persistMigration = needsIdentityMigration || salvaged !== null;
      allowIdentityCreation = needsIdentityMigration;
      const parsedConfig = enforceFeatureDependencies(
        adoptCurrentGoalPrompt(adoptWiderWindow(adoptAutoCompaction(recalibrateTokens(parsed.data))))
      );
      // Duplicate root names would make a virtual path ambiguous.
      const seen = new Set<string>();
      candidate = { ...parsedConfig, roots: parsedConfig.roots.filter((r) => {
        const key = r.name.toLowerCase();
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      }) };
    }
  } catch (err) {
    if (err instanceof InstanceProfileError) throw err;
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      if (await hasProfileEraDeviceIdentity()) {
        throw new InstanceProfileError(
          'malformed_profile',
          `Profile-era settings could not be read safely: ${(err as Error).message}. Restore the config rather than replacing instance identity.`
        );
      }
      if (legacyRecoverySource === null) {
        throw new InstanceProfileError(
          'malformed_profile',
          `Legacy settings could not be read safely: ${(err as Error).message}. Restore access to config.json before migrating; it was not overwritten.`
        );
      }
      logError(`Could not read settings: ${(err as Error).message}`);
      candidate = conservativeRecoveryConfig();
      allowIdentityCreation = true;
      persistMigration = true;
    } else {
      if (await hasProfileEraDeviceIdentity()) {
        throw new InstanceProfileError(
          'malformed_profile',
          'config.json is missing for an existing profile-era installation. Restore it or explicitly import/rebind a profile; a new singleton will not be invented over existing local state.'
        );
      }
      candidate = defaultConfig();
      persistMigration = true;
      allowIdentityCreation = true;
    }
  }
  if (legacyRecoverySource !== null) await preserveLegacyRecoveryConfig(legacyRecoverySource);
  if (!candidate) throw new InstanceProfileError('malformed_profile', 'Settings did not produce a usable configuration. No runtime owner was started.');
  const runtime = await instanceRuntimeIdentity(allowIdentityCreation);
  const projected = isPrimaryConfigOwner() ? candidate
    : projectCanonicalSharedAccess(candidate, await readCanonicalConfigFor(candidate, runtime), runtime, true);
  const canonical = canonicalizeInstances(projected, runtime);
  // The account owns saved model/effort choices. Reapplying bootstrap defaults here
  // overwrote explicit High preferences on every restart and stranded helpers when
  // that account's provider picker did not offer Extra High.
  const loaded = canonical.config;
  if (persistMigration || canonical.changed) await writeConfigFile(loaded);
  current = loaded;
  activeInstance = canonical.active;
  return current;
}

/** Applies any superseded pair in OLD_TOKEN_DEFAULTS → DEFAULT_SESSIONS, untouched pairs only. */
function recalibrateTokens(config: Config): Config {
  const { advisoryTokens, limitTokens } = config.sessions;
  const untouched = OLD_TOKEN_DEFAULTS.some(
    (old) => advisoryTokens === old.advisoryTokens && limitTokens === old.limitTokens
  );
  if (!untouched) {
    return config;
  }
  return {
    ...config,
    sessions: {
      ...config.sessions,
      advisoryTokens: DEFAULT_SESSIONS.advisoryTokens,
      limitTokens: DEFAULT_SESSIONS.limitTokens
    }
  };
}

/**
 * What automatic compaction used to default to, for the same one-time move as above.
 *
 * A config written before 1.7.5 spells the old answer out, so raising the default alone
 * would only ever reach a fresh install. A stored pair that is *exactly* the old default
 * was never a decision — it is what the app wrote for itself — so it moves. Anything the
 * user actually chose is left alone, including switching it off on purpose, which is why
 * `auto: true` with the old threshold is not touched: that is somebody's own setting.
 */
const OLD_AUTO_DEFAULTS = { auto: false, autoTokens: 300_000 };

function adoptAutoCompaction(config: Config): Config {
  const { auto, autoTokens } = config.compaction;
  if (auto !== OLD_AUTO_DEFAULTS.auto || autoTokens !== OLD_AUTO_DEFAULTS.autoTokens) return config;
  return {
    ...config,
    compaction: { ...config.compaction, auto: DEFAULT_COMPACTION.auto, autoTokens: DEFAULT_COMPACTION.autoTokens }
  };
}

/**
 * The 1.8 automatic default, moved up with the window.
 *
 * This is the third time a stored number that was never chosen has had to follow a default,
 * and it is the one case where the file's own rule is uncomfortable. `adoptAutoCompaction`
 * above deliberately leaves `auto: true` at the old threshold alone, on the grounds that
 * switching it on was a decision — but that was written when `auto: false` was the shipped
 * default. Since 1.8 the app writes `auto: true` at 300k for itself, so the two populations
 * are no longer distinguishable in the file, and the larger of them never decided anything.
 *
 * They move. A threshold that is any other number was typed by somebody and stays.
 *
 * There is no matching migration downward: 400k is what this now defaults to, so a config
 * that already holds it, whether from 1.7 or from a person, simply keeps it.
 */
const SUPERSEDED_AUTO_DEFAULTS = { auto: true, autoTokens: 300_000 };

function adoptWiderWindow(config: Config): Config {
  const { auto, autoTokens } = config.compaction;
  if (auto !== SUPERSEDED_AUTO_DEFAULTS.auto || autoTokens !== SUPERSEDED_AUTO_DEFAULTS.autoTokens) return config;
  return {
    ...config,
    compaction: { ...config.compaction, autoTokens: DEFAULT_COMPACTION.autoTokens }
  };
}

export function getConfig(): Config {
  return current;
}

/** Canonical active profile resolved against this host. Available after load/save. */
export function getActiveInstanceRuntime(): ActiveInstanceRuntime {
  if (!activeInstance) throw new Error('Instance profile runtime is not initialized');
  return activeInstance;
}

/** Existing state owners receive these roots after profile preflight; no duplicate stores exist. */
export function getActiveInstanceOwnerPaths(): InstanceOwnerPaths {
  const runtime = getActiveInstanceRuntime();
  if (!localDevice || !instanceDeviceRoot) throw new Error('Instance profile runtime is not initialized');
  return deriveInstanceOwnerPaths(runtime.profile, {
    platform: localDevice.platform,
    deviceId: localDevice.id,
    userDataRoot: instanceDeviceRoot
  });
}

/**
 * Canonical owner roots for another profile on this physical device.
 *
 * Management/diagnostic surfaces may inspect an inactive profile's persisted state, but they
 * must never reinitialize the process-wide session/durable singletons to do so. Returning null
 * for a profile bound to another computer keeps local path access fail-closed.
 */
export function getLocalInstanceOwnerPaths(id: string, registry: InstanceProfileRegistry = getInstanceRegistry()): InstanceOwnerPaths | null {
  if (!localDevice || !instanceDeviceRoot) throw new Error('Instance profile runtime is not initialized');
  const profile = registry.profiles.find(entry => entry.id === id);
  if (!profile) throw new Error('Account profile not found.');
  if (profile.platform !== localDevice.platform || profile.deviceId !== localDevice.id) return null;
  return deriveInstanceOwnerPaths(profile, {
    platform: localDevice.platform,
    deviceId: localDevice.id,
    userDataRoot: instanceDeviceRoot
  });
}

/** Exact Core/Desktop/Plugins identities projected from the active canonical profile. */
export function getActiveConnectorNames(): ReturnType<typeof projectConnectorNames> {
  return projectConnectorNames(getActiveInstanceRuntime().profile);
}

export const INSTANCE_BRIDGE_PORT_MIN = 8765;
export const INSTANCE_BRIDGE_PORT_MAX = 8796;

function profilePlatformLabel(platform: InstanceProfile['platform']): 'Windows' | 'Mac' | 'Linux' {
  return platform === 'win32' ? 'Windows' : platform === 'darwin' ? 'Mac' : 'Linux';
}

/** Adds the local device label exactly once to human-facing setup and connector names. */
function deviceQualifiedProfileLabel(nickname: string, platform: InstanceProfile['platform']): string {
  const device = profilePlatformLabel(platform);
  const lower = nickname.toLowerCase();
  const suffix = device.toLowerCase();
  return lower === suffix || lower.endsWith(` ${suffix}`) ? nickname : `${nickname} ${device}`;
}

function accountNickname(value: string): string {
  const nickname = value.trim();
  if (!nickname || nickname.length > 48) throw new Error('Enter an account nickname (1–48 characters).');
  if (/[/\\\x00-\x1f\x7f\u2028\u2029]/.test(value)) throw new Error('Account nickname cannot contain path separators or control characters.');
  return nickname;
}

function chromiumProfileDirectory(value: string): string {
  const profile = value.trim();
  if (!profile || profile.length > 128) throw new Error('Enter the Chrome/Chromium profile directory name (for example Default or Profile 2).');
  if (/[/\\:*?"<>|\x00-\x1f\x7f]/.test(value) || profile === '.' || profile === '..') {
    throw new Error('Chrome/Chromium profile must be a profile directory name, not a path.');
  }
  return profile;
}

function shortProfileId(id: string): string {
  return id.replace(/[^a-z0-9]/gi, '').toLowerCase().slice(0, 12) || 'profile';
}

function nextBridgePort(registry: NonNullable<Config['instances']>, deviceId: string): number {
  const used = new Set(registry.profiles.filter(profile => profile.deviceId === deviceId).map(profile => profile.bridge.port));
  for (let port = INSTANCE_BRIDGE_PORT_MIN; port <= INSTANCE_BRIDGE_PORT_MAX; port += 1) {
    if (!used.has(port)) return port;
  }
  throw new Error(`This device already uses every supported Luna Forge X7 bridge port (${INSTANCE_BRIDGE_PORT_MIN}–${INSTANCE_BRIDGE_PORT_MAX}).`);
}

/** Canonical profile registry for management surfaces. No credentials or browser data are added. */
export function getInstanceRegistry(): NonNullable<Config['instances']> {
  if (!current.instances) throw new Error('Instance profile registry is not initialized');
  return current.instances;
}

/** Creates an isolated local account profile without changing the process' current owner. */
export async function createLocalInstanceProfile(nicknameValue: string, browserDirectoryValue: string): Promise<InstanceProfile> {
  if (!isPrimaryConfigOwner()) throw new Error('Create account profiles from the primary account window.');
  const nickname = accountNickname(nicknameValue);
  const browserDirectory = chromiumProfileDirectory(browserDirectoryValue);
  const runtime = await instanceRuntimeIdentity(false);
  const id = `profile-${randomUUID()}`;
  const setupId = `setup-${randomUUID()}`;
  const short = shortProfileId(id);
  const accountAlias = newInstanceConnectorAlias(id);
  const deviceLabel = deviceQualifiedProfileLabel(nickname, runtime.platform);
  let created: InstanceProfile | null = null;
  await updateConfig(config => {
    const registry = config.instances ? parseInstanceRegistry(config.instances) : migrateLegacyInstanceRegistry(config.roots, runtime, {
      tunnelProfileRef: config.tunnel.profileId ?? 'default'
    });
    const browserKey = browserDirectory.toLowerCase();
    const nicknameKey = nickname.toLocaleLowerCase('en-US');
    const localProfiles = registry.profiles.filter(profile => profile.deviceId === runtime.deviceId && profile.platform === runtime.platform);
    const browserOwner = localProfiles.find(profile => (profile.browser.profileDirectory?.toLowerCase() ?? '') === browserKey);
    const nameOwners = localProfiles.filter(profile => profile.displayName.trim().toLocaleLowerCase('en-US') === nicknameKey);
    // Native Add and the operator command share updateConfig's serialized mutation. Resolve the
    // exact pair here, before limits, so concurrent requests cannot mint two account identities.
    // Reuse never enables, prepares, connects or changes permissions for an existing account.
    if (browserOwner && nameOwners.length === 1 && nameOwners[0]!.id === browserOwner.id) {
      created = browserOwner;
      return config;
    }
    if (browserOwner) {
      throw new InstanceProfileError('browser_profile_collision', `Chrome/Chromium profile "${browserDirectory}" is already assigned to another Luna Forge X7 account on this device.`);
    }
    if (nameOwners.length > 0) throw new Error('Account nickname is already assigned to another Chrome/Chromium profile on this device. Rename or rebind it explicitly in Accounts & devices.');
    if (registry.profiles.length >= 32) throw new Error('Account profile limit reached (32).');
    const profile: InstanceProfile = {
      schemaVersion: 1,
      id,
      displayName: nickname,
      platform: runtime.platform,
      deviceId: runtime.deviceId,
      accountLabel: nickname,
      enabled: true,
      state: { mode: 'isolated', root: path.join(runtime.userDataRoot, 'instances', id) },
      bridge: { host: '127.0.0.1', port: nextBridgePort(registry, runtime.deviceId) },
      connector: {
        identity: `luna-forge-x7-${id}`,
        displayBrand: newInstanceConnectorBrand(accountAlias, nickname, runtime.platform),
        legacyNames: false
      },
      tunnelProfileRef: setupId,
      browser: { profileId: `chrome-${short}`, profileDirectory: browserDirectory, family: 'chrome', electronPartition: `instance-${short}` },
      namespaces: { sessions: `sessions-${short}`, queue: `queue-${short}`, logs: `logs-${short}`, health: `health-${short}` },
      approvedFolders: [],
      projects: []
    };
    created = profile;
    const withSetup = addInactiveSetupProfile(config, deviceLabel, setupId);
    return { ...withSetup, instances: parseInstanceRegistry({ ...registry, profiles: [...registry.profiles, profile] }) };
  });
  if (!created) throw new Error('Account profile was not created.');
  return created;
}

/** Renames only human-facing account labels; stable connector/server identity never changes. */
export async function renameLocalInstanceProfile(
  id: string,
  nicknameValue: string,
  beforePublish?: () => Promise<void>
): Promise<InstanceProfile> {
  if (!isPrimaryConfigOwner()) throw new Error('Rename account profiles from the primary account window.');
  const nickname = accountNickname(nicknameValue);
  let renamed: InstanceProfile | null = null;
  let privateFile: string | null = null;
  let privateEdit: { file: string; before: string; after: string; dev: number; ino: number } | null = null;
  const recheckPrivate = async (): Promise<void> => {
    if (!privateEdit) {
      if (!privateFile) return;
      try { await fs.lstat(privateFile); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
        throw error;
      }
      throw new Error('Account runtime was prepared while the nickname edit was waiting. Inspect the account before retrying.');
    }
    for (const directory of [path.dirname(path.dirname(privateEdit.file)), path.dirname(privateEdit.file)]) {
      const stat = await fs.lstat(directory);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Prepared account runtime directory is unsafe; nickname edit was refused.');
    }
    const stat = await fs.lstat(privateEdit.file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.dev !== privateEdit.dev || stat.ino !== privateEdit.ino ||
        await fs.readFile(privateEdit.file, 'utf8') !== privateEdit.before) {
      throw new Error('Private account settings changed while the nickname was being prepared. No private settings were overwritten; inspect the account before retrying.');
    }
  };
  await updateConfig(async config => {
    if (!config.instances) throw new Error('Instance profile registry is not initialized');
    const registry = parseInstanceRegistry(config.instances);
    const found = registry.profiles.find(profile => profile.id === id);
    if (!found) throw new Error('Account profile not found.');
    const runtime = await instanceRuntimeIdentity(false);
    if (found.platform !== runtime.platform || found.deviceId !== runtime.deviceId) {
      throw new InstanceProfileError('wrong_device', 'This account profile belongs to another physical device.');
    }
    if (registry.profiles.some(profile => profile.id !== id && profile.deviceId === found.deviceId &&
        profile.platform === found.platform && profile.displayName.trim().toLocaleLowerCase('en-US') === nickname.toLocaleLowerCase('en-US'))) {
      throw new Error('Account nickname is already assigned to another account on this device. Choose a distinct nickname.');
    }
    const deviceLabel = deviceQualifiedProfileLabel(nickname, found.platform);
    const next: InstanceProfile = {
      ...found,
      displayName: nickname,
      accountLabel: nickname,
      // The provider caches this handle, and prepared accounts keep their own config snapshot.
      // A nickname edit must not rotate or split their connector metadata across runtimes.
      connector: found.connector
    };
    if (found.state.mode === 'isolated') {
      const owners = getLocalInstanceOwnerPaths(id);
      if (!owners) throw new Error('Account runtime paths could not be proven on this device.');
      const file = path.join(owners.stateRoot, 'runtime', 'config.json');
      privateFile = file;
      let inspected = false;
      try {
        for (const directory of [owners.stateRoot, path.dirname(file)]) {
          const stat = await fs.lstat(directory);
          if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Prepared account runtime directory is unsafe; nickname edit was refused.');
        }
        const stat = await fs.lstat(file);
        inspected = true;
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 2_000_000) {
          throw new Error('Prepared account settings must be a bounded regular file.');
        }
        const before = await fs.readFile(file, 'utf8');
        if (Buffer.byteLength(before) > 2_000_000) throw new Error('Prepared account settings exceed the bounded file limit.');
        // Validate without serializing schema defaults/migrations over private preferences.
        const raw = JSON.parse(before) as Config;
        const validated = configSchema.parse(migrateLegacyWorkerCeiling(migrateSharedAccountPreferences(raw)).value);
        if (validated.instances?.activeInstanceId !== id) throw new Error('Existing account runtime is bound to another profile.');
        if ((validated.tunnel.profileId ?? 'default') !== found.tunnelProfileRef) {
          throw new Error('Existing account runtime setup identity differs from the primary registry; nickname edit was refused.');
        }
        const privateProfile = validated.instances.profiles.find(profile => profile.id === id);
        if (!privateProfile) throw new Error('Existing account runtime is missing its active profile.');
        assertCanonicalAccountRouting(privateProfile, found);
        if (JSON.stringify(privateProfile.connector) !== JSON.stringify(found.connector) ||
            JSON.stringify(privateProfile.browser) !== JSON.stringify(found.browser)) {
          throw new Error('Existing account connector or browser identity differs from the primary registry; nickname edit was refused.');
        }
        const projected = { ...raw, instances: { ...raw.instances!,
          profiles: raw.instances!.profiles.map(profile => profile.id === id
            ? { ...profile, displayName: nickname, accountLabel: nickname } : profile) },
          tunnel: { ...raw.tunnel, profileName: deviceLabel },
          ...(raw.setupProfiles ? { setupProfiles: raw.setupProfiles.map(profile => profile.id === found.tunnelProfileRef
            ? { ...profile, name: deviceLabel } : profile) } : {}) };
        configSchema.parse(migrateLegacyWorkerCeiling(migrateSharedAccountPreferences(projected)).value);
        privateEdit = { file, before, after: JSON.stringify(projected, null, 2), dev: stat.dev, ino: stat.ino };
      } catch (error) {
        if (inspected || (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        // Only an absent runtime config is bootstrap. An existing file that vanished during
        // inspection must never be treated as an unprepared account.
        privateEdit = null;
      }
    }
    await beforePublish?.();
    await recheckPrivate();
    renamed = next;
    return {
      ...config,
      instances: parseInstanceRegistry({ ...registry,
        profiles: registry.profiles.map(profile => profile.id === id ? next : profile) }),
      ...(found.state.mode === 'isolated' && (config.tunnel.profileId ?? 'default') === found.tunnelProfileRef
        ? { tunnel: { ...config.tunnel, profileName: deviceLabel } } : {}),
      setupProfiles: found.state.mode === 'isolated'
        ? config.setupProfiles?.map(profile => profile.id === found.tunnelProfileRef
          ? { ...profile, name: deviceLabel }
          : profile)
        : config.setupProfiles
    };
  }, async (next, previous) => {
    if (!privateFile) return;
    const temporary = `${privateFile}.tmp-nickname-${randomUUID()}`;
    try {
      if (privateEdit) await fs.writeFile(temporary, privateEdit.after, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
      await beforePublish?.();
      await recheckPrivate();
      // One atomic attempt follows the exact snapshot/stopped reproof. A delayed sharing-lock
      // retry would reuse that proof after another private writer could have taken ownership.
      if (privateEdit) await fs.rename(temporary, privateEdit.file);
    } catch (error) {
      await fs.rm(temporary, { force: true }).catch(() => undefined);
      try {
        // afterPublish still holds mutationQueue: rollback cannot erase a queued newer edit.
        // Refuse an out-of-owner disk replacement rather than overwrite its unrelated data.
        if (JSON.stringify(JSON.parse(await fs.readFile(configPath, 'utf8'))) !== JSON.stringify(next)) {
          throw new Error('Canonical account settings changed outside their owner during nickname rollback.');
        }
        await persistConfig(previous);
      } catch (rollbackError) {
        throw new AggregateError([error, rollbackError], 'Account nickname update failed and its canonical labels could not be restored. Inspect both account configs before retrying; private settings were not reset.');
      }
      throw error;
    }
  });
  if (!renamed) throw new Error('Account profile was not renamed.');
  logInfo(`account nickname saved profile=${id} prepared=${privateEdit !== null}; connector and runtime identity retained`);
  return renamed;
}

/** Assign an explicit browser directory. An active account may only fill an absent binding. */
export async function setLocalInstanceBrowserProfile(id: string, browserDirectoryValue: string): Promise<InstanceProfile> {
  const browserDirectory = chromiumProfileDirectory(browserDirectoryValue);
  const runtime = await instanceRuntimeIdentity(false);
  let rebound: InstanceProfile | null = null;
  await updateConfig(config => {
    if (!config.instances) throw new Error('Instance profile registry is not initialized');
    const registry = parseInstanceRegistry(config.instances);
    const found = registry.profiles.find(profile => profile.id === id);
    if (!found) throw new Error('Account profile not found.');
    if (found.platform !== runtime.platform || found.deviceId !== runtime.deviceId) {
      throw new Error('This account belongs to another device.');
    }
    if (registry.activeInstanceId === id && found.browser.profileDirectory &&
        found.browser.profileDirectory.toLowerCase() !== browserDirectory.toLowerCase()) {
      throw new Error('Pause this account and switch away before changing its existing Chrome profile.');
    }
    if (registry.pendingSwitch?.toInstanceId === id) {
      throw new Error('Cancel the pending account switch before changing its Chrome profile.');
    }
    if (registry.profiles.some(profile => profile.id !== id && profile.deviceId === runtime.deviceId &&
      profile.browser.profileDirectory?.toLowerCase() === browserDirectory.toLowerCase())) {
      throw new InstanceProfileError('browser_profile_collision',
        `Chrome/Chromium profile "${browserDirectory}" is already assigned to another account on this device.`);
    }
    const next: InstanceProfile = { ...found, browser: { ...found.browser, profileDirectory: browserDirectory, family: 'chrome' } };
    rebound = next;
    return { ...config, instances: parseInstanceRegistry({ ...registry,
      profiles: registry.profiles.map(profile => profile.id === id ? next : profile) }) };
  });
  if (!rebound) throw new Error('Account browser profile was not updated.');
  return rebound;
}

/**
 * Move one inactive local account to another supported bridge port while keeping the prepared
 * private runtime's account-owned preferences intact. The primary registry owns routing; an
 * already-prepared private config mirrors only that route so the child preflight remains exact.
 * The caller must prove the account process is stopped before using this mutation.
 */
export async function setLocalInstanceBridgePort(id: string, port: number): Promise<InstanceProfile> {
  if (!Number.isInteger(port) || port < INSTANCE_BRIDGE_PORT_MIN || port > INSTANCE_BRIDGE_PORT_MAX) {
    throw new Error(`Bridge port must be within ${INSTANCE_BRIDGE_PORT_MIN}–${INSTANCE_BRIDGE_PORT_MAX}.`);
  }
  const registry = getInstanceRegistry();
  const found = registry.profiles.find(profile => profile.id === id);
  if (!found) throw new Error('Account profile not found.');
  if (registry.activeInstanceId === id) throw new Error('Switch away from this account before changing its bridge port.');
  const runtime = await instanceRuntimeIdentity(false);
  if (found.platform !== runtime.platform || found.deviceId !== runtime.deviceId) {
    throw new InstanceProfileError('wrong_device', 'This account profile belongs to another physical device.');
  }
  if (registry.profiles.some(profile => profile.id !== id && profile.deviceId === runtime.deviceId && profile.bridge.port === port)) {
    throw new InstanceProfileError('endpoint_collision', `Bridge port ${port} is already assigned to another Luna Forge X7 account on this device.`);
  }

  const owners = getLocalInstanceOwnerPaths(id);
  const privatePath = owners ? path.join(owners.stateRoot, 'runtime', 'config.json') : null;
  let privateConfig: Config | null = null;
  if (privatePath) {
    try {
      const decoded = JSON.parse(await fs.readFile(privatePath, 'utf8')) as unknown;
      privateConfig = configSchema.parse(migrateLegacyWorkerCeiling(migrateSharedAccountPreferences(decoded)).value);
      if (privateConfig.instances?.activeInstanceId !== id) {
        throw new Error('Existing account runtime is bound to another profile.');
      }
      const privateProfile = privateConfig.instances.profiles.find(profile => profile.id === id);
      if (!privateProfile) throw new Error('Existing account runtime is missing its active profile.');
      const routeWithoutPort = (profile: InstanceProfile): unknown[] => [
        profile.id, profile.platform, profile.deviceId, profile.state.mode, profile.state.root,
        profile.bridge.host, profile.connector.identity, profile.tunnelProfileRef,
        profile.browser.profileDirectory, profile.browser.family, profile.browser.electronPartition,
        profile.namespaces.sessions, profile.namespaces.queue, profile.namespaces.logs, profile.namespaces.health
      ];
      if (JSON.stringify(routeWithoutPort(privateProfile)) !== JSON.stringify(routeWithoutPort(found))) {
        throw new Error('Existing account runtime routing differs from the primary profile registry; bridge repair was refused.');
      }
      privateConfig = configSchema.parse({
        ...privateConfig,
        instances: {
          ...privateConfig.instances,
          profiles: privateConfig.instances.profiles.map(profile => profile.id === id
            ? { ...profile, bridge: { ...profile.bridge, port } }
            : profile)
        }
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }

  let updated: InstanceProfile | null = null;
  const previousPort = found.bridge.port;
  await updateConfig(config => {
    if (!config.instances) throw new Error('Instance profile registry is not initialized');
    const latest = parseInstanceRegistry(config.instances);
    const currentProfile = latest.profiles.find(profile => profile.id === id);
    if (!currentProfile) throw new Error('Account profile not found.');
    if (latest.activeInstanceId === id) throw new Error('Switch away from this account before changing its bridge port.');
    if (currentProfile.bridge.port !== previousPort && currentProfile.bridge.port !== port) {
      throw new Error('Account bridge routing changed while the repair was being prepared.');
    }
    if (latest.profiles.some(profile => profile.id !== id && profile.deviceId === currentProfile.deviceId && profile.bridge.port === port)) {
      throw new InstanceProfileError('endpoint_collision', `Bridge port ${port} is already assigned to another Luna Forge X7 account on this device.`);
    }
    const next = { ...currentProfile, bridge: { ...currentProfile.bridge, port } };
    updated = next;
    return { ...config, instances: parseInstanceRegistry({
      ...latest,
      profiles: latest.profiles.map(profile => profile.id === id ? next : profile)
    }) };
  });

  if (privatePath && privateConfig) {
    const temporary = `${privatePath}.tmp-bridge-${process.pid}`;
    try {
      await fs.writeFile(temporary, JSON.stringify(privateConfig, null, 2), { encoding: 'utf8', mode: 0o600 });
      await replaceFileAtomically(temporary, privatePath, 'Isolated runtime bridge routing');
    } catch (error) {
      await fs.rm(temporary, { force: true }).catch(() => undefined);
      try {
        await updateConfig(config => {
          if (!config.instances) return config;
          const latest = parseInstanceRegistry(config.instances);
          const currentProfile = latest.profiles.find(profile => profile.id === id);
          if (!currentProfile || currentProfile.bridge.port !== port) return config;
          const restored = { ...currentProfile, bridge: { ...currentProfile.bridge, port: previousPort } };
          return { ...config, instances: parseInstanceRegistry({
            ...latest,
            profiles: latest.profiles.map(profile => profile.id === id ? restored : profile)
          }) };
        });
      } catch (rollbackError) {
        throw new AggregateError([error, rollbackError], 'Bridge routing update failed and the canonical route could not be restored. The isolated child will fail closed until the routes are reconciled.');
      }
      throw error;
    }
  }
  if (!updated) throw new Error('Account bridge port was not updated.');
  return updated;
}

export async function setLocalInstanceProfileEnabled(id: string, enabled: boolean): Promise<InstanceProfile> {
  let result: InstanceProfile | null = null;
  await updateConfig(config => {
    if (!config.instances) throw new Error('Instance profile registry is not initialized');
    const registry = parseInstanceRegistry(config.instances);
    const found = registry.profiles.find(profile => profile.id === id);
    if (!found) throw new Error('Account profile not found.');
    if (!enabled && registry.activeInstanceId === id) throw new Error('Switch to another account before disabling the active profile.');
    if (!enabled && registry.pendingSwitch?.toInstanceId === id) throw new Error('Cancel the pending switch before disabling its target profile.');
    const next = { ...found, enabled };
    result = next;
    return { ...config, instances: parseInstanceRegistry({ ...registry,
      profiles: registry.profiles.map(profile => profile.id === id ? next : profile) }) };
  });
  if (!result) throw new Error('Account profile was not updated.');
  return result;
}

/** Removes registry/setup metadata only after the caller has proved the isolated profile unused. */
export async function removeUnusedLocalInstanceProfile(id: string): Promise<void> {
  await updateConfig(config => {
    if (!config.instances) throw new Error('Instance profile registry is not initialized');
    const registry = parseInstanceRegistry(config.instances);
    const found = registry.profiles.find(profile => profile.id === id);
    if (!found) throw new Error('Account profile not found.');
    if (registry.profiles.length <= 1) throw new Error('Keep at least one account profile.');
    if (registry.activeInstanceId === id) throw new Error('Switch to another account before removing this profile.');
    if (registry.pendingSwitch?.toInstanceId === id) throw new Error('Cancel the pending switch before removing its target profile.');
    if (found.enabled !== false) throw new Error('Disable this profile before removing it.');
    if (found.state.mode !== 'isolated') throw new Error('The migrated default profile cannot be removed.');
    return {
      ...config,
      instances: parseInstanceRegistry({ ...registry, profiles: registry.profiles.filter(profile => profile.id !== id) }),
      setupProfiles: config.setupProfiles?.filter(profile => profile.id !== found.tunnelProfileRef)
    };
  });
}

export async function requestDeferredInstanceSwitch(targetId: string): Promise<NonNullable<Config['instances']>['pendingSwitch']> {
  let pending: NonNullable<Config['instances']>['pendingSwitch'];
  await updateConfig(config => {
    if (!config.instances) throw new Error('Instance profile registry is not initialized');
    const registry = parseInstanceRegistry(config.instances);
    const target = registry.profiles.find(profile => profile.id === targetId);
    if (!target) throw new Error('Account profile not found.');
    if (target.id === registry.activeInstanceId) throw new Error('That account profile is already active.');
    if (target.enabled === false) throw new Error('Enable this account profile before switching to it.');
    if (target.platform !== runtimePlatformForConfig() || target.deviceId !== localDevice?.id) {
      throw new InstanceProfileError('wrong_device', 'This account profile belongs to another physical device. Export its safe logical mapping and rebind it locally instead.');
    }
    if (target.state.mode === 'isolated' && !target.browser.profileDirectory) {
      throw new Error('Choose an explicit Chrome/Chromium profile directory before activating this account.');
    }
    pending = { fromInstanceId: registry.activeInstanceId, toInstanceId: targetId, requestedAt: Date.now() };
    return { ...config, instances: parseInstanceRegistry({ ...registry, pendingSwitch: pending }) };
  });
  return pending!;
}

function runtimePlatformForConfig(): InstanceRuntimeIdentity['platform'] {
  return localDevice?.platform ?? instancePlatform(process.platform);
}

export async function cancelDeferredInstanceSwitch(): Promise<void> {
  await updateConfig(config => {
    if (!config.instances?.pendingSwitch) return config;
    const { pendingSwitch: _pending, ...registry } = config.instances;
    return { ...config, instances: parseInstanceRegistry(registry) };
  });
}

/** Existing instance registry is the sole durable owner of deferred profile switching. */
export function deferredProfileSwitchState(): DeferredProfileSwitch | null {
  const pending = current.instances?.pendingSwitch;
  if (!pending) return null;
  return {
    version: 1,
    transitionId: pending.transitionId ?? `migrated-${pending.requestedAt}-${pending.toInstanceId}`,
    sourceProfileId: pending.fromInstanceId,
    targetProfileId: pending.toInstanceId,
    phase: pending.phase ?? 'draining',
    requestedAt: pending.requestedAt,
    ...(pending.verifiedIdleAt === undefined ? {} : { verifiedIdleAt: pending.verifiedIdleAt })
  };
}

export async function writeDeferredProfileSwitchState(state: DeferredProfileSwitch | null): Promise<void> {
  await updateConfig(config => {
    if (!config.instances) throw new Error('Instance profile registry is not initialized');
    const registry = parseInstanceRegistry(config.instances);
    if (!state) {
      if (!registry.pendingSwitch) return config;
      const { pendingSwitch: _pending, ...withoutPending } = registry;
      return { ...config, instances: parseInstanceRegistry(withoutPending) };
    }
    if (state.sourceProfileId !== registry.activeInstanceId) {
      throw new Error(`Deferred profile switch belongs to ${state.sourceProfileId}, not active profile ${registry.activeInstanceId}.`);
    }
    const target = registry.profiles.find(profile => profile.id === state.targetProfileId);
    if (!target || target.enabled === false) throw new Error('Deferred profile switch target is missing or disabled.');
    const pending = {
      version: 1 as const,
      transitionId: state.transitionId,
      fromInstanceId: state.sourceProfileId,
      toInstanceId: state.targetProfileId,
      phase: state.phase,
      requestedAt: state.requestedAt,
      ...(state.verifiedIdleAt === undefined ? {} : { verifiedIdleAt: state.verifiedIdleAt })
    };
    return { ...config, instances: parseInstanceRegistry({ ...registry, pendingSwitch: pending }) };
  });
}

function prepareInstanceActivation(config: Config, targetId: string, runtime: InstanceRuntimeIdentity): Config {
  if (!config.instances) throw new Error('Instance profile registry is not initialized');
  const registry = parseInstanceRegistry(config.instances);
  const target = registry.profiles.find(profile => profile.id === targetId);
  if (!target) throw new Error('Account profile not found.');
  if (target.enabled === false) throw new Error('Cannot activate a disabled account profile.');
  if (target.platform !== runtime.platform || target.deviceId !== runtime.deviceId) {
    throw new InstanceProfileError('wrong_device', 'This account profile belongs to another physical device.');
  }
  if (target.state.mode === 'isolated' && !target.browser.profileDirectory) {
    throw new Error('Choose an explicit Chrome/Chromium profile directory before activating this account.');
  }
  const withSetup = activateSetupProfile(config, target.tunnelProfileRef);
  // These route settings belong to one running account, not the inherited setup defaults.
  const tunnel = { ...withSetup.tunnel };
  if (target.id !== registry.activeInstanceId) {
    delete tunnel.manualPublicOrigin;
    delete tunnel.manualPort;
    delete tunnel.manualEndpointRevision;
  }
  const { pendingSwitch: _pending, ...registryWithoutPending } = registry;
  return {
    ...withSetup,
    tunnel,
    roots: localApprovedRoots(target, runtime),
    ui: target.browser.family ? { ...withSetup.ui, chatBrowser: target.browser.family } : withSetup.ui,
    instances: { ...registryWithoutPending, activeInstanceId: target.id }
  };
}

function initialIsolatedAccountReasoning(config: Config): Config {
  return {
    ...config,
    multiAgent: { ...config.multiAgent, defaultModel: 'gpt-6-thinking', defaultReasoning: 'high' },
    goal: { ...config.goal, helperModel: 'gpt-6-thinking', helperReasoning: 'high' }
  };
}

/** Prepare another account's complete runtime config without switching this process or writing disk. */
export async function snapshotConfigForInstance(targetId: string): Promise<Config> {
  const runtime = await instanceRuntimeIdentity(false);
  let candidate = prepareInstanceActivation(current, targetId, runtime);
  const target = candidate.instances?.profiles.find(profile => profile.id === targetId);
  // GPT-6 High is a bootstrap default only. Once prepared, each account's Settings
  // owns its model and effort; reopening must not replace an explicit choice.
  if (target?.state.mode === 'isolated') {
    candidate = initialIsolatedAccountReasoning(candidate);
  }
  return canonicalizeInstances(enforceFeatureDependencies(configSchema.parse(candidate)), runtime).config;
}

/** Bootstrap an isolated account once; validate and preserve an existing account's settings. */
export async function prepareIsolatedInstanceRuntimeConfig(targetId: string): Promise<string> {
  const profile = getInstanceRegistry().profiles.find(entry => entry.id === targetId);
  if (!profile || profile.state.mode !== 'isolated') throw new Error('An isolated account profile is required.');
  const owners = getLocalInstanceOwnerPaths(targetId);
  if (!owners || !profile.browser.profileDirectory) throw new Error('Account is not fully bound to this device and Chrome profile.');
  const runtimeRoot = path.join(owners.stateRoot, 'runtime');
  const target = path.join(runtimeRoot, 'config.json');
  try {
    const decoded = JSON.parse(await fs.readFile(target, 'utf8')) as unknown;
    const existing = configSchema.parse(migrateLegacyWorkerCeiling(migrateSharedAccountPreferences(decoded)).value);
    if (existing.instances?.activeInstanceId !== targetId) throw new Error('Existing account runtime is bound to another profile.');
    return runtimeRoot;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const snapshot = await snapshotConfigForInstance(targetId);
  await fs.mkdir(runtimeRoot, { recursive: true });
  const temporary = `${target}.tmp-${process.pid}`;
  await fs.writeFile(temporary, JSON.stringify(snapshot, null, 2), { encoding: 'utf8', mode: 0o600 });
  try { await replaceFileAtomically(temporary, target, 'Isolated runtime settings'); }
  catch (error) { await fs.rm(temporary, { force: true }).catch(() => undefined); throw error; }
  return runtimeRoot;
}

/**
 * Publishes the target identity for the next process start without rebinding this process' live
 * singleton owners. Call only after a verified Drain and immediately begin ordinary shutdown.
 */
export function stageInstanceActivationForNextStart(targetId: string): Promise<Config> {
  const operation = mutationQueue.then(async () => {
    const runtime = await instanceRuntimeIdentity(false);
    const candidate = prepareInstanceActivation(current, targetId, runtime);
    const canonical = canonicalizeInstances(enforceFeatureDependencies(configSchema.parse(candidate)), runtime);
    await writeConfigFile(canonical.config);
    return canonical.config;
  });
  mutationQueue = operation.then(() => undefined, () => undefined);
  return operation;
}

/**
 * Read-only mode is enforced here as well as at the tool layer, so the effective
 * capability set can never disagree with what the UI shows.
 */
export function effectiveCapabilities(
  config: Config,
  platform: NodeJS.Platform = process.platform,
  release?: string
): Capabilities {
  const live = capabilitiesForPlatform(config.capabilities, platform, release);
  if (!config.readOnly) return live;
  // Derived from WRITE_CAPABILITIES rather than listed again here, so adding a new
  // writing capability cannot accidentally leave it enabled in read-only mode.
  const capped = { ...live };
  for (const capability of WRITE_CAPABILITIES) capped[capability] = false;
  return capped;
}

async function persistConfig(next: Config): Promise<Config> {
  const preservingRegistry = next.instances === undefined && current.instances !== undefined
    ? { ...next, instances: current.instances }
    : next;
  const runtime = await instanceRuntimeIdentity(current.instances === undefined && preservingRegistry.instances === undefined);
  let validated = enforceFeatureDependencies(configSchema.parse(preservingRegistry));
  const sameEndpointOwner = current.instances?.activeInstanceId === validated.instances?.activeInstanceId;
  let externalEnrollmentChanged = false;
  if (sameEndpointOwner) {
    const previousOrigin = current.tunnel.manualPublicOrigin ?? '';
    const nextOrigin = validated.tunnel.manualPublicOrigin ?? '';
    const previousRevision = current.tunnel.manualEndpointRevision;
    const revision = previousOrigin !== nextOrigin ? (previousRevision ?? 0) + 1 : previousRevision;
    if (revision !== undefined && !Number.isSafeInteger(revision)) throw new Error('External endpoint revision is exhausted; settings were not saved.');
    const tunnel = { ...validated.tunnel };
    if (revision === undefined) delete tunnel.manualEndpointRevision;
    else tunnel.manualEndpointRevision = revision;
    const previousEnrollment = current.tunnel.kind === 'manual' ? previousOrigin : '';
    const nextEnrollment = validated.tunnel.kind === 'manual' ? nextOrigin : '';
    externalEnrollmentChanged = previousEnrollment !== nextEnrollment && Boolean(previousEnrollment || nextEnrollment);
    // Reuse the incumbent durable automation hold. Transport proof cannot enroll a native connector.
    validated = { ...validated, tunnel, ...(externalEnrollmentChanged
      ? { ui: { ...validated.ui, automationPaused: true } } : {}) };
  }
  const policy = validated.instances?.sharedFolderAccess;
  if (!isPrimaryConfigOwner()) {
    if (JSON.stringify(policy) !== JSON.stringify(current.instances?.sharedFolderAccess) ||
        JSON.stringify(validated.sharedAccountPreferences) !== JSON.stringify(current.sharedAccountPreferences)) {
      throw new Error('Shared folder access must be changed in the primary account window.');
    }
    if (policy?.enabled && policy.platform === runtime.platform && policy.deviceId === runtime.deviceId &&
        !sameRootSet(validated.roots, current.roots, runtime)) {
      throw new Error('Shared folders must be added, renamed or removed in the primary account window.');
    }
    validated = projectCanonicalSharedAccess(validated, await readCanonicalConfigFor(validated, runtime), runtime);
  } else if (policy?.enabled && policy.platform === runtime.platform && policy.deviceId === runtime.deviceId &&
      (!sameRootSet(validated.roots, policy.roots, runtime) || validated.sharedAccountPreferences &&
       JSON.stringify(validated.sharedAccountPreferences.preferences) !== JSON.stringify(sharedAccountPreferences(validated)))) {
    validated = { ...validated, instances: { ...validated.instances!, sharedFolderAccess: {
      ...policy, revision: policy.revision + 1, roots: validatedSharedRoots(validated.roots),
    } }, ...(validated.sharedAccountPreferences ? { sharedAccountPreferences: {
      ...validated.sharedAccountPreferences, revision: policy.revision + 1, preferences: sharedAccountPreferences(validated)
    } } : {}) };
  }
  const canonical = canonicalizeInstances(validated, runtime);
  // Write once, then retry only the atomic publication. Every attempt therefore exposes
  // the exact same validated bytes, while updateConfig keeps all mutations serialized.
  await writeConfigFile(canonical.config);
  // Only publish the new in-memory state after the durable write succeeded. A disk
  // error must not leave the UI believing settings were saved when they were not.
  current = canonical.config;
  activeInstance = canonical.active;
  if (externalEnrollmentChanged) logInfo('external route settings saved: automation held until exact native connector verification and explicit Resume');
  return current;
}

/**
 * Atomically updates settings from the latest committed state.
 *
 * The callback itself runs inside the queue. This matters more than merely queuing the
 * final file write: a root change and a permission change that start at the same time
 * must each see the result of the one ahead of it instead of composing two stale full
 * Config objects and letting the later write silently erase the earlier change.
 */
export function updateConfig(
  update: (latest: Config) => Config | Promise<Config>,
  afterPublish?: (next: Config, previous: Config) => void | Promise<void>
): Promise<Config> {
  const operation = mutationQueue.then(async () => {
    await refreshSharedFolderAccessNow();
    const previous = current;
    const next = await persistConfig(await update(previous));
    const runtime = await instanceRuntimeIdentity(false);
    if (!sameRootSet(previous.roots, next.roots, runtime)) {
      notifyApprovedRootPublicationRefresh(previous.roots.length, next.roots.length);
    }
    // Keep dependent durable retirement inside the same settings transaction;
    // the next On cannot overtake a published Off's cancellation work.
    await afterPublish?.(next, previous);
    return next;
  });
  mutationQueue = operation.then(
    () => undefined,
    () => undefined
  );
  return operation;
}

/** Replaces the complete config. Prefer updateConfig for read-modify-write changes. */
export function saveConfig(next: Config): Promise<Config> {
  return updateConfig(() => next);
}
