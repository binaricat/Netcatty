import type { SessionCapabilities } from '../../domain/systemManager/types';

/** Internal entry: capabilities plus computed expiry timestamp. */
interface StoreEntry {
  capabilities: SessionCapabilities;
  expiresAt: number;
}

type Listener = () => void;

const capabilitiesBySessionId = new Map<string, StoreEntry>();
const listenersBySessionId = new Map<string, Set<Listener>>();

function isExpired(entry: StoreEntry): boolean {
  return Date.now() > entry.expiresAt;
}

function notifySession(sessionId: string) {
  listenersBySessionId.get(sessionId)?.forEach((listener) => listener());
}

export const sessionCapabilitiesStore = {
  get(sessionId: string): SessionCapabilities | undefined {
    const entry = capabilitiesBySessionId.get(sessionId);
    if (!entry) return undefined;
    if (isExpired(entry)) {
      capabilitiesBySessionId.delete(sessionId);
      notifySession(sessionId);
      return undefined;
    }
    return entry.capabilities;
  },

  set(sessionId: string, capabilities: SessionCapabilities, ttlMs: number) {
    const entry: StoreEntry = {
      capabilities: {
        ...capabilities,
        probedAt: Date.now(),
      },
      expiresAt: Date.now() + ttlMs,
    };
    capabilitiesBySessionId.set(sessionId, entry);
    notifySession(sessionId);
  },

  delete(sessionId: string) {
    if (!capabilitiesBySessionId.delete(sessionId)) return;
    notifySession(sessionId);
    listenersBySessionId.delete(sessionId);
  },

  /** Drop cached capabilities for sessions that no longer exist. */
  prune(liveSessionIds: ReadonlySet<string>) {
    for (const sessionId of capabilitiesBySessionId.keys()) {
      if (!liveSessionIds.has(sessionId)) {
        capabilitiesBySessionId.delete(sessionId);
        listenersBySessionId.delete(sessionId);
      }
    }
  },

  subscribe(sessionId: string, listener: Listener): () => void {
    let set = listenersBySessionId.get(sessionId);
    if (!set) {
      set = new Set();
      listenersBySessionId.set(sessionId, set);
    }
    set.add(listener);
    return () => {
      set?.delete(listener);
      if (set && set.size === 0) {
        listenersBySessionId.delete(sessionId);
      }
    };
  },
};
