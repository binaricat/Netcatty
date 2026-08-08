import { matchesSearchQuery } from "../lib/searchMatcher";
import {
  SETTINGS_SEARCH_CATALOG,
  type SettingsSearchEntry,
  type SettingsTabId,
} from "./settingsSearchCatalog";

export type SettingsSearchTranslator = (key: string) => string;

export type SettingsSearchHit = {
  entry: SettingsSearchEntry;
  label: string;
  description?: string;
  section?: string;
  tabLabel: string;
};

const TAB_LABEL_KEYS: Record<SettingsTabId, string> = {
  application: "settings.tab.application",
  appearance: "settings.tab.appearance",
  terminal: "settings.tab.terminal",
  shortcuts: "settings.tab.shortcuts",
  "file-associations": "settings.tab.sftpFileAssociations",
  ai: "settings.tab.ai",
  sync: "settings.tab.syncCloud",
  system: "settings.tab.system",
  plugins: "settings.tab.plugins",
};

function resolveField(t: SettingsSearchTranslator, key: string | undefined): string | undefined {
  if (!key) return undefined;
  const value = t(key);
  if (!value || value === key) return undefined;
  return value;
}

function resolveLabel(t: SettingsSearchTranslator, entry: SettingsSearchEntry): string {
  const value = t(entry.labelKey);
  return value && value !== entry.labelKey ? value : entry.labelKey;
}

export function buildSettingsSearchHit(
  entry: SettingsSearchEntry,
  t: SettingsSearchTranslator,
): SettingsSearchHit {
  const tabLabelKey = TAB_LABEL_KEYS[entry.tab];
  const tabLabelRaw = t(tabLabelKey);
  return {
    entry,
    label: resolveLabel(t, entry),
    description: resolveField(t, entry.descriptionKey),
    section: resolveField(t, entry.sectionKey),
    tabLabel: tabLabelRaw && tabLabelRaw !== tabLabelKey ? tabLabelRaw : entry.tab,
  };
}

export function filterSettingsSearchCatalog(
  query: string,
  t: SettingsSearchTranslator,
  options?: {
    catalog?: readonly SettingsSearchEntry[];
    includePlugins?: boolean;
    limit?: number;
  },
): SettingsSearchHit[] {
  const catalog = options?.catalog ?? SETTINGS_SEARCH_CATALOG;
  const includePlugins = options?.includePlugins ?? true;
  const limit = options?.limit ?? 40;
  const trimmed = query.trim();

  const hits: SettingsSearchHit[] = [];
  for (const entry of catalog) {
    if (!includePlugins && entry.tab === "plugins") continue;
    const hit = buildSettingsSearchHit(entry, t);
    if (!trimmed) {
      hits.push(hit);
      continue;
    }
    const matched = matchesSearchQuery(
      trimmed,
      hit.label,
      hit.description,
      hit.section,
      hit.tabLabel,
      entry.labelKey,
      ...(entry.keywords ?? []),
    );
    if (matched) hits.push(hit);
  }

  if (!trimmed) {
    return hits.slice(0, limit);
  }

  // Prefer label prefix / starts-with style matches first for autocomplete feel.
  const normalized = trimmed.toLowerCase();
  hits.sort((left, right) => {
    const leftLabel = left.label.toLowerCase();
    const rightLabel = right.label.toLowerCase();
    const leftStarts = leftLabel.startsWith(normalized) ? 0 : 1;
    const rightStarts = rightLabel.startsWith(normalized) ? 0 : 1;
    if (leftStarts !== rightStarts) return leftStarts - rightStarts;
    const leftIncludes = leftLabel.includes(normalized) ? 0 : 1;
    const rightIncludes = rightLabel.includes(normalized) ? 0 : 1;
    if (leftIncludes !== rightIncludes) return leftIncludes - rightIncludes;
    return leftLabel.localeCompare(rightLabel);
  });

  return hits.slice(0, limit);
}
