import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { bindBrowserInputProject, claimBrowserInput, enqueueInput, listInputs, pendingBrowserInputs, resetInputForTests } from '../src/main/session/input.js';
import { defaultConfig, initConfigPath, saveConfig } from '../src/main/config.js';
import { initDurableStore, resetDurableForTests, writeDurableNow } from '../src/main/durable.js';
import { createSession, getSession, initSessionStore, rebindSession, resetSessionStoreForTests, setSessionOrigin } from '../src/main/session/store.js';
import { addProject, armProjectCreate, assignSessionProject, claimProjectCreate, completeProjectCreate, failProjectCreate, getProject, getSessionProject, inheritSessionProject, listProjects, markProjectGone, pendingProjectCreates, PROJECT_CREATE_ARMED_MS, PROJECT_CREATE_CLAIM_MS, removeProject, retryProjectCreate } from '../src/main/projects.js';
import { validateNewRoot } from '../src/main/sandbox.js';

let directory: string, approved: string;
const nativeProjectId = `g-p-${'a'.repeat(32)}`;
async function linkNativeProject(project: Awaited<ReturnType<typeof addProject>>, id = nativeProjectId): Promise<void> {
  const request = project.chatgpt && 'requestId' in project.chatgpt ? project.chatgpt.requestId : null;
  if (!request) throw new Error('missing native Project request');
  expect(await claimProjectCreate(request, 'test-page')).toBe(true);
  expect(await armProjectCreate(request, 'test-page')).toBe(true);
  expect(await completeProjectCreate(request, 'test-page', id)).toBe(true);
}
beforeEach(async () => {
  resetInputForTests();
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'cos-projects-'));
  approved = path.join(directory, 'approved');
  await fs.mkdir(path.join(approved, 'first'), { recursive: true });
  await fs.mkdir(path.join(approved, 'second'));
  // Match IPC root approval: macOS temp paths can use /var while their canonical
  // authority is /private/var. Stored root identity must already be canonical.
  approved = await validateNewRoot(approved, []);
  initConfigPath(directory); initDurableStore(directory); initSessionStore(directory);
  await saveConfig({ ...defaultConfig(), roots: [{ name: 'work', path: approved }] });
});
afterEach(async () => { resetSessionStoreForTests(); resetDurableForTests(); await fs.rm(directory, { recursive: true, force: true }); });

it('persists one project per canonical directory and validates approved directories', async () => {
  const [one, again] = await Promise.all([addProject(path.join(approved, 'first')), addProject(path.join(approved, 'first'))]);
  expect(again.id).toBe(one.id);
  expect(await listProjects()).toEqual([one]);
  await fs.writeFile(path.join(approved, 'file.txt'), 'x');
  await expect(addProject(path.join(approved, 'file.txt'))).rejects.toThrow(/folder/);
  await expect(addProject(directory)).rejects.toThrow();
  await expect(addProject('first')).rejects.toThrow(/absolute/);
  resetDurableForTests(); initDurableStore(directory);
  expect(await listProjects()).toEqual([one]);
});

it('resolves a native picker alias to the approved identity without granting outside aliases', async () => {
  const alias = path.join(directory, 'picker-alias');
  await fs.symlink(approved, alias, process.platform === 'win32' ? 'junction' : 'dir');
  const project = await addProject(path.join(alias, 'first'));
  expect(project.path).toBe(path.join(approved, 'first'));
  expect((await addProject(path.join(approved, 'first'))).id).toBe(project.id);
  const outside = path.join(directory, 'outside');
  await fs.mkdir(outside);
  const outsideAlias = path.join(approved, 'outside-alias');
  await fs.symlink(outside, outsideAlias, process.platform === 'win32' ? 'junction' : 'dir');
  await expect(addProject(outsideAlias)).rejects.toThrow(/escapes|not inside/);
});

it('removes a grouping durably while preserving files, conversations and pending browser claims', async () => {
  const project = await addProject(path.join(approved, 'first'));
  await linkNativeProject(project);
  const linked = (await getProject(project.id))!;
  const other = await addProject(path.join(approved, 'second'));
  const session = await createSession({ title: 'Keep this chat', conversationId: 'retained-conversation' });
  await assignSessionProject(session.id, project.id);
  const file = path.join(project.path, 'keep.txt');
  await fs.writeFile(file, 'keep');
  const input = await enqueueInput({ id: randomUUID(), projectId: project.id, sessionId: null, text: 'Queued work', dueAt: 0, mode: 'auto', model: null, reasoningEffort: null });
  await Promise.all([removeProject(project.id), removeProject(project.id)]);
  resetDurableForTests(); initDurableStore(directory); resetInputForTests(); resetSessionStoreForTests();
  expect(await listProjects()).toEqual([{ ...linked, ungrouped: true }, other]);
  expect((await getSession(session.id))?.title).toBe('Keep this chat');
  expect(await getSessionProject(session.id)).toMatchObject({ virtual: '/work/first' });
  expect(await fs.readFile(file, 'utf8')).toBe('keep');
  expect(await claimBrowserInput(input.id, 'document', null, false, nativeProjectId)).toMatchObject({ id: input.id });
  expect(await bindBrowserInputProject(input.id, 'document', 'queued-conversation')).toBe(true);
  await expect(removeProject(randomUUID())).rejects.toThrow('Project not found');
  expect(await addProject(project.path)).toEqual(linked);
  expect(await listProjects()).toEqual([linked, other]);
});

