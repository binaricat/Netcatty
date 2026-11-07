type ReconnectRegistry = {
  isActive: (sessionId: string) => boolean;
  requestIfAvailable: (sessionId: string) => boolean;
};

/** Synchronous dispatch only: no queued recovery after scope/terminal disposal. */
export function requestAgentSessionReconnect(
  sessionId: string,
  status: string | undefined,
  registry: ReconnectRegistry,
): Record<string, unknown> {
  if (!status) return { ok: false, started: false, error: `Session "${sessionId}" was not found.` };
  if (status === 'connected') return { ok: true, started: false, sessionId, status: 'connected', shellReady: false };
  if (status === 'connecting' || registry.isActive(sessionId)) {
    return { ok: true, started: false, sessionId, status: 'reconnecting' };
  }
  if (status !== 'disconnected' || !registry.requestIfAvailable(sessionId)) {
    return { ok: false, started: false, sessionId, code: 'RECONNECT_UNAVAILABLE', error: 'Reconnect is unavailable: terminal may be unmounted, waiting for authentication, or recovering. Inspect session state and the Netcatty UI.' };
  }
  return { ok: true, started: true, sessionId, status: 'reconnecting', shellReady: false };
}
