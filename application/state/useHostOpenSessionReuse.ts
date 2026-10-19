import { useCallback, useLayoutEffect, useRef } from 'react';
import type { Host, Identity, SSHKey, TerminalSession } from '../../domain/models';
import { findReusableHostSession } from '../../domain/hostOpenSession';
import { resolveTelnetPassword, resolveTelnetPort, resolveTelnetUsername } from '../../domain/host';
import { isEncryptedCredentialPlaceholder, sanitizeCredentialValue } from '../../domain/credentials';
import { resolveEffectiveTerminalProtocol } from '../../domain/terminalProtocol';
import { findIncompleteProxyIdentityId, findMissingProxyIdentityId, hasUsableProxyConfig } from '../../domain/proxyProfiles';
import { buildSftpHostCredentials } from './sftp/useSftpHostCredentials';
import { buildTransferPoolKey } from './sftp/transferConnectionPool';
import { createHostTerminalSession } from './sessionFactories';

type HostOpenSessionReuseInput = {
  sessions: TerminalSession[];
  hosts: Host[];
  keys: SSHKey[];
  identities: Identity[];
  resolveEffectiveHost: (host: Host) => Host;
};

type OpeningConnection = { localHost: Host } | { key: Promise<string | undefined> };

/** Retain the opening connection identity, never credentials in session storage. */
export function useHostOpenSessionReuse({ sessions, hosts, keys, identities, resolveEffectiveHost }: HostOpenSessionReuseInput) {
  const openingKeys = useRef(new Map<string, OpeningConnection>());
  const connectionKey = useCallback((host: Host) => {
    const protocol = resolveEffectiveTerminalProtocol(host);
    if (protocol === 'local') {
      const options = {
        hostname: host.hostname,
        username: '',
        localShell: host.localShell || undefined,
        // The renderer starter omits both absent and empty args so the
        // backend chooses its discovered/login defaults for either form.
        localShellArgs: host.localShellArgs?.length ? host.localShellArgs : undefined,
        localStartDir: host.localStartDir || '~',
      };
      return buildTransferPoolKey({ hostname: host.hostname, hostId: host.id, protocol, connectionOptions: options });
    }
    if (protocol === 'telnet') {
      // The actual Telnet starter rejects these settings before connecting.
      if ((host.proxyProfileId && !host.proxyConfig)
        || findMissingProxyIdentityId(host.proxyConfig, identities)
        || findIncompleteProxyIdentityId(host.proxyConfig, identities)
        || hasUsableProxyConfig(host.proxyConfig)) {
        throw new Error('Telnet proxy configuration cannot be used');
      }
      // Match the actual Telnet starter, including explicit empty overrides.
      const identity = host.telnetIdentityId ? identities.find((item) => item.id === host.telnetIdentityId) : undefined;
      if (host.telnetIdentityId && (!identity?.username?.trim() || identity.password === undefined)) {
        throw new Error('Telnet identity is missing or incomplete');
      }
      const rawPassword = identity ? identity.password : resolveTelnetPassword(host);
      if (isEncryptedCredentialPlaceholder(rawPassword)) throw new Error('Telnet credentials are unavailable');
      const options = {
        hostname: host.hostname,
        port: resolveTelnetPort(host),
        username: identity ? identity.username?.trim() : resolveTelnetUsername(host),
        password: sanitizeCredentialValue(rawPassword),
      };
      return buildTransferPoolKey({ ...options, hostId: host.id, protocol, connectionOptions: options });
    }
    // Reuse the existing credential/chain expansion and transport identity
    // comparison. Presentation names and SFTP-only choices do not change a
    // terminal's destination or login.
    if (protocol === 'serial' && isEncryptedCredentialPlaceholder(host.password)) throw new Error('Serial credentials are unavailable');
    const options = buildSftpHostCredentials({
      host, hosts: hosts.map(resolveEffectiveHost), keys, identities,
    });
    delete options.sudo;
    delete options.fileProtocol;
    for (const hop of options.jumpHosts ?? []) delete hop.label;
    const connectionOptions = {
      ...options,
      protocol,
      moshEnabled: host.moshEnabled,
      moshServerPath: host.moshServerPath,
      etEnabled: host.etEnabled,
      etPort: host.etPort,
      etJumpPorts: protocol === 'et'
        ? host.hostChain?.hostIds.map((id) => hosts.find((item) => item.id === id)).map((hop) => hop && (resolveEffectiveHost(hop).etPort ?? 2022))
        : undefined,
      pluginConnection: host.pluginConnection,
      serialConfig: protocol === 'serial' ? createHostTerminalSession('', host).serialConfig : undefined,
      serialLogin: protocol === 'serial' ? { username: host.username?.trim(), password: sanitizeCredentialValue(host.password) } : undefined,
      agentForwarding: host.agentForwarding,
      x11Forwarding: host.x11Forwarding,
    };
    return buildTransferPoolKey({ ...options, protocol: connectionOptions.protocol, connectionOptions });
  }, [hosts, keys, identities, resolveEffectiveHost]);

  useLayoutEffect(() => {
    const liveIds = new Set(sessions.map((session) => session.id));
    for (const id of openingKeys.current.keys()) {
      if (!liveIds.has(id)) openingKeys.current.delete(id);
    }
    for (const session of sessions) {
      if (openingKeys.current.has(session.id) || session.restoreState) continue;
      const host = hosts.find((candidate) => candidate.id === session.hostId);
      if (!host) continue;
      try {
        const effectiveHost = resolveEffectiveHost(host);
        const openingHost = {
          ...effectiveHost,
          hostname: session.hostname,
          username: session.protocol === 'serial' ? resolveEffectiveHost(host).username : session.username,
          port: session.port ?? host.port,
          protocol: session.protocol ?? host.protocol,
          moshEnabled: session.moshEnabled ?? host.moshEnabled,
          etEnabled: session.etEnabled ?? host.etEnabled,
          serialConfig: session.serialConfig ?? host.serialConfig,
          pluginConnection: session.pluginConnection ?? host.pluginConnection,
          localShell: session.localShell ?? effectiveHost.localShell,
          localShellArgs: session.localShellArgs ?? effectiveHost.localShellArgs,
          localStartDir: session.localStartDir ?? effectiveHost.localStartDir,
        };
        // Local IDs may only resolve after renderer discovery completes. Keep
        // the opening settings so that later discovery can identify the same
        // executable without replacing them with edited vault/global settings.
        openingKeys.current.set(session.id, resolveEffectiveTerminalProtocol(openingHost) === 'local'
          ? { localHost: openingHost }
          : { key: connectionKey(openingHost).catch(() => undefined) });
      } catch {
        openingKeys.current.set(session.id, { key: Promise.resolve(undefined) });
      }
    }
  }, [sessions, hosts, connectionKey, resolveEffectiveHost]);

  return useCallback(async (hostId: string) => {
    const host = hosts.find((candidate) => candidate.id === hostId);
    if (!host) return undefined;
    try {
      const requestedKey = await connectionKey(resolveEffectiveHost(host));
      const matches = await Promise.all(sessions.map(async (session) => {
        if (session.hostId !== hostId) return undefined;
        const opening = openingKeys.current.get(session.id);
        const openingKey = opening && ('localHost' in opening
          // An explicit empty selector means backend default, not today's
          // global setting. Nonempty captured IDs can safely resolve now.
          ? connectionKey(opening.localHost.localShell ? resolveEffectiveHost(opening.localHost) : opening.localHost)
          : opening.key);
        return await openingKey === requestedKey ? session : undefined;
      }));
      return findReusableHostSession(matches.filter((session) => session !== undefined), hostId);
    } catch {
      // An unresolved/changed credential must never select an old transport.
      return undefined;
    }
  }, [hosts, sessions, connectionKey, resolveEffectiveHost]);
}
