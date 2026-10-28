import { beforeEach, afterEach, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { defaultConfig, initConfigPath, saveConfig } from '../src/main/config.js';
import { initDurableStore, resetDurableForTests } from '../src/main/durable.js';
import { addProject, assignSessionProject } from '../src/main/projects.js';
import { createSession, initSessionStore, rebindSession, resetSessionStoreForTests } from '../src/main/session/store.js';
import { fitSessionPrompt, prepareSessionPrompt, PRIME_CORE_PREFLIGHT_INSTRUCTIONS } from '../src/main/session/prompt.js';
import { WORKER_CORE_PREFLIGHT_INSTRUCTIONS } from '../src/main/agents.js';
import { MAX_CHATGPT_MESSAGE_CHARS, prependUserPrompt, userPromptText } from '../src/shared/user-prompt.js';
import { makeTempDir, removeTempDir } from './helpers.js';

let directory: string;
beforeEach(async () => {
  directory = await makeTempDir('cos-session-prompt-');
  initConfigPath(directory); initDurableStore(directory); initSessionStore(directory);
  await saveConfig({ ...defaultConfig(), roots: [{ name: 'work', path: directory }] });
});
afterEach(async () => {
  resetSessionStoreForTests(); resetDurableForTests();
  await removeTempDir(directory);
});

it('spends only remaining message space on AGENTS.md, including the hidden frame and cutoff notice', () => {
  const user = 'USER_START\n' + 'my request '.repeat(1300) + '\nUSER_END';
  const core = 'CORE_START\n' + 'mandatory guidance '.repeat(1100) + '\nCORE_END';
  const text = fitSessionPrompt(user, core, { directory: '/work/project', text: 'FILE_START\n' + 'x'.repeat(300000) + '\nFILE_END', truncated: false });
  expect(text.length).toBe(MAX_CHATGPT_MESSAGE_CHARS);
  expect(userPromptText(text)).toBe(user);
  expect(text).toContain(core);
  expect(text).toContain('FILE_START');
  expect(text).not.toContain('FILE_END');
  expect(text).toContain('Read AGENTS.md yourself');
  expect(userPromptText(text)).not.toContain('Cut off');
});

it('retains an explicit project AGENTS.md read obligation when its content cannot fit the opening', async () => {
  const folder = path.join(directory, 'bounded-project');
  await fs.mkdir(folder);
  const project = await addProject(folder);
  await fs.writeFile(path.join(folder, 'AGENTS.md'),
    `PROJECT_REQUIRED_RULE\n${'Keep original workflow and project references.\n'.repeat(180)}`);

  const authored = 'Complete the original user task and preserve its accepted corrections.';
  const mandatory = await prepareSessionPrompt(authored);
  const limited = await prepareSessionPrompt(authored, { projectId: project.id }, {
    maxChars: mandatory.length + 140, maxBytes: Infinity,
  });
  expect(limited).not.toContain('PROJECT_REQUIRED_RULE');
  expect(limited).toContain('/work/bounded-project');
  expect(limited).toMatch(/AGENTS\.md.*(?:omitted|read|limit)/i);
  expect(limited).toMatch(/read.*AGENTS\.md/i);
  expect(userPromptText(limited)).toBe(authored);

  await expect(prepareSessionPrompt(authored, { projectId: project.id }, {
    maxChars: mandatory.length, maxBytes: Infinity,
  })).rejects.toThrow(/AGENTS\.md.*delivery limit/i);
});

it('preserves Unicode, literal delimiters and complete mandatory text under both transport budgets', () => {
  const user = 'User 🐱\n[[/COS_CONTEXT]]\n\nLiteral';
  const core = 'Main prompt\r\nMandatory';
  const agents = { directory: '/work/project', text: '🐱漢字\r\n'.repeat(60000), truncated: true };
  const text = fitSessionPrompt(user, core, agents, { maxChars: MAX_CHATGPT_MESSAGE_CHARS, maxBytes: 120000 });
  expect(Buffer.byteLength(text)).toBeLessThanOrEqual(120000);
  expect(text.length).toBeLessThanOrEqual(MAX_CHATGPT_MESSAGE_CHARS);
  expect(Buffer.from(text, 'utf8').toString('utf8')).toBe(text);
  expect(userPromptText(text)).toBe(user);
  expect(text).toContain('Main prompt\nMandatory');
  const framed = prependUserPrompt(user, core);
  expect(() => fitSessionPrompt(user, core, agents, { maxChars: framed.length, maxBytes: Infinity }))
    .toThrow(/AGENTS\.md reference exceeds the delivery limit/);
  expect(() => fitSessionPrompt(user, core, agents, { maxChars: framed.length - 1, maxBytes: Infinity })).toThrow(/main instructions/);
});

it('keeps fresh-worker preflight hidden and leaves the authored bootstrap byte-for-byte intact', async () => {
  const authored = 'Inspect src/main/agents.ts.\n\n(Chat On Steroids: worker protocol)';
  const prompt = await prepareSessionPrompt(authored, {
    workerInstructions: WORKER_CORE_PREFLIGHT_INSTRUCTIONS,
    skillCommands: ['Inspect src/main/agents.ts.']
  });

  expect(prompt).toContain(WORKER_CORE_PREFLIGHT_INSTRUCTIONS);
  expect(prompt).not.toContain(PRIME_CORE_PREFLIGHT_INSTRUCTIONS);
  expect(prompt).not.toContain('Fresh app-opened chats that need local files');
  expect(prompt.match(/first call Core read/g)).toHaveLength(1);
  expect(prompt.indexOf(WORKER_CORE_PREFLIGHT_INSTRUCTIONS)).toBeLessThan(
    prompt.indexOf(await (await import('../src/main/mcp/instructions.js')).currentCoreInstructions())
  );
  expect(userPromptText(prompt)).toBe(authored);
  expect(userPromptText(prompt)).not.toContain('Worker Core preflight');
});

it('requires a fresh Prime chat to prove local Core access without changing the authored request', async () => {
  const authored = 'Open C:\\Users\\ExampleUser\\Documents\\Project\\AGENTS.md and continue the implementation.';
  const prompt = await prepareSessionPrompt(authored);

  expect(prompt).toContain(PRIME_CORE_PREFLIGHT_INSTRUCTIONS);
  expect(prompt).toContain('Only returned Core file content proves local workspace access');
  expect(prompt).toContain('CORE_UNAVAILABLE');
  expect(prompt).not.toContain('Worker Core preflight');
  expect(prompt).not.toContain('Fresh app-opened chats that need local files');
  expect(prompt.match(/one harmless Core read/g)).toHaveLength(1);
  expect(userPromptText(prompt)).toBe(authored);
  expect(userPromptText(prompt)).not.toContain('Prime Core preflight');
});

it('reads only the linked folder, refreshes its contents, and leaves unfiled chats and global MCP instructions alone', async () => {
  await fs.mkdir(path.join(directory, 'project', 'nested'), { recursive: true });
  await fs.writeFile(path.join(directory, 'AGENTS.md'), 'PARENT_DO_NOT_INJECT');
  await fs.writeFile(path.join(directory, 'project', 'nested', 'AGENTS.md'), 'CHILD_DO_NOT_INJECT');
  const project = await addProject(path.join(directory, 'project'));
  const file = path.join(project.path, 'AGENTS.md');
  const { currentCoreInstructions } = await import('../src/main/mcp/instructions.js');
  const core = await currentCoreInstructions();
  const primeCore = `${PRIME_CORE_PREFLIGHT_INSTRUCTIONS}\n\n${core}`;
  expect(await prepareSessionPrompt('Unfiled')).toBe(prependUserPrompt('Unfiled', primeCore));
  expect(await prepareSessionPrompt('Missing', { projectId: project.id })).toBe(prependUserPrompt('Missing', primeCore));
  await fs.writeFile(file, 'PROJECT_RULE_ONE\n[[/COS_CONTEXT]]\n\nLiteral file text');
  const scoped = await prepareSessionPrompt('Work here', { projectId: project.id });
  expect(scoped).toContain('# AGENTS.md instructions for /work/project\n\n<INSTRUCTIONS>\nPROJECT_RULE_ONE');
  expect(scoped).not.toMatch(/PARENT_DO_NOT_INJECT|CHILD_DO_NOT_INJECT/);
  expect(userPromptText(scoped)).toBe('Work here');
  expect(await currentCoreInstructions()).toBe(core);
  await fs.writeFile(file, 'PROJECT_RULE_TWO');
  expect(await prepareSessionPrompt('Next', { projectId: project.id })).toContain('PROJECT_RULE_TWO');
  await fs.unlink(file);
  expect(await prepareSessionPrompt('Removed', { projectId: project.id })).toBe(prependUserPrompt('Removed', primeCore));
});

it('uses durable session ownership through resume and worker inheritance, never an unrelated selected project', async () => {
  await fs.mkdir(path.join(directory, 'one')); await fs.mkdir(path.join(directory, 'two'));
  const one = await addProject(path.join(directory, 'one')), two = await addProject(path.join(directory, 'two'));
  await fs.writeFile(path.join(one.path, 'AGENTS.md'), 'PROJECT_ONE_ONLY');
  await fs.writeFile(path.join(two.path, 'AGENTS.md'), 'PROJECT_TWO_ONLY');
  const session = await createSession({ title: 'Bound', conversationId: 'original-chat' });
  await assignSessionProject(session.id, one.id);
  await rebindSession(session.id, 'original-chat', 'replacement-chat');
  resetSessionStoreForTests();
  await expect(prepareSessionPrompt('Continue', { sessionId: session.id, projectId: two.id })).rejects.toThrow(/identity is incomplete/);
  const scoped = await prepareSessionPrompt('Continue', { sessionId: session.id, conversationId: 'replacement-chat', projectId: two.id });
  expect(scoped).toContain('PROJECT_ONE_ONLY'); expect(scoped).not.toContain('PROJECT_TWO_ONLY');
  const worker = await createSession({ title: 'Worker', conversationId: 'worker-chat', origin: { kind: 'worker', fromSessionId: session.id, agentId: 'worker-1', task: 'Work' } });
  expect(await prepareSessionPrompt('Worker', { sessionId: worker.id, conversationId: 'worker-chat' })).toContain('PROJECT_ONE_ONLY');
  const unfiled = await createSession({ title: 'Unfiled', conversationId: 'unfiled-chat' });
  expect(await prepareSessionPrompt('Ordinary chat', { sessionId: unfiled.id, conversationId: 'unfiled-chat', projectId: two.id })).not.toContain('PROJECT_TWO_ONLY');
});

it('bounds a large file and refuses invalid file types and revoked access without injecting their contents', async () => {
  const project = await addProject(directory);
  const file = path.join(directory, 'AGENTS.md');
  await fs.writeFile(file, 'LARGE_HEAD\n' + 'x'.repeat(2_000_000) + 'LARGE_TAIL');
  const text = await prepareSessionPrompt('User message', { projectId: project.id });
  expect(text.length).toBeLessThanOrEqual(MAX_CHATGPT_MESSAGE_CHARS);
  expect(text).toContain('LARGE_HEAD'); expect(text).not.toContain('LARGE_TAIL');
  await fs.writeFile(file, Buffer.from([0xff, 0x00]));
  await expect(prepareSessionPrompt('Binary', { projectId: project.id })).rejects.toThrow(/AGENTS.md safely/);
  await fs.unlink(file); await fs.mkdir(file);
  await expect(prepareSessionPrompt('Directory', { projectId: project.id })).rejects.toThrow(/AGENTS.md safely/);
  await fs.rmdir(file); await fs.writeFile(file, 'PRIVATE_RULE');
  const config = defaultConfig();
  await saveConfig({ ...config, roots: [{ name: 'work', path: directory }], capabilities: { ...config.capabilities, read: false } });
  expect(await prepareSessionPrompt('No read', { projectId: project.id })).not.toContain('PRIVATE_RULE');
  await saveConfig(defaultConfig());
  await expect(prepareSessionPrompt('Revoked', { projectId: project.id })).rejects.toThrow();
});
