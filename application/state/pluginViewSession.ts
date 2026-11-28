import { createPluginRemoteTree } from './pluginRemoteTree';
import { registerLoadedPluginViewSessions } from './pluginViewSessionRegistry';
import { validatePluginStylesheet } from '@/domain/pluginViewStylePolicy.cjs';
import type { HostDrawnViewEvent } from '@netcatty/plugin-contract';

type Bridge = Pick<NonNullable<ReturnType<typeof import('../../infrastructure/services/netcattyBridge').netcattyBridge.get>>, 'openHostDrawnPluginView' | 'closeHostDrawnPluginView' | 'onHostDrawnPluginViewUpdate' | 'onPluginViewClosed' | 'sendHostDrawnPluginViewEvent' | 'getPluginViewResource'>;
export type PluginViewSnapshot = { tree: ReturnType<ReturnType<typeof createPluginRemoteTree>['snapshot']>; css: string; loading: boolean; error: boolean; settled: boolean };
const empty = (): PluginViewSnapshot => ({ tree: { children: [] }, css: '', loading: true, error: false, settled: true });
const EMPTY_FIRST_FRAME_GRACE_MS = 60;

function hasRenderableTreeContent(tree: PluginViewSnapshot['tree']): boolean {
  for (const child of tree.children) {
    if (child.type === 3 && child.data.trim().length > 0) return true;
    if (child.type === 1) {
      if (child.element !== 'div' || child.children.length > 0) return true;
    }
  }
  return false;
}

/** Owns a window's bounded, retained UI instances independently of React mounts. */
export class PluginViewSessions {
  private sessions = new Map<string, ReturnType<PluginViewSessions['create']>>();
  constructor(private readonly capacity = 16, private readonly idleMs = 300_000) {}
  private create(key: string, bridge: Bridge, request: Omit<import('@netcatty/plugin-contract').HostDrawnViewOpenRequest, 'instanceId'>) {
    const id = crypto.randomUUID();
    const tree = createPluginRemoteTree();
    let state = empty(); let sequence = 1; let eventId = 0; let disposed = false; let users = 0;
    let lastRawCss: string | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let emptyFrameTimer: ReturnType<typeof setTimeout> | undefined;
    const listeners = new Set<() => void>();
    const publish = (next: PluginViewSnapshot) => { state = next; for (const listener of listeners) listener(); };
    const cleanup: Array<() => void> = [];
    const dispose = (failed = false) => {
      if (disposed) return;
      disposed = true; clearTimeout(timer); clearTimeout(emptyFrameTimer); cleanup.forEach((stop) => stop());
      this.sessions.delete(key);
      publish({ ...empty(), loading: false, error: failed });
      void bridge.closeHostDrawnPluginView?.(id).catch(() => {});
    };
    if (!bridge.openHostDrawnPluginView || !bridge.onHostDrawnPluginViewUpdate || !bridge.onPluginViewClosed) throw new Error('Plugin views unavailable');
    cleanup.push(bridge.onHostDrawnPluginViewUpdate((update) => {
      if (disposed || update.kind !== 'host-ui.update' || update.instanceId !== id || update.viewId !== request.viewId) return;
      try {
        if (update.sequence !== sequence++) throw new Error('Invalid plugin update order');
        const nextCss = update.cssUnchanged
          ? state.css
          : (lastRawCss !== null && update.css === lastRawCss)
            ? state.css
            : ((lastRawCss = update.css), validatePluginStylesheet(update.css));
        const nextTree = tree.apply(update.mutations);
        const settled = (update.acknowledgedEvent ?? 0) >= eventId;
        if (state.loading && !hasRenderableTreeContent(nextTree)) {
          // Hold the host loading surface briefly while an older SDK flushes its
          // initial React commit so users never see an empty blank frame flash.
          publish({ tree: nextTree, css: nextCss, loading: true, error: false, settled });
          if (emptyFrameTimer === undefined) {
            emptyFrameTimer = setTimeout(() => {
              emptyFrameTimer = undefined;
              if (!disposed && state.loading) publish({ ...state, loading: false });
            }, EMPTY_FIRST_FRAME_GRACE_MS);
          }
          return;
        }
        if (emptyFrameTimer !== undefined) {
          clearTimeout(emptyFrameTimer);
          emptyFrameTimer = undefined;
        }
        publish({ tree: nextTree, css: nextCss, loading: false, error: false, settled });
      } catch { dispose(true); }
    }));
    cleanup.push(bridge.onPluginViewClosed((event) => { if (event.instanceId === id) dispose(true); }));
    void bridge.openHostDrawnPluginView({ ...request, instanceId: id }).then(() => {
      if (disposed) void bridge.closeHostDrawnPluginView?.(id).catch(() => {});
    }).catch(() => dispose(true));
    const imageCache = new Map<string, Promise<string>>();
    return {
      viewId: request.viewId,
      scope: request.scopeId,
      image: (path: string) => {
        if (disposed || !bridge.getPluginViewResource) return Promise.reject(new Error('Plugin image unavailable'));
        const existing = imageCache.get(path);
        if (existing) return existing;
        const pending = bridge.getPluginViewResource({ instanceId: id, path }).then((result) => {
          if (disposed) throw new Error('Plugin view closed');
          return result.url;
        }).catch((error) => {
          if (imageCache.get(path) === pending) imageCache.delete(path);
          throw error;
        });
        imageCache.set(path, pending);
        return pending;
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
  peek(key: string) {
    return this.sessions.get(key) ?? null;
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
registerLoadedPluginViewSessions(pluginViewSessions);
