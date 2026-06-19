import type { GroupConfig, Host, ProxyProfile, TerminalSession } from "./models";
import { applyGroupDefaults, resolveGroupDefaults } from "./groupConfig";
import { materializeHostProxyProfile } from "./proxyProfiles";

type LocalOs = Host["os"];

interface ResolveEffectiveHostOptions {
  host: Host;
  groupConfigs: GroupConfig[];
  proxyProfiles: ProxyProfile[];
  validProxyProfileIds?: ReadonlySet<string>;
}

interface ResolveTerminalSessionHostOptions {
  session: TerminalSession;
  hosts: Host[];
  groupConfigs: GroupConfig[];
  proxyProfiles: ProxyProfile[];
  localOs: LocalOs;
}

interface ResolveTerminalChainHostsOptions {
  host: Host | null | undefined;
  hosts: Host[];
  groupConfigs: GroupConfig[];
  proxyProfiles: ProxyProfile[];
  validProxyProfileIds?: ReadonlySet<string>;
}

export function resolveEffectiveTerminalHost({
  host,
  groupConfigs,
  proxyProfiles,
  validProxyProfileIds = new Set(proxyProfiles.map((profile) => profile.id)),
}: ResolveEffectiveHostOptions): Host {
  const groupDefaults = host.group
    ? resolveGroupDefaults(host.group, groupConfigs, { validProxyProfileIds })
    : {};
  return materializeHostProxyProfile(
    applyGroupDefaults(host, groupDefaults, { validProxyProfileIds }),
    proxyProfiles,
  );
}

function buildFallbackHostFromSession(
  session: TerminalSession,
  localOs: LocalOs,
): Host {
  const fallbackProtocol = session.protocol ?? "ssh";
  return {
    id: session.hostId,
    label: session.hostLabel || "Local Terminal",
    hostname: session.hostname || "localhost",
    username: session.username || "local",
    port: session.port ?? 22,
    os: fallbackProtocol === "local" ? localOs : "linux",
    group: "",
    tags: [],
    protocol: fallbackProtocol,
    moshEnabled: session.moshEnabled,
    etEnabled: session.etEnabled,
    charset: session.charset,
    serialConfig: session.serialConfig,
    localShell: session.localShell,
    localShellArgs: session.localShellArgs,
    localShellName: session.localShellName,
    localShellIcon: session.localShellIcon,
  };
}

export function resolveTerminalSessionHost({
  session,
  hosts,
  groupConfigs,
  proxyProfiles,
  localOs,
}: ResolveTerminalSessionHostOptions): Host {
  const vaultHost = hosts.find((host) => host.id === session.hostId);
  if (!vaultHost) return buildFallbackHostFromSession(session, localOs);

  const existingHost = resolveEffectiveTerminalHost({
    host: vaultHost,
    groupConfigs,
    proxyProfiles,
  });

  const protocol = session.protocol ?? existingHost.protocol;
  const port = session.port ?? existingHost.port;
  const moshEnabled = session.moshEnabled ?? existingHost.moshEnabled;
  const etEnabled = session.etEnabled ?? existingHost.etEnabled;

  if (
    protocol === existingHost.protocol &&
    port === existingHost.port &&
    moshEnabled === existingHost.moshEnabled &&
    etEnabled === existingHost.etEnabled
  ) {
    return existingHost;
  }

  return {
    ...existingHost,
    protocol,
    port,
    moshEnabled,
    etEnabled,
  };
}

export function resolveTerminalChainHosts({
  host,
  hosts,
  groupConfigs,
  proxyProfiles,
  validProxyProfileIds = new Set(proxyProfiles.map((profile) => profile.id)),
}: ResolveTerminalChainHostsOptions): Host[] {
  if (!host?.hostChain?.hostIds?.length) return [];
  const hostMap = new Map(hosts.map((candidate) => [candidate.id, candidate]));
  return host.hostChain.hostIds
    .map((hostId) => {
      const chainHost = hostMap.get(hostId);
      if (!chainHost) return undefined;
      return resolveEffectiveTerminalHost({
        host: chainHost,
        groupConfigs,
        proxyProfiles,
        validProxyProfileIds,
      });
    })
    .filter((value): value is Host => Boolean(value));
}
