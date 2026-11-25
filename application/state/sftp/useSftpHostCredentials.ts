import { useCallback } from "react";
import type { Host, Identity, KnownHost, SSHKey, TerminalSettings } from "../../../domain/models";
import { buildSshConnectionCredentials } from "../../../domain/sshConnectionCredentials";

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
  jumpHostsOverride,
}: UseSftpHostCredentialsParams & {
  host: Host;
  /**
   * Connect-time jump-host snapshots. When set, the chain resolves from these
   * pinned Host objects instead of the live `hosts` array, so leases opened
   * after a bastion edit keep connecting through the chain the pane's session
   * dialed — private hostnames can resolve differently per bastion.
   */
  jumpHostsOverride?: Host[];
}): NetcattySSHOptions => {
  const sshCredentials = buildSshConnectionCredentials({
    host,
    hosts,
    keys,
    identities,
    knownHosts,
    terminalSettings,
    jumpHostsOverride,
  });
  return {
    ...sshCredentials,
    sudo: host.sftpSudo,
    fileProtocol: host.sftpFileProtocol || "auto",
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
