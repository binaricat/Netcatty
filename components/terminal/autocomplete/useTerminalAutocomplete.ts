/**
 * React hook for terminal autocomplete.
 * Orchestrates:
 * - Prompt detection
 * - Ghost text addon
 * - Popup menu state
 * - Keyboard interaction (→ accept, Tab toggle popup, ↑↓ navigate, Esc close)
 * - Input debouncing
 */

import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import type { Terminal as XTerm } from "@xterm/xterm";
import { GhostTextAddon } from "./GhostTextAddon";
import { detectPrompt, type PromptDetectionResult } from "./promptDetector";
import { getCompletions, type CompletionSuggestion } from "./completionEngine";
import { recordCommand } from "./commandHistoryStore";
import { preloadCommonSpecs } from "./figSpecLoader";
import { getXTermCellDimensions } from "./xtermUtils";

export interface AutocompleteSettings {
  enabled: boolean;
  showGhostText: boolean;
  showPopupMenu: boolean;
  debounceMs: number;
  minChars: number;
  maxSuggestions: number;
  /** Typing speed threshold — suppress suggestions when typing faster than this (ms between keystrokes) */
  fastTypingThresholdMs: number;
}

export const DEFAULT_AUTOCOMPLETE_SETTINGS: AutocompleteSettings = {
  enabled: true,
  showGhostText: true,
  showPopupMenu: true,
  debounceMs: 100,
  minChars: 1,
  maxSuggestions: 8,
  fastTypingThresholdMs: 40,
};

/** Shared empty state to avoid creating new objects on every reset */
const EMPTY_STATE: AutocompleteState = Object.freeze({
  suggestions: [],
  selectedIndex: -1,
  popupVisible: false,
  popupPosition: { x: 0, y: 0 },
  expandUpward: false,
});

export interface AutocompleteState {
  suggestions: CompletionSuggestion[];
  selectedIndex: number;
  popupVisible: boolean;
  popupPosition: { x: number; y: number };
  expandUpward: boolean;
}

interface UseTerminalAutocompleteOptions {
  termRef: RefObject<XTerm | null>;
  sessionId: string;
  hostId: string;
  hostOs: "linux" | "windows" | "macos";
  settings?: Partial<AutocompleteSettings>;
  /** Callback to write text to the terminal session — replaces CustomEvent */
  onAcceptText?: (text: string) => void;
}

export interface TerminalAutocompleteHandle {
  state: AutocompleteState;
  ghostTextAddon: GhostTextAddon | null;
  handleInput: (data: string) => void;
  handleKeyEvent: (e: KeyboardEvent) => boolean;
  selectSuggestion: (suggestion: CompletionSuggestion) => void;
  closePopup: () => void;
  dispose: () => void;
}

