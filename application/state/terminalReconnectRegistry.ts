type TerminalReconnectHandler = () => void;

export const createTerminalReconnectRegistry = () => {
  const handlers = new Map<string, TerminalReconnectHandler>();
  const pendingRequests = new Set<string>();
  const activeSessionIds = new Set<string>();
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

  const register = (sessionId: string, handler: TerminalReconnectHandler): (() => void) => {
    handlers.set(sessionId, handler);
    if (pendingRequests.delete(sessionId)) {
      handler();
    }
    return () => {
      if (handlers.get(sessionId) === handler) {
        handlers.delete(sessionId);
        setActive(sessionId, false);
      }
    };
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

  return { register, request, setActive, isActive, subscribe };
};

export const terminalReconnectRegistry = createTerminalReconnectRegistry();
