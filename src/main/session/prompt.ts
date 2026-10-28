import path from 'node:path';
import { createHash } from 'node:crypto';
import { open, stat } from 'node:fs/promises';
import { readFileStream } from '../codex/filesystem.js';
import { effectiveCapabilities, getConfig } from '../config.js';
import { openingCoreInstructionParts } from '../mcp/instructions.js';
import { getSessionProject, projectWorkspace } from '../projects.js';
import { resolvePath } from '../sandbox.js';
import { MAX_CHATGPT_MESSAGE_CHARS, prependUserPrompt, userPromptText } from '../../shared/user-prompt.js';
import { authorizedAutomaticDesignSkills, canonicalSkillRelevanceWindows, directlyRequestedDesignSkills, excludedAutomaticSkills, explicitlyRequestedSkills, invokedSkills, mentionedActionableSkillIds, refusedLeadingSkills, replacedSkillChoices, scopesCurrentWorkToBackend } from '../../shared/skill-invocation.js';
import { mayRequireSkillLibrary, selectedSkillInstructions } from './skill-prompt.js';
import { listSkillLibrary } from '../skill-library.js';
import { goalObjectiveFor } from '../goal.js';
import { nativeExecutionScopeForPreparedInput } from '../mcp/plan-tool.js';
import { stampNativeExecutionScope } from '../../shared/agent-plan.js';
import { getSession, readHandoff, readRecentEvents } from './store.js';
import type { InputEntry } from './input.js';
import { resumeBootstrapMatches } from './handoff.js';
import { MAX_CANONICAL_SKILL_BYTES, sameFileSnapshot, archivedCanonicalMain, isReviewedCompactGoal, readVerifiedSavedGoalOriginal, type VerifiedSavedGoalOriginal } from './canonical-original.js';

type PromptScope = {
  sessionId?: string | null;
  conversationId?: string | null;
  /** Proven source-helper continuations are generated; their prose cannot select Skills. */
  generatedContinuation?: boolean;
  /** Only Input's native delivery owner may freeze execution scope. Plain
   * prompt preparation still returns unchanged text when no Skill is needed. */
  nativeDelivery?: boolean;
  /** Main's already-serialized Input snapshot; only the production Input
   * preparation callback supplies it. Never an MCP plan-evidence argument. */
  nativeInputOwnerRows?: readonly InputEntry[];
  nativeInput?: Readonly<InputEntry>;
  projectId?: string | null;
  skillCommands?: readonly string[];
  /** Fresh-worker-only contract supplied by the bridge; never derived from or added to user text. */
  workerInstructions?: string | null;
};

type FollowupSkillAuthority = { commands: string[]; historyDigest: string | null };

/** The same incumbent recorded user-role rows used for Skill precedence also
 * attest that the selection stayed current across asynchronous disk/body reads.
 * Proven Goal/Loop rows carry no human Skill authority; uncertain rows do.
 * Neither assistant results nor tool count changes invalidate this digest. */
function skillHistoryDigest(
  events: readonly Awaited<ReturnType<typeof readRecentEvents>>[number][],
  scope: PromptScope,
  committedHandoff: string | null | undefined,
  savedObjective: string | null | undefined
): string {
  const digest = createHash('sha256');
  digest.update(JSON.stringify([scope.conversationId, committedHandoff ?? null, savedObjective ?? null]));
  for (const event of events) {
    if (event.kind !== 'user_message' || event.automationOrigin) continue;
    digest.update(JSON.stringify([
      event.messageId, event.source, event.inputId ?? null, event.authoredText ?? null,
      event.unverifiedAuthorshipClaim === true,
      event.message.text, event.message.chars, event.message.truncated
    ]));
    digest.update('\n');
  }
  return digest.digest('hex');
}

