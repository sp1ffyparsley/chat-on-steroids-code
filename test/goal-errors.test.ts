import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { goalErrorMessage, goalHelperFailureCause, isGoalHelperFailureCause } from '../src/shared/goal-errors.js';
import { faultGate, makeTempDir, removeTempDir } from './helpers.js';

vi.mock('electron', () => ({
  app: { getPath: () => '', getVersion: () => '0.0.0' },
  safeStorage: {
    isAsyncEncryptionAvailable: async () => true,
    getSelectedStorageBackend: () => 'gnome_libsecret',
    encryptStringAsync: async (value: string) => Buffer.from(value, 'utf8'),
    decryptStringAsync: async (buffer: Buffer) => ({ result: buffer.toString('utf8'), shouldReEncrypt: false })
  }
}));

describe('Goal failure explanations', () => {
  it('distinguishes delivered unresolved helpers from unknown Send without exposing private output', () => {
    const delivered = goalErrorMessage('goal_browser_delivered_helper_unresolved');
    expect(delivered).toContain('confirmed');
    expect(delivered).toContain('cancelled');
    expect(delivered).toContain('Automatic replacement is paused');
    expect(delivered).not.toContain('could not confirm whether');
    expect(goalErrorMessage('goal_browser_answer_expired')).toContain('not collected');
    expect(goalErrorMessage('goal_browser_send_unconfirmed')).toContain('could not confirm whether');
  });
  it.each(['goal_human_history_incomplete', 'request_failed: goal_human_history_incomplete'])(
    'explains the retained human-history hold for %s without promising a retry', error => {
      const message = goalErrorMessage(error);
      expect(message).toContain('original request or later human changes');
      expect(message).toContain('missing, incomplete or unverified');
      expect(message).toContain('saved task is retained');
      expect(message).toContain('Recover the original request and changes');
      expect(message).not.toMatch(/Check the app diagnostics|Resume all|Restart helper|switch to Loop|automatically retry|Nothing was sent/i);
    });

  it('explains an unresolved native completion without treating a retry timer as progress', () => {
    for (const error of ['native_completion_unverified', 'request_failed: native_completion_unverified']) {
      const message = goalErrorMessage(error);
      expect(message).toContain('tool call');
      expect(message).toContain('completed result');
      expect(message).toContain('saved continuation has not been sent');
      expect(message).toContain('not proof of progress');
      expect(message).not.toMatch(/click Retry|resume all|send it again/i);
    }
  });

  it('explains a delivered helper STOP as a Loop protocol rejection, not an empty answer or failed Send', () => {
    for (const code of ['loop_stop_refused', 'request_failed: loop_stop_refused']) {
      expect(goalHelperFailureCause(code)).toBe('loop_stop_refused');
      const message = goalErrorMessage('goal_browser_helper_exhausted', goalHelperFailureCause(code));
      expect(message).toContain('stopping decision');
      expect(message).toContain('prompt was delivered');
      expect(message).not.toMatch(/empty|could not be parsed|before confirmed delivery/);
    }
  });
  it('explains durable account pause without inferring sign-out, completion or a spent helper attempt', () => {
    for (const code of ['goal_browser_automation_paused', 'request_failed: goal_browser_automation_paused']) {
      const message = goalErrorMessage(code);
      expect(message).toContain('Automation is paused for this account');
      expect(message).toContain('Confirmed-unsent');
      expect(message).toContain('without spending retry attempts');
      expect(message).toContain('native Send receipts remain saved');
      expect(message).toContain('Resolve the account hold');
      expect(message).not.toMatch(/signed out|Three helper attempts|goal reached|new helper/i);
    }
  });
  it('explains the native sign-out hold without calling it an empty answer or spent helper attempt', () => {
    expect(goalErrorMessage('goal_browser_signed_out')).toContain('signed out');
    expect(goalErrorMessage('goal_browser_signed_out')).toContain('without spending retry attempts');
    expect(goalErrorMessage('goal_browser_signed_out')).toContain('Send receipts are retained');
    expect(goalErrorMessage('goal_browser_signed_out')).not.toContain('Three helper attempts');
  });
  it.each([
    ['goal_browser_queued_unclaimed_timeout', 'transport_unclaimed'],
    ['goal_browser_queued_unclaimed_transport', 'transport_unclaimed'],
    ['goal_browser_send_failed: Requested model or reasoning could not be confirmed', 'model_reasoning_unconfirmed'],
    ['goal_browser_send_failed: Requested model or reasoning could not be confirmed elsewhere', 'send_failed'],
    ['request_failed: goal_browser_send_failed: Requested model or reasoning could not be confirmed.', 'model_reasoning_unconfirmed'],
    ['goal_browser_send_failed: ChatGPT did not expose the installed Core app. The draft was preserved and not sent.', 'core_attachment_unconfirmed'],
    ['goal_browser_send_failed: composer missing private text', 'send_failed'],
    ['request_failed: invalid_goal_decision_json', 'unusable_response'],
    ['request_failed: goal_content_reference_unresolved', 'unresolved_content_reference'],
    ['request_failed: provider_private_diagnostic', 'request_failed'],
    ['request_failed: '.repeat(10) + 'goal_browser_send_failed: Requested model or reasoning could not be confirmed.', 'request_failed']
  ])('classifies %s using only a fixed diagnostic category', (error, cause) => {
    expect(goalHelperFailureCause(error)).toBe(cause);
    expect(isGoalHelperFailureCause(cause)).toBe(true);
    const message = goalErrorMessage('goal_browser_helper_exhausted', goalHelperFailureCause(error));
    expect(message).toContain('exact Loop reply remains saved');
    expect(message).not.toContain('private');
  });

  it('distinguishes durable storage failures from helper model and delivery failures without leaking prose', () => {
    for (const raw of ['goal_reply_not_durable', 'goal_ack_not_durable', 'goal_stop_disposition_not_durable',
      'request_failed: request_failed: goal_objective_not_durable']) {
      expect(goalHelperFailureCause(raw)).toBe('ledger_unsaved');
      expect(goalErrorMessage(raw)).toContain('disk space');
      expect(goalErrorMessage('goal_browser_helper_exhausted', goalHelperFailureCause(raw))).toContain('could not save');
    }
    expect(isGoalHelperFailureCause('ledger_unsaved')).toBe(true);
    expect(goalHelperFailureCause('provider_private_storage_error')).toBe('request_failed');
    expect(goalErrorMessage('goal_browser_helper_exhausted', goalHelperFailureCause('provider_private_storage_error')))
      .not.toContain('provider_private_storage_error');
  });

  it('names the distinct source and acceptance holds while preserving unknown error fallback', () => {
    for (const [code, detail] of [
      ['goal_source_changed', 'source evidence changed'],
      ['goal_original_acceptance_unverified', 'task acceptance'],
      ['goal_canonical_scope_changed', 'canonical source'],
      ['goal_human_history_changed', 'human changes']
    ] as const) {
      expect(goalErrorMessage('request_failed: ' + code)).toContain(detail);
      expect(goalHelperFailureCause(code)).toBe('request_failed');
    }
    expect(goalErrorMessage('goal_newly_invented_code')).toContain('goal_newly_invented_code');
  });

  it('refuses arbitrary persisted helper causes and keeps the legacy explanation', () => {
    for (const value of ['private diagnostic', '__proto__', 'constructor', null, {}, 5]) {
      expect(isGoalHelperFailureCause(value)).toBe(false);
      expect(goalErrorMessage('goal_browser_helper_exhausted', value as any))
        .toBe(goalErrorMessage('goal_browser_helper_exhausted'));
    }
  });

  it('does not misreport pre-Send helper failures as blank provider answers', () => {
    const message = goalErrorMessage('goal_browser_helper_exhausted');
    expect(message).toContain('before Send');
    expect(message).toContain('model or reasoning choice');
    expect(message).toContain('Resume this chat');
    expect(message).not.toContain('Resume all');
    expect(message).not.toContain('ChatGPT returned three');
  });
  it('describes retained continuation delivery without inventing a Main restart or lost private answer', () => {
    const message = goalErrorMessage('goal_browser_continuation_delivery_attention');
    expect(message).toContain('saved continuation');
    expect(message).toContain('before Send');
    expect(message).toContain('same delivery');
    expect(message).not.toMatch(/Main restarted|private answer|new helper/i);
  });
  it('does not diagnose an app restart from an accepted helper with unconfirmed continuation custody', () => {
    for (const code of ['goal_browser_answer_custody_unconfirmed', 'request_failed: goal_browser_answer_custody_unconfirmed']) {
      const message = goalErrorMessage(code);
      expect(message).toContain('original helper answer was recorded');
      expect(message).toContain('continuation is not confirmed');
      expect(message).toContain('native receipt remains saved');
      expect(message).toContain('Automatic replacement is paused');
      expect(message).not.toMatch(/Main restarted|app restarted|was not sent|confirmed unsent/i);
    }
  });
  it('describes a confirmed pre-delivery helper timeout without implying an answer existed', () => {
    const message = goalErrorMessage('goal_browser_queued_unclaimed_timeout');
    expect(message).toContain('queued and unclaimed');
    expect(message).toContain('before browser delivery');
    expect(message).toContain('confirmed unsent');
    expect(message).not.toContain('response');
  });
  it('distinguishes missing tool evidence from a confirmed lost connection or disabled Loop', () => {
    const message = goalErrorMessage('loop_mcp_call_missing');
    expect(message).toContain('cannot tell whether the tool connection was lost');
    expect(message).toContain('Loop remains enabled');
    expect(message).not.toMatch(/logged out|sign in|tunnel is off/i);
    expect(goalErrorMessage('goal_reply_not_pending')).not.toContain('No MCP tool call');
  });

  it('distinguishes oversized input from oversized helper output, including wrapped failures', () => {
    for (const code of ['goal_context_too_large', 'request_failed: goal_context_too_large']) {
      const message = goalErrorMessage(code);
      expect(message).toContain('assembled Goal/Loop helper context');
      expect(message).toContain('saved task is retained');
      expect(message).toContain('component sizes in app diagnostics');
      expect(message).not.toContain('Shorten the task');
    }
    expect(goalErrorMessage('reply_too_long')).toContain('helper wrote a continuation');
    expect(goalErrorMessage('stream_record_too_long')).not.toContain('Shorten the task');
    expect(goalErrorMessage('request_failed: fetch failed')).not.toContain('too long');
  });

  it('retains native delivery and recognized protocol causes through bounded request wrappers', () => {
    expect(goalErrorMessage('request_failed: goal_browser_send_failed: Temporary Chat was not confirmed.'))
      .toBe('The helper prompt could not be delivered. Temporary Chat was not confirmed.');
    expect(goalErrorMessage('request_failed: request_failed: invalid_goal_decision_json')).toContain('unusable continuation');
    expect(goalErrorMessage('request_failed: stream_record_too_long')).toContain('oversized response');
    expect(goalErrorMessage('request_failed: goal_browser_send_failed: ' + 'x'.repeat(400)))
      .toBe('The helper prompt could not be delivered. ' + 'x'.repeat(200));
    const generic = goalErrorMessage('request_failed');
    expect(goalErrorMessage('request_failed: unexpected_private_cause')).toBe(generic);
    expect(goalErrorMessage('request_failed: fetch failed')).toBe(generic);
    expect(goalErrorMessage('request_failed: '.repeat(10) + 'no_api_key')).toBe(generic);
  });

  it('explains known provider failures without echoing arbitrary provider diagnostics', () => {
    expect(goalErrorMessage('auth_rejected: private provider detail')).toContain('Check its API key');
    expect(goalErrorMessage('auth_rejected: private provider detail')).not.toContain('private provider detail');
    expect(goalErrorMessage('rate_limited: limit')).toContain('rate-limiting');
    expect(goalErrorMessage('http_503: upstream unavailable')).toContain('HTTP 503');
    expect(goalErrorMessage('invalid_goal_decision_json')).toContain('Nothing was sent');
  });

  it('keeps uncertain delivery distinct from a safe retry and preserves readable errors', () => {
    expect(goalErrorMessage('goal_browser_send_unconfirmed')).toContain('avoid sending it twice');
    expect(goalErrorMessage('goal_browser_answer_expired')).toContain('accepted the helper prompt');
    expect(goalErrorMessage('goal_browser_answer_expired')).toContain('automatic replacement is paused');
    expect(goalErrorMessage('goal_browser_answer_expired')).not.toContain('confirmed unsent');
    expect(goalErrorMessage('goal_browser_answer_custody_unconfirmed')).toContain('original helper answer was recorded');
    expect(goalErrorMessage('goal_browser_answer_custody_unconfirmed')).toContain('Automatic replacement is paused');
    expect(goalErrorMessage('goal_browser_answer_custody_unconfirmed')).not.toContain('was not sent');
    expect(goalErrorMessage('goal_browser_send_failed')).toContain('could not be delivered');
    expect(goalErrorMessage('Enter a task of at most 16000 characters')).toBe('Enter a task of at most 16000 characters');
    expect(goalErrorMessage('future_goal_error')).toContain('Check the app diagnostics');
  });
});

