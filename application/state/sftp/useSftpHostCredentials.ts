import { useCallback } from "react";
import type { Host, Identity, SSHKey, TerminalSettings } from "../../../domain/models";
import { isEncryptedCredentialPlaceholder, sanitizeCredentialValue } from "../../../domain/credentials";
import { resolveBridgeKeyAuth, resolveHostAuth } from "../../../domain/sshAuth";
import { resolveHostKeepalive } from "../../../domain/host";

// Fallback used when no global TerminalSettings are wired through (older
// call sites or tests). Matches DEFAULT_TERMINAL_SETTINGS so behavior is
// identical whether or not the caller passes settings.
const FALLBACK_KEEPALIVE = { keepaliveInterval: 30, keepaliveCountMax: 10 };

interface UseSftpHostCredentialsParams {
  hosts: Host[];
  keys: SSHKey[];
  identities: Identity[];
  terminalSettings?: Pick<TerminalSettings, 'keepaliveInterval' | 'keepaliveCountMax'>;
}

export const buildSftpHostCredentials = ({
  host,
  hosts,
  keys,
  identities,
  terminalSettings,
}: UseSftpHostCredentialsParams & { host: Host }): NetcattySSHOptions => {
  const globalKeepalive = terminalSettings ?? FALLBACK_KEEPALIVE;
  if (host.proxyProfileId && !host.proxyConfig) {
    throw new Error(`Saved proxy for host "${host.label || host.hostname}" is missing. Open host settings and select a valid proxy.`);
  }

  const resolved = resolveHostAuth({ host, keys, identities });
  const key = resolved.key || null;

  const proxyConfig = host.proxyConfig
    ? {
      type: host.proxyConfig.type,
      host: host.proxyConfig.host,
      port: host.proxyConfig.port,
      username: host.proxyConfig.username,
      password: sanitizeCredentialValue(host.proxyConfig.password),
    }
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
      const hasJumpKeyMaterial = Boolean(jumpKeyAuth.privateKey || jumpKeyAuth.identityFilePaths?.length);
      const hasConfiguredJumpProxyEndpoint =
        index === 0 &&
        !!(jumpHost.proxyConfig?.host && jumpHost.proxyConfig?.port);
      if (
        hasConfiguredJumpProxyEndpoint &&
        jumpHost.proxyConfig?.username &&
        isEncryptedCredentialPlaceholder(jumpHost.proxyConfig.password) &&
        !sanitizeCredentialValue(jumpHost.proxyConfig.password)
      ) {
        throw new Error(`Proxy credentials for jump host "${jumpHost.label || jumpHost.hostname}" cannot be decrypted on this device. Open host settings and re-enter the proxy password.`);
      }
      const hasUnreadableJumpCredential =
        isEncryptedCredentialPlaceholder(jumpAuth.password) ||
        isEncryptedCredentialPlaceholder(jumpKey?.privateKey) ||
        isEncryptedCredentialPlaceholder(jumpAuth.passphrase);
      if (
        (jumpAuth.authMethod === "password" && isEncryptedCredentialPlaceholder(jumpAuth.password) && !jumpPassword) ||
        (jumpAuth.authMethod !== "password" && hasUnreadableJumpCredential && !jumpPassword && !hasJumpKeyMaterial)
      ) {
        throw new Error(`Saved credentials for jump host "${jumpHost.label || jumpHost.hostname}" cannot be decrypted on this device. Open host settings and re-enter them.`);
      }
      const hopKeepalive = resolveHostKeepalive(jumpHost, globalKeepalive);
      return {
        hostname: jumpHost.hostname,
        port: jumpHost.port || 22,
        username: jumpAuth.username || "root",
        password: jumpPassword,
        privateKey: jumpKeyAuth.privateKey,
        certificate: jumpKey?.certificate,
        passphrase: jumpKeyAuth.passphrase,
        publicKey: jumpKey?.publicKey,
        keyId: jumpAuth.keyId,
        keySource: jumpKey?.source,
        label: jumpHost.label,
        proxy: jumpHost.proxyConfig?.host && jumpHost.proxyConfig?.port
          ? {
            type: jumpHost.proxyConfig.type,
            host: jumpHost.proxyConfig.host,
            port: jumpHost.proxyConfig.port,
            username: jumpHost.proxyConfig.username,
            password: sanitizeCredentialValue(jumpHost.proxyConfig.password),
          }
          : undefined,
        identityFilePaths: jumpKeyAuth.identityFilePaths,
        keepaliveInterval: hopKeepalive.interval,
        keepaliveCountMax: hopKeepalive.countMax,
      };
    });
  }
  const usesTargetProxyForFirstHop = !!proxyConfig && !jumpHosts?.[0]?.proxy;
  if (usesTargetProxyForFirstHop && host.proxyConfig?.username && isEncryptedCredentialPlaceholder(host.proxyConfig.password) && !proxyConfig?.password) {
    throw new Error("Proxy credentials cannot be decrypted on this device. Open host settings and re-enter the proxy password.");
  }

  const keyAuth = resolveBridgeKeyAuth({
    key,
    fallbackIdentityFilePaths: resolved.authMethod === "password" || resolved.keyId
      ? undefined
      : host.identityFilePaths,
    passphrase: resolved.passphrase,
  });
  const password = sanitizeCredentialValue(resolved.password);
  const hasKeyMaterial = Boolean(keyAuth.privateKey || keyAuth.identityFilePaths?.length);
  const hasUnreadableCredential =
    isEncryptedCredentialPlaceholder(resolved.password) ||
    isEncryptedCredentialPlaceholder(key?.privateKey) ||
    isEncryptedCredentialPlaceholder(resolved.passphrase);
  if (
    (resolved.authMethod === "password" && isEncryptedCredentialPlaceholder(resolved.password) && !password) ||
    (resolved.authMethod !== "password" && hasUnreadableCredential && !password && !hasKeyMaterial)
  ) {
    throw new Error("Saved credentials cannot be decrypted on this device. Open host settings and re-enter them.");
  }

  const targetKeepalive = resolveHostKeepalive(host, globalKeepalive);
  return {
    hostname: host.hostname,
    username: resolved.username,
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
    identityFilePaths: keyAuth.identityFilePaths,
    keepaliveInterval: targetKeepalive.interval,
    keepaliveCountMax: targetKeepalive.countMax,
  };
};

export const useSftpHostCredentials = ({
  hosts,
  keys,
  identities,
  terminalSettings,
}: UseSftpHostCredentialsParams) =>
  useCallback(
    (host: Host): NetcattySSHOptions => buildSftpHostCredentials({ host, hosts, keys, identities, terminalSettings }),
    [hosts, identities, keys, terminalSettings],
  );
