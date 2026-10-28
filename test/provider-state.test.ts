import { promises as fs } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { initDurableStore, resetDurableForTests } from '../src/main/durable.js';
import {
  ProviderRecoveryRequiredError,
  beginProviderSubmission,
  getProviderSession,
  markProviderTurnAccepted,
  markProviderTurnTerminal,
  providerRecoveryDisposition,
  recordProviderConversationId,
  registerProviderSession,
  resetProviderSessionsForTests,
  restoreProviderSessions
} from '../src/main/providers/provider-state.js';
import type { ProviderTerminalResult } from '../src/shared/provider-adapter.js';
import { makeTempDir, removeTempDir } from './helpers.js';

let dir = '';

function terminal(overrides: Partial<ProviderTerminalResult> = {}): ProviderTerminalResult {
  return {
    providerId: 'antigravity',
    nativeConversationId: 'native-1',
    outcome: 'completed',
    providerStatus: 'SUCCESS',
    response: 'finished',
    usage: null,
    failure: null,
    ...overrides
  };
}

beforeEach(async () => {
  resetProviderSessionsForTests();
  resetDurableForTests();
  dir = await makeTempDir('cos-provider-state-');
  initDurableStore(dir);
  await restoreProviderSessions();
});

afterEach(async () => {
  resetProviderSessionsForTests();
  resetDurableForTests();
  await removeTempDir(dir);
});

