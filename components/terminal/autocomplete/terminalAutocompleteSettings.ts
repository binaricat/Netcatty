import type { AutocompleteSettings } from "./useTerminalAutocomplete";
import type { AutocompleteHistoryScope } from "../../../domain/models";
import { shouldWriteAutocompleteLivePreview } from "./livePreviewSequence";

type TerminalAutocompleteSettingFields = {
  autocompleteEnabled?: boolean;
  autocompleteGhostText?: boolean;
  autocompletePopupMenu?: boolean;
  autocompleteDebounceMs?: number;
  autocompleteMinChars?: number;
  autocompleteMaxSuggestions?: number;
  autocompleteHistoryScope?: AutocompleteHistoryScope;
  shiftEnterNewlineEnabled?: boolean;
};

export function resolveTerminalAutocompleteSettings(input: {
  protocol?: string;
  terminalSettings?: TerminalAutocompleteSettingFields;
  /** Vendor CLI / network-device session: skip live-preview PTY rewrites (#1193). */
  isNetworkDevice?: boolean;
  systemUnknown?: boolean;
}): Partial<AutocompleteSettings> | undefined {
  const { protocol, terminalSettings, isNetworkDevice, systemUnknown } = input;

  if (protocol === "serial" || systemUnknown) {
    return {
      enabled: terminalSettings?.autocompleteEnabled ?? true,
      showGhostText: terminalSettings?.autocompleteGhostText ?? true,
      showPopupMenu: terminalSettings?.autocompletePopupMenu ?? true,
      livePreview: false,
      allowLineReplacement: false,
      debounceMs: terminalSettings?.autocompleteDebounceMs ?? 100,
      minChars: terminalSettings?.autocompleteMinChars ?? 1,
      maxSuggestions: terminalSettings?.autocompleteMaxSuggestions ?? 50,
      historyScope: terminalSettings?.autocompleteHistoryScope ?? "host",
      shiftEnterNewlineEnabled: terminalSettings?.shiftEnterNewlineEnabled ?? true,
    };
  }

  if (!terminalSettings) {
    return isNetworkDevice ? { livePreview: false } : undefined;
  }

  return {
    enabled: terminalSettings.autocompleteEnabled ?? true,
    showGhostText: terminalSettings.autocompleteGhostText ?? true,
    showPopupMenu: terminalSettings.autocompletePopupMenu ?? true,
    livePreview: shouldWriteAutocompleteLivePreview(true, isNetworkDevice),
    allowLineReplacement: true,
    debounceMs: terminalSettings.autocompleteDebounceMs ?? 100,
    minChars: terminalSettings.autocompleteMinChars ?? 1,
    maxSuggestions: terminalSettings.autocompleteMaxSuggestions ?? 50,
    historyScope: terminalSettings.autocompleteHistoryScope ?? "host",
    shiftEnterNewlineEnabled: terminalSettings.shiftEnterNewlineEnabled ?? true,
  };
}
