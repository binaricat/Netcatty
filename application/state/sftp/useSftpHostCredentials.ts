import { useCallback } from "react";
import type { Host, Identity, KnownHost, SSHKey, TerminalSettings } from "../../../domain/models";
import { isEncryptedCredentialPlaceholder, sanitizeCredentialValue } from "../../../domain/credentials";
import { resolveBridgeKeyAuth, resolveBridgeSshAgentAuth, resolveHostAuth } from "../../../domain/sshAuth";
import { resolveHostKeepalive } from "../../../domain/host";
import { resolveHostSshConnectionTimeouts } from "../../../domain/sshConnectionTimeouts";
import {
  findIncompleteProxyIdentityId,
  findMissingProxyIdentityId,
  formatIncompleteProxyIdentityMessage,
  formatMissingProxyIdentityMessage,
  hasUnreadableProxyCredential,
  hasUsableProxyConfig,
  resolveProxyConfigAuth,
} from "../../../domain/proxyProfiles";

// Fallback used when no global TerminalSettings are wired through (older
// call sites or tests). Matches DEFAULT_TERMINAL_SETTINGS so behavior is
// identical whether or not the caller passes settings.
const FALLBACK_TERMINAL_SETTINGS = {
  verifyHostKeys: true,
  keepaliveInterval: 30,
  keepaliveCountMax: 10,
};

interface UseSftpHostCredentialsParams {
  hosts: Host[];
  keys: SSHKey[];
  identities: Identity[];
  knownHosts?: KnownHost[];
  terminalSettings?: Pick<TerminalSettings, 'verifyHostKeys' | 'keepaliveInterval' | 'keepaliveCountMax'>;
}

export const buildSftpHostCredentials = ({
  host,
  hosts,
  keys,
  identities,
  knownHosts,
  terminalSettings,
}: UseSftpHostCredentialsParams & { host: Host }): NetcattySSHOptions => {
  const globalTerminalSettings = { ...FALLBACK_TERMINAL_SETTINGS, ...(terminalSettings ?? {}) };
  if (host.proxyProfileId && !host.proxyConfig) {
    throw new Error(`Saved proxy for host "${host.label || host.hostname}" is missing. Open host settings and select a valid proxy.`);
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
  let jumpHosts: NetcattyJumpHost[] | undefined;
  if (host.hostChain?.hostIds && host.hostChain.hostIds.length > 0) {
    jumpHosts = host.hostChain.hostIds.map((hostId) => {
      const jumpHost = hosts.find((candidate) => candidate.id === hostId);
      if (!jumpHost) {
        throw new Error(`Jump host "${hostId}" is missing. Open host settings and repair the jump host chain.`);
      }
      if (jumpHost.proxyProfileId && !jumpHost.proxyConfig) {
        throw new Error(`Saved proxy for jump host "${jumpHost.label || jumpHost.hostname}" is missing. Open host settings and select a valid proxy.`);
      }
      if (findMissingProxyIdentityId(jumpHost.proxyConfig, identities)) {
        throw new Error(formatMissingProxyIdentityMessage(jumpHost.label || jumpHost.hostname));
      }
      if (findIncompleteProxyIdentityId(jumpHost.proxyConfig, identities)) {
        throw new Error(formatIncompleteProxyIdentityMessage(jumpHost.label || jumpHost.hostname));
      }
      return jumpHost;
    }).map((jumpHost, index) => {
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
      const hasConfiguredJumpProxyEndpoint =
        index === 0 &&
        hasUsableProxyConfig(jumpHost.proxyConfig);
      if (
        hasConfiguredJumpProxyEndpoint &&
        hasUnreadableProxyCredential(jumpHost.proxyConfig, identities)
      ) {
        throw new Error(`Proxy credentials for jump host "${jumpHost.label || jumpHost.hostname}" cannot be decrypted on this device. Open host settings and re-enter the proxy password.`);
      }
      const hasUnreadableJumpCredential =
        isEncryptedCredentialPlaceholder(jumpAuth.password) ||
        isEncryptedCredentialPlaceholder(jumpKey?.privateKey) ||
        isEncryptedCredentialPlaceholder(jumpAuth.passphrase);
      if (
        (jumpAuth.authMethod === "password" && isEncryptedCredentialPlaceholder(jumpAuth.password) && !jumpPassword) ||
        (jumpAuth.authMethod !== "password" && jumpAuth.authMethod !== "auto" && hasUnreadableJumpCredential && !jumpPassword && !hasJumpKeyMaterial)
      ) {
        throw new Error(`Saved credentials for jump host "${jumpHost.label || jumpHost.hostname}" cannot be decrypted on this device. Open host settings and re-enter them.`);
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
    throw new Error("Proxy credentials cannot be decrypted on this device. Open host settings and re-enter the proxy password.");
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
    throw new Error("Saved credentials cannot be decrypted on this device. Open host settings and re-enter them.");
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
    privateKey: keyAuth.privateKey,
    certificate: key?.certificate,
    passphrase: keyAuth.passphrase,
    publicKey: key?.publicKey,
    keyId: resolved.keyId,
    keySource: key?.source,
    proxy: proxyConfig,
    jumpHosts: jumpHosts && jumpHosts.length > 0 ? jumpHosts : undefined,
    sudo: host.sftpSudo,
    fileProtocol: host.sftpFileProtocol || "auto",
    identityFilePaths: keyAuth.identityFilePaths,
    ...targetAgentAuth,
    keepaliveInterval: targetKeepalive.interval,
    keepaliveCountMax: targetKeepalive.countMax,
    sshTcpConnectTimeoutMs: targetConnectionTimeouts.tcpConnectTimeoutSeconds * 1000,
    sshAuthReadyTimeoutMs: targetConnectionTimeouts.authReadyTimeoutSeconds * 1000,
    knownHosts,
    verifyHostKeys: globalTerminalSettings.verifyHostKeys,
    // Algorithm settings — must reach the SFTP bridge or hosts that need
    // legacy mode / the ECDSA skip / advanced overrides would still hit
    // the original negotiation failure when opening their SFTP pane,
    // even though the terminal session works.
    legacyAlgorithms: host.legacyAlgorithms,
    skipEcdsaHostKey: host.skipEcdsaHostKey,
    algorithmOverrides: host.algorithms,
  };
};

export const useSftpHostCredentials = ({
  hosts,
  keys,
  identities,
  knownHosts,
  terminalSettings,
}: UseSftpHostCredentialsParams) =>
  useCallback(
    (host: Host): NetcattySSHOptions => buildSftpHostCredentials({ host, hosts, keys, identities, knownHosts, terminalSettings }),
    [hosts, identities, keys, knownHosts, terminalSettings],
  );