async function verifyFollowupSkillAuthority(scope: PromptScope, expected: string | null): Promise<void> {
  if (!expected || !scope.sessionId || !scope.conversationId) return;
  const summary = await getSession(scope.sessionId);
  if (!summary || summary.conversationId !== scope.conversationId)
    throw new Error('Recorded Skill history changed conversation during preparation.');
  const events = await readRecentEvents(scope.sessionId, Math.max(48, summary.userMessages), { kinds: ['user_message'] });
  const still = await getSession(scope.sessionId);
  if (events.length < summary.userMessages || !still ||
      still.conversationId !== scope.conversationId || still.userMessages !== summary.userMessages ||
      skillHistoryDigest(events, scope, still.lastCommittedResumeHandoffId, goalObjectiveFor(scope.conversationId)) !== expected)
    throw new Error('Recorded Skill history changed during preparation; review the latest human corrections before sending.');
}

/** Resolve existing-chat Skill authority before enumerating the library. A neutral
 * outbox follow-up has no Skill command of its own, but it must still honor an
 * explicit user selection in the saved Goal or verified prior human messages.
 * Session ID and current conversation must match: never borrow an old chat's
 * directives after a rebind or from an unconfirmed/foreign recording. */
async function followupSkillCommands(commands: readonly string[], scope: PromptScope): Promise<FollowupSkillAuthority> {
  const current = scope.generatedContinuation ? [] : [...commands];
  // Unscoped utility callers may prepare independent text. Once an Input is
  // tied to a durable session, missing or stale native conversation custody
  // cannot turn an authenticated saved Skill/correction into current-only
  // commands. Reject before the no-Skill fast path or a library body read.
  if (!scope.sessionId && !scope.conversationId) return { commands: current, historyDigest: null };
  if (!scope.sessionId || !scope.conversationId)
    throw new Error('Recorded Skill session and conversation identity is incomplete; recover the bound chat before preparing the Input.');
  const session = await getSession(scope.sessionId);
  if (!session || session.conversationId !== scope.conversationId)
    throw new Error('Recorded Skill session changed conversation; recover the current binding before preparing this Input.');

  // Only the incumbent session reader may supply Skill history: consulting the
  // outbox from prepareText deadlocks its serialized owner. A fixed 48-message
  // tail used to forget an older real human Skill refusal after enough neutral
  // replies, then silently revive the explicit command in the saved objective.
  // Use the session's recorded user-message count to request the complete human
  // history through the existing bounded reader. If its byte/row cap prevents
  // that, refuse Skill preparation instead of guessing which correction wins.
  // Extension-authored messages have positive human provenance; app echoes and
  // helper-generated user-role messages still cannot become Skill authority.
  const recordedUsers = session.userMessages;
  const events = await readRecentEvents(scope.sessionId, Math.max(48, recordedUsers), { kinds: ['user_message'] });
  if (events.length < recordedUsers) throw new Error(
    'Recorded human Skill history is incomplete; inspect the original corrections before continuing this task.'
  );
  const handoff = session.lastCommittedResumeHandoffId
    ? await readHandoff(scope.sessionId, session.lastCommittedResumeHandoffId) : null;
  const history: string[] = [];
  const verifiedInstructions: Array<{ at: number; text: string }> = [];
  const unverifiedSkillVetoes: Array<{ at: number; text: string; targets: string[]; incomplete: boolean }> = [];
  for (const [at, event] of events.entries()) {
    if (event.kind !== 'user_message' || event.automationOrigin) continue;
    // A truncated display row can still have the complete positively authored
    // original from the recorder. Do not throw that human correction away and
    // restore an older saved Skill choice. Conversely, an incomplete original
    // might contain a later veto or renewal: preparation must fail visibly
    // rather than silently decide what the missing words instructed.
    const authored = event.authoredText ?? userPromptText(event.message.text) ?? event.message.text;
    if (!authored || (handoff && resumeBootstrapMatches(authored, handoff.text))) continue;
    // A browser echo carrying inputId proves an outbox delivery, NOT who wrote
    // the entry. The actual input owner cannot be read here: prepareText runs
    // under that owner's serializer and would deadlock. Old app-generated and
    // genuine manual entries can both lack automationOrigin. Do not silently
    // reinstate a saved Skill when an unverified later item might veto it.
    if (event.source !== 'extension' || event.inputId || event.unverifiedAuthorshipClaim === true) {
      // A bare /skill in an unverified outbox echo is reference data, not a
      // newly authenticated selection or a veto. With an explicit current
      // human-correction claim, however, silently preserving an older Skill
      // would choose the wrong authority; require source reconciliation.
      const claimsCorrection = /(?:^|\n)\s*(?:(?:current|latest|later|newer)\s+(?:(?:human|user)\s+)?(?:correction|instruction|update|follow[- ]?up)|(?:human|user)\s+(?:correction|instruction|update))\s*[:\-—]/i.test(authored);
      // A corrective sentence may request /beta in prose rather than as a
      // leading slash command. This is uncertain evidence, never authority
      // to select Beta, but it can still invalidate the older saved Alpha.
      const namedIds = mentionedActionableSkillIds(authored);
      const possibleNamedSkill = namedIds.length > 0;
      // A direct "Use the Beta Skill" can be a genuine human instruction
      // even without a "Current correction:" label. Its app/outbox echo has
      // no positive authorship proof, so preserve it as uncertainty instead
      // of silently delivering an older Skill body. Quoted, generated and
      // general Skill policy prose remain inert in explicitlyRequestedSkills.
      const possibleProseSelection = explicitlyRequestedSkills(authored).length > 0;
      if ((event.message.truncated && !event.authoredText) ||
          (claimsCorrection && (invokedSkills(authored).length > 0 || possibleNamedSkill)) ||
          possibleProseSelection ||
          directlyRequestedDesignSkills(authored).length ||
          authorizedAutomaticDesignSkills(authored).length ||
          refusedLeadingSkills(authored).length || excludedAutomaticSkills(authored).length ||
          scopesCurrentWorkToBackend(authored)) {
        // Retain which Skill an uncertain message could change. A verified
        // /gamma decision cannot settle an earlier unresolved /beta veto.
        // The full text remains local provenance, never a human instruction.
        const targets = [...new Set([
          ...namedIds, ...invokedSkills(authored),
          ...explicitlyRequestedSkills(authored), ...directlyRequestedDesignSkills(authored),
          ...replacedSkillChoices(authored),
          ...authorizedAutomaticDesignSkills(authored),
          ...refusedLeadingSkills(authored), ...excludedAutomaticSkills(authored),
          ...(scopesCurrentWorkToBackend(authored) ? ['impeccable', 'design'] : [])
        ])];
        unverifiedSkillVetoes.push({
          at, text: authored, targets,
          incomplete: event.message.truncated && !event.authoredText
        });
      }
      continue;
    }
    if (event.message.truncated && !event.authoredText) throw new Error(
      'Recorded human Skill correction is incomplete; recover the full original instruction before continuing.'
    );
    history.push(authored);
    verifiedInstructions.push({ at, text: authored });
  }
  // Resolve each uncertain Skill separately, using only positively attributed
  // later human decisions. An unrelated /gamma cannot validate old /beta, and
  // a self-refused /alpha cannot count as renewed Alpha authorization.
  // One indexed scan avoids the previous quadratic comparison with history.
  const lastHumanRestatement = new Map<string, number>();
  const lastDecisionForSkill = new Map<string, number>();
  let lastAllSkillRefusal = -1;
  for (const human of verifiedInstructions) {
    lastHumanRestatement.set(human.text, human.at);
    const refusals = new Set(refusedLeadingSkills(human.text));
    if (refusals.has('*')) {
      lastAllSkillRefusal = human.at;
      continue;
    }
    const selected = [...invokedSkills(human.text), ...explicitlyRequestedSkills(human.text), ...directlyRequestedDesignSkills(human.text)]
      .filter(id => !refusals.has(id));
    for (const id of [
      ...selected, ...refusals, ...authorizedAutomaticDesignSkills(human.text)
    ]) {
      lastDecisionForSkill.set(id, human.at);
    }
    // A specifically named replacement also resolves the previous choice,
    // even when the new /alpha is different from the old uncertain /beta.
    if (selected.length > 0) {
      for (const id of replacedSkillChoices(human.text, selected)) {
        lastDecisionForSkill.set(id, human.at);
      }
    }
  }
  if (unverifiedSkillVetoes.some(veto => {
    if (!veto.incomplete && (lastHumanRestatement.get(veto.text) ?? -1) > veto.at) return false;
    if (lastAllSkillRefusal > veto.at) return false;
    return veto.incomplete || veto.targets.length === 0 ||
      veto.targets.some(id => (lastDecisionForSkill.get(id) ?? -1) <= veto.at);
  })) {
    throw new Error('Recorded Skill correction authorship is unverified; inspect the exact original human instruction and outbox custody before selecting a saved Skill.');
  }
  const savedObjective = goalObjectiveFor(scope.conversationId);
  if ((await getSession(scope.sessionId))?.conversationId !== scope.conversationId) throw new Error(
    'The session changed conversation while its Skill corrections were being read.'
  );
  return {
    commands: [...new Set([...current, ...history.reverse(), ...(savedObjective ? [savedObjective] : [])])],
    historyDigest: skillHistoryDigest(events, scope, session.lastCommittedResumeHandoffId, savedObjective)
  };
}
export type PromptLimits = { maxChars: number; maxBytes: number };
type ProjectInstructions = { directory: string; text: string; truncated: boolean };
const limits: PromptLimits = { maxChars: MAX_CHATGPT_MESSAGE_CHARS, maxBytes: Infinity };
const cutNotice = '\n\n[Cut off because of the message limit. Read AGENTS.md yourself for the remaining instructions.]';
type RetainedCompactSkillIntent = { hints: string[]; original: VerifiedSavedGoalOriginal | null };
async function retainedCompactGoalSkillIntent(commands: readonly string[]): Promise<RetainedCompactSkillIntent> {
  let unresolvedCompactGoal = false;
  for (const command of commands) {
    const recovered = await readVerifiedSavedGoalOriginal(command);
    if (recovered) return { hints: canonicalSkillRelevanceWindows(`${recovered.main}\n${recovered.compactMain}`), original: recovered };
    // A combined human opening can quote the approved saved Goal before a
    // newer correction; the separately supplied exact saved Goal later in
    // this same command list still proves the original. Defer the error until
    // every candidate has had that opportunity.
    if (isReviewedCompactGoal(command)) unresolvedCompactGoal = true;
  }
  if (unresolvedCompactGoal) throw new Error(
    'Canonical saved Goal original-scope archive pointer is missing or changed; recover the complete human task before selecting Skills.'
  );
  return { hints: [], original: null };
}

