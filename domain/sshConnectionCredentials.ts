import type {
  Host,
  HostAlgorithmOverrides,
  HostAuthMethod,
  HostTotpConfig,
  Identity,
  KnownHost,
  ProxyConfig,
  SSHKey,
  TerminalSettings,
} from "./models";
import { isEncryptedCredentialPlaceholder, sanitizeCredentialValue } from "./credentials";
import { resolveHostKeepalive } from "./host";
import {
  findIncompleteProxyIdentityId,
  findMissingProxyIdentityId,
  formatIncompleteProxyIdentityMessage,
  formatMissingProxyIdentityMessage,
  hasUnreadableProxyCredential,
  hasUsableProxyConfig,
  resolveProxyConfigAuth,
} from "./proxyProfiles";
import { resolveBridgeKeyAuth, resolveBridgeSshAgentAuth, resolveHostAuth } from "./sshAuth";
import { resolveHostSshConnectionTimeouts } from "./sshConnectionTimeouts";
import { connectionTotpFields } from "./totpConfig";

// Fallback matching DEFAULT_TERMINAL_SETTINGS so older call sites or tests
// that omit terminalSettings still receive the standard defaults.
const FALLBACK_TERMINAL_SETTINGS = {
  verifyHostKeys: true,
  keepaliveInterval: 30,
  keepaliveCountMax: 10,
};

export interface SshJumpHostCredentials {
  hostname: string;
  hostId?: string;
  port: number;
  username: string;
  authMethod?: HostAuthMethod;
  requiresMfa?: boolean;
  password?: string;
  totp?: HostTotpConfig;
  privateKey?: string;
  certificate?: string;
  passphrase?: string;
  publicKey?: string;
  keyId?: string;
  keySource?: SSHKey["source"];
  label?: string;
  proxy?: ProxyConfig;
  identityFilePaths?: string[];
  useSshAgent?: boolean;
  agentPublicKeys?: string[];
  identityAgent?: string;
  identitiesOnly?: boolean;
  addKeysToAgent?: string;
  useKeychain?: boolean;
  keepaliveInterval?: number;
  keepaliveCountMax?: number;
  sshTcpConnectTimeoutMs?: number;
  sshAuthReadyTimeoutMs?: number;
  verifyHostKeys?: boolean;
  legacyAlgorithms?: boolean;
  skipEcdsaHostKey?: boolean;
  algorithmOverrides?: HostAlgorithmOverrides;
}

export interface SshConnectionCredentials {
  hostname: string;
  hostId?: string;
  port: number;
  username: string;
  authMethod?: HostAuthMethod;
  requiresMfa?: boolean;
  password?: string;
  totp?: HostTotpConfig;
  privateKey?: string;
  certificate?: string;
  passphrase?: string;
  publicKey?: string;
  keyId?: string;
  keySource?: SSHKey["source"];
  proxy?: ProxyConfig;
  jumpHosts?: SshJumpHostCredentials[];
  identityFilePaths?: string[];
  useSshAgent?: boolean;
  agentPublicKeys?: string[];
  identityAgent?: string;
  identitiesOnly?: boolean;
  addKeysToAgent?: string;
  useKeychain?: boolean;
  keepaliveInterval?: number;
  keepaliveCountMax?: number;
  sshTcpConnectTimeoutMs?: number;
  sshAuthReadyTimeoutMs?: number;
  knownHosts?: KnownHost[];
  verifyHostKeys?: boolean;
  legacyAlgorithms?: boolean;
  skipEcdsaHostKey?: boolean;
  algorithmOverrides?: HostAlgorithmOverrides;
}

export interface BuildSshConnectionCredentialsParams {
  host: Host;
  hosts: Host[];
  keys: SSHKey[];
  identities: Identity[];
  knownHosts?: KnownHost[];
  terminalSettings?: Pick<TerminalSettings, "verifyHostKeys" | "keepaliveInterval" | "keepaliveCountMax">;
  /**
   * Optional connect-time jump-host snapshots. When non-empty, the chain
   * resolves from these pinned Host objects instead of the live `hosts` array.
   */
  jumpHostsOverride?: Host[];
  /**
   * Optional formatter for missing jump-host chain IDs so callers can keep
   * their user-facing error phrasing without duplicating resolution logic.
   */
  formatMissingJumpHostsError?: (missingIds: string[]) => string;
}

const defaultMissingJumpHostsError = (missingIds: string[]): string =>
  `Jump host "${missingIds[0]}" is missing. Open host settings and repair the jump host chain.`;

