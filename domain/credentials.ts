import type { SyncPayload } from "./sync";

const CREDENTIAL_ENCRYPTION_PREFIX = "enc:v1:";

/**
 * Base64 pattern: only allows A-Z, a-z, 0-9, +, / and trailing = padding.
 */
const BASE64_RE = /^[A-Za-z0-9+/]+=*$/;

/**
 * Chromium/Electron safeStorage ciphertext carries known platform headers:
 * - macOS/Linux: plaintext bytes start with "v10" or "v11"
 * - Windows (legacy DPAPI blob): leading bytes are 0x01 0x00 0x00 0x00
 *
 * We validate the base64 payload starts with one of these header signatures
 * instead of relying only on prefix+length heuristics. This greatly reduces
 * false positives for plaintext credentials that happen to start with "enc:v1:".
 *
 * References:
 * - components/os_crypt/sync/os_crypt_mac.mm (kObfuscationPrefixV10 = "v10")
 * - components/os_crypt/sync/os_crypt_linux.cc (kObfuscationPrefixV10/V11)
 * - components/os_crypt/sync/os_crypt_win.cc (DPAPI legacy path)
 */
const SAFE_STORAGE_BASE64_HEADER_PREFIXES = [
  "djEw", // "v10"
  "djEx", // "v11"
  "AQAAAA", // 0x01 0x00 0x00 0x00 (DPAPI blob header)
] as const;

export const isEncryptedCredentialPlaceholder = (
  value: string | undefined | null,
): value is string => {
  if (typeof value !== "string" || !value.startsWith(CREDENTIAL_ENCRYPTION_PREFIX)) {
    return false;
  }
  const payload = value.slice(CREDENTIAL_ENCRYPTION_PREFIX.length);
  if (!payload || !BASE64_RE.test(payload)) return false;

  return SAFE_STORAGE_BASE64_HEADER_PREFIXES.some((prefix) => payload.startsWith(prefix));
};

/**
 * Strip enc:v1: placeholders from a single credential value.
 * Used at the terminal connection boundary to avoid sending encrypted
 * placeholders as actual passwords to SSH/Telnet servers.
 */
export const sanitizeCredentialValue = (
  value: string | undefined,
): string | undefined => {
  if (isEncryptedCredentialPlaceholder(value)) return undefined;
  return value;
};

/**
 * Scan a sync payload for any fields that still carry device-bound
 * enc:v1: ciphertext.  Returns the dotted paths of offending fields.
 * Used as a pre-upload guard to prevent pushing un-decryptable data.
 */
export const findSyncPayloadEncryptedCredentialPaths = (
  payload: SyncPayload,
): string[] => {
  const issues: string[] = [];

  payload.hosts.forEach((host, index) => {
    if (isEncryptedCredentialPlaceholder(host.password)) {
      issues.push(`hosts[${index}].password`);
    }
    if (isEncryptedCredentialPlaceholder(host.telnetPassword)) {
      issues.push(`hosts[${index}].telnetPassword`);
    }
    if (isEncryptedCredentialPlaceholder(host.proxyConfig?.password)) {
      issues.push(`hosts[${index}].proxyConfig.password`);
    }
  });

  payload.keys.forEach((key, index) => {
    if (isEncryptedCredentialPlaceholder(key.privateKey)) {
      issues.push(`keys[${index}].privateKey`);
    }
    if (isEncryptedCredentialPlaceholder(key.passphrase)) {
      issues.push(`keys[${index}].passphrase`);
    }
  });

  payload.identities?.forEach((identity, index) => {
    if (isEncryptedCredentialPlaceholder(identity.password)) {
      issues.push(`identities[${index}].password`);
    }
  });

  return issues;
};