/** Skill and optional project reads yield after the human original was pinned.
 * Recheck that same approved original at the return boundary, including the
 * case where an edited compact file no longer matches the saved Goal. A
 * previously verified empty/nonvisual hint still requires this check. */
async function verifyRetainedCompactSkillIntent(commands: readonly string[], prepared: RetainedCompactSkillIntent): Promise<void> {
  if (!prepared.original) return;
  const current = (await retainedCompactGoalSkillIntent(commands)).original;
  if (!current || current.id !== prepared.original.id ||
      current.main !== prepared.original.main || current.compactMain !== prepared.original.compactMain) {
    throw new Error('Canonical saved Goal original changed during Skill preparation; review the current original before sending.');
  }
}


/**
 * Canonical queue-chat launches intentionally send a short, hash-bound file reference.
 * The real UI intent lives in its main brief, not the short launcher or Loop objective.
 * Read that exact approved and immutable file as a relevance hint only; neither its text
 * nor an accidental leading /command becomes an injected instruction or explicit skill.
 */
async function canonicalTaskSkillIntent(authored: string): Promise<string[]> {
  const match = /^Start [^\r\n]{1,200}\. The complete user-authorized task is stored locally at (.+?\.md)\. SHA-256 at dispatch: ([a-f0-9]{64})\./.exec(authored);
  if (!match) return [];
  const filename = match[1]!;
  const id = /[\\/]docs[\\/]prompts[\\/](chat-\d+)\.md$/i.exec(filename)?.[1];
  if (!id || !path.isAbsolute(filename)) return [];
  if (!effectiveCapabilities(getConfig()).read) throw new Error('Cannot read the canonical task for Skill selection with current permissions');
  let original: Awaited<ReturnType<typeof resolvePath>>;
  try {
    original = await resolvePath(getConfig().roots, filename);
  } catch {
    throw new Error('Canonical task is unavailable or outside approved readable folders for Skill selection');
  }
  const handle = await open(original.real, 'r').catch(() => {
    throw new Error('Canonical task could not be opened for Skill selection');
  });
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.size <= 0) throw new Error('Canonical task must be a nonempty regular file for Skill selection');
    if (before.size > MAX_CANONICAL_SKILL_BYTES) throw new Error('Canonical task exceeds the 32 MiB Skill selection input limit');
    // The full approved file is already streamed for its dispatch hash. Retain
    // those same bounded bytes for Skill relevance instead of silently scanning
    // only the first 64 KiB of what can be a much longer original human task.
    const chunks: Buffer[] = [];
    const digest = createHash('sha256');
    let received = 0;
    for await (const chunk of handle.createReadStream({ autoClose: false })) {
      const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      received += data.length;
      if (received > MAX_CANONICAL_SKILL_BYTES) throw new Error('Canonical task exceeds the 32 MiB Skill selection input limit');
      digest.update(data);
      chunks.push(data);
    }
    if (received !== before.size || !sameFileSnapshot(before, await handle.stat())) {
      throw new Error('Canonical task changed while reading for Skill selection');
    }
    const current = await resolvePath(getConfig().roots, filename);
    const currentFile = await stat(current.real);
    if (current.real !== original.real || !sameFileSnapshot(before, currentFile) || !effectiveCapabilities(getConfig()).read) {
      throw new Error('Canonical task changed path or permission during Skill selection');
    }
    if (digest.digest('hex') !== match[2]) {
      throw new Error('The canonical task changed after dispatch; review the updated task before sending');
    }
    const full = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, received));
    if (full.includes('\0')) throw new Error('Canonical task must contain valid Markdown text');
    const marker = `<!-- source: ${id} -->`;
    const start = full.indexOf(marker);
    const end = start < 0 ? -1 : full.indexOf('<!-- end-source -->', start + marker.length);
    if (start < 0) throw new Error('Canonical task has no matching main prompt');
    if (end < 0) throw new Error('Canonical task has an incomplete main prompt');
    // Scan the full source with one shared Markdown fence/comment state, then
    // process bounded windows. Neither the long brief nor its windows go into
    // the delivered model prompt: the original hash-bound launcher stays intact.
    const compactMain = full.slice(start + marker.length, end);
    const archivedMain = await archivedCanonicalMain(compactMain, id, original.real);
    const final = await resolvePath(getConfig().roots, filename);
    if (final.real !== original.real || !sameFileSnapshot(before, await stat(final.real)) ||
        !effectiveCapabilities(getConfig()).read) {
      throw new Error('Canonical task changed during original-scope Skill selection');
    }
    return canonicalSkillRelevanceWindows(archivedMain ? `${archivedMain}\n${compactMain}` : compactMain);
  } catch (error) {
    if (error instanceof Error && (
      error.message.startsWith('Canonical task ') ||
      error.message.startsWith('The canonical task changed after dispatch')
    )) throw error;
    // Do not reveal host filesystem paths from a prompt-preparation failure.
    throw new Error('Could not read the approved canonical task safely for Skill selection');
  } finally {
    await handle.close();
  }
}

