import { createHash } from 'node:crypto';
import { authorizedAutomaticDesignSkills, autoInvokedSkills, directlyRequestedDesignSkills, excludedAutomaticSkills, explicitlyRequestedSkills, invokedSkills, refusedLeadingSkills, replacedSkillChoices, scopesCurrentWorkToBackend } from '../../shared/skill-invocation.js';
import { skillsDirectory } from '../skills.js';
import {
  listSkillLibrary,
  readLibrarySkill,
  type ScopedSkillLibrary,
  type SkillLibraryScope,
} from '../skill-library.js';
import { MAX_CHATGPT_MESSAGE_CHARS, userPromptText } from '../../shared/user-prompt.js';
import { logInfo } from '../logger.js';

/** Kept as the main-process compatibility export for focused tests and callers. */
export const leadingSkillIds = invokedSkills;

/** Follow-ups have no opening Skill metadata index. Avoid a fresh project and
 * managed catalog walk when no saved or current instruction can select a body.
 * Use relevance-only matching: an older visual task with an automatic opt-out
 * may become relevant again after a newer explicit renewal. */
export function mayRequireSkillLibrary(commands: readonly string[]): boolean {
  return commands.some(command => invokedSkills(command).length > 0 ||
    explicitlyRequestedSkills(command).length > 0 ||
    directlyRequestedDesignSkills(command).length > 0 ||
    autoInvokedSkills(command, { relevanceOnly: true }).length > 0);
}

const DESIGN_AUTO_SELECT_MARKER = 'cos-auto-select: visual-design-v1';
const DESIGN_EVIDENCE_REQUIREMENTS = [
  '# Design task evidence requirements',
  '- Apply the selected or read design Skill body and relevant reference material before planning, editing, or claiming design progress.',
  '- Look for reference screenshots, DESIGN.md, surface briefs, accepted comps, generated boards, and neighboring UI contracts. Compare against them when present, and state what was unavailable.',
  '- If the design Skill body, reference screenshot/contract, or product/viewport evidence is unavailable, state the limitation, preserve the user’s design intent, and label the result source-only or unverified instead of claiming Skill use, fidelity, polish, completion, or acceptance.',
  '- A tool existing, a Skill name being mentioned, or old history is not proof of design Skill use, UI fidelity, visual polish, completion, or acceptance. Claim those only after observed before/after evidence and real interaction or viewport checks where relevant; otherwise label the result source-only or unverified.',
].join('\n');

function optedIntoAutoSelection(id: string, text: string): boolean {
  if (id !== 'impeccable' && id !== 'design' && !/^impeccable--repo-[a-f0-9]{12}$/.test(id)) return false;
  const normalized = text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  if (!normalized.startsWith('---\n')) return false;
  const close = normalized.indexOf('\n---\n', 4);
  if (close < 0 || close > 4_096) return false;
  return normalized.slice(4, close).split('\n').some(line => line.trim() === DESIGN_AUTO_SELECT_MARKER);
}

