import type { Host, HostProtocol } from './models';

type TerminalTransportHost = Pick<Host, 'protocol' | 'moshEnabled' | 'etEnabled'>
  & Partial<Pick<Host, 'hostname'>>;

/** Resolve the transport actually selected by the first-party session launcher. */
export function resolveEffectiveTerminalProtocol(host: TerminalTransportHost): HostProtocol {
  if (host.protocol && host.protocol !== 'ssh') return host.protocol;
  if (host.moshEnabled) return 'mosh';
  if (host.etEnabled) return 'et';
  if (host.hostname === 'localhost') return 'local';
  return host.protocol ?? 'ssh';
}

/**
 * Whether a vault host can serve as an SSH jump (ProxyJump) hop.
 *
 * Chain hops are dialed over SSH, so ssh-family transports (including mosh/et
 * hosts, which bootstrap over SSH) qualify, while local shells, serial links,
 * telnet and plugin transports must never be materialized as jump hosts.
 * Hosts without an explicit protocol are legacy SSH entries.
 */
export function canServeAsSshJumpHost(
  host: Pick<Host, 'protocol'>,
): boolean {
  const protocol = host.protocol;
  return protocol === undefined || protocol === 'ssh' || protocol === 'mosh' || protocol === 'et';
}