describe('Terminal Goal recovery currentness', () => {
  const config = import('../src/main/config.js');
  const durable = import('../src/main/durable.js');
  const sessions = import('../src/main/session/store.js');
  const goal = import('../src/main/goal.js');
  const input = import('../src/main/session/input.js');
  let dir: string;

  beforeAll(async () => {
    dir = await makeTempDir('clf-goal-terminal-current-');
    (await config).initConfigPath(dir);
    (await durable).initDurableStore(dir);
    (await sessions).initSessionStore(dir);
    (await import('../src/main/secrets.js')).initSecretsPath(dir);
  });
  beforeEach(async () => {
    (await goal).resetGoalStateForTests();
    (await input).resetInputForTests();
    const { defaultConfig, saveConfig } = await config;
    const defaults = defaultConfig();
    await saveConfig({ ...defaults, goal: { ...defaults.goal, enabled: true,
      backend: 'api', loopBackend: 'api' } });
    await (await import('../src/main/secrets.js')).setSecret('openRouterApiKey', 'test-terminal-currentness');
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    (await input).resetInputForTests();
    (await goal).resetGoalStateForTests();
    await (await durable).flushDurable();
  });
  afterAll(async () => {
    (await sessions).resetSessionStoreForTests();
    await removeTempDir(dir);
  });

  async function failedTurn(conversationId: string, shape: 'failed' | 'active' | 'cooldown' | 'conversation-limit' |
    'unclassified' | 'recent' = 'failed') {
    const store = await sessions, driver = await goal;
    const session = await store.createSession({ conversationId });
    await driver.setGoalSwitchNow(conversationId, 'loop', true);
    const time = shape === 'recent' ? Date.now() - 10 : Date.now() - driver.AUTOMATIC_LOOP_RECOVERY_GRACE_MS - 1_000;
    await store.appendEvent(session.id, { source: 'extension', time, kind: 'user_message',
      message: { text: 'Continue the original task', chars: 26, truncated: false } });
    await store.appendEvent(session.id, { source: 'extension', time: time + 1,
      kind: 'turn_start', turnId: 'original-failed-turn' });
    const end = shape === 'active' ? null : await store.appendEvent(session.id, { source: 'extension', time: time + 2,
      kind: 'turn_end', turnId: 'original-failed-turn', outcome: 'failed',
      ...(shape === 'cooldown' ? { reason: 'model_cooldown' as const } :
        shape === 'conversation-limit' ? { reason: 'conversation_limit' as const } : {}),
      detail: shape === 'unclassified' ? 'Unclassified provider failure' : 'Connection interrupted' });
    return { session, end };
  }

  it('retains one existing continuation for an unchanged idle failure, including after restore', async () => {
    const driver = await goal, conversationId = 'terminal-current-positive';
    const { session, end } = await failedTurn(conversationId);
    if (!end) throw new Error('Expected the recorded terminal failure fixture');
    expect(await driver.setGoalReplyActiveNow(conversationId, true, () => true)).toBe(true);
    expect(driver.goalPendingReplyFor(conversationId)).toMatchObject({ sessionId: session.id,
      turnId: end.turnId, eventSeq: end.seq });
    expect(driver.snapshotGoalReplies().replies).toEqual([
      expect.objectContaining({ turnId: end.turnId, explicitActivation: true })
    ]);
    driver.restoreGoalReplies(driver.snapshotGoalReplies());
    expect(await driver.setGoalReplyActiveNow(conversationId, true, () => true)).toBe(false);
    await driver.setGoalReplyActiveNow(conversationId, false);
    expect(await driver.setGoalReplyActiveNow(conversationId, true, () => true)).toBe(false);
    expect(await (await input).listInputs()).toEqual([]);
  });

  it('does not override a currentness veto merely because the recorded turn failed', async () => {
    const driver = await goal, conversationId = 'terminal-current-held';
    await failedTurn(conversationId);
    expect(await driver.setGoalReplyActiveNow(conversationId, true, () => false)).toBe(false);
    expect(driver.goalPendingReplyFor(conversationId)).toBeNull();
    expect(driver.snapshotGoalReplies().replies).toEqual([]);
  });

  it.each(['active', 'cooldown', 'conversation-limit', 'unclassified', 'recent'] as const)(
    'keeps %s with its existing owner instead of creating terminal recovery debt', async shape => {
      const driver = await goal, conversationId = 'terminal-current-refusal-' + shape;
      await failedTurn(conversationId, shape);
      expect(await driver.setGoalReplyActiveNow(conversationId, true, () => true)).toBe(false);
      expect(driver.goalPendingReplyFor(conversationId)).toBeNull();
      expect(driver.snapshotGoalReplies().replies).toEqual([]);
      expect(await (await input).listInputs()).toEqual([]);
    });

  it.each(['source-read', 'accept-fsync', 'activation-fsync'] as const)(
    'declines a manual successor arriving during %s without reviving the earlier failure', async boundary => {
      const driver = await goal, store = await sessions, disk = await durable;
      const conversationId = 'terminal-current-race-' + boundary;
      const { session } = await failedTurn(conversationId);
      const gate = faultGate();
      let current = true, held = false;
      if (boundary === 'source-read') {
        const read = store.readRecentEvents;
        vi.spyOn(store, 'readRecentEvents').mockImplementation(async (...args) => {
          const rows = await read(...args);
          if (!held && args[0] === session.id && args[1] === 1) { held = true; await gate.hold(); }
          return rows;
        });
      } else {
        const write = disk.writeDurableNow;
        vi.spyOn(disk, 'writeDurableNow').mockImplementation(async (name, value) => {
          const rows = (value as { replies?: Array<{ explicitActivation?: boolean }> })?.replies;
          if (!held && name === driver.GOAL_REPLIES_STATE && rows?.length &&
              (rows[0]!.explicitActivation === true) === (boundary === 'activation-fsync')) {
            held = true; await gate.hold();
          }
          return write(name, value);
        });
      }
      const recovering = driver.setGoalReplyActiveNow(conversationId, true, () => current);
      try {
        await gate.entered;
        await store.appendEvent(session.id, { source: 'extension', time: Date.now(), kind: 'user_message',
          messageId: 'manual-successor', message: { text: 'Continue', chars: 8, truncated: false } });
        await store.appendEvent(session.id, { source: 'extension', time: Date.now() + 1,
          kind: 'turn_start', turnId: 'manual-successor-turn' });
        current = false;
        gate.release();
        expect(await recovering).toBe(false);
        expect(driver.goalPendingReplyFor(conversationId)).toBeNull();
        const saved = await disk.readDurable<ReturnType<typeof driver.snapshotGoalReplies>>(driver.GOAL_REPLIES_STATE);
        if (saved) driver.restoreGoalReplies(saved);
        expect(driver.goalPendingReplyFor(conversationId)).toBeNull();
        expect((await store.getSession(session.id))?.activeTurnId).toBe('manual-successor-turn');
        expect(await (await input).listInputs()).toEqual([]);
      } finally {
        gate.release();
        await recovering;
      }
    });
});

it.each(['goal_native_delivery_scope_mismatch', 'goal_canonical_scope_unverified'])(
  'names deterministic %s preflight evidence without promising helper retries', code => {
    expect(goalErrorMessage(code)).toContain('before a helper');
    expect(goalErrorMessage('request_failed: ' + code)).toBe(goalErrorMessage(code));
    expect(goalErrorMessage(code)).not.toMatch(/Three helper attempts|Restart helper|automatically retry/i);
  });