it('binds a claimed fresh input before evidence without acknowledging delivery or accepting another document', async () => {
  const project = await addProject(path.join(approved, 'first'));
  await linkNativeProject(project);
  const entry = await enqueueInput({ id: randomUUID(), projectId: project.id, sessionId: null, text: 'Work here', dueAt: 0, mode: 'auto', model: null, reasoningEffort: null });
  expect(await bindBrowserInputProject(entry.id, 'document', 'conversation-one')).toBe(false);
  expect(await claimBrowserInput(entry.id, 'document', null, false, nativeProjectId)).toMatchObject({ projectId: project.id });
  expect(await bindBrowserInputProject(entry.id, 'wrong-document', 'conversation-one')).toBe(false);
  expect(await bindBrowserInputProject(entry.id, 'document', 'conversation-one')).toBe(true);
  const bound = (await listInputs()).find(row => row.id === entry.id)!;
  expect(bound.state).toBe('browser');
  expect((await getSession(bound.deliveredSessionId!))?.projectId).toBe(project.id);
  resetInputForTests();
  expect(await bindBrowserInputProject(entry.id, 'document', 'conversation-one')).toBe(true);
  expect(await bindBrowserInputProject(entry.id, 'document', 'conversation-two')).toBe(false);
  expect(await rebindSession(bound.deliveredSessionId!, 'conversation-one', 'conversation-replacement')).toBe(true);
  expect(await bindBrowserInputProject(entry.id, 'document', 'conversation-one')).toBe(false);
});

it('creates native Projects only for newly added folders and holds their fresh input until exact linking', async () => {
  const project = await addProject(path.join(approved, 'first'));
  const request = project.chatgpt && 'requestId' in project.chatgpt ? project.chatgpt.requestId : '';
  expect(await pendingProjectCreates()).toEqual([expect.objectContaining({ id: request, projectId: project.id, state: 'requested' })]);
  const input = await enqueueInput({ id: randomUUID(), projectId: project.id, sessionId: null, text: 'Start here', dueAt: 0, mode: 'auto', model: null, reasoningEffort: null });
  expect((await pendingBrowserInputs()).some(row => row.id === input.id)).toBe(false);
  expect(await claimBrowserInput(input.id, 'wrong-page', null)).toBeNull();
  await linkNativeProject(project);
  expect((await pendingBrowserInputs()).find(row => row.id === input.id)).toMatchObject({ project: nativeProjectId });
  expect(await claimBrowserInput(input.id, 'wrong-project', null, false, `g-p-${'b'.repeat(32)}`)).toBeNull();
  expect(await claimBrowserInput(input.id, 'right-project', null, false, nativeProjectId)).toMatchObject({ id: input.id });
});

it('does not backfill a native ChatGPT Project request onto an existing or restored local project', async () => {
  const folder = path.join(approved, 'legacy');
  await fs.mkdir(folder, { recursive: true });
  const legacy = { id: randomUUID(), name: 'legacy', path: folder, createdAt: 1 };
  await writeDurableNow('projects', [legacy]);
  expect(await addProject(folder)).toEqual(legacy);
  expect(await removeProject(legacy.id)).toMatchObject({ ...legacy, ungrouped: true });
  expect(await addProject(folder)).toEqual(legacy);
  expect((await getProject(legacy.id))?.chatgpt).toBeUndefined();
});

it('arms before creation, never transfers ownership, and requires explicit retry after uncertain outcome', async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  try {
    const project = await addProject(path.join(approved, 'first'));
    const request = project.chatgpt && 'requestId' in project.chatgpt ? project.chatgpt.requestId : '';
    expect(await armProjectCreate(request, 'page-a')).toBe(false);
    expect(await claimProjectCreate(request, 'page-a')).toBe(true);
    expect(await claimProjectCreate(request, 'page-b')).toBe(false);
    expect(await completeProjectCreate(request, 'page-a', nativeProjectId)).toBe(false);
    expect(await armProjectCreate(request, 'page-a')).toBe(true);
    expect(await failProjectCreate(request, 'page-b', 'foreign')).toBe(false);
    vi.setSystemTime(Date.now() + PROJECT_CREATE_ARMED_MS);
    await pendingProjectCreates();
    expect((await getProject(project.id))?.chatgpt).toMatchObject({ state: 'uncertain' });
    const retried = await retryProjectCreate(project.id);
    expect(retried?.chatgpt).toMatchObject({ state: 'requested' });
    expect(retried?.chatgpt && 'requestId' in retried.chatgpt ? retried.chatgpt.requestId : '').not.toBe(request);
  } finally { vi.useRealTimers(); }
});

