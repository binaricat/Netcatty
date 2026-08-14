import type { GroupConfig, Host, Identity, KnownHost, ProxyProfile, SSHKey, TerminalSettings } from "./models";
import { resolveHostAuth, resolveBridgeSshAgentAuth } from "./sshAuth";
import { resolveHostKeepalive } from "./host";
import { resolveHostSshConnectionTimeouts } from "./sshConnectionTimeouts";
import {
  hasUnreadableProxyCredential,
  hasUsableProxyConfig,
  resolveProxyConfigAuth,
} from "./proxyProfiles";
import { isEncryptedCredentialPlaceholder, sanitizeCredentialValue } from "./credentials";
import { resolveEffectiveTerminalHost, resolveTerminalChainHosts } from "./terminalHostResolution";

/** Test-mode connection timeouts — a probe should fail fast, not wait out the
 * terminal's full keep-alive/auth window. */
const TEST_TCP_CONNECT_TIMEOUT_MS = 8000;
const TEST_AUTH_READY_TIMEOUT_MS = 15000;

/** Build the human-readable progress log line for one chain-progress event,
 * mirroring the terminal's per-hop "Connecting to … / TCP connected / Key
 * exchange complete / Authenticated / …" lines (with the `[hop/total]` prefix
 * for jump-host chains). */
export const formatConnectionTestProgressLog = (input: {
  hop: number;
  total: number;
  label: string;
  phase: string;
  error?: string;
}): string => {
  const { hop, total, label, phase, error } = input;
  const prefix = total > 1 ? `[${hop}/${total}] ` : "";
  switch (phase) {
    case "connecting":
      return `${prefix}Connecting to ${label}...`;
    case "tcp-connected":
      return `${prefix}${label} - TCP connected`;
    case "authenticating":
      return `${prefix}${label} - Key exchange complete`;
    case "auth-attempt":
      if (error?.endsWith("rejected")) return `${prefix}${label} - ✗ ${error}`;
      if (error === "all methods exhausted") return `${prefix}${label} - ✗ All authentication methods exhausted`;
      if (error === "waiting for user input..." || error === "user responded") return `${prefix}${label} - ${error}`;
      return `${prefix}${label} - Trying ${error ?? "authentication"}...`;
    case "authenticated":
      return `${prefix}${label} - Authenticated`;
    case "connected":
      return `${prefix}${label} - Connected`;
    case "forwarding":
      return `${prefix}${label} - Forwarding...`;
    case "shell":
      return `${prefix}Opening shell...`;
    case "error":
      return `${prefix}${label} - ${error ? `Error: ${error}` : "Error"}`;
    default:
      return `${prefix}${label} - ${phase}${error ? `: ${error}` : ""}`;
  }
};

export type HostConnectionTestSettings = Pick<
  TerminalSettings,
  "keepaliveInterval" | "keepaliveCountMax" | "verifyHostKeys"
>;

export type HostConnectionTestAuthOverride = {
  authMethod?: Host["authMethod"];
  username?: string;
  password?: string;
  keyId?: string;
  passphrase?: string;
};

export type BuildHostConnectionTestOptionsInput = {
  /** The (possibly unsaved) host draft to test. */
  host: Host;
  /** All vault hosts, used to resolve jump-host chain entries by id. */
  hosts: Host[];
  keys: SSHKey[];
  identities?: Identity[];
  knownHosts?: KnownHost[];
  groupConfigs?: GroupConfig[];
  proxyProfiles?: ProxyProfile[];
  terminalSettings?: HostConnectionTestSettings;
  sessionId: string;
  /** Boot generation for correlating host-key prompts with this attempt. */
  bootEpoch: number;
  /** Re-entered credentials after an undecryptable placeholder was detected. */
  authOverride?: HostConnectionTestAuthOverride | null;
};

export type HostConnectionTestPlan =
  | {
      ok: true;
      options: NetcattySSHOptions;
      /**
       * True when the primary credential is an undecryptable placeholder, so
       * the caller should prompt for re-entry (password/key) before dialing.
       */
      needsCredentialReentry: boolean;
    }
  | { ok: false; error: string };

