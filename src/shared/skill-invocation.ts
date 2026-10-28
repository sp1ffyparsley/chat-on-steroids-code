import { MAX_CHATGPT_MESSAGE_CHARS } from './user-prompt.js';

const SKILL_ID = /^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/;
const RESERVED_SKILL_IDS = new Set(['prompt']);
const WINDOWS_RESERVED_SKILL_ID = /^(?:con|prn|aux|nul|conin\$|conout\$|com[0-9]|lpt[0-9])(?:\.|$)/i;
const MAX_SELECTED_SKILLS = 64;

function validSkillId(id: string): boolean {
  return SKILL_ID.test(id) && !RESERVED_SKILL_IDS.has(id) && !WINDOWS_RESERVED_SKILL_ID.test(id);
}

/** Only leading whitespace-separated commands invoke installed skills; following prose stays literal. */
function parseLeadingSkills(text: string): { ids: string[]; remainingText: string } {
  const ids = new Set<string>();
  // Four-space and tab-indented Markdown examples are code, even if their first
  // visible token is /skill. Inline whitespace between actual commands is fine.
  const trimCommandSpace = (value: string, beginning: boolean): string => {
    const prefix = /^[ \t\r\n\uFEFF]*/.exec(value)![0];
    const newline = prefix.lastIndexOf('\n');
    const indentation = newline >= 0 ? prefix.slice(newline + 1) : prefix;
    if ((beginning || newline >= 0) && (indentation.includes('\t') || indentation.replace(/\uFEFF/g, '').length >= 4))
      return newline >= 0 ? value.slice(newline + 1) : value;
    return value.slice(prefix.length);
  };
  let rest = trimCommandSpace(text, true);
  while (rest.startsWith('/')) {
    const command = /^\/([A-Za-z0-9][A-Za-z0-9._-]*)(?=\s|$)/.exec(rest);
    if (!command) break; // Paths, punctuation and malformed commands remain authored text.
    let id = command[1]!;
    rest = trimCommandSpace(rest.slice(command[0].length), false);
    if (id === 'prompt') {
      const argument = /^([A-Za-z0-9][A-Za-z0-9._-]*)(?=\s|$)/.exec(rest);
      if (!argument) throw new Error('Choose a skill after /prompt before sending.');
      id = argument[1]!;
      rest = trimCommandSpace(rest.slice(argument[0].length), false);
      if (!validSkillId(id)) throw new Error('Choose a valid skill command after /prompt.');
    } else if (!validSkillId(id)) throw new Error('Choose a valid installed skill command.');
    ids.add(id);
    if (ids.size > MAX_SELECTED_SKILLS) throw new Error(`Choose no more than ${MAX_SELECTED_SKILLS} skills.`);
  }
  return { ids: [...ids], remainingText: rest };
}

export function invokedSkills(text: string): string[] {
  return parseLeadingSkills(text).ids;
}

/** Quoted Markdown fences and HTML comments are evidence, not new instructions.
 * Both backticks and tildes can fence incident reports or archived instructions. */