export function useTerminalAutocomplete(
  options: UseTerminalAutocompleteOptions,
): TerminalAutocompleteHandle {
  const { termRef, sessionId, hostId, hostOs, settings: userSettings, onAcceptText } = options;

  const settings: AutocompleteSettings = {
    ...DEFAULT_AUTOCOMPLETE_SETTINGS,
    ...userSettings,
  };

  // Use refs for values accessed in callbacks to avoid stale closures
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const onAcceptTextRef = useRef(onAcceptText);
  onAcceptTextRef.current = onAcceptText;
  const hostIdRef = useRef(hostId);
  hostIdRef.current = hostId;
  const hostOsRef = useRef(hostOs);
  hostOsRef.current = hostOs;
  const sessionIdRef = useRef(sessionId);
  sessionIdRef.current = sessionId;

  const [state, setState] = useState<AutocompleteState>(EMPTY_STATE);

  const ghostAddonRef = useRef<GhostTextAddon | null>(null);
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastKeystrokeRef = useRef<number>(0);
  const lastPromptRef = useRef<PromptDetectionResult | null>(null);
  const disposedRef = useRef(false);
  const stateRef = useRef(state);
  stateRef.current = state;
  /** Flag to suppress handleInput's Enter recording when selectAndExecute already did it */
  const suppressNextEnterRecordRef = useRef(false);
  /** Monotonic counter to invalidate stale async completion results */
  const fetchVersionRef = useRef(0);
  /** Last accepted suggestion text — for accurate history recording on fast Enter after accept */
  const lastAcceptedCommandRef = useRef<string | null>(null);

  // Preload common specs on first mount (only if enabled)
  useEffect(() => {
    if (settings.enabled) {
      preloadCommonSpecs();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Initialize ghost text addon — poll for termRef since it's set after xterm runtime creation
  // Also clears popup/ghost when autocomplete is disabled at runtime
  useEffect(() => {
    if (!settings.enabled) {
      // Clear any visible popup/ghost when disabled
      clearState();
      return;
    }

    let addon: GhostTextAddon | null = null;
    let pollTimer: ReturnType<typeof setTimeout> | null = null;
    let cancelled = false;

    const tryActivate = () => {
      const term = termRef.current;
      if (!term || cancelled) return;
      addon = new GhostTextAddon();
      addon.activate(term);
      ghostAddonRef.current = addon;
    };

    // termRef may not be set yet on first render — poll briefly
    if (termRef.current) {
      tryActivate();
    } else {
      const poll = () => {
        if (cancelled) return;
        if (termRef.current) {
          tryActivate();
        } else {
          pollTimer = setTimeout(poll, 50);
        }
      };
      pollTimer = setTimeout(poll, 50);
    }

    return () => {
      cancelled = true;
      if (pollTimer) clearTimeout(pollTimer);
      addon?.dispose();
      ghostAddonRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, settings.enabled]);

  /**
   * Write accepted text to the terminal via callback (no CustomEvent).
   */
  const writeToTerminal = useCallback((text: string) => {
    onAcceptTextRef.current?.(text);
  }, []);

  /**
   * Clear popup/ghost state. Skips re-render if already empty.
   */
  const clearState = useCallback(() => {
    ghostAddonRef.current?.hide();
    // Bump version to invalidate any in-flight async completions
    fetchVersionRef.current++;
    setState((prev) =>
      prev.popupVisible || prev.suggestions.length > 0 ? { ...EMPTY_STATE } : prev,
    );
  }, []);

  /**
   * Fetch and display suggestions based on current input.
   * Single query path for both ghost text and popup (no duplicate queries).
   */
  const fetchSuggestions = useCallback(async () => {
    const term = termRef.current;
    if (!term || disposedRef.current || !settingsRef.current.enabled) {
      return;
    }

    // Capture version at start — if it changes during async work, discard results
    const version = ++fetchVersionRef.current;

    const prompt = detectPrompt(term);
    lastPromptRef.current = prompt;

    if (!prompt.isAtPrompt || prompt.userInput.length < settingsRef.current.minChars) {
      clearState();
      return;
    }

    // Suppress autocomplete when cursor is not at end of input —
    // inserting text mid-line would corrupt the command (e.g., "git st|tus" → "git statustus")
    const buffer = term.buffer.active;
    const lineAfterCursor = buffer.getLine(buffer.cursorY + buffer.baseY)
      ?.translateToString(false).substring(buffer.cursorX).trimEnd();
    if (lineAfterCursor && lineAfterCursor.length > 0) {
      clearState();
      return;
    }

    const input = prompt.userInput;

    // Single query for both ghost text and popup
    const completions = await getCompletions(input, {
      hostId: hostIdRef.current,
      os: hostOsRef.current,
      maxResults: settingsRef.current.maxSuggestions,
    });

    if (disposedRef.current || version !== fetchVersionRef.current) return;

    // Discard stale results: if the user kept typing while getCompletions was running,
    // the current prompt input will have changed. Re-detect and compare.
    const currentPrompt = detectPrompt(term);
    if (!currentPrompt.isAtPrompt || currentPrompt.userInput !== input) {
      return; // Input changed — these completions are stale
    }

    // Ghost text: use the best suggestion
    if (settingsRef.current.showGhostText && completions.length > 0) {
      ghostAddonRef.current?.show(completions[0].text, input);
    } else {
      ghostAddonRef.current?.hide();
    }

    // Popup
    if (settingsRef.current.showPopupMenu && completions.length > 0) {
      const { position, expandUpward } = calculatePopupPosition(term, completions.length);
      setState({
        suggestions: completions,
        selectedIndex: -1, // No item selected until user presses ↑/↓
        popupVisible: true,
        popupPosition: position,
        expandUpward,
      });
    } else {
      setState((prev) =>
        prev.popupVisible
          ? { ...EMPTY_STATE }
          : prev,
      );
    }
  }, [termRef, clearState]);

  /**
   * Handle terminal input data. Called on every character.
   */
  const handleInput = useCallback(
    (data: string) => {
      if (!settingsRef.current.enabled) return;

      const now = Date.now();
      const timeSinceLastKeystroke = now - lastKeystrokeRef.current;
      lastKeystrokeRef.current = now;

      // Command recording: Enter key
      if (data === "\r" || data === "\n") {
        // Skip recording if selectAndExecute already recorded this command
        if (suppressNextEnterRecordRef.current) {
          suppressNextEnterRecordRef.current = false;
        } else {
          // If user accepted a completion (Tab/→) and immediately pressed Enter,
          // the buffer may not reflect the accepted text yet. Use the tracked value.
          if (lastAcceptedCommandRef.current) {
            recordCommand(lastAcceptedCommandRef.current, hostIdRef.current, hostOsRef.current);
          } else {
            // Try real-time detection; fall back to cached prompt
            const livePrompt = termRef.current ? detectPrompt(termRef.current) : null;
            const prompt = (livePrompt?.isAtPrompt && livePrompt.userInput.trim())
              ? livePrompt
              : lastPromptRef.current;
            if (prompt?.isAtPrompt && prompt.userInput.trim()) {
              recordCommand(prompt.userInput.trim(), hostIdRef.current, hostOsRef.current);
            }
          }
          lastAcceptedCommandRef.current = null;
        }
        clearState();
        return;
      }

      // Ctrl+C, Ctrl+U — clear
      if (data === "\x03" || data === "\x15") {
        clearState();
        return;
      }

      // Escape sequences (arrow keys, Home, End, etc.): clear stale suggestions
      // since cursor position may have changed, making current suggestions invalid.
      // Up/Down/Right/Tab are handled by handleKeyEvent; other sequences land here.
      if (data.startsWith("\x1b") && data !== "\x1b") {
        clearState();
        return;
      }

      // User is typing more — invalidate accepted command fallback since the
      // command is being edited further (e.g., accepted "git status" then added " --short")
      lastAcceptedCommandRef.current = null;

      // Fast typing suppression: if typing faster than threshold, skip this debounce cycle
      const isFastTyping = timeSinceLastKeystroke < settingsRef.current.fastTypingThresholdMs;

      // Debounced suggestion fetch
      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current);
      }

      if (isFastTyping) {
        // Still debounce, but with a longer delay to wait for typing to pause
        debounceTimerRef.current = setTimeout(() => {
          fetchSuggestions();
        }, settingsRef.current.debounceMs * 2);
      } else {
        debounceTimerRef.current = setTimeout(() => {
          fetchSuggestions();
        }, settingsRef.current.debounceMs);
      }
    },
    [fetchSuggestions, termRef, clearState],
  );

  /**
   * Handle keyboard events for autocomplete interaction.
   * Returns false if the event was consumed (should not propagate to terminal).
   */
  const handleKeyEvent = useCallback(
    (e: KeyboardEvent): boolean => {
      if (!settingsRef.current.enabled || e.type !== "keydown") return true;

      const s = stateRef.current;
      const ghost = ghostAddonRef.current;

      // Right arrow: accept ghost text
      if (e.key === "ArrowRight" && !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey) {
        if (ghost?.isVisible()) {
          e.preventDefault();
          const ghostText = ghost.getGhostText();
          if (ghostText) {
            writeToTerminal(ghostText);
            // Track accepted command for accurate history recording on fast Enter
            lastAcceptedCommandRef.current = ghost.getSuggestion();
            ghost.hide();
            clearState();
          }
          return false;
        }
      }

      // Ctrl+Right / Alt+Right (Mac): accept next word
      if (e.key === "ArrowRight" && (e.ctrlKey || e.altKey) && !e.metaKey && !e.shiftKey) {
        if (ghost?.isVisible()) {
          e.preventDefault();
          const nextWord = ghost.getNextWord();
          if (nextWord) {
            writeToTerminal(nextWord);
            // Update ghost text to show remaining
            const fullSuggestion = ghost.getSuggestion();
            const currentInput = ghost.getGhostText().substring(nextWord.length);
            if (currentInput && fullSuggestion) {
              // Rebuild: the new input is old input + nextWord
              const oldInput = fullSuggestion.substring(0, fullSuggestion.length - ghost.getGhostText().length);
              ghost.show(fullSuggestion, oldInput + nextWord);
            } else {
              ghost.hide();
            }
          }
          return false;
        }
      }

      // Tab: accept selected popup suggestion, or accept ghost text
      if (e.key === "Tab" && !e.ctrlKey && !e.metaKey && !e.altKey) {
        if (s.popupVisible && s.suggestions.length > 0) {
          e.preventDefault();
          const selected = s.suggestions[Math.max(0, s.selectedIndex)];
          if (selected) insertSuggestion(selected, false);
          return false;
        }
        if (ghost?.isVisible()) {
          e.preventDefault();
          const ghostText = ghost.getGhostText();
          if (ghostText) {
            writeToTerminal(ghostText);
            lastAcceptedCommandRef.current = ghost.getSuggestion();
            ghost.hide();
            clearState();
          }
          return false;
        }
      }

      // Up/Down: navigate popup
      if (s.popupVisible && s.suggestions.length > 0) {
        if (e.key === "ArrowUp") {
          e.preventDefault();
          setState((prev) => ({
            ...prev,
            selectedIndex: prev.selectedIndex <= 0
              ? prev.suggestions.length - 1
              : prev.selectedIndex - 1,
          }));
          return false;
        }
        if (e.key === "ArrowDown") {
          e.preventDefault();
          setState((prev) => ({
            ...prev,
            selectedIndex: prev.selectedIndex >= prev.suggestions.length - 1
              ? 0
              : prev.selectedIndex + 1,
          }));
          return false;
        }

        // Enter on popup: only execute suggestion if user has actively selected
        // an item via ↑/↓. If no selection (selectedIndex === -1), close popup
        // and let Enter pass through to execute the user's own typed command.
        if (e.key === "Enter") {
          if (s.selectedIndex >= 0) {
            const selected = s.suggestions[s.selectedIndex];
            if (selected) {
              e.preventDefault();
              insertSuggestion(selected, true);
              return false;
            }
          }
          // No selection — close popup, let Enter propagate to terminal
          clearState();
        }
      }

      // Escape: close popup and hide ghost text
      // Only consume Escape if popup is visible; don't block Escape for vi-mode shells
      // when only ghost text is showing (ghost text is passive/non-intrusive)
      if (e.key === "Escape" && s.popupVisible) {
        e.preventDefault();
        ghost?.hide();
        clearState();
        return false;
      }

      return true;
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps -- insertSuggestion uses refs, stable identity
    [writeToTerminal],
  );

  /**
   * Insert a suggestion into the terminal.
   * @param execute If true, also sends \r to execute the command.
   */
  const insertSuggestion = useCallback(
    (suggestion: CompletionSuggestion, execute: boolean) => {
      const term = termRef.current;
      if (!term) return;

      // Always use real-time prompt detection — lastPromptRef may be stale
      // if the user typed more characters after suggestions were fetched
      const prompt = detectPrompt(term);
      if (!prompt.isAtPrompt) return;

      // If suggestion starts with the current input, insert only the remaining part.
      // Otherwise (fuzzy match), clear the line first and write the full suggestion.
      let payload: string;
      if (suggestion.text.startsWith(prompt.userInput)) {
        const textToInsert = suggestion.text.substring(prompt.userInput.length);
        payload = execute ? textToInsert + "\r" : textToInsert;
      } else {
        // Fuzzy match: clear current input, then write full command.
        // Ctrl+U works on POSIX shells (bash/zsh/fish).
        // On Windows (cmd.exe/PowerShell), use backspaces to erase instead.
        const isWindows = hostOsRef.current === "windows";
        const clearSequence = isWindows
          ? "\b".repeat(prompt.userInput.length) // Backspace to erase
          : "\x15"; // Ctrl+U (readline kill-line)
        payload = clearSequence + suggestion.text + (execute ? "\r" : "");
      }

      if (payload) {
        writeToTerminal(payload);
      }

      // Track accepted command for accurate history recording on fast Enter
      if (!execute) {
        lastAcceptedCommandRef.current = suggestion.text;
      }

      // When executing, record command here and suppress the handleInput Enter recording
      if (execute) {
        recordCommand(suggestion.text, hostIdRef.current, hostOsRef.current);
        suppressNextEnterRecordRef.current = true;
        // Safety timeout: clear the flag if handleInput's Enter doesn't consume it
        // (e.g., if xterm doesn't fire onData because handleKeyEvent returned false)
        setTimeout(() => { suppressNextEnterRecordRef.current = false; }, 100);
      }

      clearState();
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps -- clearState is stable
    [termRef, writeToTerminal],
  );

  /**
   * Select a suggestion from the popup (Tab / mouse click — insert only, no execute).
   */
  const selectSuggestion = useCallback(
    (suggestion: CompletionSuggestion) => {
      insertSuggestion(suggestion, false);
    },
    [insertSuggestion],
  );

  const closePopup = useCallback(() => {
    clearState();
  }, [clearState]);

  const dispose = useCallback(() => {
    disposedRef.current = true;
    if (debounceTimerRef.current) {
      clearTimeout(debounceTimerRef.current);
    }
    ghostAddonRef.current?.dispose();
    ghostAddonRef.current = null;
  }, []);

  useEffect(() => {
    return () => { dispose(); };
  }, [dispose]);

  return {
    state,
    ghostTextAddon: ghostAddonRef.current,
    handleInput,
    handleKeyEvent,
    selectSuggestion,
    closePopup,
    dispose,
  };
}

/**
 * Calculate popup position based on terminal cursor.
 */
function calculatePopupPosition(
  term: XTerm,
  itemCount: number,
): { position: { x: number; y: number }; expandUpward: boolean } {
  const termElement = term.element;
  if (!termElement) return { position: { x: 0, y: 0 }, expandUpward: false };

  const dims = getXTermCellDimensions(term);
  const buffer = term.buffer.active;
  const cursorX = buffer.cursorX;
  const cursorY = buffer.cursorY;

  const estimatedPopupHeight = itemCount * 28 + 8;
  const totalRows = term.rows;
  const spaceBelow = (totalRows - cursorY - 1) * dims.height;
  const expandUpward = spaceBelow < estimatedPopupHeight && cursorY > 2;

  if (expandUpward) {
    return {
      position: { x: cursorX * dims.width, y: cursorY * dims.height },
      expandUpward: true,
    };
  }

  return {
    position: { x: cursorX * dims.width, y: (cursorY + 1) * dims.height + 4 },
    expandUpward: false,
  };
}
