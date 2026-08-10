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
import {
  getAlignedPrompt,
  type PromptDetectionResult,
} from "./promptDetector";
import { getCompletions, parseCommandLine, type CompletionSuggestion } from "./completionEngine";
import type { Snippet } from "../../../domain/models";
import { recordCommand } from "./commandHistoryStore";
import { seedLocalShellHistoryFromHistfiles } from "./localShellHistorySeed";
import { shellEscape } from "./completionEngine";
import { preloadCommonSpecs } from "./figSpecLoader";
import {
  listDirectoryEntries,
  normalizePathTokenForLookup,
  shouldPreferRemoteShellCwd,
} from "./remotePathCompleter";
import { decideGhostSuggestion } from "./ghostSuggestionPolicy";
import {
  areSubDirPanelsEqual,
  areSuggestionsEqual,
  resolveAutocompleteAnchorInViewport,
  resolveAutocompleteCursorCell,
  resolveAutocompleteCwdWithSource,
  resolvePreservedSuggestionIndex,
} from "./terminalAutocompleteLayout";
import { handleTerminalAutocompleteInput } from "./terminalAutocompleteInput";
import { handleTerminalAutocompleteKeyEvent } from "./terminalAutocompleteKeyEvent";
import {
  computeAutocompleteAcceptWrite,
  isSameAutocompleteQuery,
  resolveAutocompleteQueryInput,
} from "./terminalAutocompletePrompt";
import { isTerminalAlternateScreenActive } from "../terminalHibernateRuntime";

export interface AutocompleteSettings {
  enabled: boolean;
  showGhostText: boolean;
  showPopupMenu: boolean;
  /** Whether popup navigation should render the highlighted candidate into the terminal input line. */
  livePreview: boolean;
  /** Whether accepting a candidate may clear/replace the current input line. */
  allowLineReplacement: boolean;
  debounceMs: number;
  minChars: number;
  maxSuggestions: number;
  /** Typing speed threshold — suppress suggestions when typing faster than this (ms between keystrokes) */
  fastTypingThresholdMs: number;
  /** Whether Shift+Enter is reserved for the terminal's configured send text. */
  shiftEnterNewlineEnabled: boolean;
  /** Which history pool suggestions draw from (current host vs all hosts). */
  historyScope: "host" | "global";
}

export const DEFAULT_AUTOCOMPLETE_SETTINGS: AutocompleteSettings = {
  enabled: true,
  showGhostText: true,
  showPopupMenu: true,
  livePreview: true,
  allowLineReplacement: true,
  debounceMs: 100,
  minChars: 1,
  maxSuggestions: 50,
  fastTypingThresholdMs: 40,
  shiftEnterNewlineEnabled: true,
  historyScope: "host",
};

/** Max time to poll for shell echo after a pre-echo debounce cycle (#2813). */
const ECHO_VALIDATION_MAX_WAIT_MS = 3000;

/**
 * Whether completion work is worth doing — i.e. whether anything would
 * actually be rendered. With both the popup and ghost text disabled, querying
 * completions only to discard the result is pure main-thread waste, so callers
 * skip it entirely.
 */
export function shouldQueryCompletions(
  settings: Pick<AutocompleteSettings, "showPopupMenu" | "showGhostText">,
): boolean {
  return settings.showPopupMenu || settings.showGhostText;
}

