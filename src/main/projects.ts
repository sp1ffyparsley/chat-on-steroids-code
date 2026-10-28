import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { rawPromises as fs } from './rawfs.js';
import { readDurable, writeDurableNow } from './durable.js';
import { getConfig } from './config.js';
import { nativePathIdentity, resolvePath } from './sandbox.js';
import { bindSessionProject, findSessionByConversation, getSession } from './session/store.js';
import { CHATGPT_PROJECT_ID, type ChatgptProjectLink, type LocalProject } from '../shared/projects.js';
import { logInfo, logWarn } from './logger.js';

const at = z.number().finite().nonnegative();
const requestId = z.string().uuid();
const chatgptSchema = z.discriminatedUnion('state', [
  z.object({ state: z.literal('requested'), requestId, updatedAt: at }),
  z.object({ state: z.literal('claimed'), requestId, owner: z.string().min(1).max(64), updatedAt: at }),
  z.object({ state: z.literal('creating'), requestId, owner: z.string().min(1).max(64), updatedAt: at }),
  z.object({ state: z.literal('linked'), id: z.string().regex(CHATGPT_PROJECT_ID), updatedAt: at }),
  z.object({ state: z.literal('failed'), requestId, error: z.string().max(500), updatedAt: at }),
  z.object({ state: z.literal('uncertain'), requestId, error: z.string().max(500), updatedAt: at })
]);
const projectSchema = z.object({ id: z.string().uuid(), name: z.string().min(1).max(160), path: z.string().min(1).max(32768), createdAt: at, ungrouped: z.boolean().optional(), chatgpt: chatgptSchema.optional() });
const catalogSchema = z.array(projectSchema).max(200);
let mutations: Promise<unknown> = Promise.resolve();
const samePath = (a: string, b: string) => nativePathIdentity(a) === nativePathIdentity(b);

export async function listProjects(): Promise<LocalProject[]> {
  const raw = await readDurable<unknown>('projects');
  if (raw === null) return [];
  const parsed = catalogSchema.safeParse(raw);
  if (!parsed.success || new Set(parsed.data.map(row => row.id)).size !== parsed.data.length) throw new Error('Project catalog is invalid');
  return parsed.data;
}
export async function getProject(id: string): Promise<LocalProject | null> {
  return (await listProjects()).find(project => project.id === id) ?? null;
}
/** Folder picker callers approve roots separately; project selection cannot widen them. */
export function addProject(folderPath: string): Promise<LocalProject> {
  const operation = mutations.then(async () => {
    if (!path.isAbsolute(folderPath)) throw new Error('Choose an absolute local project folder');
    const resolved = await resolvePath(getConfig().roots, folderPath);
    if (!(await fs.stat(resolved.real)).isDirectory()) throw new Error('Choose a project folder');
    const projects = await listProjects();
    const existing = projects.find(project => samePath(project.path, resolved.real));
    if (existing) {
      if (!existing.ungrouped) return existing;
      const { ungrouped: _, ...restored } = existing;
      await writeDurableNow('projects', projects.map(project => project.id === existing.id ? restored : project));
      return restored;
    }
    if (projects.length >= 200) throw new Error('Project catalog limit reached');
    const link: ChatgptProjectLink = { state: 'requested', requestId: randomUUID(), updatedAt: Date.now() };
    const project: LocalProject = { id: randomUUID(), name: (path.basename(resolved.real) || resolved.real).slice(0, 160), path: resolved.real, createdAt: Date.now(), chatgpt: link };
    await writeDurableNow('projects', [...projects, project]);
    logInfo(`projects: native ChatGPT Project requested local=${project.id} request=${link.requestId}`);
    return project;
  });
  mutations = operation.catch(() => undefined);
  return operation;
}
/** Remove only the grouping. One catalog commit also covers unloaded sessions and
 * in-flight inputs without rewriting their durable workspace/receipt identities. */
