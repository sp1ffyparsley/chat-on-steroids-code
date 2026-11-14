import { z } from 'zod';
import { currentCaller } from './call-context.js';
import { toolDeclaration } from './tool-declarations.js';
import { fail, failIdentity, ok, resolveCwd, type SurfaceRegistrar } from './kernel.js';
import { deepAIHelperOwner, DeepAIHelperError } from '../deepai-helper.js';

export const deepAIHelperSchema = z.object({
  action: z.enum(['submit', 'continue', 'status', 'result', 'inbox', 'ack', 'cancel', 'recover', 'readiness']),
  requestKey: z.string().trim().min(1).max(120).optional(),
  workspace: z.string().min(1).max(4096).optional(),
  prompt: z.string().trim().min(1).max(200000).optional(),
  title: z.string().trim().min(1).max(160).optional(),
  model: z.string().trim().min(1).max(200).optional(),
  maxRunMinutes: z.number().int().min(1).max(120).optional(),
  job: z.string().uuid().optional(),
  offset: z.number().int().nonnegative().optional(),
  limit: z.number().int().min(1).max(16000).optional()
}).strict().superRefine((input, context) => {
  const need = (key: keyof typeof input) => {
    if (input[key] === undefined) context.addIssue({ code: 'custom', path: [key], message: key + ' is required for ' + input.action });
  };
  const allowed = new Set<string>(['action']);
  if (input.action === 'submit' || input.action === 'continue') {
    need('requestKey'); need('prompt');
    for (const key of ['requestKey', 'prompt', 'title', 'maxRunMinutes']) allowed.add(key);
    if (input.action === 'submit') {
      need('workspace'); allowed.add('workspace'); allowed.add('model');
    } else { need('job'); allowed.add('job'); }
  } else if (!['inbox', 'readiness'].includes(input.action)) {
    need('job'); allowed.add('job');
    if (input.action === 'result') { allowed.add('offset'); allowed.add('limit'); }
  }
  for (const key of Object.keys(input)) if (!allowed.has(key))
    context.addIssue({ code: 'custom', path: [key], message: key + ' is not valid for ' + input.action });
});
export function registerDeepAIHelperTool(reg: SurfaceRegistrar): void {
  if (!reg.exposedCaps.command) return;
  reg.register('deepai_helper', toolDeclaration('deepai_helper', () => ({
    description: 'Parent-bound async free-model helpers. submit: requestKey/workspace/prompt; retry uncertain sends with the SAME key/body. continue: completed job/new requestKey/prompt; retains workspace/model. readiness: native/free-model check without dispatch. inbox/readiness need no job; others do. status includes blocker/action and linked receipt. recover checks existing queue; stale live processes need review. result: offset/limit (max16000). ack: handled terminal outcome. Verify saved reports independently. Review approvals in DeepAI Code. Notices join later Core replies; no idle/paused wake.',
    inputSchema: deepAIHelperSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true }
  })), input => reg.guarded('command', 'deepai_helper', async () => {
    if (reg.ctx.readOnly) return fail('TOOL_DISABLED: DeepAI helper access requires writable command mode.');
    try {
      const principal = await deepAIHelperOwner.parent(currentCaller());
      let response: Record<string, unknown>;
      if (input.action === 'submit') {
        const workspace = await resolveCwd(reg.ctx, input.workspace!);
        response = await deepAIHelperOwner.submit(principal, {
          requestKey: input.requestKey!, prompt: input.prompt!, workspace: workspace.real,
          ...(input.title !== undefined ? { title: input.title } : {}),
          ...(input.model !== undefined ? { model: input.model } : {}),
          ...(input.maxRunMinutes !== undefined ? { maxRunMinutes: input.maxRunMinutes } : {})
        });
      } else if (input.action === 'continue') {
        // The retained workspace is validated again against current folder permissions before
        // another native model turn is admitted. An old registration cannot restore a revoked root.
        const prior = await deepAIHelperOwner.inspect(principal, 'status', input.job!);
        await resolveCwd(reg.ctx, String(prior.workspace));
        response = await deepAIHelperOwner.submit(principal, {
          job: input.job!, requestKey: input.requestKey!, prompt: input.prompt!,
          ...(input.title !== undefined ? { title: input.title } : {}),
          ...(input.maxRunMinutes !== undefined ? { maxRunMinutes: input.maxRunMinutes } : {})
        });
      } else if (input.action === 'readiness') response = await deepAIHelperOwner.readiness(principal);
      else if (input.action === 'inbox') response = await deepAIHelperOwner.inbox(principal);
      else response = await deepAIHelperOwner.inspect(principal, input.action, input.job!, {
        ...(input.offset !== undefined ? { offset: input.offset } : {}),
        ...(input.limit !== undefined ? { limit: input.limit } : {})
      });
      return ok(JSON.stringify(response));
    } catch (error) {
      if (error instanceof DeepAIHelperError)
        return error.code === 'CALLER_IDENTITY_REQUIRED' ? failIdentity(error.message) : fail(error.message);
      throw error;
    }
  }));
}