const buildTestJumpHost = (
  chainHost: Host,
  keys: SSHKey[],
  identities: Identity[],
  settings: HostConnectionTestSettings,
): NetcattyJumpHost => {
  const jumpAuth = resolveHostAuth({ host: chainHost, keys, identities });
  const jumpKey = jumpAuth.key;
  const jumpAllowsLocalIdentityFallback = !jumpAuth.keyId;
  const jumpReferenceKeyPath = jumpAuth.authMethod === "password"
    ? undefined
    : jumpKey?.source === "reference"
      ? jumpKey.filePath
      : undefined;
  const jumpIdentityFilePaths = jumpAuth.authMethod === "password"
    ? undefined
    : jumpReferenceKeyPath
      ? [jumpReferenceKeyPath]
      : jumpAllowsLocalIdentityFallback
        ? chainHost.identityFilePaths
        : undefined;
  const hopKeepalive = resolveHostKeepalive(chainHost, settings);
  const hopConnectionTimeouts = resolveHostSshConnectionTimeouts(chainHost);

  return {
    hostname: chainHost.hostname,
    hostId: chainHost.id,
    port: chainHost.port || 22,
    username: jumpAuth.username || "root",
    authMethod: jumpAuth.authMethod,
    requiresMfa: !!chainHost.requiresMfa,
    password: sanitizeCredentialValue(jumpAuth.password),
    privateKey: jumpKey?.source === "reference" ? undefined : sanitizeCredentialValue(jumpKey?.privateKey),
    certificate: jumpKey?.certificate,
    passphrase: sanitizeCredentialValue(jumpAuth.passphrase || jumpKey?.passphrase),
    publicKey: jumpKey?.publicKey,
    keyId: jumpAuth.keyId,
    keySource: jumpKey?.source,
    label: chainHost.label,
    proxy: hasUsableProxyConfig(chainHost.proxyConfig)
      ? resolveProxyConfigAuth(chainHost.proxyConfig, identities)
      : undefined,
    identityFilePaths: jumpIdentityFilePaths,
    ...resolveBridgeSshAgentAuth(chainHost, jumpKey, jumpAuth.authMethod),
    keepaliveInterval: hopKeepalive.interval,
    keepaliveCountMax: hopKeepalive.countMax,
    sshTcpConnectTimeoutMs: hopConnectionTimeouts.tcpConnectTimeoutSeconds * 1000,
    sshAuthReadyTimeoutMs: hopConnectionTimeouts.authReadyTimeoutSeconds * 1000,
    verifyHostKeys: settings.verifyHostKeys,
    legacyAlgorithms: chainHost.legacyAlgorithms,
    skipEcdsaHostKey: chainHost.skipEcdsaHostKey,
    algorithmOverrides: chainHost.algorithms,
  };
};

/**
 * Build the SSH connection options for a host-editor "test connection".
 *
 * Faithfully reuses the terminal's resolution stack (effective host with group
 * defaults + materialized proxy profile, auth resolution, jump-host chain,
 * keepalive, timeouts, and algorithm settings) but omits the shell-only fields
 * (PTY, session log, X11, sudo autofill, startup command). The caller dials
 * through `netcatty:test-connection`, which authenticates and tears down
 * without opening a shell.
 */
