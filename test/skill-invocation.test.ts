import { expect, it } from 'vitest';
import { authorizedAutomaticDesignSkills, autoInvokedSkills, directlyRequestedDesignSkills, excludedAutomaticSkills, explicitlyRequestedSkills, invokedSkills, mentionedActionableSkillIds, refusedLeadingSkills, replacedSkillChoices } from '../src/shared/skill-invocation.js';

it.each([
  'Read /C:\\Users\\ExampleUser\\Documents\\task.md before continuing.',
  'Use /C:/Users/ExampleUser/Documents/task.md as the canonical file.',
  'Preserve the original task and read /C:\\Users\\ExampleUser\\Documents\\task.md.'
])('does not turn a slash-prefixed Windows drive path into a Skill: %s', text => {
  expect(invokedSkills(text)).toEqual([]);
  expect(explicitlyRequestedSkills(text)).toEqual([]);
  expect(mentionedActionableSkillIds(text)).toEqual([]);
});

it('preserves a genuine one-letter Skill selection followed by a prose colon', () => {
  expect(explicitlyRequestedSkills('Read /c: apply its workflow to this task.')).toEqual(['c']);
  expect(mentionedActionableSkillIds('Read /c: apply its workflow to this task.')).toEqual(['c']);
  expect(invokedSkills('/c')).toEqual(['c']);
});

it('only recognizes deliberate current-task re-enablement of automatic design Skills', () => {
  for (const command of [
    'Use automatic design Skills for this task. Redesign the settings UI.',
    'Current correction: Enable automatic Skill selection for this task.',
    'Please automatically select applicable design Skills for this task.',
    'Current correction: Re-enable automatic design Skills for this task.',
    'Turn automatic design Skills back on for this task.',
  ]) expect(authorizedAutomaticDesignSkills(command)).toEqual(['impeccable', 'design']);
  expect(authorizedAutomaticDesignSkills(
    'Do not use Impeccable for this task. Use automatic design Skills for this task.'
  )).toEqual(['design']);
  for (const command of [
    'Do not automatically use skills. Redesign the settings UI.',
    'Current correction: Do not automatically use skills. Instead, use automatic design Skills for this task.',
    'An old ticket said "Use automatic design Skills for this task"; inspect only its quotation.',
    'Make agents automatically select the best design Skills.',
    '```text\nUse automatic design Skills for this task.\n```\nReview the old request.',
    'Enable automatic design Skills for a future customer, not this task.',
    'Do not re-enable automatic design Skills for this task.',
    'An archived note said "Re-enable automatic design Skills for this task"; inspect that quote.',
    '```text\nTurn automatic design Skills back on for this task.\n```\nReview its history.',
  ]) expect(authorizedAutomaticDesignSkills(command)).toEqual([]);
});

it('parses leading commands on one or several lines and leaves following prose literal', () => {
  expect(invokedSkills('\n/alpha\n/prompt review.v2\n/alpha\nDo the work.\n/design')).toEqual(['alpha', 'review.v2']);
  expect(invokedSkills('/design redesign this screen')).toEqual(['design']);
  expect(invokedSkills('/prompt design redesign this screen')).toEqual(['design']);
  expect(invokedSkills('/alpha /beta Carry out the task.')).toEqual(['alpha', 'beta']);
  expect(invokedSkills('Explain /design in prose.')).toEqual([]);
  expect(invokedSkills('```\n/design\n```')).toEqual([]);
  expect(invokedSkills('/work/project/file.md')).toEqual([]);
  expect(invokedSkills('/../escape')).toEqual([]);
  expect(invokedSkills('/design-system/components/button.ts')).toEqual([]);
  expect(invokedSkills('/design, then explain it')).toEqual([]);
  expect(() => invokedSkills('/prompt')).toThrow(/Choose a skill/);
  expect(() => invokedSkills('/prompt CON')).toThrow(/valid skill command/);
  expect(() => invokedSkills('/CON')).toThrow(/valid installed skill/);
});

