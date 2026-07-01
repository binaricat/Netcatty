type Listener = () => void;

const softHiddenSessions = new Map<string, number>();
const listeners = new Set<Listener>();
let evictionRequestSessionId: string | null = null;

function emit(): void {
  listeners.forEach((listener) => listener());
}

export const terminalHiddenRendererStore = {
  getSoftHiddenCount: () => softHiddenSessions.size,

  isSoftHidden: (sessionId: string) => softHiddenSessions.has(sessionId),

  markSoftHidden: (sessionId: string) => {
    softHiddenSessions.set(sessionId, Date.now());
    emit();
  },

  clearSoftHidden: (sessionId: string) => {
    if (!softHiddenSessions.delete(sessionId)) return;
    emit();
  },

  /** Returns the oldest soft-hidden session id when over the keep limit. */
  pickEvictionCandidate: (keepCount: number): string | null => {
    if (softHiddenSessions.size < keepCount) return null;
    let oldestId: string | null = null;
    let oldestTs = Number.POSITIVE_INFINITY;
    for (const [sessionId, ts] of softHiddenSessions) {
      if (ts < oldestTs) {
        oldestTs = ts;
        oldestId = sessionId;
      }
    }
    return oldestId;
  },

  requestEviction: (sessionId: string) => {
    evictionRequestSessionId = sessionId;
    emit();
  },

  consumeEvictionRequest: (sessionId: string): boolean => {
    if (evictionRequestSessionId !== sessionId) return false;
    evictionRequestSessionId = null;
    return true;
  },

  subscribe: (listener: Listener) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
};
