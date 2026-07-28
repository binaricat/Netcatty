import { classifyDistroId } from '../../domain/host';
import type { PortForwardingRule } from '../../domain/models';
import type { Host, TerminalSession } from '../../types';

export type AITerminalSessionInfo = {
  sessionId: string;
  hostId: string;
  hostname: string;
  label: string;
  os?: string;
  username?: string;
  protocol?: string;
  shellType?: string;
  deviceType?: string;
  connected: boolean;
  hostChain?: Array<{ hostId: string; label?: string; hostname?: string }>;
  activePortForwards?: Array<{
    ruleId: string;
    label?: string;
    type?: string;
    localPort?: number;
    status?: string;
  }>;
};

function summarizeHostChain(
  host: Host | undefined,
  allHosts: Host[],
): AITerminalSessionInfo['hostChain'] | undefined {
  if (!host?.hostChain?.hostIds?.length) return undefined;
  return host.hostChain.hostIds.map((hostId) => {
    const jumpHost = allHosts.find((entry) => entry.id === hostId);
    return {
      hostId,
      label: jumpHost?.label,
      hostname: jumpHost?.hostname,
    };
  });
}

export const buildAITerminalSessionInfo = (
  session: TerminalSession | undefined,
  host: Host | undefined,
  localOs: 'linux' | 'macos' | 'windows',
  options?: {
    allHosts?: Host[];
    portForwardingRules?: PortForwardingRule[];
  },
): AITerminalSessionInfo => {
  const protocol = session?.protocol || host?.protocol;
  const isLocalSession = protocol === 'local' || session?.hostId?.startsWith('local-');
  const allHosts = options?.allHosts ?? (host ? [host] : []);
  const hostChain = summarizeHostChain(host, allHosts);
  const activePortForwards = host?.id && options?.portForwardingRules
    ? options.portForwardingRules
      .filter((rule) => rule.hostId === host.id && (rule.status === 'active' || rule.status === 'connecting'))
      .map((rule) => ({
        ruleId: rule.id,
        label: rule.label,
        type: rule.type,
        localPort: rule.localPort,
        status: rule.status,
      }))
    : undefined;
  // Mosh / ET sessions always run over a shell-backed PTY and cannot reach a
  // vendor CLI, so network device mode never applies to them.
  const isMoshOrEt = Boolean(
    session?.moshEnabled || host?.moshEnabled || session?.etEnabled || host?.etEnabled,
  );
  // Report 'network' when the host is explicitly a network device OR when the
  // detected distro/vendor classifies as one (Huawei VRP, Cisco IOS, ...). This
  // mirrors the terminal's own gating (Terminal.tsx / systemTarget.ts) so AI
  // exec skips shell wrapping (routing to the raw-PTY path) and the system
  // prompt gets vendor-CLI guidance even before the user manually flips
  // Network Device Mode (#2367).
  const isNetworkDevice = host?.deviceType === 'network'
    || classifyDistroId(host?.distro) === 'network-device';
  const deviceType = isMoshOrEt
    ? undefined
    : (isNetworkDevice ? 'network' : host?.deviceType);
  return {
    sessionId: session?.id || '',
    hostId: session?.hostId || '',
    hostname: host?.hostname || session?.hostname || '',
    label: host?.label || session?.hostLabel || '',
    os: host?.os || (isLocalSession ? localOs : undefined),
    username: host?.username || session?.username,
    protocol,
    shellType: session?.shellType && session.shellType !== 'unknown' ? session.shellType : undefined,
    deviceType,
    connected: session?.status === 'connected',
    ...(hostChain?.length ? { hostChain } : {}),
    ...(activePortForwards?.length ? { activePortForwards } : {}),
  };
};
