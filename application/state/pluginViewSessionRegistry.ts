import { netcattyBridge } from '../../infrastructure/services/netcattyBridge';

type CloseablePluginViewSessions = {
  closeView(viewId: string): void;
};

let loadedSessions: CloseablePluginViewSessions | null = null;

/**
 * Registers the live PluginViewSessions singleton once the lazy host-drawn
 * plugin view bundle loads, so startup lifecycle hooks can close views without
 * statically importing css-tree / @remote-dom/core.
 */
export function registerLoadedPluginViewSessions(sessions: CloseablePluginViewSessions): void {
  loadedSessions = sessions;
}

export function closePluginViewSessionIfLoaded(viewId: string): void {
  loadedSessions?.closeView(viewId);
}

export function prewarmHostDrawnPluginView(viewId: string): void {
  void netcattyBridge.get()?.prewarmHostDrawnPluginView?.(viewId)?.catch?.(() => {});
}