/**
 * Fresh Prime chats must prove local-work availability instead of inferring it from the page.
 *
 * A browser answer that merely says a Windows folder is not mounted is not evidence: the Core
 * connector can be healthy while the model elects not to call it. Keeping this contract in the
 * existing opening-prompt owner makes the first harmless read observable to the recorder and
 * gives recovery one exact `CORE_UNAVAILABLE` outcome when the tool really is absent.
 */
export const PRIME_CORE_PREFLIGHT_INSTRUCTIONS = `Prime Core preflight (fresh app-opened chat only):
- When the user's request requires local files, a repository, a terminal, or workspace mutation, your first local action must be one harmless Core read of an existing workspace file. Prefer the selected project's AGENTS.md; when the user supplies an exact path, read that exact file or a known file beneath that exact folder. Do not begin with exec or apply_patch.
- Only returned Core file content proves local workspace access. Do not claim that a Windows path is unmounted, missing, or unavailable merely because it was not listed in the browser context.
- If Core read returns a real path, permission, or connector error, report that exact failure and the exact path without inventing another environment.
- If the Core read tool is absent from this chat, put CORE_UNAVAILABLE on the first line, explain that no local operation ran, and stop. Never pretend that you inspected, edited, tested, or verified workspace files.`;

const promptFolder = (scope: PromptScope): Promise<{ virtual: string; real: string } | null> =>
  scope.sessionId ? getSessionProject(scope.sessionId)
    : scope.projectId ? projectWorkspace(scope.projectId) : Promise.resolve(null);

