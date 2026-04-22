/**
 * React hook for terminal autocomplete.
 * Orchestrates:
 * - Prompt detection
 * - Ghost text addon
 * - Popup menu state
 * - Keyboard interaction (→ accept, Tab toggle popup, ↑↓ navigate, Esc close)
 * - Input debouncing
 */

import { startTransition, useCallback, useEffect, useRef, useState, type RefObject } from "react";
import type { Terminal as XTerm } from "@xterm/xterm";
import { GhostTextAddon } from "./GhostTextAddon";
import { getAlignedPrompt, type PromptDetectionResult } from "./promptDetector";
import { getCompletions, parseCommandLine, type CompletionSuggestion } from "./completionEngine";
import { recordCommand } from "./commandHistoryStore";
import { preloadCommonSpecs } from "./figSpecLoader";
import { getXTermCellDimensions } from "./xtermUtils";
import { listDirectoryEntries, normalizePathTokenForLookup } from "./remotePathCompleter";

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
  popupCursorLineTop: 0,
  popupCursorLineBottom: 0,
  expandUpward: false,
  subDirPanels: [],
  subDirFocusLevel: -1,
});

export interface SubDirEntry {
  name: string;
  type: "file" | "directory" | "symlink";
}

export interface SubDirPanel {
  entries: SubDirEntry[];
  selectedIndex: number;
  /** The absolute directory path this panel lists */
  dirPath: string;
}

export interface AutocompleteState {
  suggestions: CompletionSuggestion[];
  selectedIndex: number;
  popupVisible: boolean;
  popupPosition: { x: number; y: number };
  popupCursorLineTop: number;
  popupCursorLineBottom: number;
  expandUpward: boolean;
  /** Stack of sub-directory panels (cascading: panel 0 → panel 1 → ...) */
  subDirPanels: SubDirPanel[];
  /** Which level has focus: -1 = main panel, 0+ = sub-dir panel index */
  subDirFocusLevel: number;
}

interface UseTerminalAutocompleteOptions {
  termRef: RefObject<XTerm | null>;
  sessionId: string;
  hostId: string;
  hostOs: "linux" | "windows" | "macos";
  settings?: Partial<AutocompleteSettings>;
  /** Callback to write text to the terminal session — replaces CustomEvent */
  onAcceptText?: (text: string) => void;
  /** Connection protocol for path completion routing */
  protocol?: string;
  /** Get current working directory (from OSC 7 or other source) */
  getCwd?: () => string | undefined;
}

export interface TerminalAutocompleteHandle {
  state: AutocompleteState;
  ghostTextAddon: GhostTextAddon | null;
  handleInput: (data: string) => void;
  handleKeyEvent: (e: KeyboardEvent) => boolean;
  selectSuggestion: (suggestion: CompletionSuggestion) => void;
  repositionPopup: () => void;
  closePopup: () => void;
  dispose: () => void;
}

