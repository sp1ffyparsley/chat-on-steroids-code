import { statusForCaller } from '../agents.js';
import { runningToolProgress } from '../mcp/call-context.js';
import type { WorkerLifecycleProgress } from '../../shared/session.js';

export const EMPTY_WORKER_LIFECYCLE: WorkerLifecycleProgress = Object.freeze({
  total: 0, active: 0, queued: 0, finished: 0, failed: 0, names: [], failures: []
});

function lifecycleFromAgents(list: ReturnType<typeof statusForCaller>['state']['agents']): WorkerLifecycleProgress {
  const workers = list.filter(agent => agent.role === 'worker');
  const active = workers.filter(agent => ['active', 'waking', 'detached'].includes(agent.state));
  const failures = [...new Set(workers.filter(agent => agent.state === 'failed' && agent.result)
    .map(agent => agent.result!.replace(/\s+/g, ' ').trim().slice(0, 180)))]
    .slice(0, 4);
  return {
    total: workers.length,
    active: active.length,
    queued: workers.filter(agent => agent.state === 'invited').length,
    finished: workers.filter(agent => ['sleeping', 'finished'].includes(agent.state)).length,
    failed: workers.filter(agent => agent.state === 'failed').length,
    names: active.slice(0, 3).map(agent => (agent.label || 'Worker').slice(0, 60)),
    failures
  };
}

/**
 * Parent-chat lifecycle view for the sidebar. No broker family is a truthful all-zero result.
 * Callers must exclude worker/helper sessions before displaying this parent-only projection.
 */
export function workerLifecycleForConversation(conversationId: string): WorkerLifecycleProgress {
  try {
    const snapshot = statusForCaller({ conversationId });
    return snapshot.self?.role === 'prime'
      ? lifecycleFromAgents(snapshot.state.agents)
      : { ...EMPTY_WORKER_LIFECYCLE, names: [], failures: [] };
  } catch {
    return { ...EMPTY_WORKER_LIFECYCLE, names: [], failures: [] };
  }
}

/** Minimal presentation on the existing activity feed. No tasks, commands or identities leave the app. */
export function conversationProgress(conversationId: string) {
  let workers: WorkerLifecycleProgress | null = null;
  try {
    const snapshot = statusForCaller({ conversationId });
    if (snapshot.self?.role === 'prime') {
      workers = lifecycleFromAgents(snapshot.state.agents);
    }
  } catch { /* No enabled, exact broker owner means no worker claim for this conversation. */ }
  return { tools: runningToolProgress(conversationId), workers };
}
