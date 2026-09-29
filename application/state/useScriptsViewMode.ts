import { useCallback, useState } from "react";
import { localStorageAdapter } from "../../infrastructure/persistence/localStorageAdapter";

/** View modes for the scripts side panel library:
 * 'list' (one snippet per row, tree of packages) and 'stacked' (compact
 * wrap-around chips). */
export type ScriptsViewMode = "list" | "stacked";

export const SCRIPTS_VIEW_MODE_STORAGE_KEY = "netcatty:scripts:sidePanelView";

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

  return [viewMode, setViewModePersisted] as const;
};