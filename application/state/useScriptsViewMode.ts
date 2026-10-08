import { STORAGE_KEY_SCRIPTS_SIDE_PANEL_VIEW } from "../../infrastructure/config/storageKeys";
import { useStoredString } from "./useStoredString";

/** View modes for the scripts side panel library:
 * 'list' (one snippet per row, tree of packages) and 'stacked' (compact
 * wrap-around chips). */
export type ScriptsViewMode = "list" | "stacked";

export const SCRIPTS_VIEW_MODE_STORAGE_KEY = STORAGE_KEY_SCRIPTS_SIDE_PANEL_VIEW;

/** Pure resolver so callers and tests share one validation rule. */
export const parseScriptsViewMode = (value: string | null): ScriptsViewMode =>
  value === "stacked" ? "stacked" : "list";

const isScriptsViewMode = (value: string | null): value is ScriptsViewMode =>
  value === "list" || value === "stacked";

export const useScriptsViewMode = () =>
  useStoredString(SCRIPTS_VIEW_MODE_STORAGE_KEY, "list", isScriptsViewMode);