export const buildSshConnectionCredentials = ({
  host,
  hosts,
  keys,
  identities,
  knownHosts,
  terminalSettings,
  jumpHostsOverride,
  formatMissingJumpHostsError = defaultMissingJumpHostsError,
}: BuildSshConnectionCredentialsParams): SshConnectionCredentials => {
  const globalTerminalSettings = { ...FALLBACK_TERMINAL_SETTINGS, ...(terminalSettings ?? {}) };

  if (host.proxyProfileId && !host.proxyConfig) {
    throw new Error(
      `Saved proxy for host "${host.label || host.hostname}" is missing. Open host settings and select a valid proxy.`,
    );
  }
  if (findMissingProxyIdentityId(host.proxyConfig, identities)) {
    throw new Error(formatMissingProxyIdentityMessage(host.label || host.hostname));
  }
  if (findIncompleteProxyIdentityId(host.proxyConfig, identities)) {
    throw new Error(formatIncompleteProxyIdentityMessage(host.label || host.hostname));
  }

  const resolved = resolveHostAuth({ host, keys, identities });
  const key = resolved.key || null;
  const proxyConfig = host.proxyConfig
    ? resolveProxyConfigAuth(host.proxyConfig, identities)
    : undefined;

  let chainHosts: Host[] | null = null;
  if (jumpHostsOverride && jumpHostsOverride.length > 0) {
    chainHosts = jumpHostsOverride;
  } else if (host.hostChain?.hostIds && host.hostChain.hostIds.length > 0) {
    const resolvedJumpHosts = host.hostChain.hostIds.map((hostId) =>
      hosts.find((candidate) => candidate.id === hostId),
    );
    const missingJumpHostIds = host.hostChain.hostIds.filter((_, index) => !resolvedJumpHosts[index]);
    if (missingJumpHostIds.length > 0) {
      throw new Error(formatMissingJumpHostsError(missingJumpHostIds));
    }
    chainHosts = resolvedJumpHosts.filter((jumpHost): jumpHost is Host => Boolean(jumpHost));
  }

  let jumpHosts: SshJumpHostCredentials[] | undefined;
  if (chainHosts) {
    jumpHosts = chainHosts.map((jumpHost, index) => {
      if (jumpHost.proxyProfileId && !jumpHost.proxyConfig) {
        throw new Error(
          `Saved proxy for jump host "${jumpHost.label || jumpHost.hostname}" is missing. Open host settings and select a valid proxy.`,
        );
      }
      if (findMissingProxyIdentityId(jumpHost.proxyConfig, identities)) {
        throw new Error(formatMissingProxyIdentityMessage(jumpHost.label || jumpHost.hostname));
      }
      if (findIncompleteProxyIdentityId(jumpHost.proxyConfig, identities)) {
        throw new Error(formatIncompleteProxyIdentityMessage(jumpHost.label || jumpHost.hostname));
      }
      const hasConfiguredJumpProxyEndpoint =
        index === 0 &&
        hasUsableProxyConfig(jumpHost.proxyConfig);
      if (
        hasConfiguredJumpProxyEndpoint &&
        hasUnreadableProxyCredential(jumpHost.proxyConfig, identities)
      ) {
        throw new Error(
          `Proxy credentials for jump host "${jumpHost.label || jumpHost.hostname}" cannot be decrypted on this device. Open host settings and re-enter the proxy password.`,
        );
      }

      const jumpAuth = resolveHostAuth({
        host: jumpHost,
        keys,
        identities,
      });
      const jumpKey = jumpAuth.key;
      const jumpPassword = sanitizeCredentialValue(jumpAuth.password);
      const jumpKeyAuth = resolveBridgeKeyAuth({
        key: jumpKey,
        fallbackIdentityFilePaths: jumpAuth.authMethod === "password" || jumpAuth.keyId
          ? undefined
          : jumpHost.identityFilePaths,
        passphrase: jumpAuth.passphrase,
      });
      const jumpAgentAuth = resolveBridgeSshAgentAuth(jumpHost, jumpKey, jumpAuth.authMethod);
      const hasJumpKeyMaterial = Boolean(
        jumpAgentAuth.useSshAgent || jumpKeyAuth.privateKey || jumpKeyAuth.identityFilePaths?.length,
      );
      const hasUnreadableJumpCredential =
        isEncryptedCredentialPlaceholder(jumpAuth.password) ||
        isEncryptedCredentialPlaceholder(jumpKey?.privateKey) ||
        isEncryptedCredentialPlaceholder(jumpAuth.passphrase);
      if (
        (jumpAuth.authMethod === "password" && isEncryptedCredentialPlaceholder(jumpAuth.password) && !jumpPassword) ||
        (jumpAuth.authMethod !== "password" && jumpAuth.authMethod !== "auto" && hasUnreadableJumpCredential && !jumpPassword && !hasJumpKeyMaterial)
      ) {
        throw new Error(
          `Saved credentials for jump host "${jumpHost.label || jumpHost.hostname}" cannot be decrypted on this device. Open host settings and re-enter them.`,
        );
      }

      const hopKeepalive = resolveHostKeepalive(jumpHost, globalTerminalSettings);
      const hopConnectionTimeouts = resolveHostSshConnectionTimeouts(jumpHost);
      return {
        hostname: jumpHost.hostname,
        hostId: jumpHost.id,
        port: jumpHost.port || 22,
        username: jumpAuth.username || "root",
        authMethod: jumpAuth.authMethod,
        requiresMfa: !!jumpHost.requiresMfa,
        password: jumpPassword,
        ...connectionTotpFields(jumpHost),
        privateKey: jumpKeyAuth.privateKey,
        certificate: jumpKey?.certificate,
        passphrase: jumpKeyAuth.passphrase,
        publicKey: jumpKey?.publicKey,
        keyId: jumpAuth.keyId,
        keySource: jumpKey?.source,
        label: jumpHost.label,
        proxy: hasUsableProxyConfig(jumpHost.proxyConfig)
          ? resolveProxyConfigAuth(jumpHost.proxyConfig, identities)
          : undefined,
        identityFilePaths: jumpKeyAuth.identityFilePaths,
        ...jumpAgentAuth,
        keepaliveInterval: hopKeepalive.interval,
        keepaliveCountMax: hopKeepalive.countMax,
        sshTcpConnectTimeoutMs: hopConnectionTimeouts.tcpConnectTimeoutSeconds * 1000,
        sshAuthReadyTimeoutMs: hopConnectionTimeouts.authReadyTimeoutSeconds * 1000,
        verifyHostKeys: globalTerminalSettings.verifyHostKeys,
        legacyAlgorithms: jumpHost.legacyAlgorithms,
        skipEcdsaHostKey: jumpHost.skipEcdsaHostKey,
        algorithmOverrides: jumpHost.algorithms,
      };
    });
  }

  const usesTargetProxyForFirstHop = !!proxyConfig && !jumpHosts?.[0]?.proxy;
  if (usesTargetProxyForFirstHop && hasUnreadableProxyCredential(host.proxyConfig, identities)) {
    throw new Error(
      "Proxy credentials cannot be decrypted on this device. Open host settings and re-enter the proxy password.",
    );
  }

  const keyAuth = resolveBridgeKeyAuth({
    key,
    fallbackIdentityFilePaths: resolved.authMethod === "password" || resolved.keyId
      ? undefined
      : host.identityFilePaths,
    passphrase: resolved.passphrase,
  });
  const targetAgentAuth = resolveBridgeSshAgentAuth(host, key, resolved.authMethod);
  const password = sanitizeCredentialValue(resolved.password);
  const hasKeyMaterial = Boolean(
    targetAgentAuth.useSshAgent || keyAuth.privateKey || keyAuth.identityFilePaths?.length,
  );
  const hasUnreadableCredential =
    isEncryptedCredentialPlaceholder(resolved.password) ||
    isEncryptedCredentialPlaceholder(key?.privateKey) ||
    isEncryptedCredentialPlaceholder(resolved.passphrase);
  if (
    (resolved.authMethod === "password" && isEncryptedCredentialPlaceholder(resolved.password) && !password) ||
    (resolved.authMethod !== "password" && resolved.authMethod !== "auto" && hasUnreadableCredential && !password && !hasKeyMaterial)
  ) {
    throw new Error(
      "Saved credentials cannot be decrypted on this device. Open host settings and re-enter them.",
    );
  }

  const targetKeepalive = resolveHostKeepalive(host, globalTerminalSettings);
  const targetConnectionTimeouts = resolveHostSshConnectionTimeouts(host);
  return {
    hostname: host.hostname,
    hostId: host.id,
    username: resolved.username,
    authMethod: resolved.authMethod,
    requiresMfa: !!host.requiresMfa,
    port: host.port || 22,
    password,
    ...connectionTotpFields(host),
    privateKey: keyAuth.privateKey,
    certificate: key?.certificate,
    passphrase: keyAuth.passphrase,
    publicKey: key?.publicKey,
    keyId: resolved.keyId,
    keySource: key?.source,
    proxy: proxyConfig,
    jumpHosts: jumpHosts && jumpHosts.length > 0 ? jumpHosts : undefined,
    identityFilePaths: keyAuth.identityFilePaths,
    ...targetAgentAuth,
    keepaliveInterval: targetKeepalive.interval,
    keepaliveCountMax: targetKeepalive.countMax,
    sshTcpConnectTimeoutMs: targetConnectionTimeouts.tcpConnectTimeoutSeconds * 1000,
    sshAuthReadyTimeoutMs: targetConnectionTimeouts.authReadyTimeoutSeconds * 1000,
    knownHosts,
    verifyHostKeys: globalTerminalSettings.verifyHostKeys,
    legacyAlgorithms: host.legacyAlgorithms,
    skipEcdsaHostKey: host.skipEcdsaHostKey,
    algorithmOverrides: host.algorithms,
  };
};
