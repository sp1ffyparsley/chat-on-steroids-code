import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, realpathSync, existsSync, writeFileSync, renameSync, openSync, fstatSync, readSync, closeSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';

export const TERMINAL = new Set(['completed', 'failed', 'cancelled', 'blocked', 'incomplete']);
export const MAX_ACTIVE = 2;
export const defaultStateRoot = () => path.join(homedir(), '.cos-deepai-bridge');
export const hash = value => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
export const workspaceKey = directory => process.platform === 'win32' ? directory.toLowerCase() : directory;

function boundedControlJSON(filename, maxBytes) {
  if (workspaceKey(realpathSync.native(filename)) !== workspaceKey(path.resolve(filename))) throw new Error('Control path redirected.');
  const fd = openSync(filename, 'r');
  try {
    const before = fstatSync(fd);
    if (!before.isFile() || before.size > maxBytes) throw new Error('Control state exceeds its read limit.');
    const buffer = Buffer.alloc(before.size + 1);
    let size = 0, count;
    while (size < buffer.length && (count = readSync(fd, buffer, size, buffer.length - size, null))) size += count;
    const after = fstatSync(fd);
    if (size !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs) throw new Error('Control state changed during read.');
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, size)));
  } finally { closeSync(fd); }
}

/** Read the incumbent durable control owners; no cached permission, timer or new control ledger. */
export function helperAdmission(job) {
  if (!job.owner.startsWith('cos-core:')) return { allowed: true, reason: null };
  try {
    const control = job.control;
    if (!control || job.owner !== 'cos-core:' + hash([control.accountKey, control.sessionId])) throw new Error('Unbound Core parent.');
    const bindings = boundedControlJSON(path.join(control.durableRoot, 'state', 'deepai-helper-bindings.json'), 8 * 1024 * 1024);
    const row = bindings?.version === 1 && bindings.accountKey === control.accountKey && Array.isArray(bindings.rows)
      ? bindings.rows.filter(row => row.owner === job.owner && row.requestKey === job.requestKey) : [];
    if (row.length !== 1 || row[0].sessionId !== control.sessionId || row[0].sourceConversationId !== control.conversationId ||
        row[0].jobId !== null && row[0].jobId !== job.id || row[0].model !== job.model ||
        workspaceKey(path.resolve(row[0].workspace)) !== job.workspaceKey) throw new Error('Parent registration changed.');
    const config = boundedControlJSON(path.join(control.configRoot, 'config.json'), 4 * 1024 * 1024);
    if (config?.ui?.automationPaused === true) return { allowed: false, reason: 'parent_paused' };
    if (config?.ui?.automationPaused !== false || config.readOnly !== false || config.capabilities?.command !== true)
      return { allowed: false, reason: 'parent_command_disabled' };
    const switches = boundedControlJSON(path.join(control.durableRoot, 'state', 'goal-switches.json'), 4 * 1024 * 1024);
    if (switches?.version !== 1 || !Array.isArray(switches.switches)) throw new Error('Unverified parent switches.');
    const own = switches.switches.filter(row => row?.conversationId === control.conversationId);
    if (own.length > 1 || own.length === 1 && typeof own[0].enabled !== 'boolean') throw new Error('Invalid parent switch.');
    if (own[0] && (!own[0].enabled || own[0].role === 'decision')) return { allowed: false, reason: 'parent_off' };
    return { allowed: true, reason: null };
  } catch { return { allowed: false, reason: 'parent_control_unverified' }; }
}

function requiredText(value, label, max) {
  if (typeof value !== 'string' || !value.trim() || value.length > max || value.includes('\0')) throw new Error(`${label} must be a nonempty string of at most ${max} characters.`);
  return value.trim();
}

