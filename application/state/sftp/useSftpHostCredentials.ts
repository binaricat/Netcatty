import { useCallback } from "react";
import type { Host, Identity, SSHKey } from "../../../domain/models";
import {
  buildHostAuthPlan,
  buildJumpHostAuthPlans,
  resolveChainHostsForHost,
  resolveHostChainConnectionMode,
} from "../../../domain/authPolicy";

interface UseSftpHostCredentialsParams {
  hosts: Host[];
  keys: SSHKey[];
  identities: Identity[];
}

export const useSftpHostCredentials = ({
  hosts,
  keys,
  identities,
}: UseSftpHostCredentialsParams) =>
  useCallback(
    (host: Host): NetcattySSHOptions => {
      const resolved = buildHostAuthPlan({ host, keys, identities });

      const proxyConfig = host.proxyConfig
        ? {
            type: host.proxyConfig.type,
            host: host.proxyConfig.host,
            port: host.proxyConfig.port,
            username: host.proxyConfig.username,
            password: host.proxyConfig.password,
          }
        : undefined;

      const chainHosts = resolveChainHostsForHost(host, hosts);
      const jumpHosts = buildJumpHostAuthPlans({
        jumpHosts: chainHosts,
        keys,
        identities,
      });
      const jumpMode = resolveHostChainConnectionMode(host);

      return {
        hostname: host.hostname,
        username: resolved.username,
        authMethod: resolved.authMethod,
        port: host.port || 22,
        password: resolved.password,
        privateKey: resolved.privateKey,
        certificate: resolved.certificate,
        publicKey: resolved.publicKey,
        keyId: resolved.keyId,
        keySource: resolved.keySource,
        passphrase: resolved.passphrase,
        proxy: proxyConfig,
        jumpHosts: jumpHosts && jumpHosts.length > 0 ? jumpHosts : undefined,
        jumpMode: jumpHosts.length > 0 ? jumpMode : undefined,
        sudo: host.sftpSudo,
      };
    },
    [hosts, identities, keys],
  );
