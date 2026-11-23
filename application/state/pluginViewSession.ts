import { createPluginRemoteTree } from './pluginRemoteTree';
import { validatePluginStylesheet } from '@/domain/pluginViewStylePolicy.cjs';
import type { HostDrawnViewEvent } from '@netcatty/plugin-contract';

type Bridge = Pick<NonNullable<ReturnType<typeof import('../../infrastructure/services/netcattyBridge').netcattyBridge.get>>, 'openHostDrawnPluginView' | 'closeHostDrawnPluginView' | 'onHostDrawnPluginViewUpdate' | 'onPluginViewClosed' | 'sendHostDrawnPluginViewEvent' | 'getPluginViewResource'>;
export type PluginViewSnapshot = { tree: ReturnType<ReturnType<typeof createPluginRemoteTree>['snapshot']>; css: string; loading: boolean; error: boolean; settled: boolean };
const empty = (): PluginViewSnapshot => ({ tree: { children: [] }, css: '', loading: true, error: false, settled: true });

/** Owns a window's bounded, retained UI instances independently of React mounts. */
export class PluginViewSessions {
  private sessions = new Map<string, ReturnType<PluginViewSessions['create']>>();
  constructor(private readonly capacity = 16, private readonly idleMs = 300_000) {}
  private create(key: string, bridge: Bridge, request: Omit<import('@netcatty/plugin-contract').HostDrawnViewOpenRequest, 'instanceId'>) {
    const id = crypto.randomUUID();
    const tree = createPluginRemoteTree();
    let state = empty(); let sequence = 1; let eventId = 0; let disposed = false; let users = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const listeners = new Set<() => void>();
    const publish = (next: PluginViewSnapshot) => { state = next; for (const listener of listeners) listener(); };
    const cleanup: Array<() => void> = [];
    const dispose = (failed = false) => {
      if (disposed) return;
      disposed = true; clearTimeout(timer); cleanup.forEach((stop) => stop());
      this.sessions.delete(key);
      publish({ ...empty(), loading: false, error: failed });
      void bridge.closeHostDrawnPluginView?.(id).catch(() => {});
    };
    if (!bridge.openHostDrawnPluginView || !bridge.onHostDrawnPluginViewUpdate || !bridge.onPluginViewClosed) throw new Error('Plugin views unavailable');
    cleanup.push(bridge.onHostDrawnPluginViewUpdate((update) => {
      if (disposed || update.kind !== 'host-ui.update' || update.instanceId !== id || update.viewId !== request.viewId) return;
      try {
        if (update.sequence !== sequence++) throw new Error('Invalid plugin update order');
        publish({ tree: tree.apply(update.mutations), css: validatePluginStylesheet(update.css), loading: false, error: false, settled: (update.acknowledgedEvent ?? 0) >= eventId });
      } catch { dispose(true); }
    }));
    cleanup.push(bridge.onPluginViewClosed((event) => { if (event.instanceId === id) dispose(true); }));
    void bridge.openHostDrawnPluginView({ ...request, instanceId: id }).then(() => {
      if (disposed) void bridge.closeHostDrawnPluginView?.(id).catch(() => {});
    }).catch(() => dispose(true));
    return {
      viewId: request.viewId,
      scope: request.scopeId,
      image: async (path: string) => {
        if (disposed || !bridge.getPluginViewResource) throw new Error('Plugin image unavailable');
        const result = await bridge.getPluginViewResource({ instanceId: id, path });
        if (disposed) throw new Error('Plugin view closed');
        return result.url;
      },
      get idle() { return users === 0; },
      getSnapshot: () => state,
      subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
      acquire: () => { clearTimeout(timer); users++; },
      release: () => { if (--users === 0 && !disposed) timer = setTimeout(() => dispose(), this.idleMs); },
      send: (event: HostDrawnViewEvent) => {
        if (disposed || users === 0) return;
        publish({ ...state, settled: false });
        void bridge.sendHostDrawnPluginViewEvent?.(id, { ...event, eventId: ++eventId }).catch(() => dispose(true));
      },
      dispose,
    };
  }
  acquire(key: string, bridge: Bridge, request: Omit<import('@netcatty/plugin-contract').HostDrawnViewOpenRequest, 'instanceId'>) {
    let session = this.sessions.get(key);
    if (!session) {
      while (this.sessions.size >= this.capacity) {
        const candidate = [...this.sessions.values()].find((item) => item.idle);
        if (!candidate) throw new Error('Too many open plugin views');
        candidate.dispose();
      }
      session = this.create(key, bridge, request); this.sessions.set(key, session);
    }
    session.acquire(); return session;
  }
  closeView(viewId: string) { for (const session of [...this.sessions.values()]) if (session.viewId === viewId) session.dispose(); }
  closeScope(scope: string) { for (const session of [...this.sessions.values()]) if (session.scope === scope) session.dispose(); }
  dispose() { for (const session of [...this.sessions.values()]) session.dispose(); }
}
export const pluginViewSessions = new PluginViewSessions();
