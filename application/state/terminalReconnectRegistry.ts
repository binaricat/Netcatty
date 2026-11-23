type TerminalReconnectHandler = () => void;
export type TerminalRecoverySnapshot = { status: string; waitingForInput: boolean; reconnecting: boolean; stopped?: boolean };

export const createTerminalReconnectRegistry = () => {
  const handlers = new Map<string, TerminalReconnectHandler>();
  const eligibility = new Map<string, () => boolean>();
  const recoveryReaders = new Map<string, () => TerminalRecoverySnapshot>();
  const pendingRequests = new Set<string>();
  const activeSessionIds = new Set<string>();
  const enterReconnectEnabledIds = new Set<string>();
  const listeners = new Set<() => void>();

  const emit = () => {
    for (const listener of listeners) listener();
  };

  const setActive = (sessionId: string, active: boolean): void => {
    const changed = active
      ? !activeSessionIds.has(sessionId)
      : activeSessionIds.has(sessionId);
    if (!changed) return;
    if (active) activeSessionIds.add(sessionId);
    else activeSessionIds.delete(sessionId);
    emit();
  };

  const isActive = (sessionId: string): boolean => activeSessionIds.has(sessionId);

  const subscribe = (listener: () => void): (() => void) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  };

  const register = (sessionId: string, handler: TerminalReconnectHandler,
    canReconnect: () => boolean = () => false, readRecovery?: () => TerminalRecoverySnapshot): (() => void) => {
    handlers.set(sessionId, handler);
    eligibility.set(sessionId, canReconnect);
    if (readRecovery) recoveryReaders.set(sessionId, readRecovery);
    else recoveryReaders.delete(sessionId);
    if (pendingRequests.delete(sessionId)) {
      handler();
    }
    return () => {
      if (handlers.get(sessionId) === handler) {
        handlers.delete(sessionId);
        eligibility.delete(sessionId);
        recoveryReaders.delete(sessionId);
        setActive(sessionId, false);
      }
    };
  };

  const inspect = (sessionId: string) => {
    const state = recoveryReaders.get(sessionId)?.();
    if (!state) return null;
    return { ...state, reconnecting: state.reconnecting || isActive(sessionId),
      reconnectAllowed: !isActive(sessionId) && Boolean(eligibility.get(sessionId)?.()) };
  };

  // Agent requests must never survive unmount or bypass authentication/auto-retry.
  const requestIfAvailable = (sessionId: string): boolean => {
    const handler = handlers.get(sessionId);
    if (!handler || isActive(sessionId) || !eligibility.get(sessionId)?.()) return false;
    handler();
    return true;
  };

  const request = (sessionId: string): boolean => {
    if (isActive(sessionId)) return false;
    const handler = handlers.get(sessionId);
    if (!handler) {
      pendingRequests.add(sessionId);
      return true;
    }
    handler();
    return true;
  };

  // Enter-reconnect while a compose bar is open. Explicit reconnect clicks use
  // request(); this path stays off during auth, host-key, and blocking overlays.
  const setEnterReconnectEnabled = (sessionId: string, enabled: boolean): void => {
    if (enabled) enterReconnectEnabledIds.add(sessionId);
    else enterReconnectEnabledIds.delete(sessionId);
  };

  const requestEnterReconnect = (sessionId: string): boolean => {
    if (!enterReconnectEnabledIds.has(sessionId)) return false;
    return request(sessionId);
  };

  return {
    register,
    inspect,
    request,
    requestIfAvailable,
    requestEnterReconnect,
    setEnterReconnectEnabled,
    setActive,
    isActive,
    subscribe,
  };
};

export const terminalReconnectRegistry = createTerminalReconnectRegistry();
