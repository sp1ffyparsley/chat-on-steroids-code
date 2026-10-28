/** Display only: unknown identity never implies permission or delivery readiness. */
export interface ComposerTargetEvidence {
  account: { nickname: string; id: string } | null;
  sessionId: string | null;
  session: { title: string; projectId?: string | null } | null;
  projectId: string | null;
  projects: ReadonlyArray<{ id: string; name: string; path: string }>;
  model: { model: string; reasoningEffort: string } | null;
  paused: boolean;
}
/** Only fixed fallback messages are translated; nicknames, titles and paths stay literal. */
export interface ComposerTargetField { label: string; value: string; translatable?: true; }
export function composerTargetFields(evidence: ComposerTargetEvidence): ComposerTargetField[] {
  const projectId = evidence.sessionId ? evidence.session?.projectId : evidence.projectId;
  const project = projectId ? evidence.projects.find(row => row.id === projectId) : null;
  const field = (label: string, value: string, translatable = false): ComposerTargetField =>
    ({ label, value, ...(translatable ? { translatable: true } : {}) });
  return [
    field('Account', evidence.account ? evidence.account.nickname || evidence.account.id : 'Checking active account…', !evidence.account),
    field('Task', evidence.sessionId ? evidence.session?.title || 'Checking selected task…' : 'New chat', !evidence.sessionId || !evidence.session?.title),
    field('Folder', evidence.sessionId && !evidence.session ? 'Checking task folder…'
      : project ? `${project.name} · ${project.path}` : projectId ? 'Selected project unavailable' : 'No project folder selected', !project),
    field('Model', evidence.model ? `${evidence.model.model} · ${evidence.model.reasoningEffort}` : 'Choose a confirmed model', !evidence.model),
    ...(evidence.paused ? [field('Automation', 'Paused', true)] : [])
  ];
}
