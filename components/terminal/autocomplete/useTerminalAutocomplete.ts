/**
 * React hook for terminal autocomplete.
 * Orchestrates:
 * - Prompt detection
 * - Ghost text addon
 * - Popup menu state
 * - Keyboard interaction (→ accept, Tab toggle popup, ↑↓ navigate, Esc close)
 * - Input debouncing
 * - History recording
 */

import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import type { Terminal as XTerm } from "@xterm/xterm";
import { GhostTextAddon } from "./GhostTextAddon";
import { detectPrompt, type PromptDetectionResult } from "./promptDetector";
import {
  getCompletions,
  getInlineSuggestion,
  type CompletionSuggestion,
} from "./completionEngine";
import { recordCommand } from "./commandHistoryStore";
import { preloadCommonSpecs } from "./figSpecLoader";

export interface AutocompleteSettings {
  /** Enable/disable the autocomplete system */
  enabled: boolean;
  /** Show ghost text inline suggestions */
  showGhostText: boolean;
  /** Show popup menu for multiple suggestions */
  showPopupMenu: boolean;
  /** Debounce delay in ms for fetching suggestions */
  debounceMs: number;
  /** Minimum characters before showing suggestions */
  minChars: number;
  /** Maximum suggestions in popup menu */
  maxSuggestions: number;
  /** Typing speed threshold — disable when typing faster than this (ms between keystrokes) */
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

export interface AutocompleteState {
  /** Current suggestions for popup */
  suggestions: CompletionSuggestion[];
  /** Selected index in popup (-1 = none) */
  selectedIndex: number;
  /** Whether popup is visible */
  popupVisible: boolean;
  /** Popup position (px) */
  popupPosition: { x: number; y: number };
  /** Whether popup expands upward (when cursor is near bottom) */
  expandUpward: boolean;
}

interface UseTerminalAutocompleteOptions {
  termRef: RefObject<XTerm | null>;
  sessionId: string;
  hostId: string;
  hostOs: "linux" | "windows" | "macos";
  settings?: Partial<AutocompleteSettings>;
  /** Called when a command is accepted (for recording) */
  onCommandRecorded?: (command: string) => void;
}

/**
 * Hook return type
 */
export interface TerminalAutocompleteHandle {
  /** Current popup state */
  state: AutocompleteState;
  /** The GhostTextAddon instance (for manual control) */
  ghostTextAddon: GhostTextAddon | null;
  /** Handle terminal input data (call from onData) */
  handleInput: (data: string) => void;
  /** Handle key events (call from attachCustomKeyEventHandler) */
  handleKeyEvent: (e: KeyboardEvent) => boolean;
  /** Select a suggestion from the popup */
  selectSuggestion: (suggestion: CompletionSuggestion) => void;
  /** Close the popup */
  closePopup: () => void;
  /** Dispose of all resources */
  dispose: () => void;
}

export function useTerminalAutocomplete(
  options: UseTerminalAutocompleteOptions,
): TerminalAutocompleteHandle {
  const { termRef, sessionId, hostId, hostOs, settings: userSettings } = options;

  const settings: AutocompleteSettings = {
    ...DEFAULT_AUTOCOMPLETE_SETTINGS,
    ...userSettings,
  };

  const settingsRef = useRef(settings);
  settingsRef.current = settings;

  const [state, setState] = useState<AutocompleteState>({
    suggestions: [],
    selectedIndex: -1,
    popupVisible: false,
    popupPosition: { x: 0, y: 0 },
    expandUpward: false,
  } as AutocompleteState);

  const ghostAddonRef = useRef<GhostTextAddon | null>(null);
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastKeystrokeRef = useRef<number>(0);
  const lastPromptRef = useRef<PromptDetectionResult | null>(null);
  const disposedRef = useRef(false);
  const stateRef = useRef(state);
  stateRef.current = state;

  // Preload common specs on first mount
  useEffect(() => {
    preloadCommonSpecs();
  }, []);

  // Initialize ghost text addon
  useEffect(() => {
    const term = termRef.current;
    if (!term || !settings.enabled) return;

    const addon = new GhostTextAddon();
    addon.activate(term);
    ghostAddonRef.current = addon;

    return () => {
      addon.dispose();
      ghostAddonRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, settings.enabled]);

  /**
   * Fetch and display suggestions based on current input.
   */
  const fetchSuggestions = useCallback(async () => {
    const term = termRef.current;
    if (!term || disposedRef.current || !settingsRef.current.enabled) return;

    const prompt = detectPrompt(term);
    lastPromptRef.current = prompt;

    if (!prompt.isAtPrompt || prompt.userInput.length < settingsRef.current.minChars) {
      ghostAddonRef.current?.hide();
      setState((prev) =>
        prev.popupVisible || prev.suggestions.length > 0
          ? { ...prev, suggestions: [], popupVisible: false, selectedIndex: -1 }
          : prev,
      );
      return;
    }

    const input = prompt.userInput;

    // Ghost text: show single best suggestion
    if (settingsRef.current.showGhostText) {
      const inline = await getInlineSuggestion(input, { hostId, os: hostOs });
      if (inline && !disposedRef.current) {
        ghostAddonRef.current?.show(inline, input);
      } else {
        ghostAddonRef.current?.hide();
      }
    }

    // Popup: fetch multiple suggestions
    if (settingsRef.current.showPopupMenu) {
      const completions = await getCompletions(input, {
        hostId,
        os: hostOs,
        maxResults: settingsRef.current.maxSuggestions,
      });

      if (disposedRef.current) return;

      if (completions.length > 0) {
        const { position, expandUpward } = calculatePopupPosition(term, completions.length);
        setState({
          suggestions: completions,
          selectedIndex: 0,
          popupVisible: true,
          popupPosition: position,
          expandUpward,
        });
      } else {
        setState((prev) =>
          prev.popupVisible
            ? { ...prev, suggestions: [], popupVisible: false, selectedIndex: -1, expandUpward: false }
            : prev,
        );
      }
    }
  }, [termRef, hostId, hostOs]);

  /**
   * Handle terminal input data. Called on every character.
   */
  const handleInput = useCallback(
    (data: string) => {
      if (!settingsRef.current.enabled) return;

      const now = Date.now();

      // Fast typing detection — suppress if typing too fast
      const timeSinceLastKeystroke = now - lastKeystrokeRef.current;
      lastKeystrokeRef.current = now;

      if (timeSinceLastKeystroke < settingsRef.current.fastTypingThresholdMs) {
        // User is typing fast, don't show suggestions yet
        // But still debounce — they might pause
      }

      // Command recording: Enter key
      if (data === "\r" || data === "\n") {
        const prompt = lastPromptRef.current ?? (termRef.current ? detectPrompt(termRef.current) : null);
        if (prompt?.isAtPrompt && prompt.userInput.trim()) {
          recordCommand(prompt.userInput.trim(), hostId, hostOs);
        }
        ghostAddonRef.current?.hide();
        setState({
          suggestions: [],
          selectedIndex: -1,
          popupVisible: false,
          popupPosition: { x: 0, y: 0 },
        });
        return;
      }

      // Ctrl+C, Ctrl+U — clear
      if (data === "\x03" || data === "\x15") {
        ghostAddonRef.current?.hide();
        setState({
          suggestions: [],
          selectedIndex: -1,
          popupVisible: false,
          popupPosition: { x: 0, y: 0 },
        });
        return;
      }

      // Ignore escape sequences (arrow keys, etc.)
      if (data.startsWith("\x1b") && data !== "\x1b") {
        return;
      }

      // Debounced suggestion fetch
      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current);
      }
      debounceTimerRef.current = setTimeout(() => {
        fetchSuggestions();
      }, settingsRef.current.debounceMs);
    },
    [fetchSuggestions, hostId, hostOs, termRef],
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
          acceptFullSuggestion();
          return false;
        }
      }

      // Ctrl+Right / Alt+Right (Mac): accept next word
      if (e.key === "ArrowRight" && (e.ctrlKey || e.altKey) && !e.metaKey && !e.shiftKey) {
        if (ghost?.isVisible()) {
          e.preventDefault();
          acceptNextWord();
          return false;
        }
      }

      // Tab: accept selected popup suggestion, or toggle popup
      if (e.key === "Tab" && !e.ctrlKey && !e.metaKey && !e.altKey) {
        if (s.popupVisible && s.suggestions.length > 0) {
          e.preventDefault();
          const selected = s.suggestions[Math.max(0, s.selectedIndex)];
          if (selected) {
            selectSuggestion(selected);
          }
          return false;
        }
        // If ghost text is visible and no popup, accept ghost text
        if (ghost?.isVisible()) {
          e.preventDefault();
          acceptFullSuggestion();
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

        // Enter on popup: select current item
        if (e.key === "Enter") {
          const selected = s.suggestions[Math.max(0, s.selectedIndex)];
          if (selected) {
            e.preventDefault();
            selectSuggestion(selected);
            return false;
          }
        }
      }

      // Escape: close popup and hide ghost text
      if (e.key === "Escape") {
        if (s.popupVisible || ghost?.isVisible()) {
          e.preventDefault();
          ghost?.hide();
          setState({
            suggestions: [],
            selectedIndex: -1,
            popupVisible: false,
            popupPosition: { x: 0, y: 0 },
          });
          return false;
        }
      }

      return true;
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  /**
   * Accept the full ghost text suggestion.
   */
  const acceptFullSuggestion = useCallback(() => {
    const ghost = ghostAddonRef.current;
    const term = termRef.current;
    if (!ghost || !term) return;

    const ghostText = ghost.getGhostText();
    if (!ghostText) return;

    // Write the remaining text to the terminal
    // We need to use writeToSession, but from here we just fire
    // a custom event that the Terminal component can listen to
    const event = new CustomEvent("autocomplete:accept", {
      detail: { text: ghostText, sessionId },
    });
    term.element?.dispatchEvent(event);

    ghost.hide();
    setState({
      suggestions: [],
      selectedIndex: -1,
      popupVisible: false,
      popupPosition: { x: 0, y: 0 },
    });
  }, [termRef, sessionId]);

  /**
   * Accept the next word from ghost text.
   */
  const acceptNextWord = useCallback(() => {
    const ghost = ghostAddonRef.current;
    const term = termRef.current;
    if (!ghost || !term) return;

    const nextWord = ghost.getNextWord();
    if (!nextWord) return;

    const event = new CustomEvent("autocomplete:accept", {
      detail: { text: nextWord, sessionId },
    });
    term.element?.dispatchEvent(event);

    // Update ghost text to show remaining
    const remaining = ghost.getGhostText().substring(nextWord.length);
    if (remaining) {
      const prompt = detectPrompt(term);
      if (prompt.isAtPrompt) {
        ghost.show(prompt.userInput + nextWord + remaining, prompt.userInput + nextWord);
      }
    } else {
      ghost.hide();
    }
  }, [termRef, sessionId]);

  /**
   * Select a suggestion from the popup.
   */
  const selectSuggestion = useCallback(
    (suggestion: CompletionSuggestion) => {
      const term = termRef.current;
      if (!term) return;

      const prompt = lastPromptRef.current ?? detectPrompt(term);
      if (!prompt.isAtPrompt) return;

      // Calculate text to insert: the suggestion minus what's already typed
      let textToInsert: string;
      if (suggestion.source === "history") {
        // For history, replace the entire input line
        textToInsert = suggestion.text.substring(prompt.userInput.length);
      } else {
        // For spec suggestions, the text field is the full rebuilt command
        textToInsert = suggestion.text.substring(prompt.userInput.length);
      }

      if (textToInsert) {
        const event = new CustomEvent("autocomplete:accept", {
          detail: { text: textToInsert, sessionId },
        });
        term.element?.dispatchEvent(event);
      }

      ghostAddonRef.current?.hide();
      setState({
        suggestions: [],
        selectedIndex: -1,
        popupVisible: false,
        popupPosition: { x: 0, y: 0 },
      });
    },
    [termRef, sessionId],
  );

  /**
   * Close the popup.
   */
  const closePopup = useCallback(() => {
    ghostAddonRef.current?.hide();
    setState({
      suggestions: [],
      selectedIndex: -1,
      popupVisible: false,
      popupPosition: { x: 0, y: 0 },
    });
  }, []);

  /**
   * Dispose all resources.
   */
  const dispose = useCallback(() => {
    disposedRef.current = true;
    if (debounceTimerRef.current) {
      clearTimeout(debounceTimerRef.current);
    }
    ghostAddonRef.current?.dispose();
    ghostAddonRef.current = null;
  }, []);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      dispose();
    };
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
 * When the cursor is near the bottom of the terminal, the popup expands upward.
 */
