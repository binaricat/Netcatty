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
 * Detect headers on *decoded* bytes. A four-byte DPAPI version alone is not
 * enough — real blobs continue with provider GUID
 * {df9d8cd0-1501-11d1-8c7a-00c04fc297eb} (base64 `AQAAANCMnd8...`).
 *
 * We require a known header AND a complete-enough decoded blob. v10/v11 CBC
 * blobs are at least header(3) + one AES block(16) = 19 bytes. Header-only
 * base64 such as `enc:v1:djEw` must not be treated as ciphertext.
 *
 * Keep in sync with electron/bridges/credentialBridge.cjs.
 *
 * References:
 * - components/os_crypt/sync/os_crypt_mac.mm (kObfuscationPrefixV10 = "v10")
 * - components/os_crypt/sync/os_crypt_linux.cc (kObfuscationPrefixV10/V11)
 * - components/os_crypt/sync/os_crypt_win.cc (DPAPI legacy path)
 */
const V10_HEADER = [0x76, 0x31, 0x30] as const; // "v10"
const V11_HEADER = [0x76, 0x31, 0x31] as const; // "v11"
// Version (4) + provider GUID {df9d8cd0-1501-11d1-8c7a-00c04fc297eb} (16).
const DPAPI_BLOB_PREFIX = [
  0x01, 0x00, 0x00, 0x00,
  0xd0, 0x8c, 0x9d, 0xdf, 0x01, 0x15, 0xd1, 0x11,
  0x8c, 0x7a, 0x00, 0xc0, 0x4f, 0xc2, 0x97, 0xeb,
] as const;

/** Minimum decoded sizes for complete Chromium OSCrypt blobs. */
const MIN_V10_V11_CIPHERTEXT_BYTES = 19; // CBC: header(3) + one AES block(16)
const MIN_V10_V11_GCM_CIPHERTEXT_BYTES = 31; // header(3) + nonce(12) + tag(16)
const MIN_DPAPI_CIPHERTEXT_BYTES = DPAPI_BLOB_PREFIX.length + 1;

/**
 * Renderer-safe base64 decode. Avoids Node `Buffer` which is unavailable
 * in Electron windows with `nodeIntegration: false`.
 */
const decodeBase64Bytes = (payload: string): Uint8Array | null => {
  try {
    if (typeof atob === "function") {
      const binary = atob(payload);
      const out = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i += 1) {
        out[i] = binary.charCodeAt(i);
      }
      return out;
    }
  } catch {
    // fall through
  }
  // Node / test environments without atob.
  if (typeof Buffer !== "undefined") {
    try {
      return new Uint8Array(Buffer.from(payload, "base64"));
    } catch {
      return null;
    }
  }
  return null;
};

const startsWithBytes = (
  decoded: Uint8Array,
  prefix: readonly number[],
): boolean => {
  if (decoded.byteLength < prefix.length) return false;
  return prefix.every((byte, index) => decoded[index] === byte);
};

/** CBC is header(3) + 16-byte blocks; GCM is at least header+nonce+tag (31). */
const isValidV10V11CiphertextLength = (byteLength: number): boolean => {
  if (byteLength >= MIN_V10_V11_GCM_CIPHERTEXT_BYTES) return true;
  return byteLength >= MIN_V10_V11_CIPHERTEXT_BYTES
    && (byteLength - 3) % 16 === 0;
};