it('accepts a late exact creation receipt only while the same armed owner still exists', async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  try {
    const project = await addProject(path.join(approved, 'first'));
    const request = project.chatgpt && 'requestId' in project.chatgpt ? project.chatgpt.requestId : '';
    expect(await claimProjectCreate(request, 'exact-page')).toBe(true);
    expect(await armProjectCreate(request, 'exact-page')).toBe(true);
    vi.setSystemTime(Date.now() + PROJECT_CREATE_ARMED_MS + 1);
    // Native creation is irreversible. Its exact same-owner receipt may settle before the
    // serialized expiry sweep; once expiry persisted uncertainty, no late page can relink it.
    expect(await completeProjectCreate(request, 'exact-page', nativeProjectId)).toBe(true);

    const second = await addProject(path.join(approved, 'second'));
    const secondRequest = second.chatgpt && 'requestId' in second.chatgpt ? second.chatgpt.requestId : '';
    expect(await claimProjectCreate(secondRequest, 'expired-page')).toBe(true);
    expect(await armProjectCreate(secondRequest, 'expired-page')).toBe(true);
    vi.setSystemTime(Date.now() + PROJECT_CREATE_ARMED_MS + 1);
    await pendingProjectCreates();
    expect(await completeProjectCreate(secondRequest, 'expired-page', `g-p-${'b'.repeat(32)}`)).toBe(false);
    expect((await getProject(second.id))?.chatgpt).toMatchObject({ state: 'uncertain', requestId: secondRequest });
  } finally { vi.useRealTimers(); }
});

it('reoffers only a pre-click claim after its exact bounded lease and fails a gone linked Project closed', async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  try {
    const project = await addProject(path.join(approved, 'first'));
    const request = project.chatgpt && 'requestId' in project.chatgpt ? project.chatgpt.requestId : '';
    expect(await claimProjectCreate(request, 'page-a')).toBe(true);
    vi.setSystemTime(Date.now() + PROJECT_CREATE_CLAIM_MS);
    expect(await pendingProjectCreates()).toEqual([expect.objectContaining({ id: request, state: 'requested' })]);
    expect(await armProjectCreate(request, 'page-a')).toBe(false);
    expect(await claimProjectCreate(request, 'page-b')).toBe(true);
    expect(await armProjectCreate(request, 'page-b')).toBe(true);
    expect(await completeProjectCreate(request, 'page-b', nativeProjectId)).toBe(true);
    expect(await markProjectGone(project.id, `g-p-${'c'.repeat(32)}`)).toBe(false);
    expect(await markProjectGone(project.id, nativeProjectId)).toBe(true);
    expect((await getProject(project.id))?.chatgpt).toMatchObject({ state: 'failed' });
  } finally { vi.useRealTimers(); }
});

it('retains project ownership through restart, resume and exact worker origins', async () => {
  const project = await addProject(path.join(approved, 'first'));
  const otherProject = await addProject(path.join(approved, 'second'));
  const prime = await createSession({ title: 'Prime', conversationId: 'prime-original' });
  await assignSessionProject(prime.id, project.id);
  await expect(assignSessionProject(prime.id, otherProject.id)).rejects.toThrow(/another project/);
  const origin = { kind: 'worker' as const, fromSessionId: prime.id, agentId: 'worker-1', task: 'Inspect' };
  const worker = await createSession({ title: 'Worker', origin, conversationId: 'worker-original' });
  expect(worker.projectId).toBe(project.id);
  const late = await createSession({ title: 'Late origin' });
  await setSessionOrigin(late.id, origin, 'Worker');
  expect((await getSession(late.id))?.projectId).toBe(project.id);
  const exact = await createSession({ title: 'Exact inheritance' });
  await inheritSessionProject(exact.id, 'prime-original');
  expect((await getSession(exact.id))?.projectId).toBe(project.id);
  await rebindSession(prime.id, 'prime-original', 'prime-replacement');
  resetSessionStoreForTests();
  expect((await getSession(prime.id))?.projectId).toBe(project.id);
  expect(await getSessionProject(prime.id)).toMatchObject({ virtual: '/work/first' });
  const stale = await createSession({ title: 'Stale source' });
  await inheritSessionProject(stale.id, 'prime-original');
  expect((await getSession(stale.id))?.projectId).toBeUndefined();
});

it('fails closed when explicit project permission is removed and follows approved root renames', async () => {
  const project = await addProject(path.join(approved, 'first'));
  const session = await createSession({ title: 'Bound' });
  await assignSessionProject(session.id, project.id);
  await saveConfig({ ...defaultConfig(), roots: [{ name: 'renamed', path: approved }] });
  expect(await getSessionProject(session.id)).toMatchObject({ virtual: '/renamed/first' });
  await saveConfig({ ...defaultConfig(), roots: [] });
  await expect(getSessionProject(session.id)).rejects.toThrow();
  expect((await getSession(session.id))?.projectId).toBe(project.id);
});