export function removeProject(id: string): Promise<LocalProject> {
  const operation = mutations.then(async () => {
    z.string().uuid().parse(id);
    const projects = await listProjects();
    const project = projects.find(row => row.id === id);
    if (!project) throw new Error('Project not found');
    const removed = { ...project, ungrouped: true };
    if (!project.ungrouped) await writeDurableNow('projects', projects.map(row => row.id === id ? removed : row));
    return removed;
  });
  mutations = operation.catch(() => undefined);
  return operation;
}
export async function assignSessionProject(sessionId: string, projectId: string): Promise<void> {
  const project = await getProject(projectId);
  if (!project) throw new Error('Project not found');
  await resolveProject(project);
  await bindSessionProject(sessionId, project.id);
}
export async function projectWorkspace(projectId: string): Promise<{ virtual: string; real: string }> {
  const project = await getProject(projectId);
  if (!project) throw new Error('Project not found');
  return resolveProject(project);
}
async function resolveProject(project: LocalProject): Promise<{ virtual: string; real: string }> {
  const resolved = await resolvePath(getConfig().roots, project.path);
  if (!samePath(resolved.real, project.path) || !(await fs.stat(resolved.real)).isDirectory()) throw new Error('Project folder changed or is unavailable');
  return { virtual: resolved.virtual, real: resolved.real };
}
/** Null means no project. A broken explicit binding is an error, never permission to guess cwd. */
export async function getSessionProject(sessionId: string): Promise<{ virtual: string; real: string } | null> {
  const session = await getSession(sessionId);
  if (!session?.projectId) return null;
  const project = await getProject(session.projectId);
  if (!project) throw new Error('The session project is unavailable');
  return resolveProject(project);
}
/** The broker supplies an exact prime conversation; unrelated families are never consulted. */
export async function inheritSessionProject(sessionId: string, primeConversationId: string): Promise<void> {
  const prime = await findSessionByConversation(primeConversationId, { requireUnique: true });
  if (prime?.conversationId !== primeConversationId || !prime.projectId) return;
  await assignSessionProject(sessionId, prime.projectId);
}

export const PROJECT_CREATE_CLAIM_MS = 60_000;
export const PROJECT_CREATE_ARMED_MS = 60_000;

const linkListeners = new Set<() => void>();
export function onProjectLinkChange(listener: () => void): () => void {
  linkListeners.add(listener);
  return () => linkListeners.delete(listener);
}

function updateChatgptLink(match: (link: ChatgptProjectLink, project: LocalProject) => boolean,
  next: (link: ChatgptProjectLink, now: number) => ChatgptProjectLink | null): Promise<LocalProject | null> {
  const operation = mutations.then(async () => {
    const projects = await listProjects();
    const project = projects.find(row => row.chatgpt && match(row.chatgpt, row));
    if (!project?.chatgpt) return null;
    const changed = next(project.chatgpt, Date.now());
    if (!changed) return null;
    const updated: LocalProject = { ...project, chatgpt: changed };
    await writeDurableNow('projects', projects.map(row => row.id === project.id ? updated : row));
    const priorRequest = 'requestId' in project.chatgpt ? project.chatgpt.requestId : null;
    const request = 'requestId' in changed ? changed.requestId : priorRequest;
    const message = `projects: native ChatGPT Project ${project.chatgpt.state}->${changed.state} local=${project.id} request=${request ?? 'none'}` +
      (priorRequest && request !== priorRequest ? ` prior=${priorRequest}` : '');
    if (changed.state === 'failed' || changed.state === 'uncertain') logWarn(message);
    else logInfo(message);
    for (const listener of linkListeners) { try { listener(); } catch { /* presentation only */ } }
    return updated;
  });
  mutations = operation.catch(() => undefined);
  return operation;
}

const forRequest = (id: string) => (link: ChatgptProjectLink) => 'requestId' in link && link.requestId === id;
const claimLapsed = (link: ChatgptProjectLink, now: number) => link.state === 'claimed' && now - link.updatedAt >= PROJECT_CREATE_CLAIM_MS;

