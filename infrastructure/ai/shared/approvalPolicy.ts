import approvalPolicy from '../../../lib/aiApprovalPolicy.json';

export type ApprovalDenialReason =
  | 'user_denied'
  | 'timeout_auto_denied'
  | 'policy_denied'
  | 'observer_denied';

const denialReasons = approvalPolicy.denialReasons as {
  userDenied: 'user_denied';
  timeoutAutoDenied: 'timeout_auto_denied';
  policyDenied: 'policy_denied';
  observerDenied: 'observer_denied';
};
const denialMessages = approvalPolicy.messages as Record<ApprovalDenialReason, string>;

export interface ApprovalDecision {
  approved: true;
}

export interface ApprovalDenial {
  approved: false;
  reason: ApprovalDenialReason;
  message: string;
}

export type ApprovalResult = ApprovalDecision | ApprovalDenial;

export interface DeniedToolResult {
  error: string;
  denialReason: ApprovalDenialReason;
}

export const APPROVAL_TIMEOUT_MS = approvalPolicy.approvalTimeoutMs;

export const APPROVAL_DENIAL_REASONS = {
  USER_DENIED: denialReasons.userDenied,
  TIMEOUT_AUTO_DENIED: denialReasons.timeoutAutoDenied,
  POLICY_DENIED: denialReasons.policyDenied,
  OBSERVER_DENIED: denialReasons.observerDenied,
} as const;

export function getApprovalDenialMessage(reason: ApprovalDenialReason): string {
  return denialMessages[reason] ?? denialMessages.policy_denied;
}

export function approvalAccepted(): ApprovalDecision {
  return { approved: true };
}

export function approvalDenied(
  reason: ApprovalDenialReason,
  message = getApprovalDenialMessage(reason),
): ApprovalDenial {
  return { approved: false, reason, message };
}

export function createDeniedToolResult(
  reason: ApprovalDenialReason,
  message = getApprovalDenialMessage(reason),
): DeniedToolResult {
  return { error: message, denialReason: reason };
}

export function isApprovalDenialReason(value: unknown): value is ApprovalDenialReason {
  return (
    value === APPROVAL_DENIAL_REASONS.USER_DENIED ||
    value === APPROVAL_DENIAL_REASONS.TIMEOUT_AUTO_DENIED ||
    value === APPROVAL_DENIAL_REASONS.POLICY_DENIED ||
    value === APPROVAL_DENIAL_REASONS.OBSERVER_DENIED
  );
}
