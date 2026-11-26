import type { Host, PortForwardingRule } from '../models';
import type { TerminalSession } from '../../types';
import type { ListeningPortInfo } from './types';

export const DEFAULT_QUICK_FORWARD_BIND_ADDRESS = '127.0.0.1';

const WILDCARD_ADDRESSES = new Set(['', '*', '0.0.0.0', '::']);
const LOOPBACK_ADDRESSES = new Set(['127.0.0.1', 'localhost', '::1']);
const ACTIVE_STATUSES = new Set<PortForwardingRule['status']>(['active', 'connecting']);

function stripAddressDecoration(address: string): string {
  let normalized = address.trim();
  if (normalized.startsWith('[') && normalized.endsWith(']')) {
    normalized = normalized.slice(1, -1);
  }
  const zoneIndex = normalized.indexOf('%');
  if (zoneIndex >= 0) {
    normalized = normalized.slice(0, zoneIndex);
  }
  return normalized.trim();
}

export function normalizeEndpointHost(address: string | undefined): string {
  return stripAddressDecoration(String(address ?? '')).toLowerCase();
}

export function isWildcardAddress(address: string | undefined): boolean {
  return WILDCARD_ADDRESSES.has(normalizeEndpointHost(address));
}

export function isLoopbackAddress(address: string | undefined): boolean {
  return LOOPBACK_ADDRESSES.has(normalizeEndpointHost(address));
}

export function formatHostPort(host: string, port: number): string {
  const cleaned = stripAddressDecoration(host) || '*';
  if (cleaned.includes(':')) {
    return `[${cleaned}]:${port}`;
  }
  return `${cleaned}:${port}`;
}

/**
 * Format a copyable local address from a local bind address + port.
 * Wildcard binds (0.0.0.0 / :: / *) map to loopback so the copied endpoint can
 * be pasted directly into a browser or client.
 */
export function formatCopyableLocalEndpoint(bindAddress: string, localPort: number): string {
  const normalized = normalizeEndpointHost(bindAddress);
  if (normalized === '::') {
    return `[::1]:${localPort}`;
  }
  if (isWildcardAddress(normalized)) {
    return `127.0.0.1:${localPort}`;
  }
  return formatHostPort(bindAddress, localPort);
}

/**
 * Only connected remote SSH-capable sessions support SSH local port forwarding.
 * Local shells, Telnet, Serial, ET, and plugin transports do not use SSH forwardOut.
 */
export function canQuickForwardSession(
  host: Host | null | undefined,
  session: TerminalSession | null | undefined,
): boolean {
  if (!host || !session || session.status !== 'connected') return false;
  const protocol = host.protocol ?? session.protocol ?? 'ssh';
  if (protocol !== 'ssh' && protocol !== 'mosh') return false;
  return Boolean(host.hostname?.trim());
}

/**
 * SSH direct-tcpip forwarding supports TCP listening sockets with a valid port.
 */
export function isForwardableListeningPort(port: ListeningPortInfo): boolean {
  if (port.protocol !== 'tcp' && port.protocol !== 'tcp6') return false;
  return Number.isInteger(port.port) && port.port >= 1 && port.port <= 65535;
}

/**
 * Resolve the remote target host passed to SSH forwardOut for a listening port.
 * Wildcard listeners (* / 0.0.0.0 / ::) target 127.0.0.1; explicit interface
 * or IPv6 loopback binds (e.g. ::1, 10.0.0.5) keep their exact address.
 */
export function resolveForwardRemoteHost(port: ListeningPortInfo): string {
  const cleaned = stripAddressDecoration(port.address);
  if (isWildcardAddress(cleaned)) {
    return DEFAULT_QUICK_FORWARD_BIND_ADDRESS;
  }
  return cleaned;
}

export function isValidPortNumber(value: number): boolean {
  return Number.isInteger(value) && value >= 1 && value <= 65535;
}

export function normalizeQuickForwardBindAddress(value: string): string {
  const trimmed = stripAddressDecoration(value);
  return trimmed || DEFAULT_QUICK_FORWARD_BIND_ADDRESS;
}

