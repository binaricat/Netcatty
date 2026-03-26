export { useTerminalAutocomplete, DEFAULT_AUTOCOMPLETE_SETTINGS } from "./useTerminalAutocomplete";
export type { AutocompleteSettings, AutocompleteState, TerminalAutocompleteHandle } from "./useTerminalAutocomplete";
export { default as AutocompletePopup } from "./AutocompletePopup";
export type { CompletionSuggestion, SuggestionSource } from "./completionEngine";
export { recordCommand, clearHistory, deleteHistoryEntry, getHistoryCount } from "./commandHistoryStore";