function withoutFencedExamples(text: string): string {
  let marker = '';
  let minimum = 0;
  let inHtmlComment = false;
  const withoutHtmlComments = (line: string): string => {
    let kept = '';
    let cursor = 0;
    while (cursor < line.length) {
      if (inHtmlComment) {
        const end = line.indexOf('-->', cursor);
        if (end < 0) return kept;
        inHtmlComment = false;
        cursor = end + 3;
        continue;
      }
      const begin = line.indexOf('<!--', cursor);
      const tick = line.indexOf('`', cursor);
      if (begin < 0 && tick < 0) return kept + line.slice(cursor);
      if (tick >= 0 && (begin < 0 || tick < begin)) {
        // HTML delimiters inside Markdown inline code are literal, not comment
        // openers. Match the exact backtick-run length, including ``code``.
        let size = 0;
        while (line[tick + size] === '`') size++;
        let close = line.indexOf('`', tick + size);
        while (close >= 0) {
          let run = 0;
          while (line[close + run] === '`') run++;
          if (run === size) break;
          close = line.indexOf('`', close + run);
        }
        const end = close < 0 ? tick + size : close + size;
        kept += line.slice(cursor, end);
        cursor = end;
        continue;
      }
      // A backslash-escaped opener or an explicitly quoted literal token is
      // Markdown data, not an HTML comment. Otherwise a backend task about
      // `<!--` can hide an unrelated later human Skill correction until EOF.
      let escapes = 0;
      while (line[begin - escapes - 1] === '\\') escapes++;
      const quote = line[begin - 1];
      const quoteClose = quote === '"' || quote === "'" ? quote :
        quote === '“' ? '”' : quote === '‘' ? '’' : '';
      if (escapes % 2 === 1 || (quoteClose && line[begin + 4] === quoteClose)) {
        kept += line.slice(cursor, begin + 4);
        cursor = begin + 4;
        continue;
      }
      kept += line.slice(cursor, begin);
      cursor = begin + 4;
      inHtmlComment = true;
    }
    return kept;
  };
  // A four-space list marker is code without a preceding Markdown list parent.
  // Preserve actual nested task bullets by tracking active parent indentation.
  // This keeps an archived indented checklist from turning into a new user task.
  const listAncestors: number[] = [];
  return text.split(/\r?\n/).map(rawLine => {
    if (marker) {
      const fence = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(rawLine);
      if (fence && fence[1]![0] === marker && fence[1]!.length >= minimum && !fence[2]!.trim()) {
        marker = '';
        minimum = 0;
      }
      return '';
    }
    // Canonical prompt metadata and historical HTML comments may span lines.
    // Ignore their Skill intent without modifying the message delivered to the user.
    const line = withoutHtmlComments(rawLine);
    const fence = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    // Markdown backtick fences cannot have backticks in their info string.
    if (fence && (fence[1]![0] === '~' || !fence[2]!.includes('`'))) {
      marker = fence[1]![0]!;
      minimum = fence[1]!.length;
      listAncestors.length = 0;
      return '';
    }
    const list = /^( *)(?:[-*+]|\d+[.)])\s+/.exec(line);
    const indent = list?.[1]?.length ?? 0;
    const indentedCode = /^(?: {4}|\t)/.test(line);
    if (indentedCode && (!list || !listAncestors.some(parent => parent < indent))) return '';
    if (list) {
      while (listAncestors.length && listAncestors[listAncestors.length - 1]! >= indent) listAncestors.pop();
      listAncestors.push(indent);
    } else if (line.trim()) listAncestors.length = 0;
    return line;
  }).join('\n');
}

/** The canonical task is a relevance hint, never an explicit Skill command.
 * Prepare the whole verified main section before dividing it: splitting first
 * would turn an open Markdown fence or HTML comment into apparent user intent.
 * Individual matchers intentionally have a 96k input bound. Give each one a
 * complete set of lines and refuse an oversized single actionable line rather
 * than silently losing a late human veto or UI requirement. These windows are
 * used only locally for selection and are never injected into the prompt. */
export function canonicalSkillRelevanceWindows(text: string): string[] {
  const lines = withoutFencedExamples(text).split('\n');
  const windows: string[] = [];
  let current = '';
  for (const line of lines) {
    if (line.length > MAX_CHATGPT_MESSAGE_CHARS) throw new Error(
      'Canonical task has an instruction line too long for complete Skill selection; split the line before dispatch.'
    );
    if (current && current.length + line.length + 1 > MAX_CHATGPT_MESSAGE_CHARS) {
      if (current.trim()) windows.push(current);
      current = '';
    }
    current += current ? `\n${line}` : line;
  }
  if (current.trim()) windows.push(current);
  return windows;
}

