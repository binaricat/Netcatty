import ReactDOM from "react-dom";
import { useCallback, type ComponentProps, type RefObject } from "react";
import type { Terminal as XTerm } from "@xterm/xterm";
import {
  useTerminalAutocomplete,
  AutocompletePopup,
  type AutocompleteSettings,
} from "./autocomplete";
import type { Snippet } from "../../domain/models";
import { usePaneVisible } from "./paneVisibilityStore";
import { getWindowPluginTerminalProviderRegistry } from "../../application/state/pluginTerminalProviderRegistry";
import { provideTerminalCompletions } from "./autocomplete/terminalCompletionProviders";
import { shouldUsePluginTerminalCompletionProvider } from "../../domain/terminalPromptSecurity";

type PopupProps = ComponentProps<typeof AutocompletePopup>;

/** A mutable handler ref Terminal hands down for the xterm runtime to call. */
type HandlerRef<T> = { current: T | undefined };

interface TerminalAutocompleteProps {
  termRef: RefObject<XTerm | null>;
  sessionId: string;
  hostId: string;
  hostGroup?: string;
  hostOs: "linux" | "windows" | "macos";
  settings?: Partial<AutocompleteSettings>;
  protocol?: string;
  workspaceId?: string;
  status?: "connecting" | "connected" | "disconnected";
  /** Pane visibility fallback when paneVisibilityStore has no entry (popup terminals). */
  isVisible?: boolean;
  getCwd?: () => string | undefined;
  onAcceptText: (text: string) => void;
  snippets?: Snippet[];
  onAcceptSnippet?: (snippet: Snippet) => void;
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
  isPluginCompletionProviderAvailable?: () => boolean;
  sensitiveInputActiveRef: RefObject<boolean>;
  allowHostStyleGreaterThanPrompt?: boolean;
  /** Vendor CLI / network-device session: skip live-preview PTY rewrites (#1193). */
  isNetworkDevice?: boolean;
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
  hostGroup,
  hostOs,
  settings,
  protocol,
  workspaceId,
  status = "connected",
  isVisible = true,
  getCwd,
  onAcceptText,
  snippets,
  onAcceptSnippet,
  themeColors,
  containerRef,
  searchBarOffset,
  keyEventRef,
  inputRef,
  repositionRef,
  closeRef,
  sudoHintRef,
  sudoHintText,
  isPluginCompletionProviderAvailable,
  sensitiveInputActiveRef,
  allowHostStyleGreaterThanPrompt = false,
  isNetworkDevice = false,
}: TerminalAutocompleteProps) {
  // Self-subscribe to this pane's visibility so toggling it doesn't have to
  // flow through (and re-render) the TerminalView ctx. Popup / standalone
  // Terminal mounts never publish the store — fall back to the isVisible prop
  // (same contract as hibernate).
  const visible = usePaneVisible(sessionId, isVisible);
  const provideCompletions = useCallback(async (
    input: string,
    options: Parameters<typeof import("./autocomplete/completionEngine").getCompletions>[1] & {
      promptText: string;
      signal?: AbortSignal;
    },
  ) => {
    const normalizedProtocol: NetcattyTerminalSessionSnapshot['protocol'] = protocol ?? "ssh";
    const pluginRegistry = isPluginCompletionProviderAvailable?.() === false
      || options.allowExternalProviders === false
      || !shouldUsePluginTerminalCompletionProvider({
        sensitiveInputActive: sensitiveInputActiveRef.current === true,
        promptText: options.promptText,
        allowHostStyleGreaterThan: allowHostStyleGreaterThanPrompt,
      })
      ? null
      : getWindowPluginTerminalProviderRegistry();
    return provideTerminalCompletions(pluginRegistry, {
      input,
      session: {
        sessionId,
        ...(hostId ? { hostId } : {}),
        ...(workspaceId ? { workspaceId } : {}),
        protocol: normalizedProtocol,
        status,
        ...(options.cwd ? { cwd: options.cwd } : {}),
      },
      hostOs,
      hostGroup,
      cwdSource: options.cwdSource,
      snippets: options.snippets,
      maximum: options.maxResults ?? 15,
      historyScope: options.historyScope ?? settings?.historyScope,
      signal: options.signal,
      onLatePathSuggestions: options.onLatePathSuggestions,
    });
  }, [allowHostStyleGreaterThanPrompt, hostGroup, hostId, hostOs, isPluginCompletionProviderAvailable, protocol, sensitiveInputActiveRef, sessionId, settings?.historyScope, status, workspaceId]);
  const autocomplete = useTerminalAutocomplete({
    termRef,
    containerRef,
    sessionId,
    hostId,
    hostGroup,
    hostOs,
    settings,
    onAcceptText,
    snippets,
    onAcceptSnippet,
    protocol,
    getCwd,
    sensitiveInputActiveRef,
    provideCompletions,
    isNetworkDevice,
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
      anchorViewport={state.popupAnchorViewport}
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