/** One selected folder, never cwd inference, global discovery or a recursive document scan. */
async function projectInstructions(
  scope: PromptScope,
  expectedFolder?: { virtual: string; real: string } | null,
): Promise<ProjectInstructions | null> {
  if ((!scope.sessionId && !scope.projectId) || !effectiveCapabilities(getConfig()).read) return null;
  // Existing sessions own their project; a caller-provided project cannot replace that binding.
  const folder = expectedFolder === undefined ? await promptFolder(scope) : expectedFolder;
  if (!folder) return null;
  const filename = path.join(folder.real, 'AGENTS.md');
  try {
    const resolved = await resolvePath(getConfig().roots, filename, { allowMissing: true });
    // At most four UTF-8 bytes per available UTF-16 code unit, plus one byte to detect overflow.
    // Stream a bounded prefix so even a gigabyte AGENTS.md never becomes a gigabyte allocation.
    const budget = MAX_CHATGPT_MESSAGE_CHARS * 4;
    const chunks: Buffer[] = [];
    let bytes = 0;
    for await (const chunk of readFileStream(resolved.real)) {
      const kept = chunk.subarray(0, Math.max(0, budget + 1 - bytes));
      chunks.push(kept);
      bytes += kept.length;
      if (bytes > budget) break;
    }
    const data = Buffer.concat(chunks);
    // Streaming decode leaves an incomplete final codepoint out of a shortened prefix.
    const text = new TextDecoder('utf-8', { fatal: true }).decode(data.subarray(0, budget), { stream: bytes > budget });
    if (text.includes('\0')) throw new Error('AGENTS.md must be a UTF-8 text file');
    // Permission/path changes during the asynchronous read cannot publish another folder's text.
    const current = scope.sessionId ? await getSessionProject(scope.sessionId) : await projectWorkspace(scope.projectId!);
    const checked = await resolvePath(getConfig().roots, filename);
    if (!current || current.real !== folder.real || checked.real !== resolved.real || !effectiveCapabilities(getConfig()).read)
      throw new Error('Project instructions changed location or permission while being read');
    return text.trim() ? { directory: current.virtual, text, truncated: bytes > budget } : null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    // Do not expose native filesystem paths through the browser bridge's error response.
    throw new Error('Could not read the selected folder\'s AGENTS.md safely');
  }
}