/** Bodies remain complete. The existing delivery ledger freezes the returned text. */
export async function selectedSkillInstructions(
  commands: readonly string[],
  scope: SkillLibraryScope = {},
  library?: ScopedSkillLibrary,
  implicitContext: readonly string[] = [],
): Promise<string> {
  const currentText = commands[0] ?? '';
  const currentRefusals = new Set(refusedLeadingSkills(currentText));
  const isDirectlyRefused = (id: string, refusals: ReadonlySet<string>): boolean =>
    refusals.has('*') || refusals.has(id) ||
    (refusals.has('impeccable') && /^impeccable--repo-[a-f0-9]{12}$/.test(id));
  const isDesignChoice = (id: string): boolean =>
    id === 'design' || id === 'impeccable' || /^impeccable--repo-[a-f0-9]{12}$/.test(id);
  const allowedLeadingSkills = (command: string, refusals: ReadonlySet<string>): string[] =>
    invokedSkills(command).filter(id => !isDirectlyRefused(id, refusals));
  const currentExplicit = allowedLeadingSkills(currentText, currentRefusals);
  const currentNamed = [...explicitlyRequestedSkills(currentText), ...directlyRequestedDesignSkills(currentText)];
  const hasCurrentDesignCommand = currentExplicit.some(isDesignChoice);
  // A current slash-design choice outranks a prose request; another current
  // explicit Skill can coexist with a deliberate named Impeccable request.
  const currentNamedChoice = currentNamed.filter(id =>
    !(hasCurrentDesignCommand && isDesignChoice(id)) &&
    !isDirectlyRefused(id, currentRefusals));
  // Commands are newest first. A deliberate prose request to read a named
  // Skill has the same lasting authority as its leading slash equivalent.
  // Retain only the most recent design choice, alongside unrelated Skills,
  // respecting same-command and newer direct refusals. Quoted history and
  // automatic relevance hints never become explicit selections.
  // An actionable human "/alpha instead of Beta" supersedes the older Beta
  // body just as an explicit Beta refusal does. A replacement is meaningful
  // only alongside an effective affirmative selection in that same message.
  // Quotes and fenced examples are already excluded by the shared parser.
  const currentReplacements = currentExplicit.length || currentNamedChoice.length
    ? replacedSkillChoices(currentText, [...currentExplicit, ...currentNamedChoice]) : [];
  // A same-message replacement supersedes its own earlier affirmative choice,
  // not just an older choice recovered from the saved objective.
  for (const id of currentReplacements) {
    const leading = currentExplicit.indexOf(id);
    if (leading >= 0) currentExplicit.splice(leading, 1);
    const named = currentNamedChoice.indexOf(id);
    if (named >= 0) currentNamedChoice.splice(named, 1);
  }
  const newerRefusals = new Set([...currentRefusals, ...currentReplacements]);
  const savedExplicit: string[] = [];
  const savedNamed = new Set<string>();
  // An unrelated named Skill (for example Beta for diagnostics) does not
  // supersede a saved, explicitly selected /design or /impeccable workflow.
  // Only a genuine newer design choice competes for the one design slot;
  // direct refusals and explicit replacements are handled separately above.
  let designChoiceSelected = hasCurrentDesignCommand || currentNamedChoice.some(isDesignChoice);
  for (const command of commands.slice(1)) {
    const savedRefusals = new Set(refusedLeadingSkills(command));
    const leading = allowedLeadingSkills(command, savedRefusals);
    const named = [...explicitlyRequestedSkills(command), ...directlyRequestedDesignSkills(command)]
      .filter(id => !(leading.some(isDesignChoice) && isDesignChoice(id)) &&
        !isDirectlyRefused(id, savedRefusals));
    const replaced = leading.length || named.length ? replacedSkillChoices(command, [...leading, ...named]) : [];
    for (const id of [...leading, ...named]) {
      if (isDirectlyRefused(id, newerRefusals) || replaced.includes(id) || savedExplicit.includes(id) ||
          (isDesignChoice(id) && designChoiceSelected)) continue;
      savedExplicit.push(id);
      if (isDesignChoice(id)) designChoiceSelected = true;
      if (named.includes(id)) savedNamed.add(id);
    }
    for (const refusal of savedRefusals) newerRefusals.add(refusal);
    for (const id of replaced) newerRefusals.add(id);
  }
  // Hash-verified canonical task content may inform automatic relevance. Only the actual
  // current authored command wins. A newer named affirmative request also overrides older
  // Skill restrictions, while a current refusal still prevails over historical hints.
  const context = [...commands, ...implicitContext];
  const blocked = new Set<string>();
  const authoredDirectRefusals = new Set(commands.flatMap(refusedLeadingSkills));
  for (const id of ['impeccable', 'design']) {
    // Later authored automatic-only corrections outrank older opt-outs (including
    // canonical relevance hints). A direct Skill prohibition is more specific:
    // broad automatic permission never silently revokes it.
    let authoredDecision = false;
    for (const command of commands) {
      if (excludedAutomaticSkills(command).includes(id)) {
        blocked.add(id);
        authoredDecision = true;
        break;
      }
      if (authorizedAutomaticDesignSkills(command).includes(id)) {
        authoredDecision = true;
        break;
      }
    }
    // A long canonical file contributes multiple relevance windows, not a
    // chronological sequence of authenticated human messages. Any opt-out in
    // that reference must survive its own older renewal/window order. Only a
    // later positively authored command may renew automatic selection.
    if (!authoredDecision && implicitContext.some(hint => excludedAutomaticSkills(hint).includes(id))) blocked.add(id);
    if (isDirectlyRefused(id, authoredDirectRefusals)) blocked.add(id);
  }
  // Automatic opt-outs apply to discovery only. Saved explicit commands are
  // revoked by actual direct Skill refusals in authored commands, not by an
  // automatic-only veto or a canonical relevance hint.
  for (const id of currentNamedChoice) blocked.delete(id);
  const isBlocked = (id: string) => blocked.has(id) || currentRefusals.has('*') || currentRefusals.has(id) ||
    ((blocked.has('impeccable') || currentRefusals.has('impeccable')) && /^impeccable--repo-[a-f0-9]{12}$/.test(id));
  const explicit = [...new Set([...currentExplicit, ...savedExplicit])];
  // A saved unrelated command is still part of the original task, but must not
  // suppress automatic UI guidance for the newer current instruction. Input/Goal
  // owns authorship; this selector respects only the caller-supplied ordering.
  // Current explicit commands and saved design choices keep their authority;
  // neutral follow-ups cannot revive saved automatic hints.
  const savedOrCurrentDesignChoice = explicit.some(isDesignChoice);
  const currentBackendScope = scopesCurrentWorkToBackend(currentText);
  const currentAutomatic = currentBackendScope ? [] : autoInvokedSkills(currentText).filter(id => !isBlocked(id));
  // A later authored backend-only correction can temporarily narrow a stored
  // UI objective. Resolve task scope newest-first before consulting old visual
  // relevance; a later explicit renewal or actionable UI correction restores it.
  let backendScoped = false;
  for (const command of commands) {
    if (authorizedAutomaticDesignSkills(command).length) break;
    if (scopesCurrentWorkToBackend(command)) { backendScoped = true; break; }
    if (autoInvokedSkills(command, { relevanceOnly: true }).length) break;
  }
  const automatic = currentNamedChoice.length || currentExplicit.length || savedOrCurrentDesignChoice ? []
      : currentAutomatic.length ? currentAutomatic
        : backendScoped ? [] : [...new Set(context.flatMap(command =>
          autoInvokedSkills(command, { relevanceOnly: true })))].filter(id => !isBlocked(id));
  // A direct prose request to read/use Impeccable is a deliberate selection,
  // even when its package disables implicit invocation. Resolve a unique
  // project Impeccable package through the existing name-mapping helper.
  const candidates = [...new Set([...explicit, ...currentNamedChoice, ...automatic])];
  if (!candidates.length) return '';
  if (!skillsDirectory()) throw new Error('The skills library is not ready. Open Skills and try again.');
  const current = library ?? await listSkillLibrary(scope);
  const available = new Map(current.skills.map(skill => [skill.id, skill]));
  const automaticSummary = (id: string) => {
    const exact = available.get(id);
    if (exact || id !== 'impeccable') return exact;
    const projectMatches = current.skills.filter(skill => /^impeccable--repo-[a-f0-9]{12}$/.test(skill.id));
    // Project skills deliberately keep collision-resistant IDs. A single project Impeccable
    // package is still the same automatic preference; multiple packages are ambiguous, so let
    // the existing /design fallback win instead of guessing which project instructions apply.
    return projectMatches.length === 1 ? projectMatches[0] : undefined;
  };
  const selected: Array<{ id: string; text: string; path: string }> = [];
  const notes: string[] = [];
  const noteOnce = (text: string): void => {
    if (!notes.includes(text)) notes.push(text);
  };
  const trySelectDesignFallback = async (): Promise<boolean> => {
    if (selected.some(skill => skill.id === 'design') || isBlocked('design')) return false;
    const summary = available.get('design');
    if (!summary) return false;
    try {
      const skill = await readLibrarySkill('design', scope, current);
      if (!skill.summary.allowImplicitInvocation || !optedIntoAutoSelection('design', skill.text)) return false;
      selected.push({ id: 'design', text: skill.text, path: summary.path });
      return true;
    } catch {
      return false;
    }
  };
  const noteMissingProseSkill = async (reason: string): Promise<void> => {
    const fallbackSelected = await trySelectDesignFallback();
    noteOnce(`Skill /impeccable was requested in prose but ${reason}. Preserve the user’s intended design workflow. Do not claim /impeccable was read or used; continue with available evidence${fallbackSelected ? ' and the selected /design fallback' : ''}.`);
  };
  for (const id of candidates) {
    const isNamed = currentNamedChoice.includes(id) || savedNamed.has(id);
    const isLeadingExplicit = explicit.includes(id);
    const isExplicit = isLeadingExplicit || isNamed;
    const summary = isNamed ? automaticSummary(id) : isExplicit ? available.get(id) : automaticSummary(id);
    if (!summary) {
      if (isNamed && id === 'impeccable' && !isLeadingExplicit) {
        await noteMissingProseSkill('is not installed or available for this project');
        continue;
      }
      if (isExplicit) throw new Error(`Skill /${id} is unavailable. Select an installed skill from Skills or remove the command.`);
      continue;
    }
    let skill: Awaited<ReturnType<typeof readLibrarySkill>>;
    try {
      skill = await readLibrarySkill(summary.id, scope, current);
    } catch (error) {
      if (isNamed && id === 'impeccable' && !isLeadingExplicit) {
        await noteMissingProseSkill('its body could not be read');
        continue;
      }
      if (isExplicit) throw error;
      noteOnce(`Automatic Skill /${summary.id} was discovered but its body could not be read. Do not claim it was read or used; continue with available Skills and evidence.`);
      continue;
    }
    if (!isExplicit) {
      if (!skill.summary.allowImplicitInvocation || !optedIntoAutoSelection(summary.id, skill.text)) continue;
    }
    selected.push({ id: summary.id, text: skill.text, path: summary.path });
    // Automatic candidates are ordered preferences, not a stack. Selecting both the richer
    // workflow and its bundled fallback would duplicate and potentially conflict instructions.
    if (!isExplicit) break;
  }
  if (!selected.length && !notes.length) return '';
  if (selected.length) logInfo(`skills: selected ids=${selected.map(skill => skill.id).join(',')} source=${explicit.length || currentNamedChoice.length ? 'explicit-or-mixed' : 'automatic'}`);
  const sections: string[] = [];
  if (notes.length) sections.push(['# Skill selection notes', ...notes.map(note => `- ${note}`)].join('\n'));
  if (notes.length || selected.some(skill => isDesignChoice(skill.id))) sections.push(DESIGN_EVIDENCE_REQUIREMENTS);
  if (!selected.length) return sections.join('\n\n');
  const lines = ['# Selected skills', 'Use these selected skill instructions for the task, subject to the main instructions and available tools.'];
  for (const skill of selected) {
    const { id } = skill;
    const body = skill.text.replace(/\r\n?/g, '\n');
    // A later acceptance projection can prove that this exact body reached a
    // confirmed native input. The marker is computed from the body itself and
    // is not a selection claim or an execution receipt on its own.
    const bodySha256 = createHash('sha256').update(body).digest('hex');
    lines.push(`## ${id}\nSource: ${skill.path}\n\n<!-- cos-skill-body-sha256:${bodySha256} -->\n<SKILL_INSTRUCTIONS>\n${body}\n</SKILL_INSTRUCTIONS>`);
    if (lines.join('\n\n').length > MAX_CHATGPT_MESSAGE_CHARS) throw new Error('Selected skills exceed the 96,000-character message limit. Select fewer or shorter skills.');
  }
  sections.push(lines.join('\n\n'));
  const result = sections.join('\n\n');
  if (result.length > MAX_CHATGPT_MESSAGE_CHARS) throw new Error('Selected skills exceed the 96,000-character message limit. Select fewer or shorter skills.');
  return result;
}