it('refuses complete dotted Skill IDs without swallowing sentence-final punctuation or code quotations', () => {
  expect(refusedLeadingSkills('Do not use /beta.')).toEqual(['beta']);
  expect(refusedLeadingSkills('Current human correction: use Alpha; do not use /review.v2.'))
    .toEqual(['review.v2']);
  expect(refusedLeadingSkills('/alpha\nLatest human correction: resume Alpha; do not use /beta.'))
    .toEqual(['beta']);
  expect(refusedLeadingSkills('Do not use /alpha, /beta, or the /review.v2.'))
    .toEqual(['alpha', 'beta', 'review.v2']);
  expect(refusedLeadingSkills('A historical ticket said "do not use /beta."; continue the saved task.'))
    .toEqual([]);
});

it('treats only actionable instead-of Skill corrections as replacements', () => {
  expect(replacedSkillChoices('/alpha\nLatest human correction: use Alpha instead of the earlier possible Beta choice.'))
    .toEqual(['beta']);
  expect(replacedSkillChoices('Switch to /review.v2 instead of the old /alpha.'))
    .toEqual(['alpha']);
  expect(replacedSkillChoices('/alpha\nA past ticket said "use Alpha instead of Beta for this phase"; that was quoted history.'))
    .toEqual([]);
  expect(replacedSkillChoices('/alpha\n```text\nUse Alpha instead of Beta for this phase.\n```\nKeep the original work.'))
    .toEqual([]);
});

it('recognizes explicit named-Skill prose vetoes and replacement phrasing while ignoring quoted examples', () => {
  expect(refusedLeadingSkills('Current human correction: do not use the Beta Skill for this task.'))
    .toEqual(['beta']);
  expect(refusedLeadingSkills('Do not use the /review.v2 Skill during this phase.'))
    .toEqual(['review.v2']);
  expect(refusedLeadingSkills('A past ticket said "do not use the Beta Skill"; keep current selection.'))
    .toEqual([]);
  expect(replacedSkillChoices('/alpha\nLatest human correction: replace Beta with Alpha for this task.'))
    .toEqual(['beta']);
  expect(replacedSkillChoices('/alpha\nA past ticket said "replace Beta with Alpha"; it was historical.'))
    .toEqual([]);
  expect(replacedSkillChoices('/alpha\nUse Gamma instead of Beta for a separate product comparison.', ['alpha']))
    .toEqual([]);
  expect(replacedSkillChoices('/alpha\nUse Alpha instead of the earlier Beta choice for this same task.', ['alpha']))
    .toEqual(['beta']);
  expect(replacedSkillChoices('/alpha\nReplace Beta with Gamma for a separate product.', ['alpha']))
    .toEqual([]);
});

it('recognizes explicitly requested non-design Skill bodies in actionable prose without promoting examples or policy', () => {
  expect(explicitlyRequestedSkills('Current human correction: replace the Beta Skill with the Alpha Skill for this task.'))
    .toEqual(['alpha']);
  expect(explicitlyRequestedSkills('Latest human correction: use the Beta Skill again for the original task.'))
    .toEqual(['beta']);
  expect(explicitlyRequestedSkills('Please select /review.v2 Skill for this phase.'))
    .toEqual(['review.v2']);
  expect(explicitlyRequestedSkills('Please use /review.v2 for this same task.'))
    .toEqual(['review.v2']);
  expect(explicitlyRequestedSkills('Current human correction: use /beta instead of Alpha for this task.'))
    .toEqual(['beta']);
  expect(explicitlyRequestedSkills('Current human correction: keep the original Design Skill and use the Beta Skill for diagnostics.'))
    .toEqual(['beta']);
  expect(explicitlyRequestedSkills('Preserve the original requirements while use /beta for diagnostics.'))
    .toEqual(['beta']);
  expect(explicitlyRequestedSkills('Keep the original Design Skill and use the Beta Skill for diagnostics and use the Gamma Skill for review.'))
    .toEqual(['beta', 'gamma']);
  expect(explicitlyRequestedSkills('Current human correction: use the Beta Skill and use the Gamma Skill for separate verification.'))
    .toEqual(['beta', 'gamma']);
  expect(explicitlyRequestedSkills('Current human correction: keep the Design Skill and replace the Beta Skill with the Gamma Skill for verification.'))
    .toEqual(['gamma']);
  expect(replacedSkillChoices('Keep the Design Skill and replace the Beta Skill with the Gamma Skill for verification.', ['gamma']))
    .toEqual(['beta']);
  expect(explicitlyRequestedSkills('Current human correction: preserve the original task and replace the Beta Skill with the MissingProse Skill.'))
    .toEqual(['missingprose']);
  for (const inert of [
    'A prior ticket said "replace the Beta Skill with the Alpha Skill for this task"; only review its wording.',
    'Current human correction: do not use the Alpha Skill.',
    'Make all agents use the Alpha Skill when creating apps.',
    'Make all agents keep their original work and use the Beta Skill for diagnostics.',
    'An old ticket said keep the original work and use the Beta Skill for diagnostics.',
    'Keep the original task and do not use the Beta Skill.',
    'Keep the original task and ask other agents to use the Beta Skill.',
    'An archived ticket said "keep Design and replace the Beta Skill with the Gamma Skill".',
    'Make all agents keep Design and replace the Beta Skill with the Gamma Skill.',
    'Replace the beta release with the alpha server.',
    'Inspect the quoted instruction "Please use /alpha for this task" without applying it.',
    'Use /work/project/file.md as the path to inspect.',
    '```text\nUse the Beta Skill.\n```\nReview this example.',
  ]) expect(explicitlyRequestedSkills(inert), inert).toEqual([]);
});

