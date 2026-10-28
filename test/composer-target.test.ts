import { describe, expect, it } from 'vitest';
import { composerTargetFields, type ComposerTargetEvidence } from '../src/renderer/composer-target.js';

const evidence = (): ComposerTargetEvidence => ({ account: { nickname: 'Garry', id: 'runtime-2' },
  sessionId: 'task-1234', session: { title: 'My exact nickname', projectId: 'project-1' },
  projectId: 'wrong-new-chat-project', projects: [{ id: 'project-1', name: 'Cut', path: 'H:\\Clips\\素材' }],
  model: { model: 'GPT 6', reasoningEffort: 'high' }, paused: false });
describe('composer target evidence', () => {
  it('preserves nicknames and shows the selected task’s actual project', () => {
    expect(composerTargetFields(evidence())).toEqual([
      { label: 'Account', value: 'Garry' }, { label: 'Task', value: 'My exact nickname' },
      { label: 'Folder', value: 'Cut · H:\\Clips\\素材' }, { label: 'Model', value: 'GPT 6 · high' }
    ]);
  });
  it('does not turn missing task evidence into an unassigned New chat', () => {
    const fields = composerTargetFields({ ...evidence(), session: null });
    expect(fields[1]!.value).toBe('Checking selected task…');
    expect(fields[2]!.value).toBe('Checking task folder…');
  });
  it('distinguishes removed projects from unassigned projects', () => {
    expect(composerTargetFields({ ...evidence(), projects: [] })[2]!.value).toBe('Selected project unavailable');
    expect(composerTargetFields({ ...evidence(), session: { title: 'Task' } })[2]!.value).toBe('No project folder selected');
  });
  it('uses the explicitly selected project for a new chat', () => {
    expect(composerTargetFields({ ...evidence(), sessionId: null, session: null, projectId: 'project-1' })[2]!.value).toContain('H:\\Clips');
  });
  it('does not invent active account or model evidence and keeps Pause visible', () => {
    const fields = composerTargetFields({ ...evidence(), account: null, model: null, paused: true });
    expect(fields[0]!.value).toBe('Checking active account…');
    expect(fields[3]!.value).toBe('Choose a confirmed model');
    expect(fields[4]!.value).toBe('Paused');
  });
  it('translates fallback messages while retaining literal nicknames and titles', () => {
    const data = { ...evidence(), account: { id: 'runtime-2', nickname: 'New chat' }, session: { title: 'Paused' } };
    const fields = composerTargetFields(data);
    expect(fields[0]).toEqual({ label: 'Account', value: 'New chat' });
    expect(fields[1]).toEqual({ label: 'Task', value: 'Paused' });
    expect(fields[2]!.translatable).toBe(true);
    expect(composerTargetFields({ ...data, account: null })[0]!.translatable).toBe(true);
  });
});
