import type { SessionCapabilities } from '../../domain/systemManager/types';

/** How long cached capability probes remain valid before requiring re-probe. */
export const CAPABILITIES_TTL_MS = 60_000;

type Listener = () => void;

const capabilitiesBySessionId = new Map<string, SessionCapabilities>();
const listenersBySessionId = new Map<string, Set<Listener>>();

function isExpired(capabilities: SessionCapabilities): boolean {
  return Date.now() - capabilities.probedAt > CAPABILITIES_TTL_MS;
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
      return undefined;
    }
    return entry;
  },

  set(sessionId: string, capabilities: SessionCapabilities) {
    const entry: SessionCapabilities = {
      ...capabilities,
      probedAt: Date.now(),
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