export type SelectedSkillBodyEvidence = Readonly<{ id: string; sourcePath: string; bodySha256: string }>;

/** The length-delimited Core frame is the only selected-Skill authority. The
 * authored message may literally quote a Skill marker or example; inspecting
 * those bytes as though CoS selected it can fabricate evidence or block work. */
function trustedSkillInstructions(prepared: string): string | null {
  const normalized = prepared.replace(/\r\n?/g, '\n');
  const header = /^(?:\[\[CLF-(?:HANDOFF|RESUME):[A-Za-z0-9_-]{16,64}\]\]\n\n)?\[\[COS_CONTEXT:(\d{1,6})\]\]\n/.exec(normalized);
  if (!header) return null;
  if (userPromptText(normalized) === null) throw new Error('Selected Skill instruction frame is incomplete or malformed.');
  return normalized.slice(header[0].length, header[0].length + Number(header[1]));
}

/** Verify selected Skill *declarations* as well as body hashes against exact
 * approved current sources. Return a read-only source attestation for the
 * incumbent Send-time owner; this never proves a Send, use, or completion. */
export async function verifySelectedSkillBodies(prepared: string, scope: SkillLibraryScope = {}): Promise<readonly SelectedSkillBodyEvidence[]> {
  const trusted = trustedSkillInstructions(prepared);
  if (trusted === null) return [];
  const label = '# Selected skills\n\nUse these selected skill instructions for the task, subject to the main instructions and available tools.';
  const sectionAt = trusted.indexOf(label);
  if (sectionAt < 0) {
    if (trusted.includes('<!-- cos-skill-body-sha256:') || trusted.includes('<SKILL_INSTRUCTIONS>'))
      throw new Error('Selected Skill instructions are incomplete or malformed.');
    return [];
  }
  const section = trusted.slice(sectionAt + label.length);
  const entry = /^## ([a-z0-9._-]+)\nSource: ([^\n]+)\n\n<!-- cos-skill-body-sha256:([a-f0-9]{64}) -->\n<SKILL_INSTRUCTIONS>\n([\s\S]*?)\n<\/SKILL_INSTRUCTIONS>/gm;
  const found = [...section.matchAll(entry)];
  // Do not let a complete Alpha mask a truncated Beta declaration. Ignore
  // Markdown headings and markers *inside* verified bodies when checking the
  // remaining selected-section syntax.
  const outsideBodies = section.replace(entry, '');
  if (!found.length || /^## [a-z0-9._-]+\nSource:/m.test(outsideBodies) ||
      outsideBodies.includes('<!-- cos-skill-body-sha256:') ||
      outsideBodies.includes('<SKILL_INSTRUCTIONS>') || outsideBodies.includes('</SKILL_INSTRUCTIONS>'))
    throw new Error('Selected Skill instructions are incomplete or malformed.');
  const library = await listSkillLibrary(scope);
  const evidence: SelectedSkillBodyEvidence[] = [];
  const seen = new Set<string>();
  for (const match of found) {
    const [, id, source, sha, body] = match;
    if (seen.has(id!)) throw new Error('Selected Skill instructions are incomplete or malformed.');
    seen.add(id!);
    if (createHash('sha256').update(body!).digest('hex') !== sha) throw new Error('Selected Skill body hash is invalid.');
    const current = await readLibrarySkill(id!, scope, library);
    if (current.summary.path !== source || current.text.replace(/\r\n?/g, '\n') !== body)
      throw new Error('Selected Skill source changed after preparation; rebuild the unsent Input.');
    evidence.push({ id: id!, sourcePath: source!, bodySha256: sha! });
  }
  return evidence;
}
