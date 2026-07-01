export const SSH_TCP_CONNECT_TIMEOUT_MS = 20_000;
export const SSH_AUTH_READY_TIMEOUT_MS = 120_000;

type ConnectionTimeoutState = {
  status: string;
  needsAuth: boolean;
  isLocalConnection: boolean;
  isSerialConnection: boolean;
  hasSshTcpConnectProgress: boolean;
  needsHostKeyVerification: boolean;
  isConnectionAwaitingUserInput: boolean;
  isConnectionPastTcpDial: boolean;
};

export function getConnectionTimeoutMs(state: ConnectionTimeoutState): number {
  if (!state.hasSshTcpConnectProgress) return SSH_AUTH_READY_TIMEOUT_MS;
  return state.isConnectionPastTcpDial
    ? SSH_AUTH_READY_TIMEOUT_MS
    : SSH_TCP_CONNECT_TIMEOUT_MS;
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
    && !state.isConnectionAwaitingUserInput;
}