export const isEncryptedCredentialPlaceholder = (
  value: string | undefined | null,
): value is string => {
  if (typeof value !== "string" || !value.startsWith(CREDENTIAL_ENCRYPTION_PREFIX)) {
    return false;
  }
  const payload = value.slice(CREDENTIAL_ENCRYPTION_PREFIX.length);
  if (!payload || !BASE64_RE.test(payload)) return false;
  const decoded = decodeBase64Bytes(payload);
  if (!decoded) return false;
  if (startsWithBytes(decoded, V10_HEADER) || startsWithBytes(decoded, V11_HEADER)) {
    return isValidV10V11CiphertextLength(decoded.byteLength);
  }
  if (startsWithBytes(decoded, DPAPI_BLOB_PREFIX)) {
    return decoded.byteLength >= MIN_DPAPI_CIPHERTEXT_BYTES;
  }
  return false;
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

export const isVaultStoredKeySource = (
  source: string | undefined,
): source is "imported" | "generated" =>
  source === "imported" || source === "generated";

/**
 * Imported/generated keys store private material in the vault. Empty or
 * still-encrypted privateKey means hydration has not finished (or failed).
 */
export const needsVaultStoredKeyHydration = (
  key?: { source?: string; privateKey?: string } | null,
): boolean => {
  if (!key || !isVaultStoredKeySource(key.source)) return false;
  return !key.privateKey || isEncryptedCredentialPlaceholder(key.privateKey);
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

  payload.proxyProfiles?.forEach((profile, index) => {
    if (isEncryptedCredentialPlaceholder(profile.config.password)) {
      issues.push(`proxyProfiles[${index}].config.password`);
    }
  });

  payload.groupConfigs?.forEach((config, index) => {
    if (isEncryptedCredentialPlaceholder(config.password)) {
      issues.push(`groupConfigs[${index}].password`);
    }
    if (isEncryptedCredentialPlaceholder(config.telnetPassword)) {
      issues.push(`groupConfigs[${index}].telnetPassword`);
    }
    if (isEncryptedCredentialPlaceholder(config.proxyConfig?.password)) {
      issues.push(`groupConfigs[${index}].proxyConfig.password`);
    }
  });

  return issues;
};

/**
 * Clear device-bound enc:v1 placeholders from a portable sync payload.
 *
 * Cloud / backup payloads must carry plaintext secrets (protected by the
 * master key envelope). If a previous bug uploaded undecryptable local
 * ciphertext, stripping placeholders lets download restore a usable vault
 * shell so the user can re-enter credentials instead of looping forever.
 */
export const stripSyncPayloadEncryptedCredentials = (
  payload: SyncPayload,
): SyncPayload => {
  const hosts = payload.hosts.map((host) => {
    const next = { ...host };
    if (isEncryptedCredentialPlaceholder(next.password)) delete next.password;
    if (isEncryptedCredentialPlaceholder(next.telnetPassword)) delete next.telnetPassword;
    if (next.proxyConfig && isEncryptedCredentialPlaceholder(next.proxyConfig.password)) {
      const { password: _removed, ...proxyRest } = next.proxyConfig;
      next.proxyConfig = proxyRest;
    }
    return next;
  });

  const keys = payload.keys.map((key) => {
    const next = { ...key };
    if (isEncryptedCredentialPlaceholder(next.privateKey)) next.privateKey = "";
    if (isEncryptedCredentialPlaceholder(next.passphrase)) delete next.passphrase;
    return next;
  });

  const identities = payload.identities?.map((identity) => {
    if (!isEncryptedCredentialPlaceholder(identity.password)) return identity;
    const next = { ...identity };
    delete next.password;
    return next;
  });

  const proxyProfiles = payload.proxyProfiles?.map((profile) => {
    if (!isEncryptedCredentialPlaceholder(profile.config.password)) return profile;
    const { password: _removed, ...configRest } = profile.config;
    return { ...profile, config: configRest };
  });

  const groupConfigs = payload.groupConfigs?.map((config) => {
    const next = { ...config };
    if (isEncryptedCredentialPlaceholder(next.password)) delete next.password;
    if (isEncryptedCredentialPlaceholder(next.telnetPassword)) delete next.telnetPassword;
    if (next.proxyConfig && isEncryptedCredentialPlaceholder(next.proxyConfig.password)) {
      const { password: _removed, ...proxyRest } = next.proxyConfig;
      next.proxyConfig = proxyRest;
    }
    return next;
  });

  return {
    ...payload,
    hosts,
    keys,
    identities: identities ?? payload.identities,
    proxyProfiles: proxyProfiles ?? payload.proxyProfiles,
    groupConfigs: groupConfigs ?? payload.groupConfigs,
  };
};

const usableCredential = (value: string | undefined): string | undefined => {
  if (typeof value !== "string" || value.length === 0) return undefined;
  if (isEncryptedCredentialPlaceholder(value)) return undefined;
  return value;
};

/**
 * Resolve a poisoned secret against preferred then fallback.
 *
 * If the preferred *entity* exists, an empty/missing preferred secret is an
 * explicit deletion and must win over fallback/base. Only when preferred is
 * also poisoned (or the preferred entity is absent) may we revive from base.
 */
const healPoisonedCredential = (
  preferredEntity: unknown,
  preferredValue: string | undefined,
  fallbackValue: string | undefined,
): string | undefined => {
  if (preferredEntity) {
    if (isEncryptedCredentialPlaceholder(preferredValue)) {
      return usableCredential(fallbackValue);
    }
    return usableCredential(preferredValue);
  }
  return usableCredential(fallbackValue);
};

/**
 * Before three-way merge, replace device-bound enc:v1 secrets on `poisoned`
 * with usable values from `preferred` then `fallback`. Used for both remote
 * and local sides so a poisoned field cannot win the entity-level merge and
 * delete a still-usable secret from the other side / base.
 *
 * Explicit preferred-side deletions (empty/absent secrets on a present entity)
 * are authoritative and are not revived from base.
 */
export const healPoisonedSecretsForMerge = (
  poisoned: SyncPayload,
  preferred: SyncPayload,
  fallback: SyncPayload | null | undefined,
): SyncPayload => {
  const preferredHosts = new Map(preferred.hosts.map((host) => [host.id, host]));
  const fallbackHosts = new Map((fallback?.hosts ?? []).map((host) => [host.id, host]));
  const hosts = poisoned.hosts.map((host) => {
    const preferredHost = preferredHosts.get(host.id);
    const fallbackHost = fallbackHosts.get(host.id);
    const next = { ...host };
    if (isEncryptedCredentialPlaceholder(next.password)) {
      const healed = healPoisonedCredential(
        preferredHost,
        preferredHost?.password,
        fallbackHost?.password,
      );
      if (healed !== undefined) next.password = healed;
      else delete next.password;
    }
    if (isEncryptedCredentialPlaceholder(next.telnetPassword)) {
      const healed = healPoisonedCredential(
        preferredHost,
        preferredHost?.telnetPassword,
        fallbackHost?.telnetPassword,
      );
      if (healed !== undefined) next.telnetPassword = healed;
      else delete next.telnetPassword;
    }
    if (next.proxyConfig && isEncryptedCredentialPlaceholder(next.proxyConfig.password)) {
      const healed = healPoisonedCredential(
        preferredHost,
        preferredHost?.proxyConfig?.password,
        fallbackHost?.proxyConfig?.password,
      );
      if (healed !== undefined) {
        next.proxyConfig = { ...next.proxyConfig, password: healed };
      } else {
        const { password: _removed, ...proxyRest } = next.proxyConfig;
        next.proxyConfig = proxyRest;
      }
    }
    return next;
  });

  const preferredKeys = new Map(preferred.keys.map((key) => [key.id, key]));
  const fallbackKeys = new Map((fallback?.keys ?? []).map((key) => [key.id, key]));
  const keys = poisoned.keys.map((key) => {
    const preferredKey = preferredKeys.get(key.id);
    const fallbackKey = fallbackKeys.get(key.id);
    const next = { ...key };
    if (isEncryptedCredentialPlaceholder(next.privateKey)) {
      next.privateKey = healPoisonedCredential(
        preferredKey,
        preferredKey?.privateKey,
        fallbackKey?.privateKey,
      ) ?? "";
    }
    if (isEncryptedCredentialPlaceholder(next.passphrase)) {
      const healed = healPoisonedCredential(
        preferredKey,
        preferredKey?.passphrase,
        fallbackKey?.passphrase,
      );
      if (healed !== undefined) next.passphrase = healed;
      else delete next.passphrase;
    }
    return next;
  });

  const preferredIdentities = new Map((preferred.identities ?? []).map((identity) => [identity.id, identity]));
  const fallbackIdentities = new Map((fallback?.identities ?? []).map((identity) => [identity.id, identity]));
  const identities = poisoned.identities?.map((identity) => {
    if (!isEncryptedCredentialPlaceholder(identity.password)) return identity;
    const preferredIdentity = preferredIdentities.get(identity.id);
    const healed = healPoisonedCredential(
      preferredIdentity,
      preferredIdentity?.password,
      fallbackIdentities.get(identity.id)?.password,
    );
    if (healed !== undefined) return { ...identity, password: healed };
    const next = { ...identity };
    delete next.password;
    return next;
  });

  const preferredProfiles = new Map((preferred.proxyProfiles ?? []).map((profile) => [profile.id, profile]));
  const fallbackProfiles = new Map((fallback?.proxyProfiles ?? []).map((profile) => [profile.id, profile]));
  const proxyProfiles = poisoned.proxyProfiles?.map((profile) => {
    if (!isEncryptedCredentialPlaceholder(profile.config.password)) return profile;
    const preferredProfile = preferredProfiles.get(profile.id);
    const healed = healPoisonedCredential(
      preferredProfile,
      preferredProfile?.config.password,
      fallbackProfiles.get(profile.id)?.config.password,
    );
    if (healed !== undefined) {
      return { ...profile, config: { ...profile.config, password: healed } };
    }
    const { password: _removed, ...configRest } = profile.config;
    return { ...profile, config: configRest };
  });

  const preferredGroupConfigs = new Map((preferred.groupConfigs ?? []).map((config) => [config.path, config]));
  const fallbackGroupConfigs = new Map((fallback?.groupConfigs ?? []).map((config) => [config.path, config]));
  const groupConfigs = poisoned.groupConfigs?.map((config) => {
    const preferredConfig = preferredGroupConfigs.get(config.path);
    const fallbackConfig = fallbackGroupConfigs.get(config.path);
    const next = { ...config };
    let changed = false;
    if (isEncryptedCredentialPlaceholder(next.password)) {
      const healed = healPoisonedCredential(
        preferredConfig,
        preferredConfig?.password,
        fallbackConfig?.password,
      );
      if (healed !== undefined) next.password = healed;
      else delete next.password;
      changed = true;
    }
    if (isEncryptedCredentialPlaceholder(next.telnetPassword)) {
      const healed = healPoisonedCredential(
        preferredConfig,
        preferredConfig?.telnetPassword,
        fallbackConfig?.telnetPassword,
      );
      if (healed !== undefined) next.telnetPassword = healed;
      else delete next.telnetPassword;
      changed = true;
    }
    if (next.proxyConfig && isEncryptedCredentialPlaceholder(next.proxyConfig.password)) {
      const healed = healPoisonedCredential(
        preferredConfig,
        preferredConfig?.proxyConfig?.password,
        fallbackConfig?.proxyConfig?.password,
      );
      if (healed !== undefined) {
        next.proxyConfig = { ...next.proxyConfig, password: healed };
      } else {
        const { password: _removed, ...proxyRest } = next.proxyConfig;
        next.proxyConfig = proxyRest;
      }
      changed = true;
    }
    return changed ? next : config;
  });

  return {
    ...poisoned,
    hosts,
    keys,
    identities: identities ?? poisoned.identities,
    proxyProfiles: proxyProfiles ?? poisoned.proxyProfiles,
    groupConfigs: groupConfigs ?? poisoned.groupConfigs,
  };
};


