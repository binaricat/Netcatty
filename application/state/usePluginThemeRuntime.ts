import { useEffect, useSyncExternalStore } from "react";
import { netcattyBridge } from "../../infrastructure/services/netcattyBridge";
import { pluginThemeRegistry } from "../../infrastructure/config/pluginThemeRegistry";
export function usePluginThemeRevision() {
  return useSyncExternalStore(
    pluginThemeRegistry.subscribe,
    pluginThemeRegistry.getRevision,
    pluginThemeRegistry.getRevision,
  );
}
/** Host-owned selection; never stored in plugin KV or cloud sidecars. */
let runtimeUsers = 0;
let disconnectRuntime: (() => void) | undefined;
function connectRuntime() {
  const bridge = netcattyBridge.get();
  let active = true,
    request = 0;
  const refresh = async () => {
    const current = ++request;
    try {
      const catalog = await bridge?.getPluginThemes?.();
      if (active && current === request && catalog)
        pluginThemeRegistry.setCatalog(catalog);
    } catch {
      /* Keep the last host-validated selection; never apply unvalidated data. */
    }
  };
  void refresh();
  const dispose = bridge?.onPluginThemesChanged?.(() => {
    pluginThemeRegistry.invalidate();
    void refresh();
  });
  const forced = window.matchMedia?.("(forced-colors: active)"),
    contrast = window.matchMedia?.("(prefers-contrast: more)");
  const update = () =>
    pluginThemeRegistry.setHighContrast(
      Boolean(forced?.matches || contrast?.matches),
    );
  update();
  forced?.addEventListener?.("change", update);
  contrast?.addEventListener?.("change", update);
  return () => {
    active = false;
    request++;
    dispose?.();
    forced?.removeEventListener?.("change", update);
    contrast?.removeEventListener?.("change", update);
  };
}
export function usePluginThemeRuntime() {
  const revision = usePluginThemeRevision();
  useEffect(() => {
    if (runtimeUsers++ === 0) disconnectRuntime = connectRuntime();
    return () => {
      if (--runtimeUsers === 0) {
        disconnectRuntime?.();
        disconnectRuntime = undefined;
      }
    };
  }, []);
  return revision;
}
export async function applyPluginThemeSelection(
  mode: "light" | "dark",
  choice: import("@netcatty/plugin-contract").ThemePackChoice | null,
) {
  if (choice === null && !pluginThemeRegistry.isActive(mode))
    return pluginThemeRegistry.getCatalog();
  const bridge = netcattyBridge.require();
  if (!bridge.applyPluginTheme) throw new Error("Plugin themes unavailable");
  const next = await bridge.applyPluginTheme({
    mode,
    choice,
    expectedRevision: pluginThemeRegistry.getCatalog().selection.revision,
  });
  return next; // The host change event refreshes every window; never publish a potentially stale apply response.
}