function actionableText(text: string, maxChars = 16_000): string {
  const bounded = withoutFencedExamples(text.slice(0, maxChars));
  // The leading command is metadata, but any same-line words after it are still
  // the user's instructions. Reuse the explicit-command parser so /prompt,
  // multi-command headers and ordinary slash paths keep the same boundary.
  const remaining = parseLeadingSkills(bounded).remainingText;
  return remaining.split(/\r?\n/)
    .filter(line => !/^\s*>/.test(line) && !/^\s*\//.test(line))
    .join('\n')
    // A backticked Skill name in a direct correction is still the named target.
    // Strip ordinary inline code afterwards so examples and code are not instructions.
    .replace(/`(\/[a-z0-9][a-z0-9._-]*)`/gi, '$1')
    .replace(/`[^`\r\n]*`/g, ' ')
    .replace(/[“”][^“”\r\n]*[“”]/g, ' ')
    .replace(/"[^"\r\n]*"/g, ' ')
    // Ticket excerpts are context, including single-quoted UI instructions. Do not treat
    // apostrophes inside contractions as opening quotation marks.
    .replace(/(^|[\s([{])(?:'[^'\r\n]*'|‘[^’\r\n]*’)(?=[\s)\]},.;!?]|$)/gm, '$1');
}

const DESIGN_ACTION = /\b(?:design|redesign|restyle|rework|polish(?:ing)?|moderni[sz]e|improve|create|build|make|implement|prototype|mock[ -]?up)\b/i;
const DESIGN_REVIEW = /\b(?:audit|critique|review|evaluate|improve)\b/i;
const VISUAL_REPAIR_ACTION = /\b(?:fix|repair|align|simplify|refine|reorganize|adjust|tidy|clean\s+up)\b/i;
const VISUAL_TARGET = /\b(?:ui|u\.i\.|ux|u\.x\.|user interface|user experience|visual design|product design|design system|screen|page layout|landing page|website|web page|web app|mobile app|dashboard (?:ui|interface|layout|page|screen)|sidebar|navigation|navbar|modal|dialog|form layout|wireframe|mock[ -]?up|prototype|responsive layout|visual hierarchy|typography|colou?r palette|brand identity|logo|poster|frontend interface)\b/i;
const REVIEW_TARGET = /\b(?:ui|u\.i\.|ux|u\.x\.|user interface|user experience|visual design|product design|accessibility|responsive layout|visual hierarchy|typography|colou?r palette)\b/i;
const VISUAL_REPAIR_TARGET = /\b(?:ui|u\.i\.|ux|u\.x\.|user interface|user experience|accessibility|settings screen|screen layout|page layout|layout|spacing|keyboard focus|focus states?|focus rings?|contrast|responsive(?:ness| layout)?|visual hierarchy|typography|colou?r palette|sidebar|navigation|navbar|modal|dialog|buttons?|design system)\b/i;
const NON_VISUAL_DESIGN = /\b(?:design patterns?|(?:database|schema|api|system|software|class|algorithm|experimental|research|pcb) design|design (?:(?:a|an|the) )?(?:database|schema|api|system|software|class|algorithm|experiment|research study|pcb))\b/i;
// If the action's own object is technical, an incidental mention of a screen or app
// should not invoke UI design. An explicit visual clause is still handled separately.
const NON_VISUAL_ACTION_TARGET = /\b(?:design|create|build|make|implement|fix|repair|refine|review|audit|evaluate|improve|simplify|reorganize|adjust|polish(?:ing)?)\s+(?:(?:a|an|the|this|that|our|its)\s+)?(?:api|backend|database|schema|quer(?:y|ies)|logs?|logging|server|data pipeline|dependency|software|algorithm|class|endpoint)\b/i;
const NEGATED_DESIGN = /\b(?:(?:do not|don't|dont|no need to|without|avoid)\s+(?:\w+\s+){0,5}(?:design|redesign|restyle|rework|mock[ -]?up|prototype|fix|repair|polish(?:ing)?|simplify|refine|reorganize|adjust|align|create|build|implement|make|change|modify)|no\s+(?:\w+\s+){0,3}(?:design|redesign)\s+(?:needed|required|planned|requested))\b/i;
const DESIGN_SKILL_DIRECTIVE = /\b(?:read|use|load|apply|follow)\s+(?:(?:and|then)\s+)?(?:\w+\s+){0,8}impeccable\b/i;
const NEGATED_SKILL_DIRECTIVE = /\b(?:do not|don't|dont|never|avoid|without)\s+(?:\w+\s+){0,4}(?:read|use|load|apply|follow)\b/i;
const OMIT_IMPECCABLE = /\b(?:do not|don't|dont|never|avoid|without)\s+(?:use|read|load|apply|follow|select|invoke)\s+(?:(?:the|installed)\s+){0,2}\/?impeccable\b/i;
// This only disables *automatic* Impeccable selection. It must not revoke an
// older or current deliberate /impeccable command as a direct Skill refusal.
const OMIT_AUTOMATIC_IMPECCABLE = /\b(?:do not|don't|dont|never|avoid|without)\s+automatically\s+(?:use|read|load|apply|follow|select|invoke)\s+(?:(?:the|installed)\s+){0,2}\/?impeccable\b/i;
// A newer authored correction can deliberately restore automatic UI Skill
// selection after a prior automatic-only opt-out. Require a task-directed
// imperative, not a quoted ticket or a meta rule about other agents.
const ENABLE_AUTOMATIC_DESIGN_SKILLS = /^(?:(?:current|new)\s+correction:\s*)?(?:please\s+)?(?:actually,?\s+)?(?:use|enable|re-?enable|allow|resume|restore)\s+(?:the\s+)?automatic\s+(?:(?:design|ui)\s+)?skills?(?:\s+selection)?\s+(?:for|on)\s+(?:this|the current)\s+(?:task|request|workflow)\b/i;
const SELECT_AUTOMATIC_DESIGN_SKILLS = /^(?:(?:current|new)\s+correction:\s*)?(?:please\s+)?automatically\s+(?:select|use|load|read)\s+(?:(?:the|relevant|applicable|installed)\s+){0,3}(?:design|ui)\s+skills?\s+(?:for|on)\s+(?:this|the current)\s+(?:task|request|workflow)\b/i;
const RESTORE_AUTOMATIC_DESIGN_SKILLS = /^(?:(?:current|new)\s+correction:\s*)?(?:please\s+)?(?:turn|switch)\s+(?:the\s+)?automatic\s+(?:(?:design|ui)\s+)?skills?(?:\s+selection)?\s+back\s+on\s+(?:for|on)\s+(?:this|the current)\s+(?:task|request|workflow)\b/i;
const OMIT_ALL_SKILLS = /\b(?:do not|don't|dont|never|avoid|without|no need to)\s+(?:automatically\s+)?(?:use|using|read|load|apply|follow|select|invoke)\s+(?:(?:any|the|these|those|installed|automatic)\s+){0,4}skills?\b|\bwithout\s+(?:(?:any|installed|automatic)\s+){0,3}skills?\b|\bno\s+(?:(?:any|installed|automatic)\s+){0,3}skills?\s+(?:for|on|needed|required|allowed|permitted)\b/i;
const OMIT_ALL_DESIGN_SKILLS = /\b(?:do not|don't|dont|never|avoid|without|no need to)\s+(?:automatically\s+)?(?:use|using|read|load|apply|follow|select|invoke)\s+(?:(?:any|the|these|those|installed|automatic|design|ui)\s+){0,4}skills?\b|\bwithout\s+(?:(?:any|installed|automatic|design|ui)\s+){0,3}skills?\b|\bno\s+(?:(?:any|installed|automatic|design|ui)\s+){0,3}skills?\s+(?:for|on|needed|required|allowed|permitted)\b/i;
const OMIT_DESIGN_SKILL = /\b(?:do not|don't|dont|never|avoid|without)\s+(?:use|read|load|apply|follow|select|invoke)\s+(?:\/design\b|(?:(?:the|installed|bundled|default)\s+){0,2}design\s+skill\b)/i;
const META_SKILL_ROUTING = /\b(?:make|ensure|require|teach|instruct|have)\s+(?:(?:the|all)\s+)?(?:agents?|assistants?|workers?|models?|ui tasks?|design tasks?)\s+(?:automatically\s+)?(?:discover|read|load|select|use)\b|\b(?:for\s+(?:ui|u\.i\.|design|ui\/design|visual)[^,;.!?\r\n]{0,60},\s*)?require\s+(?:selected\/read|selected\s+or\s+read|applicable|relevant|installed)\s+(?:design[-\s]skill|skill)\s+(?:body\s+)?evidence\b|\b(?:forbid|forbidding|prevent|prevention\s+of|do\s+not\s+manipulate\s+live\s+browser\s+delivery)\b[^.!?;\r\n]{0,100}\b(?:skill\s+name|tool\s+exists|tool\s+existing|proof\s+of\s+use|fidelity\s+claims?|ui\s+changes?)\b/i;
const META_DESIGN_EVIDENCE_TASK = /\b(?:prompt|prompts|instruction|instructions|assembled instructions|skill-selection|workflow-instruction|canonical|routing)\b[^.!?;\r\n]{0,180}\b(?:ui|u\.i\.|design|visual)\b[^.!?;\r\n]{0,180}\b(?:skill|evidence|fidelity|claims?|proof)\b/i;
const META_SKILL_CLAIM_POLICY = /\bprompts?\s+only\s+claim\s+relevant\s+installed\s+skills?\b|\bskills?\s+after\s+they\s+are\s+actually\s+(?:discovered|read|discovered\/read)\b|\b(?:skill[-\s]?selection|workflow[-\s]?instruction|prompt[-\s]?selection)\b[^.!?;\r\n]{0,140}\bclaims?\s+skills?\b|\b(?:ui\/design|ui|design|visual)\s+workflow\s+prompts?\s+claims?\s+skills?\b/i;
const META_PROOF_OF_USE_TASK = /\b(?:prevent|forbid|proof|claim|claims|evidence)\b[^.!?;\r\n]{0,120}\b(?:tool\s+exists|tool\s+existing|skill\s+name|proof\s+of\s+use|fidelity\s+claims?)\b/i;
const META_UI_DESIGN_POLICY_TASK = /\b(?:for\s+(?:ui|u\.i\.|design|ui\/design|visual)\s+(?:slices?|tasks?|workflows?)|ui\/design\s+slices?)\b[^.!?;\r\n]{0,180}\b(?:require|evidence|claim|claims|fidelity|completion|acceptance)\b/i;
const META_UI_DESIGN_POLICY_FRAGMENT = /^(?:for\s+)?(?:ui|u\.i\.|design|ui\/design|visual)\s+(?:slices?|tasks?|workflows?)$/i;
const OMIT_EXPLICIT_ALL_SKILLS = /\b(?:do not|don't|dont|never|avoid|without|no need to)\s+(?:use|using|read|load|apply|follow|select|invoke)\s+(?:(?:any|the|these|those|installed)\s+){0,4}skills?\b|\bwithout\s+(?:(?:any|installed)\s+){0,3}skills?\b|\bno\s+(?:(?:any|installed)\s+){0,3}skills?\s+(?:for|on|needed|required|allowed|permitted)\b/i;
const OMIT_EXPLICIT_DESIGN_SKILLS = /\b(?:do not|don't|dont|never|avoid|without)\s+(?:use|read|load|apply|follow|select|invoke)\s+(?:(?:any|the|these|those|installed)\s+){0,3}(?:design|ui)\s+skills?\b/i;
// One refusal can name several saved commands: "Do not use /alpha, /beta or /design".
// Optional "the" can precede each name: "Do not use the /alpha or the /beta skills".
// Keep the list anchored to the refusal verb so an unrelated later /skill is not revoked.
// Dot is legal *inside* a skill ID (review.v2) but a trailing sentence period
// is punctuation, not part of that ID. Match a final alphanumeric character
// before the following delimiter, including for joined refusal lists.
const OMIT_NAMED_SLASH_SKILLS = /\b(?:do not|don't|dont|never|avoid|without)\s+(?:use|read|load|apply|follow|select|invoke)\s+(?:the\s+)?((?:\/[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?)(?:\s*(?:,\s*(?:and|or)?|(?:and|or))\s*(?:the\s+)?\/[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?)*)(?=\s|[.,!?;:]|$)/gi;

// A human can refuse an explicitly named Skill in prose without typing a
// slash command: "do not use the Beta Skill". Require the noun "Skill" so a
// generic reference to a beta release cannot revoke a selected Skill.
const OMIT_NAMED_SKILL_PROSE = /\b(?:do not|don't|dont|never|avoid|without)\s+(?:use|read|load|apply|follow|select|invoke)\s+(?:(?:the|installed)\s+){0,2}\/?([a-z0-9](?:[a-z0-9._-]*[a-z0-9])?)\s+skills?\b/gi;
const REPLACE_NAMED_SKILL = /\b(?:replace|substitute|swap out)\s+(?:the\s+)?\/?([a-z0-9](?:[a-z0-9._-]*[a-z0-9])?)\s+(?:skill\s+)?(?:with|for)\s+(?:the\s+)?\/?([a-z0-9](?:[a-z0-9._-]*[a-z0-9])?)(?:\s+skill)?(?=\s|[.,!?;:]|$)/gi;

export function forbidsAllSkillUse(text: string): boolean {
  return OMIT_ALL_SKILLS.test(actionableText(text, MAX_CHATGPT_MESSAGE_CHARS));
}

/** Human opt-outs carry across separate authored/objective/canonical relevance hints. */
export function excludedAutomaticSkills(text: string): string[] {
  // Positive matching stays on a short actionable prefix; explicit vetoes must be checked
  // through the entire bounded authored message, including late human corrections.
  const prose = actionableText(text, MAX_CHATGPT_MESSAGE_CHARS);
  if (OMIT_ALL_SKILLS.test(prose) || OMIT_ALL_DESIGN_SKILLS.test(prose)) return ['impeccable', 'design'];
  return [
    ...(OMIT_IMPECCABLE.test(prose) || OMIT_AUTOMATIC_IMPECCABLE.test(prose) ? ['impeccable'] : []),
    ...(OMIT_DESIGN_SKILL.test(prose) ? ['design'] : []),
  ];
}

/** Explicit current-task permission to re-enable automatic visual Skill discovery.
 * Generic UI relevance and historical text are not a renewed permission. */
export function authorizedAutomaticDesignSkills(text: string): string[] {
  const prose = actionableText(text, MAX_CHATGPT_MESSAGE_CHARS);
  // A same-message veto wins only for the prohibited Skill; excluding Impeccable
  // must not also cancel a deliberate renewal of the bundled design fallback.
  const prohibited = new Set(excludedAutomaticSkills(text));
  for (const sentence of prose.split(/(?:[.!?](?:\s|$)|\r?\n|;)+/)) {
    const clause = sentence.trim();
    if (ENABLE_AUTOMATIC_DESIGN_SKILLS.test(clause) || SELECT_AUTOMATIC_DESIGN_SKILLS.test(clause) ||
        RESTORE_AUTOMATIC_DESIGN_SKILLS.test(clause))
      return ['impeccable', 'design'].filter(id => !prohibited.has(id));
  }
  return [];
}

/** A current slash selection does not defeat the same message's direct Skill refusal.
 * "Do not use automatic skills" still permits deliberate /skill selections. */
export function refusedLeadingSkills(text: string): string[] {
  const prose = actionableText(text, MAX_CHATGPT_MESSAGE_CHARS);
  if (OMIT_EXPLICIT_ALL_SKILLS.test(prose)) return ['*'];
  const ids = new Set<string>();
  if (OMIT_EXPLICIT_DESIGN_SKILLS.test(prose)) {
    ids.add('design');
    ids.add('impeccable');
  }
  if (OMIT_DESIGN_SKILL.test(prose)) ids.add('design');
  if (OMIT_IMPECCABLE.test(prose)) ids.add('impeccable');
  for (const match of prose.matchAll(OMIT_NAMED_SLASH_SKILLS)) {
    for (const skill of match[1]!.matchAll(/\/([a-z0-9](?:[a-z0-9._-]*[a-z0-9])?)(?=\s|[.,!?;:]|$)/gi)) {
      const id = skill[1]!.toLowerCase();
      if (validSkillId(id)) ids.add(id);
    }
  }
  for (const match of prose.matchAll(OMIT_NAMED_SKILL_PROSE)) {
    const id = match[1]!.toLowerCase();
    if (validSkillId(id)) ids.add(id);
  }
  return [...ids];
}

/** Only actionable human prose may explicitly replace an earlier Skill choice.
 * An archived quote, code fence or HTML comment is not a fresh correction. */
export function replacedSkillChoices(text: string, effectiveSelections?: readonly string[]): string[] {
  const prose = actionableText(text, MAX_CHATGPT_MESSAGE_CHARS);
  const ids = new Set<string>();
  for (const match of prose.matchAll(/\binstead of\s+(?:(?:the|earlier|previous|possible|old|saved|original)\s+){0,6}\/?([a-z0-9](?:[a-z0-9._-]*[a-z0-9])?)(?=\s|[.,!?;:]|$)/gi)) {
    const id = match[1]!.toLowerCase();
    // The surrounding prose may explicitly choose a *different* new Skill:
    // /alpha plus "use Gamma instead of Beta" is not human permission to
    // revoke Beta on Alpha's behalf. Leave a genuinely ambiguous choice held.
    const before = prose.slice(Math.max(0, (match.index ?? 0) - 120), match.index ?? 0);
    const chosen = /\b(?:use|select|read|load|apply|invoke|resume|prefer|switch\s+to)\s+(?:the\s+)?\/?([a-z0-9](?:[a-z0-9._-]*[a-z0-9])?)\s*$/i.exec(before)?.[1]?.toLowerCase();
    if (effectiveSelections && chosen && !effectiveSelections.includes(chosen)) continue;
    if (validSkillId(id)) ids.add(id);
  }
  for (const match of prose.matchAll(REPLACE_NAMED_SKILL)) {
    const oldId = match[1]!.toLowerCase();
    const newId = match[2]!.toLowerCase();
    if (validSkillId(oldId) && validSkillId(newId) &&
        (!effectiveSelections || effectiveSelections.includes(newId))) ids.add(oldId);
  }
  return [...ids];
}

/** An instruction explicitly naming a Skill may select its complete body even
 * without a slash command. Require the noun "Skill" and an actionable leading
 * directive; product names, old tickets and policy about other agents cannot
 * silently become selections. Only the caller establishes human provenance. */
export function explicitlyRequestedSkills(text: string): string[] {
  const prose = actionableText(text, MAX_CHATGPT_MESSAGE_CHARS);
  const ids = new Set<string>();
  const correctionPrefix = /^(?:(?:current|latest|later|newer)\s+(?:(?:human|user)\s+)?(?:correction|instruction|update|follow[- ]?up)\s*[:\-—]\s*)?(?:please\s+)?/i;
  // A slash name is itself an explicit Skill address ("use /beta"); a
  // slashless name still requires the noun "Skill" to exclude ordinary
  // products, releases, API paths and historical policy examples.
  const selection = /^(?:use|select|read|load|apply|follow|invoke|enable|re-?enable|resume|switch\s+to)\s+(?:(?:the|installed|named)\s+){0,2}(?:\/([a-z0-9](?:[a-z0-9._-]*[a-z0-9])?)(?!:[\\/])(?=\s|[.,!?;:]|$)|([a-z0-9](?:[a-z0-9._-]*[a-z0-9])?)\s+skills?\b)/i;
  const replacement = /^(?:replace|substitute|swap out)\s+(?:the\s+)?\/?([a-z0-9](?:[a-z0-9._-]*[a-z0-9])?)\s+skills?\s+(?:with|for)\s+(?:the\s+)?\/?([a-z0-9](?:[a-z0-9._-]*[a-z0-9])?)\s+skills?\b/i;
  for (const sentence of prose.split(/(?:[.!?](?=\s|$)|\r?\n|;)+/)) {
    const directive = sentence.trim().replace(correctionPrefix, '');
    const match = replacement.exec(directive);
    const selected = selection.exec(directive);
    const id = (match?.[2] ?? selected?.[1] ?? selected?.[2])?.toLowerCase();
    if (id && validSkillId(id)) ids.add(id);
    // A single authenticated command may ADD multiple independent Skills.
    // Read only affirmative conjunction clauses of an already actionable
    // leading choice or task-preservation directive; an archived description,
    // quoted example or instruction about other agents is not such a choice.
    if (id || /^(?:keep|retain|preserve|continue|finish|complete)\b/i.test(directive)) {
      for (const clause of directive.split(/\s+(?:and|but|while)\s+/i).slice(1)) {
        // A follow-on human replacement is also an affirmative new Skill
        // selection. Keep the replaced *old* id in replacedSkillChoices, so
        // resolving Gamma alone cannot silently clear an uncertain Beta.
        const switched = replacement.exec(clause.trim());
        const added = selection.exec(clause.trim());
        const extra = (switched?.[2] ?? added?.[1] ?? added?.[2])?.toLowerCase();
        if (extra && validSkillId(extra)) ids.add(extra);
      }
    }
  }
  return [...ids];
}

/** Named Skill references in actionable prose are evidence of possible scope,
 * NOT proof that the writer is human or that the Skill was selected. In
 * uncertain outbox history the raw message can contain quoted/fenced old
 * /skills, which must not turn into independent unresolved human directives. */
export function mentionedActionableSkillIds(text: string): string[] {
  const prose = actionableText(text, MAX_CHATGPT_MESSAGE_CHARS);
  const ids = new Set<string>();
  // A standalone slash-addressed Skill has a boundary before its slash.
  // Matching only the tail "/file.md" in /work/project/file.md, or "/gamma"
  // in https://example.com/gamma, would invent human Skill uncertainty.
  // A slash-prefixed Windows drive (/C:\path or /C:/path) is still a path,
  // not the single-letter Skill /c followed by a punctuation delimiter.
  for (const match of prose.matchAll(/(?:^|[^\w/])\/([a-z0-9](?:[a-z0-9._-]*[a-z0-9])?)(?!:[\\/])(?=\s|[.,!?;:]|$)/gi)) {
    const id = match[1]!.toLowerCase();
    if (validSkillId(id)) ids.add(id);
  }
  return [...ids];
}

/** A current named request may renew an older disabled Skill without a slash command. */
export function directlyRequestedDesignSkills(text: string): string[] {
  const prose = actionableText(text, MAX_CHATGPT_MESSAGE_CHARS);
  // Refusing automatic invocation does not refuse an explicit prose request to
  // read/use the named Skill. Actual direct refusals still win in this message.
  const refused = new Set(refusedLeadingSkills(text));
  for (const sentence of prose.split(/(?:[.!?](?:\s|$)|\r?\n)+/)) {
    for (const part of sentence.split(/\s*(?:;|,(?=\s)|\b(?:but|while|instead)\b)\s*/i)) {
      const clause = part.trim();
      if (!clause || META_SKILL_ROUTING.test(clause) || NEGATED_SKILL_DIRECTIVE.test(clause)) continue;
      if (DESIGN_SKILL_DIRECTIVE.test(clause) && !refused.has('*') && !refused.has('impeccable')) return ['impeccable'];
    }
  }
  return [];
}

/**
 * Returns only known, metadata-opted-in candidates in preference order. This intentionally
 * is not a description search: one concrete visual-design request is required in authored
 * prose. Impeccable is the richer shared design workflow; the bundled design skill remains
 * the zero-install fallback.
 */
export function autoInvokedSkills(text: string, { relevanceOnly = false }: { relevanceOnly?: boolean } = {}): string[] {
  // Later human corrections may follow lengthy retained Goal/Loop context. The
  // 16k relevance prefix was dropping an actionable UI clause even though direct
  // refusals were already scanned across the full bounded authored message.
  const prose = actionableText(text, MAX_CHATGPT_MESSAGE_CHARS);
  // A saved task can still describe the UI work after a later human correction
  // re-enables automatic Skills. Its old opt-out is resolved by the caller's
  // newest-first authorization, not by this relevance-only pass.
  const excluded = new Set(relevanceOnly ? [] : excludedAutomaticSkills(text));
  const preference = ['impeccable', 'design'].filter(id => !excluded.has(id));
  if (!preference.length) return [];
  const sentences = prose.split(/(?:[.!?](?:\s|$)|\r?\n)+/);
  for (const sentence of sentences) {
    const sentenceRoutesSkillPolicy = META_SKILL_ROUTING.test(sentence);
    // One request can contain distinct visual and backend clauses, or a prohibition
    // followed by an affirmative UI change. A veto in one clause cannot suppress another.
    for (const part of sentence.split(/\s*(?:;|,(?=\s)|\b(?:but|while|and|instead|without)\b)\s*/i)) {
      const candidate = part.trim();
      if (!candidate || NEGATED_DESIGN.test(candidate) || NEGATED_SKILL_DIRECTIVE.test(candidate) ||
          META_SKILL_ROUTING.test(candidate) ||
          META_DESIGN_EVIDENCE_TASK.test(candidate) || META_SKILL_CLAIM_POLICY.test(candidate) ||
          META_PROOF_OF_USE_TASK.test(candidate) ||
          META_UI_DESIGN_POLICY_TASK.test(candidate) || META_UI_DESIGN_POLICY_FRAGMENT.test(candidate) ||
          NON_VISUAL_DESIGN.test(candidate) || NON_VISUAL_ACTION_TARGET.test(candidate)) continue;
      if ((DESIGN_ACTION.test(candidate) && VISUAL_TARGET.test(candidate)) ||
          (DESIGN_REVIEW.test(candidate) && REVIEW_TARGET.test(candidate)) ||
          (VISUAL_REPAIR_ACTION.test(candidate) && VISUAL_REPAIR_TARGET.test(candidate)) ||
          (!sentenceRoutesSkillPolicy && DESIGN_SKILL_DIRECTIVE.test(candidate))) return preference;
    }
  }
  return [];
}

/** A current backend-only correction narrows which part of a saved UI task is
 * actionable. Preserve the saved objective, but do not revive automatic visual
 * instructions from that older objective until a newer visual task or explicit
 * automatic-design renewal makes them relevant again. */
export function scopesCurrentWorkToBackend(text: string): boolean {
  const prose = actionableText(text, MAX_CHATGPT_MESSAGE_CHARS);
  const backendOnly = /\b(?:api|backend|server|database|logging|queries?)\s*[- ]only\b|\b(?:only|just)\s+(?:fix|review|audit|inspect|update|investigate|implement|work on)\b[^.!?;\r\n]{0,90}\b(?:api|backend|server|database|endpoint|logs?|logging|queries?|query)\b/gi;
  let lastBackendScopeEnd = -1;
  for (const match of prose.matchAll(backendOnly))
    lastBackendScopeEnd = match.index! + match[0].length;
  // One authored message can contain the original UI request followed by a
  // human correction. The final backend-only scope wins unless the user gives
  // another actionable visual instruction *after* that scope statement.
  return lastBackendScopeEnd >= 0 &&
    autoInvokedSkills(prose.slice(lastBackendScopeEnd), { relevanceOnly: true }).length === 0;
}
