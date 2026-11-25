import {
  DEFAULT_SSH_AUTH_READY_TIMEOUT_SECONDS,
  DEFAULT_SSH_TCP_CONNECT_TIMEOUT_SECONDS,
} from '../../domain/sshConnectionTimeouts';
import type { Host } from '../../domain/models';

export const SSH_TCP_CONNECT_TIMEOUT_MS = DEFAULT_SSH_TCP_CONNECT_TIMEOUT_SECONDS * 1000;
export const SSH_AUTH_READY_TIMEOUT_MS = DEFAULT_SSH_AUTH_READY_TIMEOUT_SECONDS * 1000;

type ConnectionTimeouts = {
  tcpConnectTimeoutMs?: number;
  authReadyTimeoutMs?: number;
};

type HostConnectionTimeouts = Pick<
  Host,
  'sshTcpConnectTimeoutSeconds' | 'sshAuthReadyTimeoutSeconds'
>;

export function resolveActiveConnectionTimeoutHost(
  targetHost: HostConnectionTimeouts,
  chainHosts: HostConnectionTimeouts[],
  currentHop?: number,
  connectionPhase?: string,
): HostConnectionTimeouts {
  const activeHop = connectionPhase === 'forwarding' && currentHop
    ? currentHop + 1
    : currentHop;
  if (!activeHop || activeHop > chainHosts.length) return targetHost;
  return chainHosts[activeHop - 1] ?? targetHost;
}

type ConnectionTimeoutState = {
  status: string;
  needsAuth: boolean;
  isLocalConnection: boolean;
  isSerialConnection: boolean;
  hasSshTcpConnectProgress: boolean;
  needsHostKeyVerification: boolean;
  isConnectionAwaitingUserInput: boolean;
  isConnectionPastTcpDial: boolean;
  isWaitingForAutoReconnect?: boolean;
};

export function getConnectionTimeoutMs(
  state: ConnectionTimeoutState,
  timeouts: ConnectionTimeouts = {},
): number {
  const tcpConnectTimeoutMs = timeouts.tcpConnectTimeoutMs ?? SSH_TCP_CONNECT_TIMEOUT_MS;
  const authReadyTimeoutMs = timeouts.authReadyTimeoutMs ?? SSH_AUTH_READY_TIMEOUT_MS;
  if (!state.hasSshTcpConnectProgress) return SSH_AUTH_READY_TIMEOUT_MS;
  return state.isConnectionPastTcpDial
    ? authReadyTimeoutMs
    : tcpConnectTimeoutMs;
}

export function hasConnectionPassedTcpDial(status: string): boolean {
  return status === "tcp-connected"
    || status === "authenticating"
    || status === "authenticated"
    || status === "connected"
    || status === "shell";
}

export function shouldRunConnectionTimeout(state: ConnectionTimeoutState): boolean {
  return state.status === "connecting"
    && !state.needsAuth
    && !state.isLocalConnection
    && !state.isSerialConnection
    && !state.needsHostKeyVerification
    && !state.isConnectionAwaitingUserInput
    && !state.isWaitingForAutoReconnect;
}