it('extracts possible Skill IDs from actionable prose, not quoted historical or fenced references', () => {
  expect(mentionedActionableSkillIds('Current human correction: use /beta for this task. Prior ticket said "use /gamma as an example".'))
    .toEqual(['beta']);
  expect(mentionedActionableSkillIds('Current human correction: a past ticket said "use /gamma in the former workflow".'))
    .toEqual([]);
  expect(mentionedActionableSkillIds('Current human correction: read /review.v2 for the new phase.'))
    .toEqual(['review.v2']);
  expect(mentionedActionableSkillIds('```text\nuse /beta for this task\n```\nKeep the current work.'))
    .toEqual([]);
  expect(mentionedActionableSkillIds('Current human correction: inspect /work/project/file.md for reference, not a Skill selection.'))
    .toEqual([]);
  expect(mentionedActionableSkillIds('Current human correction: inspect https://example.com/gamma?stage=old; this URL is evidence.'))
    .toEqual([]);
  expect(mentionedActionableSkillIds('Current human correction: use /beta after reviewing /work/project/file.md.'))
    .toEqual(['beta']);
});

it('recognizes concrete visual-design work without treating generic design language as intent', () => {
  for (const prompt of [
    'Design a polished landing page for the product.',
    'Please redesign the settings screen and improve its UI.',
    'Build a responsive website with a clear page layout.',
    'Audit the UX and accessibility of this user interface.',
    'Create a wireframe and visual design for the mobile app.',
    'Current human correction: resume polishing the settings UI layout and keyboard focus.',
  ]) expect(autoInvokedSkills(prompt)).toEqual(['impeccable', 'design']);

  for (const prompt of [
    'Use a software design pattern for this class.',
    'Design a database schema and API.',
    'Do not redesign the UI.',
    '> Redesign the landing page.\nAssess the quoted statement.',
    'The ticket says "redesign the settings screen"; only fix its logging.',
    '```text\nCreate a website mockup\n```\nExplain the code block.',
    'Make the dashboard query faster.',
  ]) expect(autoInvokedSkills(prompt), prompt).toEqual([]);
});

it('recognizes UI repair and separately actionable visual clauses in mixed tasks', () => {
  for (const prompt of [
    'Fix the spacing and keyboard focus states in the settings UI.',
    'Fix the spacing around API fields in the settings UI.',
    'Fix clipping in the Settings modal.',
    'Simplify the sidebar navigation and improve the responsive layout.',
    'Redesign the dashboard UI and update the API design.',
    'Review the database schema, but polish the dashboard UI.',
    'Do not redesign the UI, but fix its typography and contrast.',
    'Fix the settings UI without redesign.',
  ]) expect(autoInvokedSkills(prompt)).toEqual(['impeccable', 'design']);

  for (const prompt of [
    'Fix the API client used by the settings UI.',
    'Design the database schema for dashboard UI events.',
    'Create the API schema consumed by the dashboard UI.',
    'Build a backend for the web app settings page.',
    'Do not redesign the settings UI; only fix the API integration.',
    'Do not fix the settings UI.',
    'Avoid polishing the sidebar UI.',
    'Do not resume polishing the settings UI now.',
    'Resume polishing API logging for the settings UI without changing its layout.',
    'No redesign needed for the settings UI.',
    'Avoid redesign of the settings UI.',
    'The request says "fix the layout", but investigate server logging.',
    "The ticket says 'redesign the settings screen'; only fix its logging.",
    'The ticket says ‘redesign the settings screen’; only fix its logging.',
    "Don't change the database schema for this UI; fix API logging instead.",
  ]) expect(autoInvokedSkills(prompt), prompt).toEqual([]);
});