export function isValidQuickForwardBindAddress(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) return true; // Empty falls back to 127.0.0.1
  if (/\s/.test(trimmed)) return false;
  // Reject control characters and obvious path/URL separators.
  if (/[/?#@\\]/.test(trimmed)) return false;
  return true;
}

function bindAddressesOverlap(a: string, b: string): boolean {
  const normA = normalizeEndpointHost(a || DEFAULT_QUICK_FORWARD_BIND_ADDRESS);
  const normB = normalizeEndpointHost(b || DEFAULT_QUICK_FORWARD_BIND_ADDRESS);
  if (isWildcardAddress(normA) || isWildcardAddress(normB)) return true;
  if (normA === normB) return true;
  if (
    (normA === 'localhost' && normB === '127.0.0.1')
    || (normA === '127.0.0.1' && normB === 'localhost')
  ) {
    return true;
  }
  return false;
}

/**
 * Find an active or connecting local/dynamic rule whose local bind + port
 * conflicts with the requested local endpoint.
 */
export function findLocalPortConflict(
  rules: readonly PortForwardingRule[],
  bindAddress: string,
  localPort: number,
  excludeRuleId?: string,
): PortForwardingRule | undefined {
  return rules.find((rule) => {
    if (excludeRuleId && rule.id === excludeRuleId) return false;
    if (!ACTIVE_STATUSES.has(rule.status)) return false;
    if (rule.type !== 'local' && rule.type !== 'dynamic') return false;
    if (rule.localPort !== localPort) return false;
    return bindAddressesOverlap(rule.bindAddress, bindAddress);
  });
}

export interface ListeningPortForwardMatches {
  activeRules: PortForwardingRule[];
  primaryActiveRule: PortForwardingRule | undefined;
  reusableInactiveRule: PortForwardingRule | undefined;
}

function remoteHostMatchesPort(ruleRemoteHost: string | undefined, port: ListeningPortInfo): boolean {
  const normRuleHost = normalizeEndpointHost(ruleRemoteHost);
  if (!normRuleHost) return false;
  const targetHost = normalizeEndpointHost(resolveForwardRemoteHost(port));
  if (normRuleHost === targetHost) return true;
  // Wildcard listeners accept loopback connections on any loopback alias.
  if (isWildcardAddress(port.address) && isLoopbackAddress(normRuleHost)) {
    return true;
  }
  // Treat 127.0.0.1 and localhost as equivalent for IPv4 loopback listeners.
  if (
    (targetHost === '127.0.0.1' && normRuleHost === 'localhost')
    || (targetHost === 'localhost' && normRuleHost === '127.0.0.1')
  ) {
    return true;
  }
  return false;
}

/**
 * Match existing local port-forwarding rules for the current host against a
 * remote listening port row.
 */
export function matchListeningPortForwardRules(
  port: ListeningPortInfo,
  hostId: string | undefined,
  rules: readonly PortForwardingRule[],
): ListeningPortForwardMatches {
  if (!hostId || !isForwardableListeningPort(port)) {
    return {
      activeRules: [],
      primaryActiveRule: undefined,
      reusableInactiveRule: undefined,
    };
  }

  const matching = rules.filter(
    (rule) =>
      rule.type === 'local'
      && rule.hostId === hostId
      && rule.remotePort === port.port
      && remoteHostMatchesPort(rule.remoteHost, port),
  );

  const activeRules = matching
    .filter((rule) => ACTIVE_STATUSES.has(rule.status))
    .sort((a, b) => {
      if (a.status === b.status) return a.localPort - b.localPort;
      return a.status === 'active' ? -1 : 1;
    });

  const reusableInactiveRule = matching.find((rule) => !ACTIVE_STATUSES.has(rule.status));

  return {
    activeRules,
    primaryActiveRule: activeRules[0],
    reusableInactiveRule,
  };
}

/**
 * Reuse an existing inactive/error rule only when every connection parameter
 * matches so we never silently mutate a user's saved rule.
 */
export function findExactReusableForwardRule(
  rules: readonly PortForwardingRule[],
  params: {
    hostId: string;
    remoteHost: string;
    remotePort: number;
    localPort: number;
    bindAddress: string;
  },
): PortForwardingRule | undefined {
  const normRemote = normalizeEndpointHost(params.remoteHost);
  const normBind = normalizeEndpointHost(params.bindAddress);
  return rules.find(
    (rule) =>
      rule.type === 'local'
      && !ACTIVE_STATUSES.has(rule.status)
      && rule.hostId === params.hostId
      && rule.remotePort === params.remotePort
      && rule.localPort === params.localPort
      && normalizeEndpointHost(rule.remoteHost) === normRemote
      && normalizeEndpointHost(rule.bindAddress) === normBind,
  );
}

/**
 * Pick a sensible default local port for quick forwarding:
 * - Avoid privileged ports (< 1024) by default (80 -> 8080, 443 -> 8443, others -> +10000).
 * - Avoid ports already used by existing local/dynamic rules.
 */
export function suggestQuickForwardLocalPort(
  remotePort: number,
  existingRules: readonly PortForwardingRule[],
): number {
  const usedLocalPorts = new Set<number>();
  for (const rule of existingRules) {
    if (rule.type === 'local' || rule.type === 'dynamic') {
      usedLocalPorts.add(rule.localPort);
    }
  }

  let candidate: number;
  if (remotePort === 80) {
    candidate = usedLocalPorts.has(8080) ? 10080 : 8080;
  } else if (remotePort === 443) {
    candidate = usedLocalPorts.has(8443) ? 10443 : 8443;
  } else if (remotePort < 1024) {
    candidate = remotePort + 10000;
  } else if (remotePort <= 65535) {
    candidate = remotePort;
  } else {
    candidate = 8080;
  }

  const start = candidate;
  while (usedLocalPorts.has(candidate)) {
    candidate = candidate >= 65535 ? 1024 : candidate + 1;
    if (candidate === start) break;
  }

  return candidate;
}

export function buildQuickForwardRuleLabel(
  hostLabel: string | undefined,
  port: ListeningPortInfo,
  localPort: number,
  remoteHost: string,
): string {
  const hostPrefix = hostLabel?.trim();
  const processName = port.processName?.trim();
  if (hostPrefix && processName) {
    return `${hostPrefix} · ${processName} (:${port.port})`;
  }
  if (hostPrefix) {
    return `${hostPrefix} :${port.port}`;
  }
  if (processName) {
    return `${processName} (:${port.port})`;
  }
  return `Local:${localPort} -> ${formatHostPort(remoteHost, port.port)}`;
}

export type QuickForwardValidationError =
  | { code: 'invalidPort' }
  | { code: 'invalidBindAddress' }
  | { code: 'localPortInUse'; conflictRule: PortForwardingRule };

export function validateQuickForwardInput(params: {
  localPortText: string;
  bindAddressText: string;
  rules: readonly PortForwardingRule[];
  excludeRuleId?: string;
}):
  | { ok: true; localPort: number; bindAddress: string }
  | { ok: false; error: QuickForwardValidationError } {
  const trimmedPort = params.localPortText.trim();
  if (!/^\d+$/.test(trimmedPort)) {
    return { ok: false, error: { code: 'invalidPort' } };
  }
  const localPort = Number(trimmedPort);
  if (!isValidPortNumber(localPort)) {
    return { ok: false, error: { code: 'invalidPort' } };
  }
  if (!isValidQuickForwardBindAddress(params.bindAddressText)) {
    return { ok: false, error: { code: 'invalidBindAddress' } };
  }
  const bindAddress = normalizeQuickForwardBindAddress(params.bindAddressText);
  const conflictRule = findLocalPortConflict(
    params.rules,
    bindAddress,
    localPort,
    params.excludeRuleId,
  );
  if (conflictRule) {
    return { ok: false, error: { code: 'localPortInUse', conflictRule } };
  }
  return { ok: true, localPort, bindAddress };
}
