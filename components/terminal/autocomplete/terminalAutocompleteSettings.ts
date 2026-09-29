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
  /** Vendor CLI / network device: skip live-preview PTY rewrites. */
  isNetworkDevice?: boolean;
  /** One-channel bastion: Ctrl-U line replacement kills the session (#1193). */
  restrictPtyRewrites?: boolean;
  systemUnknown?: boolean;
}): Partial<AutocompleteSettings> | undefined {
  const { protocol, terminalSettings, isNetworkDevice, restrictPtyRewrites, systemUnknown } = input;
  const blockLivePreview = isNetworkDevice === true || restrictPtyRewrites === true;

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
    if (!blockLivePreview && restrictPtyRewrites !== true) return undefined;
    return {
      ...(blockLivePreview ? { livePreview: false } : {}),
      ...(restrictPtyRewrites ? { allowLineReplacement: false } : {}),
    };
  }

  return {
    enabled: terminalSettings.autocompleteEnabled ?? true,
    showGhostText: terminalSettings.autocompleteGhostText ?? true,
    showPopupMenu: terminalSettings.autocompletePopupMenu ?? true,
    livePreview: shouldWriteAutocompleteLivePreview(true, blockLivePreview),
    allowLineReplacement: restrictPtyRewrites !== true,
    debounceMs: terminalSettings.autocompleteDebounceMs ?? 100,
    minChars: terminalSettings.autocompleteMinChars ?? 1,
    maxSuggestions: terminalSettings.autocompleteMaxSuggestions ?? 50,
    historyScope: terminalSettings.autocompleteHistoryScope ?? "host",
    shiftEnterNewlineEnabled: terminalSettings.shiftEnterNewlineEnabled ?? true,
  };
}