function calculatePopupPosition(
  term: XTerm,
  itemCount: number,
): { position: { x: number; y: number }; expandUpward: boolean } {
  const termElement = term.element;
  if (!termElement) return { position: { x: 0, y: 0 }, expandUpward: false };

  const coreAccess = term as XTerm & {
    _core?: { _renderService?: { dimensions?: { css?: { cell?: { width: number; height: number } } } } };
  };
  const cellWidth = coreAccess._core?._renderService?.dimensions?.css?.cell?.width ?? 8;
  const cellHeight = coreAccess._core?._renderService?.dimensions?.css?.cell?.height ?? 16;

  const buffer = term.buffer.active;
  const cursorX = buffer.cursorX;
  const cursorY = buffer.cursorY;

  // Estimate popup height: each item ~28px + 8px padding
  const estimatedPopupHeight = itemCount * 28 + 8;
  // Available space below the cursor line
  const totalRows = term.rows;
  const spaceBelow = (totalRows - cursorY - 1) * cellHeight;

  const expandUpward = spaceBelow < estimatedPopupHeight && cursorY > 2;

  if (expandUpward) {
    // Position: bottom edge of popup aligns with the cursor line
    return {
      position: {
        x: cursorX * cellWidth,
        y: cursorY * cellHeight, // top of cursor row — popup will grow upward from here
      },
      expandUpward: true,
    };
  }

  // Default: below the cursor
  return {
    position: {
      x: cursorX * cellWidth,
      y: (cursorY + 1) * cellHeight + 4,
    },
    expandUpward: false,
  };
}