describe('durable provider submission ownership', () => {
  it('fails closed when the provider ledger JSON is corrupt', async () => {
    resetProviderSessionsForTests();
    await fs.mkdir(path.join(dir, 'state'), { recursive: true });
    await fs.writeFile(path.join(dir, 'state', 'provider-sessions.json'), '{"schemaVersion":1,"sessions":', 'utf8');

    await expect(restoreProviderSessions()).rejects.toThrow();
    await expect(registerProviderSession({
      localSessionId: 'must-not-start-fresh',
      providerId: 'antigravity',
      selectedModel: 'gemini-3-pro'
    })).rejects.toThrow('has not been restored');
  });

  it('fails closed when parsed provider state violates its durable schema', async () => {
    resetProviderSessionsForTests();
    await fs.mkdir(path.join(dir, 'state'), { recursive: true });
    await fs.writeFile(
      path.join(dir, 'state', 'provider-sessions.json'),
      JSON.stringify({ schemaVersion: 99, sessions: {} }),
      'utf8'
    );

    await expect(restoreProviderSessions()).rejects.toThrow('restore refused');
    await expect(registerProviderSession({
      localSessionId: 'must-not-ignore-schema',
      providerId: 'antigravity',
      selectedModel: 'gemini-3-pro'
    })).rejects.toThrow('has not been restored');
  });

  it('commits intent before transport and never auto-replays a crash before acceptance', async () => {
    await registerProviderSession({
      localSessionId: 'local-1',
      providerId: 'antigravity',
      selectedModel: 'gemini-3-pro',
      nativeConversationId: 'native-1',
      now: 1
    });
    await beginProviderSubmission({
      localSessionId: 'local-1',
      turnId: 'turn-1',
      messageId: 'message-1',
      content: 'Do the work once',
      now: 2
    });

    const bytes = JSON.parse(await fs.readFile(path.join(dir, 'state', 'provider-sessions.json'), 'utf8')) as any;
    expect(bytes.sessions['local-1'].pendingTurn).toMatchObject({
      turnId: 'turn-1',
      messageId: 'message-1',
      phase: 'submitting'
    });
    expect(bytes.sessions['local-1'].pendingTurn).not.toHaveProperty('content');

    resetProviderSessionsForTests();
    await restoreProviderSessions();
    expect(providerRecoveryDisposition('local-1')).toMatchObject({ state: 'blocked', autoResubmit: false });
    await expect(beginProviderSubmission({
      localSessionId: 'local-1',
      turnId: 'turn-1',
      messageId: 'message-1',
      content: 'Do the work once',
      now: 3
    })).rejects.toBeInstanceOf(ProviderRecoveryRequiredError);
  });

  it('persists acceptance before a missing result and still forbids duplicate submission after restart', async () => {
    await registerProviderSession({
      localSessionId: 'local-2',
      providerId: 'antigravity',
      selectedModel: 'gemini-3-pro',
      nativeConversationId: 'native-2'
    });
    await beginProviderSubmission({
      localSessionId: 'local-2',
      turnId: 'turn-2',
      messageId: 'message-2',
      content: 'accepted once'
    });
    await markProviderTurnAccepted('local-2', 'turn-2', 20);

    resetProviderSessionsForTests();
    await restoreProviderSessions();
    expect(getProviderSession('local-2')).toMatchObject({
      lastAcceptedMessage: { messageId: 'message-2', acceptedAt: 20 },
      pendingTurn: { turnId: 'turn-2', phase: 'accepted', acceptedAt: 20 },
      resumableState: 'recovery required'
    });
    expect(providerRecoveryDisposition('local-2')).toMatchObject({ state: 'blocked', autoResubmit: false });
    await expect(beginProviderSubmission({
      localSessionId: 'local-2',
      turnId: 'turn-2',
      messageId: 'message-2',
      content: 'accepted once'
    })).rejects.toBeInstanceOf(ProviderRecoveryRequiredError);
  });

  it('deduplicates acceptance and an identical terminal result while rejecting a conflicting duplicate', async () => {
    await registerProviderSession({
      localSessionId: 'local-3',
      providerId: 'antigravity',
      selectedModel: 'gemini-3-pro',
      nativeConversationId: 'native-3'
    });
    await beginProviderSubmission({
      localSessionId: 'local-3',
      turnId: 'turn-3',
      messageId: 'message-3',
      content: 'one terminal'
    });
    await markProviderTurnAccepted('local-3', 'turn-3', 30);
    await markProviderTurnAccepted('local-3', 'turn-3', 31);
    const result = terminal({ nativeConversationId: 'native-3' });
    await markProviderTurnTerminal('local-3', 'turn-3', result, { accepted: true, now: 32 });
    await markProviderTurnTerminal('local-3', 'turn-3', result, { accepted: true, now: 33 });

    expect(getProviderSession('local-3')).toMatchObject({
      lastAcceptedMessage: { messageId: 'message-3', acceptedAt: 30 },
      lastTerminalEvent: { turnId: 'turn-3', recordedAt: 32, outcome: 'completed' },
      pendingTurn: null,
      resumableState: 'resumable'
    });
    await expect(markProviderTurnTerminal(
      'local-3',
      'turn-3',
      { ...result, response: 'different terminal bytes' },
      { accepted: true, now: 34 }
    )).rejects.toThrow('no pending submission');
  });

  it('never re-admits a terminal turn id, even after later turns and restart', async () => {
    await registerProviderSession({
      localSessionId: 'local-terminal-fence',
      providerId: 'antigravity',
      selectedModel: 'gemini-3-pro',
      nativeConversationId: 'native-terminal-fence'
    });
    await beginProviderSubmission({
      localSessionId: 'local-terminal-fence',
      turnId: 'turn-old',
      messageId: 'message-old',
      content: 'old once'
    });
    await markProviderTurnTerminal(
      'local-terminal-fence',
      'turn-old',
      terminal({ nativeConversationId: 'native-terminal-fence', response: 'old done' }),
      { accepted: true, now: 50 }
    );
    await beginProviderSubmission({
      localSessionId: 'local-terminal-fence',
      turnId: 'turn-new',
      messageId: 'message-new',
      content: 'new once'
    });
    await markProviderTurnTerminal(
      'local-terminal-fence',
      'turn-new',
      terminal({ nativeConversationId: 'native-terminal-fence', response: 'new done' }),
      { accepted: true, now: 51 }
    );

    resetProviderSessionsForTests();
    await restoreProviderSessions();
    await expect(beginProviderSubmission({
      localSessionId: 'local-terminal-fence',
      turnId: 'turn-old',
      messageId: 'message-old',
      content: 'old once'
    })).rejects.toBeInstanceOf(ProviderRecoveryRequiredError);
    expect(getProviderSession('local-terminal-fence')?.terminalTurns).toHaveProperty('turn-old');
    expect(getProviderSession('local-terminal-fence')?.terminalTurns).toHaveProperty('turn-new');
  });

  it('does not fabricate acceptance for a terminal model error that occurred before acceptance', async () => {
    await registerProviderSession({
      localSessionId: 'local-4',
      providerId: 'antigravity',
      selectedModel: 'bad-model'
    });
    await beginProviderSubmission({
      localSessionId: 'local-4',
      turnId: 'turn-4',
      messageId: 'message-4',
      content: 'will be rejected'
    });
    await markProviderTurnTerminal('local-4', 'turn-4', terminal({
      nativeConversationId: null,
      outcome: 'failed',
      providerStatus: 'ERROR',
      response: '',
      failure: {
        kind: 'unknown_model',
        message: 'unknown model',
        advice: { retryable: false, retryAfterMs: null, reason: 'select a real model' }
      }
    }), { accepted: false, now: 40 });

    expect(getProviderSession('local-4')).toMatchObject({
      lastAcceptedMessage: null,
      lastTerminalEvent: { turnId: 'turn-4', failureKind: 'unknown_model' },
      pendingTurn: null,
      resumableState: 'blocked'
    });
  });

  it('pins provider, model, and native conversation identity instead of silently substituting them', async () => {
    await registerProviderSession({
      localSessionId: 'local-5',
      providerId: 'antigravity',
      selectedModel: 'gemini-3-pro'
    });
    await recordProviderConversationId('local-5', 'native-5');
    await expect(registerProviderSession({
      localSessionId: 'local-5',
      providerId: 'antigravity',
      selectedModel: 'some-fallback'
    })).rejects.toThrow('already pinned');
    await expect(recordProviderConversationId('local-5', 'native-other')).rejects.toThrow('changed native conversation identity');
    expect(getProviderSession('local-5')).toMatchObject({
      providerId: 'antigravity',
      selectedModel: 'gemini-3-pro',
      nativeConversationId: 'native-5',
      resumableState: 'resumable'
    });
  });

  it('rejects a terminal callback from the wrong provider or native conversation', async () => {
    await registerProviderSession({
      localSessionId: 'local-identity',
      providerId: 'antigravity',
      selectedModel: 'gemini-3-pro',
      nativeConversationId: 'native-identity'
    });
    await beginProviderSubmission({
      localSessionId: 'local-identity',
      turnId: 'turn-identity',
      messageId: 'message-identity',
      content: 'identity'
    });
    await expect(markProviderTurnTerminal('local-identity', 'turn-identity', terminal({
      providerId: 'chatgpt',
      nativeConversationId: 'native-identity'
    }))).rejects.toThrow('pinned provider');
    await expect(markProviderTurnTerminal('local-identity', 'turn-identity', terminal({
      nativeConversationId: 'native-other'
    }))).rejects.toThrow('changed native conversation identity');
    expect(getProviderSession('local-identity')?.pendingTurn?.turnId).toBe('turn-identity');
  });

  it('keeps WAITING/RUNNING-style terminal state blocked across restart', async () => {
    await registerProviderSession({
      localSessionId: 'local-blocked',
      providerId: 'antigravity',
      selectedModel: 'gemini-3-pro',
      nativeConversationId: 'native-blocked'
    });
    await beginProviderSubmission({
      localSessionId: 'local-blocked',
      turnId: 'turn-blocked',
      messageId: 'message-blocked',
      content: 'blocked turn'
    });
    await markProviderTurnTerminal('local-blocked', 'turn-blocked', terminal({
      nativeConversationId: 'native-blocked',
      outcome: 'blocked',
      providerStatus: 'WAITING',
      response: '',
      failure: {
        kind: 'provider',
        message: 'inspect native state',
        advice: { retryable: false, retryAfterMs: null, reason: 'inspect first' }
      }
    }), { accepted: true, now: 60 });
    expect(providerRecoveryDisposition('local-blocked')).toMatchObject({ state: 'blocked', autoResubmit: false });

    resetProviderSessionsForTests();
    await restoreProviderSessions();
    expect(getProviderSession('local-blocked')).toMatchObject({
      resumableState: 'blocked',
      lastTerminalEvent: { providerStatus: 'WAITING', outcome: 'blocked' }
    });
    expect(providerRecoveryDisposition('local-blocked')).toMatchObject({ state: 'blocked', autoResubmit: false });
    await expect(beginProviderSubmission({
      localSessionId: 'local-blocked',
      turnId: 'turn-after-blocked',
      messageId: 'message-after-blocked',
      content: 'must not send before reconciliation'
    })).rejects.toBeInstanceOf(ProviderRecoveryRequiredError);
  });
});
