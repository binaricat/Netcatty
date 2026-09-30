import { useCallback, useEffect, useState } from "react";
import { STORAGE_KEY_SCRIPTS_SIDE_PANEL_VIEW } from "../../infrastructure/config/storageKeys";
import {
  localStorageAdapter,
  LOCAL_STORAGE_ADAPTER_CHANGED_EVENT,
} from "../../infrastructure/persistence/localStorageAdapter";

/** View modes for the scripts side panel library:
 * 'list' (one snippet per row, tree of packages) and 'stacked' (compact
 * wrap-around chips). */
export type ScriptsViewMode = "list" | "stacked";

export const SCRIPTS_VIEW_MODE_STORAGE_KEY = STORAGE_KEY_SCRIPTS_SIDE_PANEL_VIEW;

/** Pure resolver so callers and tests share one validation rule. */
export const parseScriptsViewMode = (value: string | null): ScriptsViewMode =>
  value === "stacked" ? "stacked" : "list";

export const useScriptsViewMode = () => {
  const [viewMode, setViewMode] = useState<ScriptsViewMode>(() =>
    parseScriptsViewMode(localStorageAdapter.readString(SCRIPTS_VIEW_MODE_STORAGE_KEY)),
  );

  const setViewModePersisted = useCallback((mode: ScriptsViewMode) => {
    setViewMode(mode);
    localStorageAdapter.writeString(SCRIPTS_VIEW_MODE_STORAGE_KEY, mode);
  }, []);

  // The terminal layer mounts one panel per tab, so follow storage changes to
  // keep every mounted panel on the same mode instead of a stale snapshot.
  useEffect(() => {
    const handler = (event: Event) => {
      const detail = (event as CustomEvent<{ key?: string }>).detail;
      if (detail?.key !== SCRIPTS_VIEW_MODE_STORAGE_KEY) return;
      setViewMode(
        parseScriptsViewMode(localStorageAdapter.readString(SCRIPTS_VIEW_MODE_STORAGE_KEY)),
      );
    };
    window.addEventListener(LOCAL_STORAGE_ADAPTER_CHANGED_EVENT, handler);
    return () => window.removeEventListener(LOCAL_STORAGE_ADAPTER_CHANGED_EVENT, handler);
  }, []);

  return [viewMode, setViewModePersisted] as const;
};