/** User text, Core and selected skills are mandatory; only project instructions spend slack. */
export function fitSessionPrompt(text: string, core: string, agents: ProjectInstructions | null = null, budget = limits, standing = ''): string {
  const fits = (value: string): boolean => value.length <= Math.min(MAX_CHATGPT_MESSAGE_CHARS, budget.maxChars) &&
    Buffer.byteLength(value, 'utf8') <= budget.maxBytes;
  const withStanding = (instructions: string): string => standing ? `${instructions}\n\n${standing}` : instructions;
  const base = prependUserPrompt(text, withStanding(core));
  if (!fits(base)) throw new Error('The message, main instructions and selected skills exceed the delivery limit (maximum 96,000 characters). Shorten the message or standing instructions, or select fewer skills.');
  if (!agents) return base;
  const content = agents.text.replace(/\r\n?/g, '\n');
  const render = (length: number, shortened: boolean): string => {
    // Never split a UTF-16 surrogate pair at the character budget boundary.
    if (length > 0 && /[\uD800-\uDBFF]/.test(content[length - 1]!)) length--;
    const instructions = `# AGENTS.md instructions for ${agents.directory}\n\n<INSTRUCTIONS>\n${content.slice(0, length)}${shortened ? cutNotice : ''}\n</INSTRUCTIONS>`;
    return prependUserPrompt(text, withStanding(`${core}\n\n${instructions}`));
  };
  const full = render(content.length, agents.truncated);
  if (fits(full)) return full;
  // Include the framing, length header and truncation notice in the exact final budget.
  let low = 0, high = content.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (fits(render(middle, true))) low = middle;
    else high = middle - 1;
  }
  if (low > 0) return render(low, true);
  // A nearly full required Core/Skill/user frame must not silently erase the
  // selected project's only AGENTS.md reference. The executor can read the
  // approved project file through Core when even a shortened body won't fit.
  const readNotice = `# Project AGENTS.md omitted: ${agents.directory}\nRead AGENTS.md in this project via Core before acting; report if unavailable.`;
  const referenced = prependUserPrompt(text, withStanding(`${core}\n\n${readNotice}`));
  if (fits(referenced)) return referenced;
  // A missing reference is a task-fidelity failure. Reject preparation before
  // the delivery owner can send a misleadingly complete user task.
  throw new Error('The selected project\'s AGENTS.md reference exceeds the delivery limit. Shorten the message or selected Skill instructions.');
}