export function normalizeRequest(input, previous) {
  const owner = requiredText(input.owner, 'owner', 200);
  const requestKey = requiredText(input.requestKey, 'requestKey', 200);
  const prompt = requiredText(input.prompt, 'prompt', 200000);
  const workspace = realpathSync.native(previous?.workspace || requiredText(input.workspace, 'workspace', 2000));
  const title = requiredText(input.title || previous?.title || 'CoS DeepAI helper', 'title', 160);
  const model = requiredText(input.model || previous?.model || 'deepai/glm-5.3-flash', 'model', 200);
  const maxRunMinutes = input.maxRunMinutes ?? 20;
  let control;
  if (input.control !== undefined) {
    const value = input.control;
    control = { configRoot: realpathSync.native(requiredText(value.configRoot, 'control.configRoot', 4096)),
      durableRoot: realpathSync.native(requiredText(value.durableRoot, 'control.durableRoot', 4096)),
      accountKey: requiredText(value.accountKey, 'control.accountKey', 200),
      sessionId: requiredText(value.sessionId, 'control.sessionId', 64),
      conversationId: requiredText(value.conversationId, 'control.conversationId', 256) };
    if (owner !== 'cos-core:' + hash([control.accountKey, control.sessionId])) throw new Error('Core control does not match its parent owner.');
  }
  if (owner.startsWith('cos-core:') && !control) throw new Error('Core helper dispatch requires its exact durable parent control binding.');
  if (!Number.isInteger(maxRunMinutes) || maxRunMinutes < 1 || maxRunMinutes > 120) throw new Error('maxRunMinutes must be an integer from 1 to 120.');
  if (previous && previous.owner !== owner) throw new Error('The helper belongs to another owner.');
  if (previous && (input.workspace && workspaceKey(realpathSync.native(input.workspace)) !== workspaceKey(workspace))) throw new Error('A continuation must keep the original workspace.');
  if (previous && model !== previous.model) throw new Error('A continuation must keep its pinned model; create another helper to change model.');
  return { owner, requestKey, prompt, workspace, title, model, maxRunMinutes, ...(control ? { control } : {}), ...(previous ? { previousJobId: previous.id } : {}) };
}

function safeResultDirectory(workspace, id) {
  let directory = workspace;
  for (const segment of ['.cos-deepai', 'results', id]) {
    directory = path.join(directory, segment);
    if (!existsSync(directory)) mkdirSync(directory);
    if (workspaceKey(realpathSync.native(directory)) !== workspaceKey(directory)) throw new Error('Workspace result directory must not redirect through a symlink.');
  }
  return directory;
}

