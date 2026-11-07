import type {
  ThemePackCatalog,
  ThemePackEntry,
} from "@netcatty/plugin-contract";
import type { UiThemePreset, UiThemeTokens } from "./uiThemes";
import themeColors from "@/domain/pluginThemePack.cjs";
const colors = themeColors as unknown as {
  resolveThemePalette(palette: ThemePackEntry["palette"]): UiThemeTokens;
  securityThemeTokens(mode: "light" | "dark", hc?: boolean): UiThemeTokens;
};
let catalog: ThemePackCatalog = {
  selection: { formatVersion: 1, revision: 0, light: null, dark: null },
  entries: [],
  diagnostics: [],
};
let revision = 0,
  highContrast = false;
let preview: { owner: string; entry: ThemePackEntry; revision: number } | null =
  null;
const listeners = new Set<() => void>();
const refKey = (ref: ThemePackEntry["ref"]) =>
  JSON.stringify([
    ref.pluginId,
    ref.themeId,
    ref.version,
    ref.digest,
    ref.variant,
  ]);
const emit = () => {
  revision++;
  for (const listener of listeners) listener();
};
export const pluginThemeRegistry = {
  subscribe(listener: () => void) {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
  getRevision: () => revision,
  getCatalog: () => catalog,
  invalidate() {
    preview = null;
    catalog = { ...catalog, entries: [] };
    emit();
  },
  setCatalog(next: ThemePackCatalog) {
    if (next.selection.revision < catalog.selection.revision) return;
    catalog = next;
    if (
      preview &&
      (preview.revision !== next.selection.revision ||
        !next.entries.some((e) => refKey(e.ref) === refKey(preview!.entry.ref)))
    )
      preview = null;
    emit();
  },
  setHighContrast(value: boolean) {
    if (value !== highContrast) {
      highContrast = value;
      emit();
    }
  },
  isHighContrast: () => highContrast,
  startPreview(owner: string, entry: ThemePackEntry) {
    if (!catalog.entries.some((e) => refKey(e.ref) === refKey(entry.ref)))
      throw new Error("Theme unavailable");
    preview = { owner, entry, revision: catalog.selection.revision };
    emit();
  },
  cancelPreview(owner: string) {
    if (preview?.owner === owner) {
      preview = null;
      emit();
    }
  },
  isActive(mode: "light" | "dark") {
    return Boolean(
      (preview?.entry.palette.base === mode ? preview : null) ||
        catalog.selection[mode],
    );
  },
  getTheme(
    mode: "light" | "dark",
    includePreview = true,
  ): UiThemePreset | null {
    const selected = catalog.selection[mode];
    const entry =
      includePreview && preview?.entry.palette.base === mode
        ? preview.entry
        : selected
          ? catalog.entries.find((e) => refKey(e.ref) === refKey(selected.ref))
          : null;
    // Forced/high contrast always uses a fixed host palette. No downgrade to an ordinary pack.
    if (highContrast && (entry || selected))
      return {
        id: "host-high-contrast",
        name: "High contrast",
        tokens: colors.securityThemeTokens(mode, true),
      };
    if (!entry)
      return selected
        ? {
            id: "host-plugin-fallback",
            name: "Default",
            tokens: colors.securityThemeTokens(mode),
          }
        : null;
    return {
      id: `plugin:${entry.ref.pluginId}:${entry.ref.themeId}`,
      name: entry.label,
      tokens: colors.resolveThemePalette(entry.palette),
    };
  },
  securityTokens: (mode: "light" | "dark") =>
    colors.securityThemeTokens(mode, highContrast),
};