/** Opening normal/worker messages only. Callers own first-message eligibility;
 * follow-ups, helpers, handoff requests and resumed bootstraps never call this. */
export async function prepareSessionPrompt(text: string, scope: PromptScope = {}, budget = limits): Promise<string> {
  const verifyOpeningBinding = async (): Promise<void> => {
    if (!scope.sessionId && !scope.conversationId) return;
    if (!scope.sessionId || !scope.conversationId)
      throw new Error('Opening session and conversation identity is incomplete; recover the current native chat.');
    const current = await getSession(scope.sessionId);
    if (!current || current.conversationId !== scope.conversationId)
      throw new Error('Opening session changed conversation; recover the current native chat before preparing the Input.');
  };
  await verifyOpeningBinding();
  const folder = await promptFolder(scope);
  const skillScope = { projectPath: folder?.real ?? null };
  const library = await listSkillLibrary(skillScope);
  const commands = scope.skillCommands ?? [text];
  // Goal/Loop openings wrap the authored launcher with its saved objective in
  // the delivery text. IPC keeps the raw authored launcher as skillCommands[0];
  // that is the only source eligible for the hash-bound canonical relevance read.
  // Verify the complete hash-bound canonical file before every eligible native
  // opening, even when a saved Goal has an explicit /skill. Skill precedence
  // determines relevance only; it must never bypass the dispatch integrity gate.
  const authoredLauncher = commands[0] ?? text;
  const canonicalLauncher = /^Start [^\r\n]{1,200}\. The complete user-authorized task is stored locally at /.test(authoredLauncher);
  const verifiedCanonicalHint = await canonicalTaskSkillIntent(authoredLauncher);
  const savedGoalIntent = canonicalLauncher
    ? { hints: [], original: null } : await retainedCompactGoalSkillIntent(commands);
  const implicitContext = scope.workerInstructions ? [] : [...verifiedCanonicalHint, ...savedGoalIntent.hints];
  const [parts, skills] = await Promise.all([
    openingCoreInstructionParts(library),
    selectedSkillInstructions(commands, skillScope, library, implicitContext),
  ]);
  // Presentation-only worker instructions replace the ordinary Prime preflight, but skill
  // selection still reads the explicit caller-supplied commands above. The authored prompt
  // remains untouched in either case.
  const preflight = scope.workerInstructions?.trim() || PRIME_CORE_PREFLIGHT_INSTRUCTIONS;
  const core = [preflight, parts.main, skills].filter((part): part is string => !!part).join('\n\n');
  fitSessionPrompt(text, core, null, budget, parts.standing); // Reject mandatory overflow before reading optional files.
  const agents = await projectInstructions(scope, folder);
  const currentFolder = await promptFolder(scope);
  if ((currentFolder?.real ?? null) !== (folder?.real ?? null)) throw new Error('The selected project changed during Skill preparation');
  if (canonicalLauncher) await canonicalTaskSkillIntent(authoredLauncher);
  else await verifyRetainedCompactSkillIntent(commands, savedGoalIntent);
  // A committed provider Resume may rebind the session during asynchronous
  // Skill/core/project reads; never deliver the departed chat's opening body.
  await verifyOpeningBinding();
  return fitSessionPrompt(text, core, agents, budget, parts.standing);
}