/** Shared empty state to avoid creating new objects on every reset */
const EMPTY_STATE: AutocompleteState = Object.freeze({
  suggestions: [],
  selectedIndex: -1,
  popupVisible: false,
  popupAnchorViewport: { left: 0, top: 0, bottom: 0 },
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
  popupAnchorViewport: { left: number; top: number; bottom: number };
  expandUpward: boolean;
  /** Stack of sub-directory panels (cascading: panel 0 → panel 1 → ...) */
  subDirPanels: SubDirPanel[];
  /** Which level has focus: -1 = main panel, 0+ = sub-dir panel index */
  subDirFocusLevel: number;
}

type HostCompletionProviderOptions = Parameters<typeof getCompletions>[1] & {
  /** Host-owned prompt identity used to gate third-party Provider access. */
  promptText: string;
  /**
   * False when input was synthesized from the pre-echo keystroke buffer.
   * External Providers must stay disabled until the live line validates input.
   */
  allowExternalProviders?: boolean;
  /** Aborted whenever the prompt/session security state invalidates this query. */
  signal?: AbortSignal;
};

interface UseTerminalAutocompleteOptions {
  termRef: RefObject<XTerm | null>;
  containerRef: RefObject<HTMLElement | null>;
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
  /** Custom snippets to surface at the command position */
  snippets?: Snippet[];
  /** Accept a snippet — clears typed input then runs it (host-canonical send) */
  onAcceptSnippet?: (snippet: Snippet) => void;
  /** Host-owned completion Provider adapter; defaults to Netcatty's built-in Provider. */
  provideCompletions?: (
    input: string,
    options: HostCompletionProviderOptions,
  ) => Promise<CompletionSuggestion[]>;
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
  showSudoHint: (text: string) => boolean;
  hideSudoHint: () => void;
}

export {
  computeAutocompleteAcceptWrite,
  getCommandToRecordOnEnter,
  resolveAutocompleteQueryInput,
} from "./terminalAutocompletePrompt";

export function useTerminalAutocomplete(
  options: UseTerminalAutocompleteOptions,
): TerminalAutocompleteHandle {
  const { termRef, containerRef, sessionId, hostId, hostOs, settings: userSettings, onAcceptText, protocol, getCwd, snippets, onAcceptSnippet, provideCompletions } = options;
  const rawSettings: AutocompleteSettings = {
    ...DEFAULT_AUTOCOMPLETE_SETTINGS,
    ...userSettings,
  };
  // Mutual-exclusivity guard matching the repo-wide contract:
  //   - SettingsTerminalTab toggles one off when the other is enabled.
  //   - domain/models.ts normalizes stored settings so popup wins.
  // Keep the guard here too so callers that pass DEFAULT_AUTOCOMPLETE_SETTINGS
  // directly (e.g. tests or future embedders) don't end up rendering both
  // systems at once. In the normal Terminal.tsx → store path only one of
  // the two arrives as true, so this is defensive, not load-bearing.
  const settings: AutocompleteSettings = {
    ...rawSettings,
    showGhostText: rawSettings.showPopupMenu ? false : rawSettings.showGhostText,
  };

  // Use refs for values accessed in callbacks to avoid stale closures
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const onAcceptTextRef = useRef(onAcceptText);
  onAcceptTextRef.current = onAcceptText;
  const snippetsRef = useRef(snippets);
  snippetsRef.current = snippets;
  const onAcceptSnippetRef = useRef(onAcceptSnippet);
  onAcceptSnippetRef.current = onAcceptSnippet;
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
  const provideCompletionsRef = useRef(provideCompletions ?? getCompletions);
  provideCompletionsRef.current = provideCompletions ?? getCompletions;

  const [state, setState] = useState<AutocompleteState>(EMPTY_STATE);

  const ghostAddonRef = useRef<GhostTextAddon | null>(null);
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /**
   * Pre-echo debounce cycles must poll until the live line validates the
   * keystroke buffer (or we give up). PTY echo updates xterm only and does
   * not schedule another fetchSuggestions — without this, whole-word IME /
   * high-latency SSH commits never show completions until the next key.
   */
  const echoValidationTypedRef = useRef<string | null>(null);
  const echoValidationStartedAtRef = useRef<number | null>(null);
  const lastKeystrokeRef = useRef<number>(0);
  const lastPromptRef = useRef<PromptDetectionResult | null>(null);
  const disposedRef = useRef(false);
  const stateRef = useRef(state);
  stateRef.current = state;
  /** Flag to suppress handleInput's Enter recording when selectAndExecute already did it */
  const suppressNextEnterRecordRef = useRef(false);
  /** Monotonic counter to invalidate stale async completion results */
  const fetchVersionRef = useRef(0);
  const completionAbortRef = useRef<AbortController | null>(null);
  /** Last accepted suggestion text — for accurate history recording on fast Enter after accept */
  const lastAcceptedCommandRef = useRef<string | null>(null);
  /** The user's typed input that produced the current popup suggestions (live-preview baseline). */
  const previewBaselineRef = useRef<string>("");
  /** Whether a popup candidate is currently rendered into the command line (#1005). */
  const previewActiveRef = useRef(false);
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

  // Local Terminal: seed autocomplete history from ~/.zsh_history (etc.) once
  // per stable hostId so prefix suggestions match Ghostty-style histfile recall
  // (#2037). Remote sessions keep reading history via the side panel instead.
  useEffect(() => {
    if (!settings.enabled) return;
    if (protocol !== "local") return;
    if (!hostId) return;
    void seedLocalShellHistoryFromHistfiles(hostId, hostOs);
  }, [settings.enabled, protocol, hostId, hostOs]);

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

  // Hide any active ghost when the user turns showGhostText off mid-
  // session. The fetchSuggestions branch (~L531) already gates new
  // shows on the flag, but a ghost that was already on screen at toggle
  // time would otherwise keep sliding around under a disabled setting
  // until something unrelated called clearState (Codex #815 P2).
  useEffect(() => {
    if (!settings.showGhostText) {
      ghostAddonRef.current?.hide();
    }
  }, [settings.showGhostText]);

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
    if (debounceTimerRef.current) {
      clearTimeout(debounceTimerRef.current);
      debounceTimerRef.current = null;
    }
    echoValidationTypedRef.current = null;
    echoValidationStartedAtRef.current = null;
    ghostAddonRef.current?.hide();
    completionAbortRef.current?.abort();
    completionAbortRef.current = null;
    // Bump version to invalidate any in-flight async completions
    fetchVersionRef.current++;
    subDirFetchVersionRef.current++;
    setState((prev) =>
      prev.popupVisible || prev.suggestions.length > 0 ? { ...EMPTY_STATE } : prev,
    );
  }, []);

  const repositionPopup = useCallback(() => {
    const term = termRef.current;
    if (!term) return;

    setState((prev) => {
      if (!prev.popupVisible || prev.suggestions.length === 0) return prev;
      const { prompt } = getAlignedPrompt(term, typedInputBufferRef.current, typedBufferReliableRef.current);
      const queryInput = resolveAutocompleteQueryInput(
        prompt,
        typedInputBufferRef.current,
        typedBufferReliableRef.current,
      );
      // Prefer resolved query input for anchoring so lagging remote echo does
      // not leave the popup behind the typed command (main CursorCell helper).
      const cursorCell = prompt.isAtPrompt && queryInput !== null
        ? resolveAutocompleteCursorCell(term, {
          promptText: prompt.promptText,
          userInput: queryInput,
        })
        : {
          column: term.buffer.active.cursorX,
          row: term.buffer.active.cursorY,
        };
      const anchor = resolveAutocompleteAnchorInViewport(
        term,
        containerRef.current,
        prev.suggestions.length,
        cursorCell.column,
        cursorCell.row,
      );

      // Force a re-render even when the relative cursor cell hasn't changed.
      // The terminal container may have moved in the viewport after a fit/resize.
      return {
        ...prev,
        popupAnchorViewport: {
          left: anchor.anchorLeft,
          top: anchor.anchorTop,
          bottom: anchor.anchorBottom,
        },
        expandUpward: anchor.expandUpward,
      };
    });
  }, [containerRef, termRef]);

  /** Fetch directory listing via IPC. */
  const fetchDirEntries = useCallback(async (dirPath: string): Promise<SubDirEntry[]> => {
    return listDirectoryEntries(dirPath, {
      sessionId: sessionIdRef.current,
      protocol: protocolRef.current,
      os: hostOsRef.current,
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
    const activeLine = activePrompt
      ? resolveAutocompleteQueryInput(
        activePrompt,
        typedInputBufferRef.current,
        typedBufferReliableRef.current,
      )
      : null;
    const activeWord = activeLine !== null
      ? parseCommandLine(activeLine).currentWord
      : parseCommandLine(item.text).currentWord;
    const cwdResolution = resolveAutocompleteCwdWithSource(
      activePrompt?.promptText ?? "",
      activeWord,
      getCwdRef.current?.(),
      hostOsRef.current,
    );
    const dirPath = normalizePathTokenForLookup(parseCommandLine(item.text).currentWord, cwdResolution.cwd, {
      preferRelativeCwd: shouldPreferRemoteShellCwd(
        protocolRef.current,
        sessionIdRef.current,
        hostOsRef.current,
        cwdResolution.cwd,
        cwdResolution.source,
      ),
    });
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
      // Adding/removing sub-dir panels changes the popup's total width, which
      // can push it off-screen. Recompute placement after state settles.
      requestAnimationFrame(() => {
        repositionPopup();
      });
    });
  }, [fetchDirEntries, repositionPopup, termRef]);

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

  /**
   * Render the full path for a sub-dir entry into the line WITHOUT finalizing
   * (no clearState). Used for live-preview while navigating sub-dir panels (#1005).
   */
  const renderSubDirPath = useCallback((level: number, entry: SubDirEntry) => {
    const s = stateRef.current;
    const term = termRef.current;
    if (!term) return;
    const panel = s.subDirPanels[level];
    if (!panel) return;
    const { prompt } = getAlignedPrompt(
      term, typedInputBufferRef.current, typedBufferReliableRef.current,
    );
    const line = resolveAutocompleteQueryInput(
      prompt,
      typedInputBufferRef.current,
      typedBufferReliableRef.current,
    );
    if (line === null) return;
    const parsed = parseCommandLine(line);
    const cmdPrefix = parsed.tokens.slice(0, parsed.wordIndex).join(" ")
      + (parsed.wordIndex > 0 ? " " : "");
    const currentToken = parsed.currentWord;
    const quotePrefix = currentToken.startsWith('"') || currentToken.startsWith("'")
      ? currentToken[0] : "";
    const quoteSuffix = quotePrefix && currentToken.endsWith(quotePrefix) ? quotePrefix : "";
    const suffix = entry.type === "directory" ? "/" : "";
    const entryName = quotePrefix || !/[\\$'"|!<>;#~` ]/.test(entry.name)
      ? entry.name : shellEscape(entry.name);
    const newCommand = cmdPrefix + `${quotePrefix}${panel.dirPath}${entryName}${suffix}${quoteSuffix}`;
    const seq = computeAutocompleteAcceptWrite({
      prompt,
      typedBuffer: typedInputBufferRef.current,
      typedBufferReliable: typedBufferReliableRef.current,
      candidate: newCommand,
      os: hostOsRef.current,
    });
    if (seq) writeToTerminal(seq);
    typedInputBufferRef.current = newCommand;
    typedBufferReliableRef.current = true;
    previewActiveRef.current = true;
    lastAcceptedCommandRef.current = newCommand;
  }, [termRef, writeToTerminal]);

  /** Handle selecting a file/directory from any sub-dir panel.
   *  Builds the full path from the panel stack and replaces the current input. */
  const handleSubDirSelect = useCallback((level: number, entry: SubDirEntry) => {
    const s = stateRef.current;
    const term = termRef.current;
    if (!term) return;

    // Build the full path: panel's dirPath + entry name
    const panel = s.subDirPanels[level];
    if (!panel) return;

    // getAlignedPrompt handles robbyrussell-style themes by trimming the
    // cwd marker out of userInput when the typed buffer is aligned (#806).
    // Mutation baseline still prefers the reliable typed buffer when echo lags
    // (#2830), matching suggestion matching / live-preview.
    const { prompt } = getAlignedPrompt(term, typedInputBufferRef.current, typedBufferReliableRef.current);
    const line = resolveAutocompleteQueryInput(
      prompt,
      typedInputBufferRef.current,
      typedBufferReliableRef.current,
    );
    if (line === null) return;

    // Find the command part (everything before the path argument)
    // e.g., userInput = "cd /usr/" → command prefix = "cd ", we replace the whole path
    const parsedPrompt = parseCommandLine(line);
    const cmdPrefix = parsedPrompt.tokens
      .slice(0, parsedPrompt.wordIndex)
      .join(" ") + (parsedPrompt.wordIndex > 0 ? " " : "");
    const currentToken = parsedPrompt.currentWord;
    const quotePrefix = currentToken.startsWith('"') || currentToken.startsWith("'")
      ? currentToken[0]
      : "";
    const quoteSuffix = quotePrefix && currentToken.endsWith(quotePrefix) ? quotePrefix : "";
    const suffix = entry.type === "directory" ? "/" : "";
    const entryName = quotePrefix || !/[\\$'"|!<>;#~` ]/.test(entry.name)
      ? entry.name
      : shellEscape(entry.name);
    const fullPath = panel.dirPath + entryName + suffix;
    const replacementPath = `${quotePrefix}${fullPath}${quoteSuffix}`;
    const newCommand = cmdPrefix + replacementPath;
    const payload = computeAutocompleteAcceptWrite({
      prompt,
      typedBuffer: typedInputBufferRef.current,
      typedBufferReliable: typedBufferReliableRef.current,
      candidate: newCommand,
      os: hostOsRef.current,
    });
    if (payload === null) return;
    if (payload) writeToTerminal(payload);
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

    // Suppress autocomplete for the entire alternate screen buffer (codex CLI,
    // vim, htop, less, …). Full-screen apps own their own input UI there;
    // Netcatty's popup/ghost text would clash — e.g. codex's "/" slash-command
    // menu gets covered because the composer line also matches the shell-prompt
    // heuristic. This is intentionally unconditional: multiplexers (tmux/screen)
    // also keep the outer xterm on the alternate buffer for the whole session,
    // so Netcatty autocomplete is off while attached — same simple tradeoff as
    // other terminal hosts, rather than chasing TUI-vs-shell heuristics. #2530
    if (isTerminalAlternateScreenActive(term)) {
      clearState();
      return;
    }

    // Nothing will be rendered when both the popup and ghost text are off, so
    // don't run the (potentially expensive) completion query just to throw the
    // result away. Clear any stale state and bail before touching history,
    // fig specs, or remote path lookups.
    if (!shouldQueryCompletions(settingsRef.current)) {
      clearState();
      return;
    }

    const { prompt, allowExternalProviders = true } = getAlignedPrompt(
      term,
      typedInputBufferRef.current,
      typedBufferReliableRef.current,
    );
    lastPromptRef.current = prompt;

    // Pre-echo keystroke buffer can look identical to an echo-disabled
    // password prompt (`read -s -p '$ '`). Do not render or accept
    // built-in history/snippet suggestions until the shell echoes input.
    // Incoming PTY echo does not re-schedule fetches, so keep polling this
    // debounce cycle until the live line validates — or until max wait
    // (silent prompts never echo). clearState cancels timers and echo-wait
    // refs; re-arm the wait afterward when still within the window.
    if (allowExternalProviders === false) {
      const typed = typedInputBufferRef.current;
      const startedAt =
        echoValidationTypedRef.current === typed &&
        echoValidationStartedAtRef.current != null
          ? echoValidationStartedAtRef.current
          : Date.now();
      clearState();
      const withinWait =
        typed.length > 0 &&
        !disposedRef.current &&
        Date.now() - startedAt < ECHO_VALIDATION_MAX_WAIT_MS;
      if (withinWait) {
        echoValidationTypedRef.current = typed;
        echoValidationStartedAtRef.current = startedAt;
        debounceTimerRef.current = setTimeout(() => {
          debounceTimerRef.current = null;
          void fetchSuggestionsRef.current();
        }, settingsRef.current.debounceMs);
      }
      return;
    }

    echoValidationTypedRef.current = null;
    echoValidationStartedAtRef.current = null;

    // Capture version at start — if it changes during async work, discard results
    const version = ++fetchVersionRef.current;

    // Prefer the reliable keystroke buffer when remote echo lags (#2830).
    // getAlignedPrompt intentionally stays stricter for Enter recording.
    // `prompt` was already resolved above for the echo-validation gate.
    const input = resolveAutocompleteQueryInput(
      prompt,
      typedInputBufferRef.current,
      typedBufferReliableRef.current,
    );
    if (!prompt.isAtPrompt || input === null || input.length < settingsRef.current.minChars) {
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
    const parsedInput = parseCommandLine(input);
    const cwdResolution = resolveAutocompleteCwdWithSource(
      prompt.promptText,
      parsedInput.currentWord,
      getCwdRef.current?.(),
      hostOsRef.current,
    );

    // Single query for both ghost text and popup
    completionAbortRef.current?.abort();
    const completionController = new AbortController();
    completionAbortRef.current = completionController;
    // Retain the first (budgeted) result so a late path listing for cache-bypassed
    // relative SSH cwd can merge path suggestions without another IPC round-trip.
    let settledCompletions: CompletionSuggestion[] | null = null;
    let pendingLatePathSuggestions: CompletionSuggestion[] | null = null;

    const mergeLatePathSuggestions = (
      base: CompletionSuggestion[],
      latePathSuggestions: CompletionSuggestion[],
    ): CompletionSuggestion[] => {
      const withoutPaths = base.filter((entry) => entry.source !== "path");
      const indexByText = new Map<string, number>();
      const merged = [...withoutPaths];
      for (let index = 0; index < withoutPaths.length; index++) {
        indexByText.set(withoutPaths[index].text, index);
      }
      for (const suggestion of latePathSuggestions) {
        const existingIndex = indexByText.get(suggestion.text);
        if (existingIndex !== undefined) {
          // Prefer late path over duplicate history/plugin text so directory
          // candidates keep fileType for cascading path panels (matches
          // in-budget score-sort + dedup where path at 750 beats recent history).
          merged[existingIndex] = suggestion;
          continue;
        }
        indexByText.set(suggestion.text, merged.length);
        merged.push(suggestion);
      }
      merged.sort((left, right) => right.score - left.score);
      // Cap to the configured popup limit. provideTerminalCompletions already
      // slices built-in+plugin results to request.maximum; late path merges
      // bypass that path and must honor the same user setting (including when
      // it is below getCompletions' internal path-active floor of 24).
      const limit = Math.max(1, settingsRef.current.maxSuggestions);
      const limited = merged.slice(0, limit);
      if (!settingsRef.current.allowLineReplacement) {
        return limited.filter((completion) =>
          completion.source !== "snippet" && completion.text.startsWith(input),
        );
      }
      return limited;
    };

    const applyCompletions = (
      completions: CompletionSuggestion[],
      currentPrompt: ReturnType<typeof getAlignedPrompt>["prompt"],
      options?: { preserveSelection?: boolean },
    ) => {
      // Echo-lag-aware logical caret: resolved query `input` can be ahead of
      // the live xterm cursor / currentPrompt.userInput. When a late path
      // refresh lands while live-preview has already rewritten the shell line,
      // anchor from that resolved command line instead — keep `input` only for
      // query-staleness checks above.
      const caretUserInput =
        options?.preserveSelection && previewActiveRef.current
          ? (resolveAutocompleteQueryInput(
            currentPrompt,
            typedInputBufferRef.current,
            typedBufferReliableRef.current,
          ) ?? typedInputBufferRef.current)
          : input;
      const cursorCell = resolveAutocompleteCursorCell(term, {
        promptText: currentPrompt.promptText,
        userInput: caretUserInput,
      });

      if (settingsRef.current.showGhostText) {
        const ghost = ghostAddonRef.current;
        const activeSuggestion = ghost?.isActive() ? ghost.getSuggestion() : null;
        // Snippets are popup-only — never used as inline ghost text.
        const nextSuggestion = completions.find((c) => c.source !== "snippet")?.text ?? null;
        const ghostDecision = decideGhostSuggestion(
          activeSuggestion,
          caretUserInput,
          nextSuggestion,
        );
        if (ghostDecision.type === "show") {
          // Pre-echo probe in GhostTextAddon handles lagging SSH echo.
          ghost?.show(ghostDecision.suggestion, caretUserInput);
        } else if (ghostDecision.type === "hide") {
          ghost?.hide();
        }
      }

      // Popup
      if (settingsRef.current.showPopupMenu && completions.length > 0) {
        // Live-preview baseline: the typed input these suggestions completed.
        previewBaselineRef.current = input;
        // Ordinary new queries clear preview; same-query late-path refreshes
        // keep it so Escape can still restore the typed baseline after a
        // highlight that remains written into the shell line.
        if (!options?.preserveSelection) {
          previewActiveRef.current = false;
        }
        const anchor = resolveAutocompleteAnchorInViewport(
          term,
          containerRef.current,
          completions.length,
          cursorCell.column,
          cursorCell.row,
        );
        startTransition(() => {
          setState((prev) => {
            if (version !== fetchVersionRef.current) return prev;

            // Only late-path refreshes for *this* query preserve highlight.
            // Ordinary keystroke-driven queries must reset selection; otherwise
            // preview-off Enter can accept a stale row that still matches.
            const selectedIndex = options?.preserveSelection && prev.popupVisible
              ? resolvePreservedSuggestionIndex(
                prev.suggestions,
                prev.selectedIndex,
                completions,
              )
              : -1;

            const nextState: AutocompleteState = {
              suggestions: completions,
              selectedIndex,
              popupVisible: true,
              popupAnchorViewport: {
                left: anchor.anchorLeft,
                top: anchor.anchorTop,
                bottom: anchor.anchorBottom,
              },
              expandUpward: anchor.expandUpward,
              subDirPanels: [],
              subDirFocusLevel: -1,
            };

            if (
              prev.popupVisible &&
              prev.selectedIndex === nextState.selectedIndex &&
              prev.expandUpward === nextState.expandUpward &&
              prev.popupAnchorViewport.left === nextState.popupAnchorViewport.left &&
              prev.popupAnchorViewport.top === nextState.popupAnchorViewport.top &&
              prev.popupAnchorViewport.bottom === nextState.popupAnchorViewport.bottom &&
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
    };

    const isCurrentQueryStillActive = (): ReturnType<typeof getAlignedPrompt>["prompt"] | null => {
      if (disposedRef.current || version !== fetchVersionRef.current) return null;
      if (isTerminalAlternateScreenActive(term)) {
        clearState();
        return null;
      }
      // Discard stale results: if the user kept typing while getCompletions was running,
      // the current prompt input will have changed. Re-detect and compare. Use the same
      // echo-lag-aware resolver as the query so catching-up remote echo alone does not
      // drop local matches (#2830).
      const { prompt: currentPrompt } = getAlignedPrompt(
        term,
        typedInputBufferRef.current,
        typedBufferReliableRef.current,
      );
      const currentInput = resolveAutocompleteQueryInput(
        currentPrompt,
        typedInputBufferRef.current,
        typedBufferReliableRef.current,
      );
      if (
        !currentPrompt.isAtPrompt
        || !isSameAutocompleteQuery({
          queryInput: input,
          currentInput,
          previewActive: previewActiveRef.current,
          previewBaseline: previewBaselineRef.current,
        })
      ) {
        return null;
      }
      return currentPrompt;
    };

    let completions: CompletionSuggestion[];
    try {
      completions = await provideCompletionsRef.current(input, {
        hostId: hostIdRef.current,
        os: hostOsRef.current,
        maxResults: settingsRef.current.maxSuggestions,
        historyScope: settingsRef.current.historyScope,
        sessionId: sessionIdRef.current,
        protocol: protocolRef.current,
        cwd: cwdResolution.cwd,
        cwdSource: cwdResolution.source,
        snippets: snippetsRef.current,
        promptText: prompt.promptText,
        allowExternalProviders,
        signal: completionController.signal,
        onLatePathSuggestions: (latePathSuggestions) => {
          if (completionController.signal.aborted) return;
          const currentPrompt = isCurrentQueryStillActive();
          if (!currentPrompt) return;
          // Plugin merge may still be in flight after built-in getCompletions
          // returns; hold late paths until the first settled result arrives.
          if (settledCompletions === null) {
            pendingLatePathSuggestions = latePathSuggestions;
            return;
          }
          const next = mergeLatePathSuggestions(settledCompletions, latePathSuggestions);
          settledCompletions = next;
          applyCompletions(next, currentPrompt, { preserveSelection: true });
        },
      });
    } finally {
      if (completionAbortRef.current === completionController) completionAbortRef.current = null;
    }
    if (completionController.signal.aborted) return;
    if (!settingsRef.current.allowLineReplacement) {
      completions = completions.filter((completion) =>
        completion.source !== "snippet" && completion.text.startsWith(input),
      );
    }

    // Recheck after the async lookup: the terminal may have entered the alternate
    // screen while completions were pending (e.g. launching codex/vim). Drop any
    // result that would paint popup/ghost over a TUI. Same unconditional policy. #2530
    const currentPrompt = isCurrentQueryStillActive();
    if (!currentPrompt) return;

    if (pendingLatePathSuggestions) {
      completions = mergeLatePathSuggestions(completions, pendingLatePathSuggestions);
      pendingLatePathSuggestions = null;
    }
    settledCompletions = completions;
    applyCompletions(completions, currentPrompt);
  }, [termRef, clearState, containerRef]);

  // Keep ref in sync so handleSubDirSelect can call it
  fetchSuggestionsRef.current = fetchSuggestions;

  /**
   * Handle terminal input data. Called on every character.
   */
  const handleInput = useCallback(
    (data: string) => {
      handleTerminalAutocompleteInput(data, {
        settingsRef,
        lastKeystrokeRef,
        suppressNextEnterRecordRef,
        lastAcceptedCommandRef,
        typedInputBufferRef,
        typedBufferReliableRef,
        previewActiveRef,
        termRef,
        hostIdRef,
        hostOsRef,
        ghostAddonRef,
        debounceTimerRef,
        clearState,
        fetchSuggestions,
      });
    },
    [fetchSuggestions, termRef, clearState],
  );

  /**
   * Handle keyboard events for autocomplete interaction.
   * Returns false if the event was consumed (should not propagate to terminal).
   */
  const handleKeyEvent = useCallback(
    (e: KeyboardEvent): boolean => handleTerminalAutocompleteKeyEvent(e, {
      settingsRef,
      stateRef,
      ghostAddonRef,
      typedInputBufferRef,
      typedBufferReliableRef,
      previewActiveRef,
      lastAcceptedCommandRef,
      setState,
      expandSubDir,
      writeToTerminal,
      clearState,
      renderSubDirPath,
      handleSubDirSelect,
      fetchSubDirForIndex,
      renderPreviewSelection,
      acceptPreviewlessSelection,
      acceptSnippet,
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- handler uses refs and callbacks initialized below.
    [writeToTerminal],
  );

  /**
   * Render the suggestion at `index` straight into the command line (Termius
   * live-preview, #1005). `index < 0` restores the user's typed baseline.
   */
  const renderPreviewSelection = useCallback((index: number) => {
    if (!settingsRef.current.livePreview) return;
    const s = stateRef.current;
    const term = termRef.current;
    if (!term) return;
    const baseline = previewBaselineRef.current;
    const selected = index >= 0 ? s.suggestions[index] : null;
    // Snippets aren't literal completions — keep the user's typed text in the
    // line (the popup detail panel shows the full command instead).
    const candidate =
      selected && selected.source !== "snippet" ? selected.text : baseline;
    const { prompt } = getAlignedPrompt(
      term,
      typedInputBufferRef.current,
      typedBufferReliableRef.current,
    );
    const seq = computeAutocompleteAcceptWrite({
      prompt,
      typedBuffer: typedInputBufferRef.current,
      typedBufferReliable: typedBufferReliableRef.current,
      candidate,
      os: hostOsRef.current,
    });
    if (seq === null) return;
    if (seq) writeToTerminal(seq);
    typedInputBufferRef.current = candidate;
    typedBufferReliableRef.current = true;
    const isPreview = index >= 0 && candidate !== baseline;
    previewActiveRef.current = isPreview;
    lastAcceptedCommandRef.current = isPreview ? candidate : null;
    // Live-preview can move/wrap the cursor. Recompute the anchor after xterm
    // has processed the write so the popup doesn't drift or flip into a stale
    // position (fixes #1710).
    requestAnimationFrame(() => {
      repositionPopup();
    });
  }, [termRef, writeToTerminal, repositionPopup]);

  /** Accept a snippet: clear the user's typed input, then run it via the
   *  host-canonical send path (onAcceptSnippet). */
  const acceptSnippet = useCallback((snippet: Snippet): boolean => {
    const term = termRef.current;
    if (term) {
      const { prompt } = getAlignedPrompt(term, typedInputBufferRef.current, typedBufferReliableRef.current);
      const line = resolveAutocompleteQueryInput(
        prompt,
        typedInputBufferRef.current,
        typedBufferReliableRef.current,
      );
      if (line !== null && line.length > 0) {
        if (!settingsRef.current.allowLineReplacement) return false;
        const clearSequence = hostOsRef.current === "windows"
          ? "\b".repeat(line.length)
          : "\x15"; // Ctrl+U (readline kill-line)
        writeToTerminal(clearSequence);
      }
    }
    typedInputBufferRef.current = "";
    typedBufferReliableRef.current = true;
    onAcceptSnippetRef.current?.(snippet);
    clearState();
    return true;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- clearState is stable
  }, [termRef, writeToTerminal]);

  /**
   * Insert a suggestion into the terminal.
   * @param execute If true, also sends \r to execute the command.
   */
  const insertSuggestion = useCallback(
    (suggestion: CompletionSuggestion, execute: boolean) => {
      const term = termRef.current;
      if (!term) return false;

      // Always use real-time prompt detection — lastPromptRef may be stale
      // if the user typed more characters after suggestions were fetched.
      // Accept writes must use the echo-lag-aware line baseline (#2830).
      const { prompt } = getAlignedPrompt(term, typedInputBufferRef.current, typedBufferReliableRef.current);
      const payload = computeAutocompleteAcceptWrite({
        prompt,
        typedBuffer: typedInputBufferRef.current,
        typedBufferReliable: typedBufferReliableRef.current,
        candidate: suggestion.text,
        os: hostOsRef.current,
        execute,
        allowLineReplacement: settingsRef.current.allowLineReplacement,
      });
      if (payload === null) return false;

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
      return true;
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps -- clearState is stable
    [termRef, writeToTerminal],
  );

  const acceptPreviewlessSelection = useCallback((index: number): boolean => {
    const suggestion = stateRef.current.suggestions[index];
    if (!suggestion) return false;
    if (suggestion.source === "snippet" && suggestion.snippet) {
      return acceptSnippet(suggestion.snippet);
    }
    return insertSuggestion(suggestion, true);
  }, [acceptSnippet, insertSuggestion]);

  /**
   * Select a suggestion from the popup (Tab / mouse click — insert only, no execute).
   */
  const selectSuggestion = useCallback(
    (suggestion: CompletionSuggestion) => {
      if (suggestion.source === "snippet" && suggestion.snippet) {
        acceptSnippet(suggestion.snippet);
        return;
      }
      insertSuggestion(suggestion, false);
    },
    [insertSuggestion, acceptSnippet],
  );

  const closePopup = useCallback(() => {
    clearState();
  }, [clearState]);

  const dispose = useCallback(() => {
    disposedRef.current = true;
    completionAbortRef.current?.abort();
    completionAbortRef.current = null;
    if (debounceTimerRef.current) {
      clearTimeout(debounceTimerRef.current);
    }
    ghostAddonRef.current?.dispose();
    ghostAddonRef.current = null;
  }, []);

  const showSudoHint = useCallback((text: string): boolean => {
    const addon = ghostAddonRef.current;
    if (!addon) return false;
    addon.showHint(text);
    return addon.isHintActive();
  }, []);
  const hideSudoHint = useCallback(() => {
    ghostAddonRef.current?.hideHint();
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
    showSudoHint,
    hideSudoHint,
  };
}