export class HelperState {
  constructor(root = defaultStateRoot()) {
    this.root = path.resolve(root);
    mkdirSync(this.root, { recursive: true });
    this.db = new DatabaseSync(path.join(this.root, 'state.sqlite'));
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY, owner TEXT NOT NULL, request_key TEXT NOT NULL, workspace_key TEXT NOT NULL, thread_id TEXT NOT NULL, status TEXT NOT NULL, created_ms INTEGER NOT NULL, data TEXT NOT NULL, UNIQUE(owner, request_key));
      CREATE TABLE IF NOT EXISTS projects (workspace_key TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS runtime (key TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS events (sequence INTEGER PRIMARY KEY AUTOINCREMENT, job_id TEXT, at TEXT NOT NULL, type TEXT NOT NULL, data TEXT NOT NULL);`);
  }
  close() { this.db.close(); }
  transaction(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  get(id, owner) {
    const row = this.db.prepare('SELECT data FROM jobs WHERE id=?').get(id);
    if (!row) throw new Error('Unknown helper job.');
    const job = JSON.parse(row.data);
    if (owner !== undefined && job.owner !== owner) throw new Error('The helper belongs to another owner.');
    return job;
  }
  list(owner) {
    return (owner === undefined ? this.db.prepare('SELECT data FROM jobs ORDER BY created_ms,id').all() : this.db.prepare('SELECT data FROM jobs WHERE owner=? ORDER BY created_ms,id').all(owner)).map(row => JSON.parse(row.data));
  }
  pending() { return this.db.prepare("SELECT data FROM jobs WHERE status NOT IN ('completed','failed','cancelled','blocked','incomplete') ORDER BY created_ms,id").all().map(row => JSON.parse(row.data)); }
  unsaved() { return this.db.prepare("SELECT data FROM jobs WHERE json_extract(data,'$.result') IS NOT NULL AND json_extract(data,'$.resultSavedAt') IS NULL AND json_extract(data,'$.resultSaveBlockedAt') IS NULL").all().map(row => JSON.parse(row.data)); }
  event(jobId, type, data = {}) {
    this.db.prepare('INSERT INTO events(job_id,at,type,data) VALUES(?,?,?,?)').run(jobId, new Date().toISOString(), type, JSON.stringify(data));
  }
  patch(id, patch) {
    return this.transaction(() => {
      const current = this.get(id);
      const changes = typeof patch === 'function' ? patch(current) : patch;
      const updated = { ...current, ...changes, updatedAt: new Date().toISOString() };
      this.db.prepare('UPDATE jobs SET status=?,data=? WHERE id=?').run(updated.status, JSON.stringify(updated), id);
      if (updated.status !== current.status) this.event(id, 'status', { from: current.status, to: updated.status });
      if (updated.waitingFor !== current.waitingFor) this.event(id, 'waiting', { reason: updated.waitingFor ?? null });
      if (updated.lastError && updated.lastError !== current.lastError) this.event(id, 'error', { message: updated.lastError });
      if (updated.acknowledgedAt && !current.acknowledgedAt) this.event(id, 'outcome-acknowledged', { runId: updated.runId, resultSaved: !!updated.resultSavedAt });
      if (updated.resultSavedAt && !current.resultSavedAt) this.event(id, 'result-saved', { directory: updated.resultDirectory, runId: updated.runId });
      return updated;
    });
  }
  enqueue(input, previousJobId) {
    const previous = previousJobId ? this.get(previousJobId, input.owner) : undefined;
    const request = normalizeRequest(input, previous);
    const requestHash = hash(request);
    return this.transaction(() => {
      const existing = this.db.prepare('SELECT data FROM jobs WHERE owner=? AND request_key=?').get(request.owner, request.requestKey);
      if (existing) {
        const job = JSON.parse(existing.data);
        if (job.requestHash !== requestHash) throw new Error('requestKey was already used with different content. Use a new key for a new request.');
        return { job, reused: true };
      }
      if (previous) {
        const latestPrevious = this.get(previous.id);
        if (latestPrevious.status !== 'completed' || !latestPrevious.result || !latestPrevious.resultSavedAt) throw new Error('Save the completed result into its workspace before continuing this helper.');
        if (this.pending().some(job => job.threadId === previous.threadId)) throw new Error('This helper already has a pending continuation.');
      }
      const id = randomUUID();
      const workspace = request.workspace;
      const key = workspaceKey(workspace);
      let projectRow = this.db.prepare('SELECT data FROM projects WHERE workspace_key=?').get(key);
      let project = projectRow ? JSON.parse(projectRow.data) : null;
      if (!project) {
        const projectId = randomUUID();
        project = { workspace, projectId, command: { type: 'project.create', commandId: randomUUID(), projectId, title: `CoS helpers: ${path.basename(workspace)}`.slice(0, 160), workspaceRoot: workspace } };
        this.db.prepare('INSERT INTO projects(workspace_key,data) VALUES(?,?)').run(key, JSON.stringify(project));
      }
      const threadId = previous?.threadId || randomUUID(), messageId = randomUUID(), commandId = randomUUID();
      const text = `CoS helper request ${id}. Owner label: ${request.owner}. Work only in ${workspace}. Follow that workspace's instructions. Do not delegate or start other agents, change provider/model, or modify the helper bridge's state/result directory. Do not commit, merge, or switch branches. Complete the requested work and report exact changed paths, checks actually run, results, and anything unresolved. A completed response is evidence for review, not automatic acceptance.\n\n${request.prompt}`;
      const modelSelection = { instanceId: 'deepai', model: request.model, options: { thinking: 'high' } };
      const command = previous ? { type: 'message.dispatch', createdBy: 'user', creationSource: 'web', commandId, threadId, messageId, text, attachments: [], modelSelection, dispatchMode: { type: 'start_immediately' } } : { commandId, threadId, projectId: project.projectId, title: request.title, generateTitle: false, modelSelection, runtimeMode: 'auto', interactionMode: 'default', workspaceStrategy: { type: 'root' }, initialMessage: { messageId, text, attachments: [] } };
      const job = { version: 1, id, ...request, requestHash, workspaceKey: key, projectId: project.projectId, threadId, messageId, command, operation: previous ? 'continue' : 'launch', status: 'queued', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), resultDirectory: safeResultDirectory(workspace, id), cancelRequestedAt: null, lastError: null };
      this.db.prepare('INSERT INTO jobs(id,owner,request_key,workspace_key,thread_id,status,created_ms,data) VALUES(?,?,?,?,?,?,?,?)').run(id, job.owner, job.requestKey, key, threadId, job.status, Date.now(), JSON.stringify(job));
      this.event(id, 'queued', { owner: job.owner, threadId, messageId });
      return { job, reused: false };
    });
  }
  project(workspace) { return JSON.parse(this.db.prepare('SELECT data FROM projects WHERE workspace_key=?').get(workspaceKey(workspace)).data); }
  lastAdmissions() { return new Map(this.db.prepare("SELECT owner,MAX(json_extract(data,'$.submittedAt')) AS admitted FROM jobs WHERE json_extract(data,'$.submittedAt') IS NOT NULL GROUP BY owner").all().map(row => [row.owner, Date.parse(row.admitted)])); }
  workspacesForThreads(threadIds) {
    if (!threadIds.length) return [];
    return this.db.prepare(`SELECT DISTINCT workspace_key FROM jobs WHERE thread_id IN (${threadIds.map(() => '?').join(',')})`).all(...threadIds).map(row => row.workspace_key);
  }
  cancel(id, owner) {
    this.get(id, owner);
    return this.patch(id, current => TERMINAL.has(current.status) ? {} : { cancelRequestedAt: current.cancelRequestedAt || new Date().toISOString(), cancelReason: 'Requested by the owning task' });
  }
  runtime(key) { const row = this.db.prepare('SELECT data FROM runtime WHERE key=?').get(key); return row ? JSON.parse(row.data) : null; }
  setRuntime(key, data) { this.db.prepare('INSERT INTO runtime(key,data) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET data=excluded.data').run(key, JSON.stringify(data)); }
  acquireWorker(token, pid, alive) {
    return this.transaction(() => {
      const previous = this.runtime('worker');
      if (previous && previous.token !== token && alive(previous.pid)) return false;
      this.setRuntime('worker', { token, pid, startedAt: new Date().toISOString(), heartbeatAt: new Date().toISOString(), lastError: null });
      return true;
    });
  }
  heartbeat(token, patch = {}) {
    return this.transaction(() => {
      const worker = this.runtime('worker');
      if (worker?.token !== token) return false;
      this.setRuntime('worker', { ...worker, ...patch, heartbeatAt: new Date().toISOString() });
      return true;
    });
  }
  releaseWorker(token) { this.transaction(() => { if (this.runtime('worker')?.token === token) this.db.prepare('DELETE FROM runtime WHERE key=?').run('worker'); }); }
  releaseIfIdle(token) { return this.transaction(() => { if (this.pending().length || this.unsaved().length) return false; if (this.runtime('worker')?.token === token) this.db.prepare('DELETE FROM runtime WHERE key=?').run('worker'); return true; }); }
}

export function writeResultFiles(job) {
  if (!job.result) return;
  const directory = safeResultDirectory(job.workspace, job.id);
  const result = JSON.stringify(job.result, null, 2);
  const report = `# DeepAI helper result\n\n- Job: ${job.id}\n- Owner: ${job.owner}\n- Native chat: ${job.threadId}\n- Native run: ${job.result.run.id}\n- Native command: ${job.command.commandId}\n- Previous job: ${job.previousJobId ?? 'none'}\n- Model: ${job.model} (High)\n- State: ${job.status}\n- Workspace: ${job.workspace}\n- Retrieved: ${job.result.retrievedAt}\n\nNative completion does not independently verify the agent's claims. Review the actual files and run relevant checks before integration.\n\n## Response\n\n${job.result.assistantText || '(No final assistant text was returned.)'}\n`;
  for (const [name, text] of [['result.json', result], ['report.md', report]]) {
    const filename = path.join(directory, name), temporary = filename + '.' + randomUUID() + '.tmp';
    writeFileSync(temporary, text, { encoding: 'utf8', flag: 'wx' }); renameSync(temporary, filename);
  }
}

export function publicJob(job) {
  return { id: job.id, owner: job.owner, requestKey: job.requestKey, status: job.status, commandId: job.command?.commandId, previousJobId: job.previousJobId ?? null, resultSavedAt: job.resultSavedAt ?? null, nativeStatus: job.nativeStatus ?? null, threadId: job.threadId, messageId: job.messageId, runId: job.runId ?? null, workspace: job.workspace, model: job.model, createdAt: job.createdAt, submittedAt: job.submittedAt ?? null, completedAt: job.completedAt ?? null, lastProgressAt: job.lastProgressAt ?? null, cancelRequested: !!job.cancelRequestedAt, waitingFor: job.waitingFor ?? null, attention: job.attention ?? null, attentionUnavailableReason: job.attentionUnavailableReason ?? null, lastError: job.lastError, resultDirectory: job.resultDirectory, resultSaved: !!job.resultSavedAt };
}
