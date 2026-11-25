import type { PortForwardingRule } from "./models";

export const PORT_FORWARD_RECONNECT_BASE_DELAY_MS = 3_000;
export const PORT_FORWARD_RECONNECT_MAX_DELAY_MS = 60_000;

const NON_RETRYABLE_ERROR_PATTERNS: readonly RegExp[] = [
  // SSH authentication & key/passphrase failures
  /all configured authentication methods failed/i,
  /\bauthentication failed\b/i,
  /too many authentication failures/i,
  /\bpermission denied\b/i,
  /\bERR_PASSPHRASE_CANCELLED\b/i,
  /passphrase.*cancel+ed|cancel+ed.*passphrase/i,
  /\bbad passphrase\b/i,
  /no passphrase given/i,
  /cannot parse privatekey/i,
  /does not contain a private key/i,
  /\bunsupported key\b/i,
  // Host key verification failures
  /host denied \(verification failed\)/i,
  /host key rejected/i,
  /host key verification failed/i,
  /host key mismatch/i,
  /\bERR_HOST_KEY_UNVERIFIED\b/i,
  // Local listener bind conflicts / permission errors
  /\bEADDRINUSE\b/i,
  /address already in use/i,
  /\bEACCES\b/i,
  /\bEADDRNOTAVAIL\b/i,
  /cannot assign requested address/i,
  // Local configuration & credential decryption errors
  /saved proxy for .* is missing/i,
  /proxy identity for .* is (?:missing|incomplete)/i,
  /missing jump host configuration/i,
  /cannot be decrypted on this device/i,
  /unknown forwarding type/i,
  /^(?:rule not found|rule host is not configured|host not found)$/i,
  /(?:proxy or jump host|host authentication) configuration is not ready/i,
];

/**
 * Whether a port-forwarding rule should automatically reconnect (with capped
 * exponential backoff) after an unexpected disconnect.
 *
 * Legacy rules without `autoReconnect` retain their auto-start reconnect
 * behavior. An explicit choice always takes precedence.
 */
export const isPortForwardingAutoReconnectEnabled = (
  rule: Pick<PortForwardingRule, "autoStart" | "autoReconnect">,
): boolean => rule.autoReconnect ?? rule.autoStart === true;

/**
 * Compute the delay before reconnect attempt `attempt` (1-based) using capped
 * exponential backoff: 3s -> 6s -> 12s -> 24s -> 48s -> 60s (capped).
 */
export const computePortForwardReconnectDelayMs = (attempt: number): number => {
  const normalizedAttempt = Number.isFinite(attempt) ? Math.max(1, Math.floor(attempt)) : 1;
  const exponent = Math.min(normalizedAttempt - 1, 10);
  const delay = PORT_FORWARD_RECONNECT_BASE_DELAY_MS * (2 ** exponent);
  return Math.min(delay, PORT_FORWARD_RECONNECT_MAX_DELAY_MS);
};

/**
 * Format a concise status message describing the next scheduled reconnect.
 */
export const formatPortForwardReconnectMessage = (
  attempt: number,
  delayMs?: number,
): string => {
  const normalizedAttempt = Number.isFinite(attempt) ? Math.max(1, Math.floor(attempt)) : 1;
  const resolvedDelayMs = delayMs ?? computePortForwardReconnectDelayMs(normalizedAttempt);
  const delaySeconds = Math.max(1, Math.round(resolvedDelayMs / 1000));
  return `Reconnecting (attempt #${normalizedAttempt}, next in ${delaySeconds}s)...`;
};

/**
 * Classify errors that cannot be resolved by reconnecting (e.g. bad credentials,
 * rejected host keys, local port conflicts, invalid configuration). Transient
 * network/transport disconnects return false so capped backoff can recover.
 */
export const isPortForwardingNonRetryableError = (error?: string | null): boolean => {
  if (typeof error !== "string") return false;
  const trimmed = error.trim();
  if (!trimmed) return false;
  return NON_RETRYABLE_ERROR_PATTERNS.some((pattern) => pattern.test(trimmed));
};