export function useTerminalAutocomplete(
  options: UseTerminalAutocompleteOptions,
): TerminalAutocompleteHandle {
  const { termRef, sessionId, hostId, hostOs, settings: userSettings, onAcceptText, protocol, getCwd } = options;
  const rawSettings: AutocompleteSettings = {
    ...DEFAULT_AUTOCOMPLETE_SETTINGS,
    ...userSettings,
  };
  const settings: AutocompleteSettings = {
    ...rawSettings,
    showGhostText: rawSettings.showPopupMenu ? false : rawSettings.showGhostText,
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
  const protocolRef = useRef(protocol);
  protocolRef.current = protocol;
  const getCwdRef = useRef(getCwd);
  getCwdRef.current = getCwd;

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
  /** Monotonic counter to invalidate stale async sub-dir fetches */
  const subDirFetchVersionRef = useRef(0);
  /**
   * Keystroke buffer mirroring what the user has typed since the last
   * prompt boundary (Enter / Ctrl-C / Ctrl-U / cursor movement).
   *
   * detectPrompt parses the xterm buffer and can misattribute theme
   * content — e.g. oh-my-zsh robbyrussell's "➜  ~ " — as user input.
   * Keeping an independent keystroke log lets getAlignedPrompt snap the
   * detected userInput back to what was actually typed (and only when
   * the buffer matches the live line's tail), which in turn keeps
   * history recording and Tab insertion honest (#806).
   */
  const typedInputBufferRef = useRef<string>("");
  /**
   * Whether typedInputBufferRef can be trusted as the full tail of the
   * current command line. Cleared after any event this append-only buffer
   * can't follow (history recall via ↑/Ctrl-P, cursor moves, reverse
   * search, etc.). Reset to true on clean line boundaries — Enter,
   * Ctrl-C, Ctrl-U — and after we explicitly re-align via
   * insertSuggestion or a ghost-text accept.
   *
   * Without this flag, an Up-arrow-recall workflow would leave the buffer
   * holding only the post-navigation suffix, and Enter would record that
   * suffix as a command (pollutes history, misleads future completions).
   */
  const typedBufferReliableRef = useRef<boolean>(true);

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
    subDirFetchVersionRef.current++;
    setState((prev) =>
      prev.popupVisible || prev.suggestions.length > 0 ? { ...EMPTY_STATE } : prev,
    );
  }, []);

  /** Fetch directory listing via IPC. */
  const fetchDirEntries = useCallback(async (dirPath: string): Promise<SubDirEntry[]> => {
    return listDirectoryEntries(dirPath, {
      sessionId: sessionIdRef.current,
      protocol: protocolRef.current,
      foldersOnly: false,
      limit: 50,
    });
  }, []);

  /** Fetch sub-dir entries for the main panel's selected item (level 0). */
  const fetchSubDirForIndex = useCallback((index: number) => {
    const s = stateRef.current;
    if (index < 0 || index >= s.suggestions.length) return;
    const item = s.suggestions[index];
    if (item.source !== "path" || item.fileType !== "directory") {
      subDirFetchVersionRef.current++;
      setState((prev) => prev.subDirPanels.length > 0
        ? { ...prev, subDirPanels: [], subDirFocusLevel: -1 }
        : prev);
      return;
    }
    const term = termRef.current;
    const { prompt: livePrompt } = getAlignedPrompt(
      term,
      typedInputBufferRef.current,
      typedBufferReliableRef.current,
    );
    const activePrompt = livePrompt.isAtPrompt ? livePrompt : lastPromptRef.current;
    const activeWord = activePrompt?.isAtPrompt
      ? parseCommandLine(activePrompt.userInput).currentWord
      : parseCommandLine(item.text).currentWord;
    const cwd = resolveAutocompleteCwd(
      activePrompt?.promptText ?? "",
      activeWord,
      getCwdRef.current?.(),
      hostOsRef.current,
    );
    const dirPath = normalizePathTokenForLookup(parseCommandLine(item.text).currentWord, cwd);
    if (!dirPath) return;

    const requestVersion = ++subDirFetchVersionRef.current;
    fetchDirEntries(dirPath).then((entries) => {
      if (requestVersion !== subDirFetchVersionRef.current) return;
      startTransition(() => {
        setState((prev) => {
          if (prev.selectedIndex !== index) return prev;
          const nextPanels = entries.length > 0 ? [{ entries, selectedIndex: -1, dirPath }] : [];
          if (
            prev.subDirFocusLevel === -1 &&
            prev.subDirPanels.length === nextPanels.length &&
            areSubDirPanelsEqual(prev.subDirPanels, nextPanels)
          ) {
            return prev;
          }
          return {
            ...prev,
            subDirPanels: nextPanels,
            subDirFocusLevel: -1,
          };
        });
      });
    });
  }, [fetchDirEntries, termRef]);

  /** Expand a directory at the given panel level → fetch contents and push new panel.
   *  Does NOT change focus level — use moveFocus param to override. */
  const expandSubDir = useCallback((level: number, entry: SubDirEntry, moveFocus = false) => {
    const s = stateRef.current;
    const panel = s.subDirPanels[level];
    if (!panel || entry.type !== "directory") return;

    const parentPath = panel.dirPath.endsWith("/") ? panel.dirPath : panel.dirPath + "/";
    const childPath = parentPath + entry.name + "/";

    const requestVersion = ++subDirFetchVersionRef.current;
    fetchDirEntries(childPath).then((entries) => {
      if (requestVersion !== subDirFetchVersionRef.current || entries.length === 0) return;
      startTransition(() => {
        setState((prev) => {
          const currentPanel = prev.subDirPanels[level];
          if (!currentPanel || currentPanel.dirPath !== panel.dirPath) return prev;

          const nextPanels = prev.subDirPanels.slice(0, level + 1);
          nextPanels.push({ entries, selectedIndex: moveFocus ? 0 : -1, dirPath: childPath });
          const nextFocusLevel = moveFocus ? level + 1 : prev.subDirFocusLevel;

          if (
            prev.subDirFocusLevel === nextFocusLevel &&
            prev.subDirPanels.length === nextPanels.length &&
            areSubDirPanelsEqual(prev.subDirPanels, nextPanels)
          ) {
            return prev;
          }

          return {
            ...prev,
            subDirPanels: nextPanels,
            subDirFocusLevel: nextFocusLevel,
          };
        });
      });

      // When moving focus into a newly opened panel, the first item is auto-selected.
      // If that first item is itself a directory, eagerly show its next level so the
      // user doesn't need to move ↓↑ just to trigger the usual auto-expand behavior.
      const firstEntry = moveFocus ? entries[0] : null;
      if (firstEntry?.type !== "directory") return;

      const nestedChildPath = `${childPath}${firstEntry.name}/`;
      fetchDirEntries(nestedChildPath).then((nestedEntries) => {
        if (requestVersion !== subDirFetchVersionRef.current || nestedEntries.length === 0) return;
        startTransition(() => {
          setState((prev) => {
            const currentChildPanel = prev.subDirPanels[level + 1];
            if (
              !currentChildPanel ||
              currentChildPanel.dirPath !== childPath ||
              currentChildPanel.selectedIndex !== 0
            ) {
              return prev;
            }

            const nextPanels = prev.subDirPanels.slice(0, level + 2);
            nextPanels.push({ entries: nestedEntries, selectedIndex: -1, dirPath: nestedChildPath });

            if (
              prev.subDirPanels.length === nextPanels.length &&
              areSubDirPanelsEqual(prev.subDirPanels, nextPanels)
            ) {
              return prev;
            }

            return {
              ...prev,
              subDirPanels: nextPanels,
            };
          });
        });
      });
    });
  }, [fetchDirEntries]);

  // Ref to fetchSuggestions (avoids circular dep — defined after fetchSuggestions)
  const fetchSuggestionsRef = useRef<() => void>(() => {});

  const repositionPopup = useCallback(() => {
    const term = termRef.current;
    if (!term) return;

    setState((prev) => {
      if (!prev.popupVisible || prev.suggestions.length === 0) return prev;
      const { position, cursorLineTop, cursorLineBottom, expandUpward } = calculatePopupPosition(term, prev.suggestions.length);

      // Force a re-render even when the relative cursor cell hasn't changed.
      // The terminal container may have moved in the viewport after a fit/resize.
      return {
        ...prev,
        popupPosition: position,
        popupCursorLineTop: cursorLineTop,
        popupCursorLineBottom: cursorLineBottom,
        expandUpward,
      };
    });
  }, [termRef]);

  /** Handle selecting a file/directory from any sub-dir panel.
   *  Builds the full path from the panel stack and replaces the current input. */
  const handleSubDirSelect = useCallback((level: number, entry: SubDirEntry) => {
    const s = stateRef.current;
    const term = termRef.current;
    if (!term) return;

    // Build the full path: panel's dirPath + entry name
    const panel = s.subDirPanels[level];
    if (!panel) return;

    // Get current prompt to know what command prefix to keep (e.g., "cd ").
    // getAlignedPrompt handles robbyrussell-style themes by trimming the
    // cwd marker out of userInput when the typed buffer is aligned (#806).
    const { prompt } = getAlignedPrompt(term, typedInputBufferRef.current, typedBufferReliableRef.current);
    if (!prompt.isAtPrompt) return;

    // Find the command part (everything before the path argument)
    // e.g., userInput = "cd /usr/" → command prefix = "cd ", we replace the whole path
    const parsedPrompt = parseCommandLine(prompt.userInput);
    const cmdPrefix = parsedPrompt.tokens
      .slice(0, parsedPrompt.wordIndex)
      .join(" ") + (parsedPrompt.wordIndex > 0 ? " " : "");
    const currentToken = parsedPrompt.currentWord;
    const quotePrefix = currentToken.startsWith('"') || currentToken.startsWith("'")
      ? currentToken[0]
      : "";
    const quoteSuffix = quotePrefix && currentToken.endsWith(quotePrefix) ? quotePrefix : "";
    const suffix = entry.type === "directory" ? "/" : "";
    const entryName = quotePrefix || !entry.name.includes(" ")
      ? entry.name
      : entry.name.replace(/ /g, "\\ ");
    const fullPath = panel.dirPath + entryName + suffix;
    const replacementPath = `${quotePrefix}${fullPath}${quoteSuffix}`;

    // Clear current input and write: cmdPrefix + fullPath
    const isWindows = hostOsRef.current === "windows";
    const clearSeq = isWindows
      ? "\b".repeat(prompt.userInput.length)
      : "\x15";
    const newCommand = cmdPrefix + replacementPath;
    writeToTerminal(clearSeq + newCommand);
    // Sub-dir selection rewrote the whole command line; re-align the
    // keystroke buffer so the next Enter records the executed command
    // instead of whatever partial input we had before (P2 from #814).
    typedInputBufferRef.current = newCommand;
    typedBufferReliableRef.current = true;
    clearState();

    if (entry.type === "directory") {
      setTimeout(() => fetchSuggestionsRef.current(), 50);
    }
  }, [writeToTerminal, clearState, termRef]);

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

    const { prompt } = getAlignedPrompt(term, typedInputBufferRef.current, typedBufferReliableRef.current);
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
    const parsedInput = parseCommandLine(input);
    const cwd = resolveAutocompleteCwd(
      prompt.promptText,
      parsedInput.currentWord,
      getCwdRef.current?.(),
      hostOsRef.current,
    );

    // Single query for both ghost text and popup
    const completions = await getCompletions(input, {
      hostId: hostIdRef.current,
      os: hostOsRef.current,
      maxResults: settingsRef.current.maxSuggestions,
      sessionId: sessionIdRef.current,
      protocol: protocolRef.current,
      cwd,
    });

    if (disposedRef.current || version !== fetchVersionRef.current) return;

    // Discard stale results: if the user kept typing while getCompletions was running,
    // the current prompt input will have changed. Re-detect and compare.
    const { prompt: currentPrompt } = getAlignedPrompt(term, typedInputBufferRef.current, typedBufferReliableRef.current);
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
      const { position, cursorLineTop, cursorLineBottom, expandUpward } = calculatePopupPosition(term, completions.length);
      startTransition(() => {
        setState((prev) => {
          const nextState: AutocompleteState = {
            suggestions: completions,
            selectedIndex: -1,
            popupVisible: true,
            popupPosition: position,
            popupCursorLineTop: cursorLineTop,
            popupCursorLineBottom: cursorLineBottom,
            expandUpward,
            subDirPanels: [],
            subDirFocusLevel: -1,
          };

          if (
            prev.popupVisible &&
            prev.selectedIndex === nextState.selectedIndex &&
            prev.expandUpward === nextState.expandUpward &&
            prev.popupPosition.x === nextState.popupPosition.x &&
            prev.popupPosition.y === nextState.popupPosition.y &&
            prev.popupCursorLineTop === nextState.popupCursorLineTop &&
            prev.popupCursorLineBottom === nextState.popupCursorLineBottom &&
            prev.subDirFocusLevel === -1 &&
            prev.subDirPanels.length === 0 &&
            areSuggestionsEqual(prev.suggestions, nextState.suggestions)
          ) {
            return prev;
          }

          return nextState;
        });
      });
    } else {
      startTransition(() => {
        setState((prev) =>
          prev.popupVisible || prev.suggestions.length > 0
            ? { ...EMPTY_STATE }
            : prev,
        );
      });
    }
  }, [termRef, clearState]);

  // Keep ref in sync so handleSubDirSelect can call it
  fetchSuggestionsRef.current = fetchSuggestions;

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
            // Require a live prompt before trusting either keystroke buffer
            // or buffer-based detection — otherwise sudo password Enter
            // would record the typed password as a command.
            const { prompt: livePrompt, alignedTyped } = getAlignedPrompt(
              termRef.current,
              typedInputBufferRef.current,
              typedBufferReliableRef.current,
            );
            if (livePrompt.isAtPrompt) {
              // alignedTyped is only non-null when the buffer is reliable
              // AND matches the live line's tail — that single signal
              // covers both the robbyrussell "~ " case (#806) and the
              // stale-buffer cases from out-of-band pastes / history
              // recall (#814 P1/P2). When it's null we fall back to the
              // reconciled livePrompt.userInput, which for paste-bypass
              // scenarios lands on pre-PR behavior (no regression).
              if (alignedTyped && alignedTyped.trim()) {
                recordCommand(alignedTyped.trim(), hostIdRef.current, hostOsRef.current);
              } else if (livePrompt.userInput.trim()) {
                recordCommand(livePrompt.userInput.trim(), hostIdRef.current, hostOsRef.current);
              }
            } else if (lastPromptRef.current?.isAtPrompt && lastPromptRef.current.userInput.trim()) {
              // Only fall back to the cached prompt when we have no live
              // reading at all — guards against recording during interactive
              // prompts where detectPrompt correctly bails out.
              recordCommand(lastPromptRef.current.userInput.trim(), hostIdRef.current, hostOsRef.current);
            }
          }
          lastAcceptedCommandRef.current = null;
        }
        typedInputBufferRef.current = "";
        typedBufferReliableRef.current = true;
        clearState();
        return;
      }

      // Ctrl+C, Ctrl+U — clear. These kill the zle line entirely, so the
      // buffer is once again a true reflection of the (empty) line.
      if (data === "\x03" || data === "\x15") {
        typedInputBufferRef.current = "";
        typedBufferReliableRef.current = true;
        clearState();
        return;
      }

      // Backspace / DEL: drop the last typed char so the buffer stays aligned
      // with what the shell actually holds.
      if (data === "\x7f" || data === "\b") {
        typedInputBufferRef.current = typedInputBufferRef.current.slice(0, -1);
      } else if (data === "\x17") {
        // Ctrl+W: word-erase — kill the trailing whitespace + word.
        typedInputBufferRef.current = typedInputBufferRef.current.replace(/\s*\S+\s*$/, "");
      } else if (data.startsWith("\x1b[200~")) {
        // Bracketed paste: "\x1b[200~...\x1b[201~". The inner bytes are
        // literal input, so newlines stay on the zle line instead of
        // executing each segment — meaning we must preserve the whole
        // content in the buffer, not just the post-final-newline tail
        // (Codex #814 P2).
        //
        // Reliability is *inherited*, not reset: if the buffer was
        // already aligned with the line (reliable=true), appending this
        // paste keeps it aligned; if the buffer was unreliable (e.g.
        // after ↑ recalled a history command so line ≠ buffer), the
        // paste only extends the tail but the head is still whatever
        // the shell had, so the buffer stays unreliable. Without this,
        // a paste-after-recall flow would flip reliability back on and
        // Enter would record just the pasted suffix as the command
        // (Codex #814 P1 follow-up).
        const endIdx = data.indexOf("\x1b[201~");
        const content = endIdx >= 0
          ? data.slice("\x1b[200~".length, endIdx)
          : data.slice("\x1b[200~".length);
        typedInputBufferRef.current += content;
        clearState();
        return;
      } else if (data.startsWith("\x1b") && data !== "\x1b") {
        // Cursor-movement / function keys — we lose track of where the
        // cursor sits relative to our append-only buffer. Mark the
        // buffer unreliable and drop it; detectPrompt takes over until
        // the next Enter / Ctrl-C / Ctrl-U.
        typedInputBufferRef.current = "";
        typedBufferReliableRef.current = false;
      } else if (data.length === 1 && data.charCodeAt(0) >= 32) {
        typedInputBufferRef.current += data;
      } else if (data.length > 1 && !data.startsWith("\x1b")) {
        // Paste chunk. Any \r / \n inside executes the preceding text as
        // a command in the shell, so keeping the pre-newline portion in
        // our buffer would leave stale content that a later Enter could
        // record (Codex #814 P2). Drop everything up to and including
        // the last terminator and keep only the tail as new content.
        // Intermediate executed lines aren't synthesized back into
        // recordCommand here — the onCommandExecuted path in
        // createXTermRuntime still captures them independently.
        const lastCR = data.lastIndexOf("\r");
        const lastLF = data.lastIndexOf("\n");
        const nlIdx = Math.max(lastCR, lastLF);
        if (nlIdx >= 0) {
          typedInputBufferRef.current = data.slice(nlIdx + 1);
          typedBufferReliableRef.current = true;
          // The embedded newline flushed any previously-accepted
          // suggestion too — clearing the cache here prevents the next
          // Enter from falling into the lastAcceptedCommandRef fast path
          // and recording that stale command.
          lastAcceptedCommandRef.current = null;
          clearState();
          return;
        }
        typedInputBufferRef.current += data;
      } else if (data.length === 1 && data.charCodeAt(0) < 32) {
        // Any other single control char (Ctrl-A, Ctrl-E, Ctrl-B, Ctrl-F,
        // Ctrl-R, Ctrl-P, Ctrl-N, ...) moves the cursor or swaps the
        // line in ways this append-only buffer can't follow. Same story
        // as escape sequences above.
        typedInputBufferRef.current = "";
        typedBufferReliableRef.current = false;
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
        }, settingsRef.current.debounceMs * 3);
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

      // Right arrow: if popup has selected directory with sub-dir panel, enter it
      // Skip this handler entirely when sub-dir panels are focused — let the
      // sub-panel navigation block handle → for deeper expansion.
      if (e.key === "ArrowRight" && !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey && s.subDirFocusLevel < 0) {
        if (s.popupVisible && s.selectedIndex >= 0 && s.subDirPanels.length > 0) {
          const selected = s.suggestions[s.selectedIndex];
          if (selected?.fileType === "directory") {
            e.preventDefault();
            const firstEntry = s.subDirPanels[0]?.entries[0];
            setState((prev) => {
              const panels = [...prev.subDirPanels];
              if (panels[0]) panels[0] = { ...panels[0], selectedIndex: 0 };
              return { ...prev, subDirPanels: panels, subDirFocusLevel: 0 };
            });
            if (firstEntry?.type === "directory") {
              expandSubDir(0, firstEntry, false);
            }
            return false;
          }
        }
        // Otherwise: accept ghost text
        if (ghost?.isVisible()) {
          e.preventDefault();
          const ghostText = ghost.getGhostText();
          if (ghostText) {
            writeToTerminal(ghostText);
            const fullSuggestion = ghost.getSuggestion();
            lastAcceptedCommandRef.current = fullSuggestion;
            if (fullSuggestion) {
              typedInputBufferRef.current = fullSuggestion;
              typedBufferReliableRef.current = true;
            }
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
            // Only extend the buffer if it was already aligned with the
            // line — otherwise we'd end up with just the appended word,
            // which the next Enter would then record as the command.
            if (typedBufferReliableRef.current) {
              typedInputBufferRef.current += nextWord;
            }
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

      // Tab: accept selected popup suggestion. Ghost text is accepted via → only —
      // letting Tab pass through lets the shell's native completion (bash/zsh) run,
      // which is otherwise shadowed by our single-Tab ghost accept.
      if (e.key === "Tab" && !e.ctrlKey && !e.metaKey && !e.altKey && s.subDirFocusLevel < 0) {
        if (s.popupVisible && s.suggestions.length > 0) {
          e.preventDefault();
          const selected = s.suggestions[Math.max(0, s.selectedIndex)];
          if (selected) insertSuggestion(selected, false);
          return false;
        }
        // Hide stale ghost text before Tab reaches the shell — the shell's
        // completion will rewrite the line and the old ghost would mislead.
        if (ghost?.isVisible()) {
          ghost.hide();
        }
      }

      // Up/Down/Left/Right: navigate popup + sub-dir panel
      if (s.popupVisible && s.suggestions.length > 0) {

        const focusLevel = s.subDirFocusLevel;
        const focusedPanel = focusLevel >= 0 ? s.subDirPanels[focusLevel] : null;

        // Sub-dir panel focused: ↑↓ navigate, ← go back, → go deeper
        if (focusLevel >= 0 && focusedPanel) {
          if (e.key === "ArrowUp" || e.key === "ArrowDown") {
            e.preventDefault();
            const newIdx = e.key === "ArrowUp"
              ? (focusedPanel.selectedIndex <= 0 ? focusedPanel.entries.length - 1 : focusedPanel.selectedIndex - 1)
              : (focusedPanel.selectedIndex >= focusedPanel.entries.length - 1 ? 0 : focusedPanel.selectedIndex + 1);
            setState((prev) => {
              const panels = [...prev.subDirPanels];
              const p = panels[focusLevel];
              if (!p) return prev;
              panels[focusLevel] = { ...p, selectedIndex: newIdx };
              return { ...prev, subDirPanels: panels.slice(0, focusLevel + 1) };
            });
            // Auto-expand next level if the newly selected item is a directory
            const newEntry = focusedPanel.entries[newIdx];
            if (newEntry?.type === "directory") {
              expandSubDir(focusLevel, newEntry);
            }
            return false;
          }
          if (e.key === "ArrowLeft") {
            e.preventDefault();
            setState((prev) => ({
              ...prev,
              subDirPanels: prev.subDirPanels.slice(0, focusLevel + 1),
              subDirFocusLevel: focusLevel - 1,
            }));
            return false;
          }
          if (e.key === "ArrowRight") {
            const entry = focusedPanel.entries[focusedPanel.selectedIndex];
            if (entry?.type === "directory") {
              e.preventDefault();
              expandSubDir(focusLevel, entry, true); // moveFocus = true
              return false;
            }
          }
          if (e.key === "Enter" || e.key === "Tab") {
            const entry = focusedPanel.entries[focusedPanel.selectedIndex];
            if (entry && focusedPanel.selectedIndex >= 0) {
              e.preventDefault();
              handleSubDirSelect(focusLevel, entry);
              return false;
            }
          }
          if (e.key === "Escape") {
            e.preventDefault();
            if (focusLevel > 0) {
              setState((prev) => ({
                ...prev,
                subDirPanels: prev.subDirPanels.slice(0, focusLevel),
                subDirFocusLevel: focusLevel - 1,
              }));
            } else {
              setState((prev) => ({ ...prev, subDirPanels: [], subDirFocusLevel: -1 }));
            }
            return false;
          }
          if (
            e.key.length === 1 ||
            e.key === "Backspace" ||
            e.key === "Delete" ||
            e.key === "Home" ||
            e.key === "End"
          ) {
            clearState();
          }
          return true;
        }

        // Main panel navigation
        if (e.key === "ArrowUp") {
          e.preventDefault();
          setState((prev) => ({
            ...prev,
            selectedIndex: prev.selectedIndex <= 0 ? prev.suggestions.length - 1 : prev.selectedIndex - 1,
            subDirPanels: [], subDirFocusLevel: -1,
          }));
          fetchSubDirForIndex(s.selectedIndex <= 0 ? s.suggestions.length - 1 : s.selectedIndex - 1);
          return false;
        }
        if (e.key === "ArrowDown") {
          e.preventDefault();
          setState((prev) => ({
            ...prev,
            selectedIndex: prev.selectedIndex >= prev.suggestions.length - 1 ? 0 : prev.selectedIndex + 1,
            subDirPanels: [], subDirFocusLevel: -1,
          }));
          fetchSubDirForIndex(s.selectedIndex >= s.suggestions.length - 1 ? 0 : s.selectedIndex + 1);
          return false;
        }

        // Enter on popup
        if (e.key === "Enter") {
          if (s.selectedIndex >= 0) {
            const selected = s.suggestions[s.selectedIndex];
            if (selected) {
              e.preventDefault();
              insertSuggestion(selected, true);
              return false;
            }
          }
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
      // if the user typed more characters after suggestions were fetched.
      const { prompt } = getAlignedPrompt(term, typedInputBufferRef.current, typedBufferReliableRef.current);
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

      // Keystroke buffer now reflects the accepted text (either extended by
      // the insertion suffix, or wholesale replaced by the fuzzy-match path
      // that emits Ctrl-U first). Re-aligning it here keeps the subsequent
      // Enter-record honest, and flips reliability back on since we know
      // the line content exactly.
      if (execute) {
        typedInputBufferRef.current = "";
      } else {
        typedInputBufferRef.current = suggestion.text;
      }
      typedBufferReliableRef.current = true;

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
    repositionPopup,
    closePopup,
    dispose,
  };
}

function resolveAutocompleteCwd(
  promptText: string,
  currentWord: string,
  fallbackCwd: string | undefined,
  os: "linux" | "windows" | "macos",
): string | undefined {
  if (os === "windows") return fallbackCwd;

  const normalizedWord = currentWord.trim().replace(/^['"]/, "");

  // Absolute or home-relative paths don't depend on cwd
  if (normalizedWord.startsWith("/") || normalizedWord.startsWith("~/")) {
    return fallbackCwd;
  }

  // For empty word (e.g. "cd ") and relative paths, try prompt-based cwd
  // extraction which reflects the current visible prompt — more up-to-date
  // than fallbackCwd when OSC 7 is not supported.
  const promptCwd = extractPosixCwdFromPrompt(promptText);
  return chooseAutocompleteCwd(promptCwd, fallbackCwd);
}

function chooseAutocompleteCwd(
  promptCwd: string | undefined,
  fallbackCwd: string | undefined,
): string | undefined {
  if (!promptCwd) return fallbackCwd;
  if (!fallbackCwd) return promptCwd;

  // Prompt cwd is extracted from the currently visible prompt, so it tracks
  // directory changes even when OSC 7 is not supported. Prefer it over
  // fallbackCwd (which may be stale from initial connection) whenever it
  // looks like a usable path.
  if (promptCwd.startsWith("/") || promptCwd === "~" || promptCwd.startsWith("~/")) {
    return promptCwd;
  }

  // Bare directory name (e.g. "xunlong") can't be used as a path — fallback
  return fallbackCwd;
}

function extractPosixCwdFromPrompt(promptText: string): string | undefined {
  const trimmed = promptText.trimEnd().replace(/[#$%>]\s*$/, "");
  if (!trimmed) return undefined;

  const patterns = [
    /:(\/[^\s\]]*|~(?:\/[^\s\]]*)?)$/,
    /\s(\/[^\s\]]*|~(?:\/[^\s\]]*)?)\]$/,
    /(^|[\s:])(\/[^\s\]]*|~(?:\/[^\s\]]*)?)$/,
  ];

  for (const pattern of patterns) {
    const match = trimmed.match(pattern);
    if (!match) continue;
    const candidate = match[match.length - 1];
    if (candidate === "/" || candidate.startsWith("/") || candidate === "~" || candidate.startsWith("~/")) {
      return candidate;
    }
  }

  const fallbackTokens = trimmed
    .split(/\s+/)
    .map((token) => token.replace(/^[([{:]+/, "").replace(/[\])}:]+$/, ""));

  for (let index = fallbackTokens.length - 1; index >= 0; index--) {
    const candidate = fallbackTokens[index];
    if (candidate === "/" || candidate.startsWith("/") || candidate === "~" || candidate.startsWith("~/")) {
      return candidate;
    }
  }

  return undefined;
}