it('recognizes a direct user instruction to read an installed UI skill without treating quotes or prohibitions as selection', () => {
  expect(autoInvokedSkills('Read and use installed Impeccable and relevant UI references.')).toEqual(['impeccable', 'design']);
  expect(autoInvokedSkills('Load Impeccable for the settings UI critique.')).toEqual(['impeccable', 'design']);
  for (const prompt of [
    'Do not use Impeccable; this task is API-only.',
    "The ticket said 'Read and use installed Impeccable'; fix the API only.",
    'An unrelated document mentions Impeccable, but this request is backend-only.',
    'Make UI tasks automatically discover and read applicable installed design skills such as Impeccable.',
    'Require selected/read design-skill body evidence, reference comparison, observed before/after evidence and real interaction for UI claims.',
    'For UI/design slices, require selected/read design-skill body evidence, reference screenshots and real interaction before claiming fidelity.',
    'Prevent tool exists or skill name mentioned from becoming proof of use for UI fidelity claims.',
    'Do not manipulate live browser delivery or implement UI changes yourself.',
    'Implement a real behavior/regression improvement so UI/design/reverse-engineering/task prompts only claim relevant installed skills after they are actually discovered/read.',
  ]) expect(autoInvokedSkills(prompt), prompt).toEqual([]);
  expect(directlyRequestedDesignSkills('Implement a real behavior/regression improvement so UI/design/reverse-engineering/task prompts only claim relevant installed skills after they are actually discovered/read.'))
    .toEqual([]);
  expect(autoInvokedSkills('Do not use Impeccable for this task. Polish the settings UI.')).toEqual(['design']);
});

it('skips meta Skill policy clauses while preserving separately actionable UI work', () => {
  expect(autoInvokedSkills('Update the canonical prompts for UI evidence and skill proof. Also redesign the settings UI and test keyboard focus.'))
    .toEqual(['impeccable', 'design']);
  expect(autoInvokedSkills('Prevent tool exists or skill name mentioned from becoming proof of use. Then fix the keyboard focus states in the settings UI.'))
    .toEqual(['impeccable', 'design']);
  expect(directlyRequestedDesignSkills('Read and use installed Impeccable for this task, and redesign the settings UI.'))
    .toEqual(['impeccable']);
  expect(autoInvokedSkills('Read and use installed Impeccable for this task, and redesign the settings UI.'))
    .toEqual(['impeccable', 'design']);
  const directReading = 'Read relevant installed design skills such as Impeccable for this UI redesign.';
  expect(directlyRequestedDesignSkills(directReading)).toEqual(['impeccable']);
  expect(autoInvokedSkills(directReading)).toEqual(['impeccable', 'design']);
});

it('honors a user prohibition on automatic design Skills while preserving more specific choices', () => {
  for (const prompt of [
    'Do not use any installed skills for this task. Redesign the settings UI.',
    'Do not use design skills. Polish the navigation UI.',
    'No skills for this task; redesign the settings screen.',
    'Please redesign the UI without using any skills.',
  ]) expect(autoInvokedSkills(prompt), prompt).toEqual([]);

  expect(autoInvokedSkills('Do not use /design for this task. Polish the settings UI.')).toEqual(['impeccable']);
  expect(autoInvokedSkills('Do not use /impeccable for this task. Polish the settings UI.')).toEqual(['design']);
  expect(autoInvokedSkills('Do not use Impeccable for this task. Polish the settings UI.')).toEqual(['design']);
  expect(autoInvokedSkills('No skills are installed yet. Redesign the settings UI.'))
    .toEqual(['impeccable', 'design']);
  expect(autoInvokedSkills('No design skills are installed yet. Redesign the settings UI.'))
    .toEqual(['impeccable', 'design']);
  expect(autoInvokedSkills('No design skills for this task; redesign the settings UI.')).toEqual([]);
  // A negated quote is evidence from a ticket, not a new instruction from this user.
  expect(autoInvokedSkills('The ticket says "Do not use any skills". Please redesign the UI.'))
    .toEqual(['impeccable', 'design']);

  const longContext = 'Background information without new instructions.\n'.repeat(400);
  expect(autoInvokedSkills(`Please redesign the settings UI.\n${longContext}`))
    .toEqual(['impeccable', 'design']);
  expect(autoInvokedSkills(`Please redesign the settings UI.\n${longContext}Do not use Impeccable for this task.`))
    .toEqual(['design']);
  expect(autoInvokedSkills(`Please redesign the settings UI.\n${longContext}Do not use any skills.`))
    .toEqual([]);
});