/** Explicitly selected follow-up skills use the same hidden frame without repeating setup. */
export async function prepareFollowupPrompt(
  text: string,
  commands: readonly string[] = [text],
  budget = limits,
  scope: PromptScope = {},
): Promise<string> {
  const folder = await promptFolder(scope);
  const { commands: authorizedCommands, historyDigest } = await followupSkillCommands(commands, scope);
  // Capture the same canonical human scope used by update_plan BEFORE this
  // Input's native Send. The existing Input serializer freezes the resulting
  // deliveryText, so a later correction cannot retroactively mint a matching
  // task version for an older Core result or selected Skill body.
  const sourceScope = scope.nativeDelivery && scope.sessionId && scope.conversationId
    ? await nativeExecutionScopeForPreparedInput(scope.sessionId, scope.conversationId,
      scope.nativeInputOwnerRows, scope.nativeInput) : null;
  const markerLength = sourceScope ? stampNativeExecutionScope('', sourceScope).length : 0;
  const markerBytes = sourceScope ? Buffer.byteLength(stampNativeExecutionScope('', sourceScope)) : 0;
  const fitted = sourceScope ? { maxChars: budget.maxChars - markerLength,
    maxBytes: budget.maxBytes - markerBytes } : budget;
  const finalize = async (prepared: string): Promise<string> => {
    // Every NEW native Input needs a retained frame, including ordinary
    // follow-ups without selected Skills. ChatGPT may prefix Core and escape
    // Markdown; the exact whole-payload matcher only accepts those reversible
    // spellings with this frame. Never change an already-frozen deliveryText.
    const framed = scope.nativeDelivery && userPromptText(prepared) === null
      ? prependUserPrompt(prepared, '') : prepared;
    if (sourceScope) {
      const next = await nativeExecutionScopeForPreparedInput(scope.sessionId!, scope.conversationId!,
        scope.nativeInputOwnerRows, scope.nativeInput);
      if (next !== sourceScope) throw new Error(
        'Human task scope changed during native Input preparation; do not deliver an outdated Goal or Skill version.');
    }
    const stamped = sourceScope ? stampNativeExecutionScope(framed, sourceScope) : framed;
    if (scope.nativeDelivery && (stamped.length > Math.min(MAX_CHATGPT_MESSAGE_CHARS, budget.maxChars) ||
        Buffer.byteLength(stamped) > budget.maxBytes)) throw new Error(
      'Prepared native execution frame or task-version metadata exceeds the delivery limit.');
    return stamped;
  };
  // Compact saved Goals retain the original visual task only in their pinned
  // archive. Its verified relevance must be considered before skipping the
  // library walk on a neutral or automatic-Skill-renewal follow-up.
  const savedGoalIntent = await retainedCompactGoalSkillIntent(authorizedCommands);
  if (!mayRequireSkillLibrary([...authorizedCommands, ...savedGoalIntent.hints])) {
    // The ordinary Goal/Loop continuation path must still check its project
    // association, without enumerating or reading unrelated Skill files.
    const currentFolder = await promptFolder(scope);
    if ((currentFolder?.real ?? null) !== (folder?.real ?? null)) throw new Error('The selected project changed during Skill preparation');
    await verifyFollowupSkillAuthority(scope, historyDigest);
    await verifyRetainedCompactSkillIntent(authorizedCommands, savedGoalIntent);
    return finalize(text);
  }
  const skillScope = { projectPath: folder?.real ?? null };
  const library = await listSkillLibrary(skillScope);
  const skills = await selectedSkillInstructions(authorizedCommands, skillScope, library, savedGoalIntent.hints);
  const currentFolder = await promptFolder(scope);
  if ((currentFolder?.real ?? null) !== (folder?.real ?? null)) throw new Error('The selected project changed during Skill preparation');
  await verifyFollowupSkillAuthority(scope, historyDigest);
  await verifyRetainedCompactSkillIntent(authorizedCommands, savedGoalIntent);
  return finalize(skills ? fitSessionPrompt(text, skills, null, fitted) : text);
}