function areSuggestionsEqual(
  left: CompletionSuggestion[],
  right: CompletionSuggestion[],
): boolean {
  if (left.length !== right.length) return false;
  for (let i = 0; i < left.length; i++) {
    const a = left[i];
    const b = right[i];
    if (
      a.text !== b.text ||
      a.displayText !== b.displayText ||
      a.description !== b.description ||
      a.source !== b.source ||
      a.score !== b.score ||
      a.frequency !== b.frequency ||
      a.fileType !== b.fileType
    ) {
      return false;
    }
  }
  return true;
}

function areSubDirPanelsEqual(left: SubDirPanel[], right: SubDirPanel[]): boolean {
  if (left.length !== right.length) return false;
  for (let i = 0; i < left.length; i++) {
    const a = left[i];
    const b = right[i];
    if (a.dirPath !== b.dirPath || a.selectedIndex !== b.selectedIndex) return false;
    if (a.entries.length !== b.entries.length) return false;
    for (let j = 0; j < a.entries.length; j++) {
      if (a.entries[j].name !== b.entries[j].name || a.entries[j].type !== b.entries[j].type) {
        return false;
      }
    }
  }
  return true;
}

/**
 * Calculate popup position based on terminal cursor.
 */
function calculatePopupPosition(
  term: XTerm,
  itemCount: number,
): {
  position: { x: number; y: number };
  cursorLineTop: number;
  cursorLineBottom: number;
  expandUpward: boolean;
} {
  const termElement = term.element;
  if (!termElement) {
    return {
      position: { x: 0, y: 0 },
      cursorLineTop: 0,
      cursorLineBottom: 0,
      expandUpward: false,
    };
  }

  const dims = getXTermCellDimensions(term);
  const buffer = term.buffer.active;
  const cursorX = buffer.cursorX;
  const cursorY = buffer.cursorY;
  const cursorLineTop = cursorY * dims.height;
  const cursorLineBottom = (cursorY + 1) * dims.height;

  const estimatedPopupHeight = itemCount * 28 + 8;
  const totalRows = term.rows;
  const spaceBelow = (totalRows - cursorY - 1) * dims.height;
  const expandUpward = spaceBelow < estimatedPopupHeight && cursorY > 2;

  if (expandUpward) {
    return {
      position: { x: cursorX * dims.width, y: cursorY * dims.height },
      cursorLineTop,
      cursorLineBottom,
      expandUpward: true,
    };
  }

  return {
    position: { x: cursorX * dims.width, y: (cursorY + 1) * dims.height + 4 },
    cursorLineTop,
    cursorLineBottom,
    expandUpward: false,
  };
}
