/**
 * Pure custody classification shared by input transport and diagnostics.
 *
 * This module intentionally has no transport imports. It records the last proven delivery
 * boundary; retry/send authority remains with the existing input owner.
 */
export type ProviderRecoveryFailurePhase =
  | 'pre_send_preparation'
  | 'native_send_ambiguous'
  | 'receipt_missing'
  | 'provider_recovery_unknown';

export interface ProviderRecoveryFailureEvidence {
  state: 'queued' | 'browser' | 'sent' | 'failed' | 'cancelled';
  sendAuthorized: boolean;
  messageIdPresent: boolean;
  deliveredAtPresent: boolean;
  /** Positive proof from the exact delivery owner; absent receipt fields alone are not proof. */
  confirmedUnsent?: boolean;
  error?: string | null;
}

export function classifyProviderRecoveryFailure(
  evidence: ProviderRecoveryFailureEvidence
): { phase: ProviderRecoveryFailurePhase; retrySafe: boolean; detail: string } {
  const noNativeSend = evidence.sendAuthorized === false && evidence.messageIdPresent === false &&
    evidence.deliveredAtPresent === false;
  if (evidence.confirmedUnsent === true && noNativeSend &&
      (evidence.state === 'queued' || evidence.state === 'browser' || evidence.state === 'failed')) {
    return {
      phase: 'pre_send_preparation',
      retrySafe: true,
      detail: 'The delivery owner confirmed that native Send was not attempted; retry may reuse the existing custody record.'
    };
  }
  if (evidence.sendAuthorized === true && evidence.messageIdPresent === false && evidence.deliveredAtPresent === false) {
    return {
      phase: 'native_send_ambiguous',
      retrySafe: false,
      detail: 'Native Send was authorized without a durable receipt; automatic replay is blocked.'
    };
  }
  if (evidence.state === 'sent' && evidence.messageIdPresent === false && evidence.deliveredAtPresent === false) {
    return {
      phase: 'receipt_missing',
      retrySafe: false,
      detail: 'A sent state exists without receipt evidence; preserve custody until resolved.'
    };
  }
  return {
    phase: 'provider_recovery_unknown',
    retrySafe: false,
    detail: 'Available evidence does not establish a retryable pre-Send boundary; preserve and reconcile the existing custody record.'
  };
}
