import { describe, expect, it } from 'vitest';
import { classifyProviderRecoveryFailure } from '../src/main/session/recovery-failure.js';

describe('positive pre-Send recovery evidence', () => {
  it.each(['queued', 'browser', 'failed'] as const)('does not infer safe retry from absent receipt fields in %s state', state => {
    expect(classifyProviderRecoveryFailure({ state, sendAuthorized: false, messageIdPresent: false,
      deliveredAtPresent: false })).toMatchObject({ phase: 'provider_recovery_unknown', retrySafe: false });
  });

  it('retains a positive pre-Send classification only when the delivery owner confirmed it', () => {
    expect(classifyProviderRecoveryFailure({ state: 'failed', sendAuthorized: false, messageIdPresent: false,
      deliveredAtPresent: false, confirmedUnsent: true })).toMatchObject({ phase: 'pre_send_preparation', retrySafe: true });
  });

  it.each([
    { sendAuthorized: true, messageIdPresent: false, deliveredAtPresent: false },
    { sendAuthorized: false, messageIdPresent: true, deliveredAtPresent: false },
    { sendAuthorized: false, messageIdPresent: false, deliveredAtPresent: true }
  ])('does not let a claimed unsent flag override native boundary evidence: %j', receipt => {
    expect(classifyProviderRecoveryFailure({ state: 'failed', ...receipt, confirmedUnsent: true }).retrySafe).toBe(false);
  });

  it('never turns terminal cancellation into a retryable preparation failure', () => {
    expect(classifyProviderRecoveryFailure({ state: 'cancelled', sendAuthorized: false,
      messageIdPresent: false, deliveredAtPresent: false, confirmedUnsent: true }).retrySafe).toBe(false);
  });
});