export async function pendingProjectCreates(): Promise<Array<{ id: string; projectId: string; name: string; state: 'requested' | 'claimed' | 'creating' }>> {
  await expireArmedProjectCreates();
  return (await listProjects()).flatMap(project => {
    const link = project.chatgpt;
    if (project.ungrouped || !link || !['requested', 'claimed', 'creating'].includes(link.state)) return [];
    const state = link.state === 'claimed' && claimLapsed(link, Date.now()) ? 'requested' : link.state as 'requested' | 'claimed' | 'creating';
    return [{ id: (link as { requestId: string }).requestId, projectId: project.id, name: project.name, state }];
  });
}

let armedSweep: NodeJS.Timeout | null = null;
export async function expireArmedProjectCreates(): Promise<void> {
  const now = Date.now();
  let next = Infinity;
  for (const project of await listProjects()) {
    const link = project.chatgpt;
    if (link?.state !== 'creating') continue;
    if (now - link.updatedAt >= PROJECT_CREATE_ARMED_MS) {
      await updateChatgptLink(forRequest(link.requestId), (current, changedAt) => current.state === 'creating' && current.updatedAt === link.updatedAt
        ? { state: 'uncertain', requestId: current.requestId, error: 'ChatGPT did not show the new Project in time', updatedAt: changedAt } : null);
    } else next = Math.min(next, link.updatedAt + PROJECT_CREATE_ARMED_MS);
  }
  if (armedSweep) clearTimeout(armedSweep);
  armedSweep = null;
  if (Number.isFinite(next)) {
    armedSweep = setTimeout(() => {
      armedSweep = null;
      void expireArmedProjectCreates().catch(error =>
        logWarn(`projects: native ChatGPT Project expiry sweep failed — ${error instanceof Error ? error.message : String(error)}`));
    }, Math.max(0, next - Date.now()) + 50);
    armedSweep.unref?.();
  }
}

export async function claimProjectCreate(id: string, owner: string): Promise<boolean> {
  return !!await updateChatgptLink(forRequest(id), (link, now) =>
    link.state === 'requested' || (link.state === 'claimed' && (link.owner === owner || claimLapsed(link, now)))
      ? { state: 'claimed', requestId: id, owner, updatedAt: now } : null);
}

export async function armProjectCreate(id: string, owner: string): Promise<boolean> {
  const armed = !!await updateChatgptLink(forRequest(id), (link, now) =>
    link.state === 'claimed' && link.owner === owner && !claimLapsed(link, now)
      ? { state: 'creating', requestId: id, owner, updatedAt: now } : null);
  if (armed) await expireArmedProjectCreates();
  return armed;
}

export async function completeProjectCreate(id: string, owner: string, chatgptId: string): Promise<boolean> {
  if (!CHATGPT_PROJECT_ID.test(chatgptId)) return false;
  return !!await updateChatgptLink(forRequest(id), (link, now) =>
    link.state === 'creating' && link.owner === owner ? { state: 'linked', id: chatgptId, updatedAt: now } : null);
}

export async function failProjectCreate(id: string, owner: string, error: string): Promise<boolean> {
  const why = error.slice(0, 500) || 'unknown error';
  return !!await updateChatgptLink(forRequest(id), (link, now) =>
    link.state === 'claimed' && link.owner === owner ? { state: 'failed', requestId: id, error: why, updatedAt: now }
      : link.state === 'creating' && link.owner === owner ? { state: 'uncertain', requestId: id, error: why, updatedAt: now } : null);
}

export async function retryProjectCreate(projectId: string): Promise<LocalProject | null> {
  z.string().uuid().parse(projectId);
  return updateChatgptLink((_link, project) => project.id === projectId, (link, now) =>
    link.state === 'failed' || link.state === 'uncertain' ? { state: 'requested', requestId: randomUUID(), updatedAt: now } : null);
}

export async function markProjectGone(projectId: string, chatgptId: string): Promise<boolean> {
  return !!await updateChatgptLink((link, project) => project.id === projectId && link.state === 'linked' && link.id === chatgptId,
    (_link, now) => ({ state: 'failed', requestId: randomUUID(), error: 'ChatGPT no longer opens this Project', updatedAt: now }));
}