it('recognizes a current named Impeccable request without treating quoted or meta instructions as permission', () => {
  expect(directlyRequestedDesignSkills('Read and use installed Impeccable for the settings UI.'))
    .toEqual(['impeccable']);
  expect(directlyRequestedDesignSkills('Load Impeccable for this UI critique.'))
    .toEqual(['impeccable']);
  expect(directlyRequestedDesignSkills('Do not use Impeccable. Read and use Impeccable for the UI.'))
    .toEqual([]);
  for (const prompt of [
    'The ticket says "Read and use Impeccable"; review the backend only.',
    'Make UI tasks automatically read and use Impeccable when relevant.',
    '```text\nRead and use Impeccable for the UI.\n```\nReview the API logs.',
  ]) expect(directlyRequestedDesignSkills(prompt)).toEqual([]);
  const longContext = 'Previously accepted requirements remain preserved.\n'.repeat(400);
  expect(directlyRequestedDesignSkills(`${longContext}Current correction: Read and use installed Impeccable for the UI.`))
    .toEqual(['impeccable']);
});

it('keeps authored corrections after a same-line leading skill command', () => {
  expect(invokedSkills('/alpha Read and use installed Impeccable for the settings UI.')).toEqual(['alpha']);
  expect(directlyRequestedDesignSkills('/alpha Read and use installed Impeccable for the settings UI.'))
    .toEqual(['impeccable']);
  expect(excludedAutomaticSkills('/alpha Do not use /design for this task. Polish the settings UI.'))
    .toEqual(['design']);
  // A literal path or a quoted ticket must not become a skill instruction.
  expect(directlyRequestedDesignSkills('/work/example/Read and use Impeccable for the UI.')).toEqual([]);
  expect(directlyRequestedDesignSkills('/alpha The ticket says "Read and use Impeccable"; fix its backend.'))
    .toEqual([]);
});

it('treats tilde-fenced retained requests as quoted data, including a missing closing fence', () => {
  const quoted = 'Investigate the API timeout.\n~~~markdown\nRead and use installed Impeccable.\nRedesign the settings UI.\n~~~\nFix the server handler.';
  expect(directlyRequestedDesignSkills(quoted)).toEqual([]);
  expect(autoInvokedSkills(quoted)).toEqual([]);
  expect(authorizedAutomaticDesignSkills(
    'Inspect the previous instructions.\n~~~text\nUse automatic design Skills for this task.\n~~~\nFix server logging.'
  )).toEqual([]);
  const incomplete = 'Fix the API timeout only.\n~~~~text\nRedesign the settings screen and read Impeccable.';
  expect(autoInvokedSkills(incomplete)).toEqual([]);
  expect(directlyRequestedDesignSkills(incomplete)).toEqual([]);
  const humanCorrection = `${quoted}\nCurrent correction: Redesign the settings UI and compare it to the accepted reference.`;
  expect(autoInvokedSkills(humanCorrection)).toEqual(['impeccable', 'design']);
});

it('does not promote indented Markdown examples into current Skill commands or design work', () => {
  const savedExample = '    /impeccable\n    Read and use installed Impeccable.\n    Redesign the settings UI.\nInvestigate the API timeout only.';
  expect(invokedSkills(savedExample)).toEqual([]);
  expect(directlyRequestedDesignSkills(savedExample)).toEqual([]);
  expect(autoInvokedSkills(savedExample)).toEqual([]);
  expect(invokedSkills('/alpha\n    /design\nFix the API timeout.')).toEqual(['alpha']);
  expect(invokedSkills('  /alpha /design\nFix the server handler.')).toEqual(['alpha', 'design']);
  expect(autoInvokedSkills(`${savedExample}\nCurrent correction: Redesign the settings UI.`)).toEqual(['impeccable', 'design']);
  // A nested list is active task prose only with a real Markdown list parent.
  expect(autoInvokedSkills('- Improve settings:\n    - Redesign the settings UI.')).toEqual(['impeccable', 'design']);
});

