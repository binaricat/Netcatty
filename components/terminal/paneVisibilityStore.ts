import { useCallback, useSyncExternalStore } from 'react';

/**
 * Per-session pane visibility, published by <TerminalPane> and read by the few
 * deep consumers that actually need it (TerminalServerStats, TerminalAutocomplete).
 *
 * Why a store instead of a prop: `isVisible` used to flow through Terminal into
 * the giant TerminalView ctx, so every visibility toggle on tab switch
 * re-rendered the whole (expensive) TerminalView for each affected pane. By
 * routing visibility through this store, those consumers self-subscribe and
 * re-render on their own, letting TerminalView's memo skip visibility-only
 * changes entirely.
 */
type Listener = () => void;

const visibleBySession = new Map<string, boolean>();
const listenersBySession = new Map<string, Set<Listener>>();

export function setPaneVisible(sessionId: string, isVisible: boolean): void {
  if (visibleBySession.get(sessionId) === isVisible) return;
  visibleBySession.set(sessionId, isVisible);
  listenersBySession.get(sessionId)?.forEach((listener) => listener());
}

export function removePaneVisible(sessionId: string): void {
  if (!visibleBySession.has(sessionId)) return;
  visibleBySession.delete(sessionId);
  listenersBySession.get(sessionId)?.forEach((listener) => listener());
}

export function getPaneVisible(sessionId: string): boolean {
  return visibleBySession.get(sessionId) ?? false;
}

/** True when a workspace pane (or similar) publishes visibility for this session. */
export function hasPaneVisibilityEntry(sessionId: string): boolean {
  return visibleBySession.has(sessionId);
}

/** Prefer the store when present; otherwise fall back to the Terminal `isVisible` prop. */
export function resolvePaneVisible(sessionId: string, fallbackVisible: boolean): boolean {
  if (!visibleBySession.has(sessionId)) return fallbackVisible;
  return visibleBySession.get(sessionId)!;
}

export function subscribePaneVisible(sessionId: string, listener: Listener): () => void {
  let set = listenersBySession.get(sessionId);
  if (!set) {
    set = new Set();
    listenersBySession.set(sessionId, set);
  }
  set.add(listener);
  return () => {
    set!.delete(listener);
    if (set!.size === 0) listenersBySession.delete(sessionId);
  };
}

export function usePaneVisible(sessionId: string): boolean {
  const subscribe = useCallback((listener: Listener) => {
    let set = listenersBySession.get(sessionId);
    if (!set) {
      set = new Set();
      listenersBySession.set(sessionId, set);
    }
    set.add(listener);
    return () => {
      set!.delete(listener);
      if (set!.size === 0) listenersBySession.delete(sessionId);
    };
  }, [sessionId]);

  const getSnapshot = useCallback(() => visibleBySession.get(sessionId) ?? false, [sessionId]);

  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