export const buildHostConnectionTestPlan = (
  input: BuildHostConnectionTestOptionsInput,
): HostConnectionTestPlan => {
  const {
    host,
    hosts,
    keys,
    identities = [],
    knownHosts,
    groupConfigs = [],
    proxyProfiles = [],
    sessionId,
    bootEpoch,
    authOverride = null,
  } = input;
  const settings: HostConnectionTestSettings = {
    verifyHostKeys: true,
    keepaliveInterval: 30,
    keepaliveCountMax: 10,
    ...(input.terminalSettings ?? {}),
  };

  const effectiveHost = resolveEffectiveTerminalHost({
    host,
    groupConfigs,
    proxyProfiles,
  });

  const resolvedAuth = resolveHostAuth({
    host: effectiveHost,
    keys,
    identities,
    override: authOverride ?? null,
  });

  const chainHosts = resolveTerminalChainHosts({
    host: effectiveHost,
    hosts,
    groupConfigs,
    proxyProfiles,
  });
  const requestedChainIds = effectiveHost.hostChain?.hostIds ?? [];
  if (requestedChainIds.length > 0 && chainHosts.length !== requestedChainIds.length) {
    return {
      ok: false,
      error: "A configured jump host is missing. Open host settings and repair the jump host chain.",
    };
  }

  // A proxy whose saved credential cannot be decrypted cannot be dialed; fail
  // before opening the test dialog's progress rather than timing out mid-dial.
  if (hasUnreadableProxyCredential(effectiveHost.proxyConfig, identities)) {
    return {
      ok: false,
      error: "Proxy credentials cannot be decrypted on this device. Open host settings and re-enter the proxy password.",
    };
  }

  const key = resolvedAuth.key;
  const effectiveUsername = resolvedAuth.username || "root";
  const effectivePassword = sanitizeCredentialValue(resolvedAuth.password);
  const effectivePassphrase = sanitizeCredentialValue(resolvedAuth.passphrase);
  const hasEncryptedPrimaryPassword = isEncryptedCredentialPlaceholder(resolvedAuth.password);
  const hasEncryptedPrimaryKey = isEncryptedCredentialPlaceholder(key?.privateKey);

  // A connection test should exercise the specific credential the user
  // configured, not the full "auto" discovery (agent + every ~/.ssh key +
  // password + keyboard-interactive fallback). When the host resolved to
  // "auto" and a password is present without a selected key, pin it to
  // "password" so the bridge tries exactly one method.
  const authMethod: Host["authMethod"] =
    resolvedAuth.authMethod === "auto" && effectivePassword && !key
      ? "password"
      : resolvedAuth.authMethod;
  const allowsLocalIdentityFallback = !resolvedAuth.keyId;
  const targetReferenceKeyPath = key?.source === "reference" ? key.filePath : undefined;
  const targetIdentityFilePaths = authMethod === "password"
    ? undefined
    : targetReferenceKeyPath
      ? [targetReferenceKeyPath]
      : allowsLocalIdentityFallback
        ? effectiveHost.identityFilePaths
        : undefined;

  const agentAuth = resolveBridgeSshAgentAuth(effectiveHost, key, authMethod);
  const usesSystemAgent = agentAuth.useSshAgent === true;
  const hasKeyMaterial = usesSystemAgent || Boolean(
    (sanitizeCredentialValue(key?.privateKey) || targetIdentityFilePaths?.length)
    && (authMethod !== "password" || effectiveHost.useSshAgent === true),
  );
  const hasPassword = Boolean(effectivePassword);

  const needsCredentialReentry =
    (authMethod === "password" && hasEncryptedPrimaryPassword && !hasPassword)
    || (
      authMethod !== "password"
      && authMethod !== "auto"
      && hasEncryptedPrimaryKey
      && !hasKeyMaterial
      && !hasPassword
    );

  const keepalive = resolveHostKeepalive(effectiveHost, settings);
  const proxyConfig = hasUsableProxyConfig(effectiveHost.proxyConfig)
    ? resolveProxyConfigAuth(effectiveHost.proxyConfig, identities)
    : undefined;

  const options: NetcattySSHOptions = {
    sessionId,
    hostLabel: effectiveHost.label,
    hostname: effectiveHost.hostname,
    hostId: effectiveHost.id,
    username: effectiveUsername,
    authMethod,
    requiresMfa: !!effectiveHost.requiresMfa,
    port: effectiveHost.port || 22,
    password: effectivePassword,
    privateKey: key?.source === "reference" ? undefined : sanitizeCredentialValue(key?.privateKey),
    certificate: key?.certificate,
    publicKey: key?.publicKey,
    keyId: key?.id,
    keySource: key?.source,
    passphrase: key ? (effectivePassphrase || sanitizeCredentialValue(key.passphrase)) : undefined,
    legacyAlgorithms: effectiveHost.legacyAlgorithms,
    skipEcdsaHostKey: effectiveHost.skipEcdsaHostKey,
    algorithmOverrides: effectiveHost.algorithms,
    charset: effectiveHost.charset,
    proxy: proxyConfig,
    jumpHosts: chainHosts.length > 0
      ? chainHosts.map((chainHost) => buildTestJumpHost(chainHost, keys, identities, settings))
      : undefined,
    keepaliveInterval: keepalive.interval,
    keepaliveCountMax: keepalive.countMax,
    sshTcpConnectTimeoutMs: TEST_TCP_CONNECT_TIMEOUT_MS,
    sshAuthReadyTimeoutMs: TEST_AUTH_READY_TIMEOUT_MS,
    verifyHostKeys: settings.verifyHostKeys,
    bootEpoch,
    identityFilePaths: targetIdentityFilePaths,
    ...agentAuth,
    knownHosts,
  };

  return { ok: true, options, needsCredentialReentry };
};
