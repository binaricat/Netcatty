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
  const [state, setState] = useState<{ key: string; snapshot: PluginViewSnapshot }>({ key: '', snapshot: initial() });
  const [hidden, setHidden] = useState(false);
  const unavailableRef = useRef(unavailable); unavailableRef.current = unavailable;
  const sessionRef = useRef<{ key: string; image(path: string): Promise<string>; send(event: HostDrawnViewEvent): void } | null>(null);
  useEffect(() => {
    if (!active) return;
    const bridge = netcattyBridge.get();
    if (!bridge) { unavailableRef.current(); return; }
    const scopeId = resolvePluginViewWindowScope({ pathname: window.location.pathname, search: window.location.search, hash: `${window.location.hash}|plugin-slot:${slot}` });
    try {
      const session = pluginViewSessions.acquire(JSON.stringify([scopeId, key]), bridge, { viewId, scopeId, context: JSON.parse(contextKey) });
      const update = () => { const snapshot = session.getSnapshot(); setState({ key, snapshot }); if (snapshot.error) unavailableRef.current(); };
      const stop = session.subscribe(update); update(); setHidden(false);
      sessionRef.current = { key, send: session.send, image: session.image };
      const stopHidden = subscribeHidden(() => { sessionRef.current = null; setHidden(true); });
      return () => { sessionRef.current = null; stopHidden(); stop(); session.release(); };
    } catch { unavailableRef.current(); }
  }, [active, contextKey, key, slot, subscribeHidden, viewId]);
  const loadImage = useCallback((path: string) => {
    const session = sessionRef.current;
    return active && session?.key === key ? session.image(path) : Promise.reject(new Error('Plugin view unavailable'));
  }, [active, key]);
  const sendEvent = useCallback((event: HostDrawnViewEvent) => {
    const session = sessionRef.current; if (active && session?.key === key) session.send(event);
  }, [active, key]);
  // A newly selected plugin must never receive values from the previous tree,
  // even during the render before effect cleanup and the next activation.
  return { ...(state.key === key ? state.snapshot : initial()), visible: active && !hidden, loadImage, sendEvent };
}
