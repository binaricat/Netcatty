import ReactDOM from "react-dom";
import type { ComponentProps, RefObject } from "react";
import type { Terminal as XTerm } from "@xterm/xterm";
import {
  useTerminalAutocomplete,
  AutocompletePopup,
  type AutocompleteSettings,
} from "./autocomplete";
import type { Snippet } from "../../domain/models";

type PopupProps = ComponentProps<typeof AutocompletePopup>;

/** A mutable handler ref Terminal hands down for the xterm runtime to call. */
type HandlerRef<T> = { current: T | undefined };

interface TerminalAutocompleteProps {
  termRef: RefObject<XTerm | null>;
  sessionId: string;
  hostId: string;
  hostOs: "linux" | "windows" | "macos";
  settings?: Partial<AutocompleteSettings>;
  protocol?: string;
  getCwd?: () => string | undefined;
  onAcceptText: (text: string) => void;
  snippets?: Snippet[];
  onAcceptSnippet?: (snippet: Snippet) => void;
  /** Whether this terminal tab is the visible one. */
  visible: boolean;
  themeColors: PopupProps["themeColors"];
  containerRef: PopupProps["containerRef"];
  searchBarOffset: number;
  // Handlers exposed back to Terminal so createXTermRuntime can drive them.
  keyEventRef: HandlerRef<(e: KeyboardEvent) => boolean>;
  inputRef: HandlerRef<(data: string) => void>;
  repositionRef: HandlerRef<() => void>;
  closeRef: HandlerRef<() => void>;
  sudoHintRef: HandlerRef<(active: boolean) => boolean>;
  sudoHintText: string;
}

/**
 * Owns the terminal autocomplete hook and renders its popup.
 *
 * Kept as its own component so the frequent autocomplete state updates
 * (suggestions, selection, live-preview navigation) re-render only this small
 * subtree rather than the whole Terminal component. The hook's handlers are
 * surfaced back to Terminal through refs so the xterm runtime can call them.
 *
 * Must be mounted unconditionally for the terminal session's lifetime: the hook
 * records command history on Enter and intercepts completion keys even while no
 * popup is visible. Visibility only gates the rendered popup, not the hook.
 */
export function TerminalAutocomplete({
  termRef,
  sessionId,
  hostId,
  hostOs,
  settings,
  protocol,
  getCwd,
  onAcceptText,
  snippets,
  onAcceptSnippet,
  visible,
  themeColors,
  containerRef,
  searchBarOffset,
  keyEventRef,
  inputRef,
  repositionRef,
  closeRef,
  sudoHintRef,
  sudoHintText,
}: TerminalAutocompleteProps) {
  const autocomplete = useTerminalAutocomplete({
    termRef,
    sessionId,
    hostId,
    hostOs,
    settings,
    onAcceptText,
    snippets,
    onAcceptSnippet,
    protocol,
    getCwd,
  });

  // Surface the handlers for runtime wiring. They have stable identities
  // (useCallback over refs), so assigning during render is cheap and mirrors
  // the wiring Terminal did inline before this was extracted.
  keyEventRef.current = autocomplete.handleKeyEvent;
  inputRef.current = autocomplete.handleInput;
  repositionRef.current = autocomplete.repositionPopup;
  closeRef.current = autocomplete.closePopup;
  sudoHintRef.current = (active: boolean): boolean => {
    if (!active) {
      autocomplete.hideSudoHint();
      return false;
    }
    return autocomplete.showSudoHint(sudoHintText);
  };

  const { state } = autocomplete;
  if (!visible || !state.popupVisible || state.suggestions.length === 0) {
    return null;
  }

  // Portal to body so the popup escapes the terminal container's overflow.
  return ReactDOM.createPortal(
    <AutocompletePopup
      suggestions={state.suggestions}
      selectedIndex={state.selectedIndex}
      position={state.popupPosition}
      cursorLineTop={state.popupCursorLineTop}
      cursorLineBottom={state.popupCursorLineBottom}
      visible={state.popupVisible}
      expandUpward={state.expandUpward}
      themeColors={themeColors}
      onSelect={autocomplete.selectSuggestion}
      subDirPanels={state.subDirPanels}
      subDirFocusLevel={state.subDirFocusLevel}
      containerRef={containerRef}
      onRequestReposition={autocomplete.repositionPopup}
      searchBarOffset={searchBarOffset}
      onDismiss={autocomplete.closePopup}
    />,
    document.body,
  );
}
