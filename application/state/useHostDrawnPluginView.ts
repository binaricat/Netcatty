import { useCallback, useEffect, useRef, useState } from 'react';
import { netcattyBridge } from '../../infrastructure/services/netcattyBridge';
import { resolvePluginViewWindowScope } from './pluginViewScopes';
import { pluginViewSessions, type PluginViewSnapshot } from './pluginViewSession';
import type { HostDrawnViewEvent } from '@netcatty/plugin-contract';

const initial = (): PluginViewSnapshot => ({ tree: { children: [] }, css: '', loading: true, error: false, settled: true });
export function useHostDrawnPluginView({ viewId, version, slot, active, context, subscribeHidden, unavailable }: {
  viewId: string; version: string; slot: string; active: boolean; context: Record<string, unknown>;
  subscribeHidden(listener: () => void): () => void; unavailable(): void;
}) {
  const contextKey = JSON.stringify(context);
  const key = JSON.stringify([viewId, version, slot, contextKey]);
  const scopeId = typeof window !== 'undefined'
    ? resolvePluginViewWindowScope({ pathname: window.location.pathname, search: window.location.search, hash: `${window.location.hash}|plugin-slot:${slot}` })
    : '';
  const sessionKey = scopeId ? JSON.stringify([scopeId, key]) : '';
  const cachedSession = active && sessionKey ? pluginViewSessions.peek(sessionKey) : null;
  const [state, setState] = useState<{
    key: string;
    snapshot: PluginViewSnapshot;
    image?: (path: string) => Promise<string>;
  }>(() => (
    cachedSession
      ? { key, snapshot: cachedSession.getSnapshot(), image: cachedSession.image }
      : { key: '', snapshot: initial() }
  ));
  const [hidden, setHidden] = useState(false);
  const unavailableRef = useRef(unavailable); unavailableRef.current = unavailable;
  const sessionRef = useRef<{ key: string; image(path: string): Promise<string>; send(event: HostDrawnViewEvent): void } | null>(null);
  useEffect(() => {
    if (!active) {
      setHidden(false);
      return;
    }
    const bridge = netcattyBridge.get();
    if (!bridge) { unavailableRef.current(); return; }
    const resolvedScopeId = resolvePluginViewWindowScope({ pathname: window.location.pathname, search: window.location.search, hash: `${window.location.hash}|plugin-slot:${slot}` });
    try {
      const session = pluginViewSessions.acquire(JSON.stringify([resolvedScopeId, key]), bridge, { viewId, scopeId: resolvedScopeId, context: JSON.parse(contextKey) });
      sessionRef.current = { key, send: session.send, image: session.image };
      const update = () => { const snapshot = session.getSnapshot(); setState({ key, snapshot, image: session.image }); if (snapshot.error) unavailableRef.current(); };
      const stop = session.subscribe(update); update(); setHidden(false);
      const stopHidden = subscribeHidden(() => { sessionRef.current = null; setHidden(true); });
      return () => { sessionRef.current = null; stopHidden(); stop(); session.release(); };
    } catch { unavailableRef.current(); }
  }, [active, contextKey, key, slot, subscribeHidden, viewId]);
  const fallbackLoadImage = useCallback((path: string) => {
    const session = sessionRef.current;
    return active && session?.key === key ? session.image(path) : Promise.reject(new Error('Plugin view unavailable'));
  }, [active, key]);
  const hasCurrentState = active && state.key === key && cachedSession !== null && state.image === cachedSession.image;
  const resolvedSnapshot = hasCurrentState
    ? state.snapshot
    : cachedSession
      ? cachedSession.getSnapshot()
      : initial();
  const loadImage = hasCurrentState && state.image
    ? state.image
    : (cachedSession?.image ?? fallbackLoadImage);
  const sendEvent = useCallback((event: HostDrawnViewEvent) => {
    const session = sessionRef.current; if (active && session?.key === key) session.send(event);
  }, [active, key]);
  // A newly selected plugin must never receive values from the previous tree,
  // even during the render before effect cleanup and the next activation.
  return { ...resolvedSnapshot, visible: active && !hidden, loadImage, sendEvent };
}