it('keeps indented archived checklist examples inert across later backend corrections', () => {
  const quote = 'Historical ticket:\n    - Redesign the settings UI.\n    - Read and use installed Impeccable.\nCurrent task: fix the API response serializer.';
  expect(autoInvokedSkills(quote)).toEqual([]);
  expect(directlyRequestedDesignSkills(quote)).toEqual([]);
  expect(invokedSkills(quote)).toEqual([]);
  const nested = '- Current release scope:\n    - Redesign the settings UI for keyboard navigation.\n    - Improve the API response serializer.';
  expect(autoInvokedSkills(nested)).toEqual(['impeccable', 'design']);
  expect(autoInvokedSkills(`${quote}\nCurrent correction: Redesign the settings UI for keyboard navigation.`))
    .toEqual(['impeccable', 'design']);
});

it('does not give HTML-commented historical Skill choices or refusals current authority', () => {
  const history = 'Preserve the API fix.\n<!-- archived request\nRead and use installed Impeccable.\nRedesign the settings UI.\n-->\nSummarize the historical snippet only.';
  expect(directlyRequestedDesignSkills(history)).toEqual([]);
  expect(autoInvokedSkills(history)).toEqual([]);
  expect(authorizedAutomaticDesignSkills('<!-- Re-enable automatic design Skills for this task. -->\nKeep the API fix.')).toEqual([]);
  const renewed = '<!-- Do not use Impeccable. -->\nCurrent correction: Read and use installed Impeccable for the settings UI.';
  expect(directlyRequestedDesignSkills(renewed)).toEqual(['impeccable']);
  expect(excludedAutomaticSkills(renewed)).toEqual([]);
  expect(autoInvokedSkills(`${history}\nCurrent correction: Redesign the settings UI for keyboard use.`)).toEqual(['impeccable', 'design']);
  expect(autoInvokedSkills('Fix the API request only.\n<!-- archived\nRedesign the old settings UI.')).toEqual([]);
});

it('keeps later human Skill corrections visible after literal HTML delimiters in inline code', () => {
  const current = 'Fix the parser for the literal `<!--` token.\nCurrent correction: Redesign the settings UI for keyboard access.';
  expect(autoInvokedSkills(current)).toEqual(['impeccable', 'design']);
  const named = 'Handle the literal ``<!--`` sequence in the backend.\nCurrent correction: Read and use installed Impeccable for the settings UI.';
  expect(directlyRequestedDesignSkills(named)).toEqual(['impeccable']);
  expect(autoInvokedSkills(named)).toEqual(['impeccable', 'design']);
  const old = 'Fix the HTML parser for a literal `<!--` token.\n<!-- archived visual ticket\nRedesign the retired settings UI.\n-->\nCurrent task: fix the API response.';
  expect(autoInvokedSkills(old)).toEqual([]);
  const renewed = `${old}\nCurrent correction: Improve the settings UI keyboard focus.`;
  expect(autoInvokedSkills(renewed)).toEqual(['impeccable', 'design']);
});

it('does not treat escaped or quoted literal comment openers as HTML comment authority', () => {
  const escaped = 'The Markdown fixture writes \\<!-- to output literally.\nCurrent correction: Redesign the settings UI for keyboard access.';
  expect(autoInvokedSkills(escaped)).toEqual(['impeccable', 'design']);
  const quoted = 'The parser accepts the literal string "<!--".\nCurrent correction: Read and use installed Impeccable for the settings UI.';
  expect(directlyRequestedDesignSkills(quoted)).toEqual(['impeccable']);
  const single = "The lexer matches '<!--' as text.\nCurrent correction: Polish the settings UI.";
  expect(autoInvokedSkills(single)).toEqual(['impeccable', 'design']);
  const actualComment = 'Fix the API.\n<!-- archived UI request\nRedesign the settings UI.\n-->\nReview the API.';
  expect(autoInvokedSkills(actualComment)).toEqual([]);
});
