import type { SearchAddon } from "@xterm/addon-search";
import type { Terminal as XTerm } from "@xterm/xterm";
import { useCallback, useEffect, useRef, useState } from "react";
import type { RefObject } from "react";
import { useStoredBoolean } from "../../../application/state/useStoredBoolean";
import { STORAGE_KEY_TERMINAL_SEARCH_OPEN } from "../../../infrastructure/config/storageKeys";

type SearchMatchCount = { current: number; total: number } | null;

type SearchAddonResetTarget = Pick<SearchAddon, "findNext" | "clearDecorations"> | null;
type TerminalSearchVisualElement = {
  querySelectorAll: (selector: string) => ArrayLike<{ remove: () => void }>;
};
type TerminalSearchResetTarget = Pick<XTerm, "refresh" | "rows" | "clearSelection"> & {
  element?: TerminalSearchVisualElement | null;
  clearTextureAtlas?: () => void;
} | null;
type TerminalSearchGuardTarget = TerminalSearchResetTarget;

const SEARCH_DECORATIONS = {
  matchBackground: "#FFFF0044",
  matchBorder: "#FFFF00",
  matchOverviewRuler: "#FFFF00",
  activeMatchBackground: "#FF880088",
  activeMatchBorder: "#FF8800",
  activeMatchColorOverviewRuler: "#FF8800",
} as const;

const SEARCH_DECORATION_BACKGROUNDS = new Set<string>([
  SEARCH_DECORATIONS.matchBackground.toLowerCase(),
  SEARCH_DECORATIONS.activeMatchBackground.toLowerCase(),
]);

type StaleSearchDecoration = {
  dispose: () => void;
  options?: { backgroundColor?: string };
  element?: {
    classList?: { contains: (name: string) => boolean };
    style?: { backgroundColor?: string };
  };
};

type CellDecorationService = {
  decorations?: Iterable<StaleSearchDecoration>;
  forEachDecorationAtCell?: (
    x: number,
    y: number,
    layer: "bottom" | "top" | undefined,
    callback: (decoration: StaleSearchDecoration) => void,
  ) => void;
};

type SearchAddonInternals = {
  clearDecorations?: () => void;
  clearActiveDecoration?: () => void;
  _highlightTimeout?: { clear?: () => void };
  _state?: { reset?: () => void };
};

type TerminalDecorationHost = {
  _core?: { _decorationService?: CellDecorationService };
  _decorationService?: CellDecorationService;
};

export const SEARCH_DECORATION_TRACKER_KEY = "__netcattySearchDecorationTracker";

export type SearchDecorationTracker = {
  disposeAll: () => number;
  size: () => number;
  markSearched: () => void;
  hasSearched: () => boolean;
  consumeSearched: () => boolean;
  noteEmptyQueryReset: () => void;
  consumeCloseSweep: () => boolean;
};

type TrackableTerminal = Pick<XTerm, "registerDecoration"> & {
  [SEARCH_DECORATION_TRACKER_KEY]?: SearchDecorationTracker;
};

const SEARCH_OPTIONS = {
  regex: false,
  caseSensitive: false,
  wholeWord: false,
  decorations: SEARCH_DECORATIONS,
} as const;

/**
 * SearchAddon schedules `_updateMatches` 200ms after writes/resizes and does
 * not cancel that timer from `clearDecorations()`. A timeout that already
 * captured the prior term can revive yellow match decorations after reset —
 * re-clear once past that window (issue #2980).
 */
export const SEARCH_HIGHLIGHT_REVIVAL_GUARD_MS = 250;

/**
 * SearchAddon paints matches as HTML overlays (`.xterm-find-result-decoration`).
 * Disposing the addon decoration does not always detach that node — after Esc
 * closes the search bar and the terminal refits, the first two cells of the
 * last hit can stay outlined on top of the buffer.
 */
export const SEARCH_DECORATION_NODE_SELECTOR =
  ".xterm-find-result-decoration, .xterm-find-active-result-decoration";

export const stripStaleSearchDecorationNodes = (
  term?: { element?: TerminalSearchVisualElement | null } | null,
): void => {
  const nodes = term?.element?.querySelectorAll(SEARCH_DECORATION_NODE_SELECTOR);
  if (!nodes) return;
  for (let i = 0; i < nodes.length; i += 1) {
    nodes[i]?.remove();
  }
};

export const isSearchDecorationBackground = (color?: string): boolean => (
  Boolean(color) && SEARCH_DECORATION_BACKGROUNDS.has(color.trim().toLowerCase())
);

export const installSearchDecorationTracker = (
  term: TrackableTerminal,
): SearchDecorationTracker => {
  const existing = term[SEARCH_DECORATION_TRACKER_KEY];
  if (existing) return existing;

  const tracked = new Set<{ dispose: () => void }>();
  let searched = false;
  let pendingCloseSweep = false;
  const originalRegister = term.registerDecoration.bind(term);
  term.registerDecoration = (options) => {
    // Keep search fill on the HTML overlay only. Passing backgroundColor into
    // xterm lets WebGL bake the yellow into the glyph atlas, and those cells
    // stay stained after Esc even when the decoration handle is gone.
    const searchBackground = isSearchDecorationBackground(options.backgroundColor)
      ? options.backgroundColor
      : undefined;
    const decoration = originalRegister(
      searchBackground ? { ...options, backgroundColor: undefined } : options,
    );
    if (!decoration) return decoration;
    if (!searchBackground) return decoration;
    tracked.add(decoration);
    decoration.onRender((element) => {
      element.style.backgroundColor = searchBackground;
    });
    decoration.onDispose(() => {
      tracked.delete(decoration);
    });
    return decoration;
  };

  const tracker: SearchDecorationTracker = {
    disposeAll: () => {
      const leftover = [...tracked];
      tracked.clear();
      for (const decoration of leftover) decoration.dispose();
      return leftover.length;
    },
    size: () => tracked.size,
    markSearched: () => {
      searched = true;
      pendingCloseSweep = true;
    },
    hasSearched: () => searched,
    consumeSearched: () => {
      const value = searched;
      searched = false;
      return value;
    },
    noteEmptyQueryReset: () => {
      searched = false;
    },
    consumeCloseSweep: () => {
      const value = pendingCloseSweep;
      pendingCloseSweep = false;
      return value;
    },
  };
  term[SEARCH_DECORATION_TRACKER_KEY] = tracker;
  return tracker;
};

export const getSearchDecorationTracker = (term?: unknown): SearchDecorationTracker | null => {
  if (!term || typeof term !== "object") return null;
  const tracker = (term as TrackableTerminal)[SEARCH_DECORATION_TRACKER_KEY];
  return tracker && typeof tracker.disposeAll === "function" ? tracker : null;
};

const isStaleSearchDecoration = (decoration: StaleSearchDecoration): boolean => (
  isSearchDecorationBackground(decoration.options?.backgroundColor)
  || isSearchDecorationBackground(decoration.element?.style?.backgroundColor)
  || decoration.element?.classList?.contains("xterm-find-result-decoration") === true
  || decoration.element?.classList?.contains("xterm-find-active-result-decoration") === true
);

const readDecorationService = (term?: unknown): CellDecorationService | null => {
  const host = term as TerminalDecorationHost & {
    _core?: Record<string, unknown>;
  } | null | undefined;
  const direct = host?._core?._decorationService ?? host?._decorationService;
  if (direct && (direct.decorations || direct.forEachDecorationAtCell)) {
    return direct;
  }
  const core = host?._core;
  if (!core || typeof core !== "object") return null;
  for (const value of Object.values(core)) {
    const candidate = value as CellDecorationService | undefined;
    if (candidate && typeof candidate.forEachDecorationAtCell === "function") {
      return candidate;
    }
  }
  return null;
};

const readDecorationIterable = (
  term?: unknown,
): Iterable<StaleSearchDecoration> | null => (
  readDecorationService(term)?.decorations ?? null
);

export const disposeSearchDecorationsInViewport = (term?: unknown): number => {
  const service = readDecorationService(term);
  const view = term as {
    cols?: number;
    rows?: number;
    buffer?: { active?: { viewportY?: number } };
  } | null | undefined;
  if (!service?.forEachDecorationAtCell || !view?.cols || !view.rows) return 0;
  const viewportY = view.buffer?.active?.viewportY ?? 0;
  const stale = new Set<StaleSearchDecoration>();
  for (let y = viewportY; y < viewportY + view.rows; y += 1) {
    for (let x = 0; x < view.cols; x += 1) {
      service.forEachDecorationAtCell(x, y, undefined, (decoration) => {
        if (isStaleSearchDecoration(decoration)) stale.add(decoration);
      });
    }
  }
  for (const decoration of stale) decoration.dispose();
  return stale.size;
};

/**
 * WebGL paints decoration backgroundColor into the cell. SearchAddon can lose
 * a couple of those handles on Esc+refit, so walk the terminal decoration
 * service and dispose anything still using the search yellow/orange.
 */
export const disposeStaleSearchDecorations = (term?: unknown): number => {
  if (term && typeof term === "object" && "registerDecoration" in term) {
    installSearchDecorationTracker(term as TrackableTerminal);
  }
  const trackedCount = getSearchDecorationTracker(term)?.disposeAll() ?? 0;
  const viewportCount = disposeSearchDecorationsInViewport(term);
  const decorations = readDecorationIterable(term);
  if (!decorations) return trackedCount + viewportCount;
  const stale: StaleSearchDecoration[] = [];
  for (const decoration of decorations) {
    if (isStaleSearchDecoration(decoration)) stale.push(decoration);
  }
  for (const decoration of stale) decoration.dispose();
  return trackedCount + viewportCount + stale.length;
};

/** Cancel SearchAddon's 200ms _updateMatches timer and drop cached term/options. */
export const disarmSearchAddonRevival = (searchAddon?: unknown): void => {
  const addon = searchAddon as SearchAddonInternals | null | undefined;
  if (!addon) return;
  addon._highlightTimeout?.clear?.();
  addon._state?.reset?.();
  addon.clearActiveDecoration?.();
  addon.clearDecorations?.();
};

/**
 * Delayed re-clear for addon decoration revival only. Do not clearSelection
 * here: reset already cleared the search selection, and a user may have made
 * a new manual selection during the guard window.
 */
export const clearTerminalSearchHighlights = (
  searchAddon: Pick<SearchAddon, "clearDecorations"> | null,
  term?: Pick<XTerm, "refresh" | "rows"> & {
    element?: TerminalSearchVisualElement | null;
    clearTextureAtlas?: () => void;
  } | null,
): void => {
  disarmSearchAddonRevival(searchAddon);
  disposeStaleSearchDecorations(term);
  stripStaleSearchDecorationNodes(term);
  if (term && term.rows > 0) {
    term.refresh(0, term.rows - 1);
  }
};

/**
 * After the search bar unmounts the terminal grows and is force-fitted.
 * Re-sweep leftover overlays and the addon selection that a resize can revive
 * as a 2-cell sliver of the last match.
 */
export const settleTerminalSearchAfterLayout = (
  searchAddon: Pick<SearchAddon, "clearDecorations"> | null,
  term?: TerminalSearchResetTarget,
  onRepaint?: () => void,
): void => {
  // Search-open state is shared across terminals. A sibling that never
  // searched still sees the bar close and would otherwise lose a manual
  // selection via clearSelection(). Emptying the query resets highlights
  // while the bar stays open; keep the close-time repaint, but do not
  // treat that stale search as a reason to wipe a later manual selection.
  const tracker = getSearchDecorationTracker(term);
  const shouldClearSelection = tracker ? tracker.consumeSearched() : true;
  const shouldSweepLeftovers = tracker ? tracker.consumeCloseSweep() : true;
  const shouldSweep = !tracker || shouldClearSelection || shouldSweepLeftovers;
  if (!shouldSweep) return;
  clearTerminalSearchHighlights(searchAddon, term);
  if (shouldClearSelection) term?.clearSelection();
  term?.clearTextureAtlas?.();
  onRepaint?.();
};

export const resetTerminalSearch = (
  searchAddon: SearchAddonResetTarget,
  searchTermRef: { current: string },
  term?: TerminalSearchResetTarget,
): void => {
  searchTermRef.current = "";
  // Drop decorations and cachedSearchTerm first so any not-yet-running addon
  // `_updateMatches` timeout observes an empty cache and does not revive.
  disarmSearchAddonRevival(searchAddon);
  // clearDecorations() leaves the active-match selection; clear it explicitly.
  term?.clearSelection();
  // Empty find clears selection via the addon path. Do NOT pass SEARCH_OPTIONS:
  // findNext always assigns lastSearchOptions, and decoration options would
  // keep that latch armed for later write/resize updates.
  try {
    searchAddon?.findNext("");
  } catch {
    // Addon not activated yet.
  }
  // findNext("") assigns cachedSearchTerm back to "". Clear again so the cache
  // is undefined rather than an empty string.
  searchAddon?.clearDecorations();
  // SearchAddon can drop a couple of decoration handles on Esc+refit. Those
  // leftover yellow cells are still in xterm's decoration service and WebGL
  // keeps painting them until we dispose them directly.
  disposeStaleSearchDecorations(term);
  // Disposing search decorations does not always detach the overlay nodes
  // (Esc close leaves the first two cells of the last hit). Sweep them
  // before refresh so WebGL/DOM cannot keep the yellow outline.
  stripStaleSearchDecorationNodes(term);
  // Disposing search decorations does not always repaint cells (observed on
  // Windows after clearing or closing search). Keyword highlighting already
  // forces a refresh after dispose; do the same here so yellow match
  // backgrounds cannot linger.
  if (term && term.rows > 0) {
    term.refresh(0, term.rows - 1);
  }
};

/**
 * Pointer listeners used to tell a user-created selection apart from the
 * addon's delayed findPrevious re-select. Keyboard selections in this 250ms
 * window are rare enough that treating them as addon revival is acceptable.
 */
export const subscribeTerminalUserSelection = (
  term: Pick<XTerm, "element"> | null | undefined,
  mark: () => void,
): (() => void) => {
  const el = term?.element;
  if (!el) return () => {};
  const onPointer = () => mark();
  el.addEventListener("mousedown", onPointer);
  el.addEventListener("touchstart", onPointer);
  return () => {
    el.removeEventListener("mousedown", onPointer);
    el.removeEventListener("touchstart", onPointer);
  };
};

export const armSearchHighlightRevivalGuard = ({
  getSearchAddon,
  getTerm,
  subscribeUserSelection,
  delayMs = SEARCH_HIGHLIGHT_REVIVAL_GUARD_MS,
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout,
}: {
  getSearchAddon: () => Pick<SearchAddon, "clearDecorations"> | null;
  getTerm: () => TerminalSearchGuardTarget;
  subscribeUserSelection?: (mark: () => void) => () => void;
  delayMs?: number;
  setTimeoutFn?: typeof setTimeout;
  clearTimeoutFn?: typeof clearTimeout;
}): { arm: () => void; dispose: () => void; markUserSelection: () => void } => {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let userTouchedSelection = false;
  let unsubscribeUserSelection: (() => void) | null = null;

  const markUserSelection = () => {
    userTouchedSelection = true;
  };

  const dispose = () => {
    if (timer !== null) {
      clearTimeoutFn(timer);
      timer = null;
    }
    unsubscribeUserSelection?.();
    unsubscribeUserSelection = null;
  };

  const arm = () => {
    dispose();
    userTouchedSelection = false;
    if (subscribeUserSelection) {
      unsubscribeUserSelection = subscribeUserSelection(markUserSelection);
    }
    timer = setTimeoutFn(() => {
      timer = null;
      unsubscribeUserSelection?.();
      unsubscribeUserSelection = null;
      const term = getTerm();
      clearTerminalSearchHighlights(getSearchAddon(), term);
      // Addon findPrevious re-selects the prior active match. Clear that
      // revived selection unless the user started a new one in this window.
      if (!userTouchedSelection) {
        term?.clearSelection();
      }
    }, delayMs);
  };

  return { arm, dispose, markUserSelection };
};

/** True when this terminal has a local query that shared search-close must clear. */
export const shouldResetOnSharedSearchClose = (localSearchTerm: string): boolean =>
  localSearchTerm !== "";

export const useTerminalSearch = ({
  searchAddonRef,
  termRef,
}: {
  searchAddonRef: RefObject<SearchAddon | null>;
  termRef: RefObject<XTerm | null>;
}) => {
  const [isSearchOpen, setIsSearchOpen] = useStoredBoolean(
    STORAGE_KEY_TERMINAL_SEARCH_OPEN,
    false,
  );
  const [searchMatchCount, setSearchMatchCount] = useState<SearchMatchCount>(null);
  // Bumped each time the search hotkey fires. The SearchBar watches this token
  // to refocus its input — without it, calling setIsSearchOpen(true) when
  // already open is a no-op (React bails on the unchanged boolean) and focus
  // never returns to the input. See issue #1789.
  const [searchFocusToken, setSearchFocusToken] = useState(0);
  const searchTermRef = useRef<string>("");
  const revivalGuardRef = useRef<ReturnType<typeof armSearchHighlightRevivalGuard> | null>(null);

  // Existing sessions (and Vite HMR) never go back through createXTermRuntime.
  // Install on the live term so Esc can still find leaked decorations.
  if (termRef.current) {
    installSearchDecorationTracker(termRef.current);
  }

  if (revivalGuardRef.current === null) {
    revivalGuardRef.current = armSearchHighlightRevivalGuard({
      getSearchAddon: () => searchAddonRef.current,
      getTerm: () => termRef.current,
      subscribeUserSelection: (mark) => subscribeTerminalUserSelection(termRef.current, mark),
    });
  }

  useEffect(() => () => {
    revivalGuardRef.current?.dispose();
  }, []);

  const runReset = useCallback(() => {
    resetTerminalSearch(searchAddonRef.current, searchTermRef, termRef.current);
    revivalGuardRef.current?.arm();
  }, [searchAddonRef, termRef]);

  // Search open state is shared via localStorage across terminal sessions. When
  // another session closes search, this session's bar unmounts without going
  // through handleCloseSearch — clear leftover decorations only when this
  // terminal actually searched (otherwise shared false would wipe unrelated
  // manual selections in other splits).
  useEffect(() => {
    if (isSearchOpen) return;
    setSearchMatchCount(null);
    if (!shouldResetOnSharedSearchClose(searchTermRef.current)) return;
    runReset();
  }, [isSearchOpen, runReset]);

  // Invoked by the searchTerminal hotkey (Cmd/Ctrl+F). Always opens the bar
  // and bumps the focus token: when closed, setIsSearchOpen(true) mounts the
  // SearchBar (whose isOpen effect focuses the input); when open, the token
  // bump makes the SearchBar re-run its focus effect and refocus. Doing both
  // unconditionally avoids reading `isSearchOpen` here — the xterm runtime
  // captures this callback once at creation (it only re-runs on host.id /
  // sessionId change), so a stale `isSearchOpen` closure would otherwise pick
  // the wrong branch.
  const requestSearchFocus = useCallback(() => {
    setIsSearchOpen(true);
    setSearchFocusToken((n) => n + 1);
  }, [setIsSearchOpen]);

  const handleToggleSearch = useCallback(() => {
    const next = !isSearchOpen;
    setIsSearchOpen(next);
    if (!next) {
      setSearchMatchCount(null);
      runReset();
    }
  }, [isSearchOpen, runReset, setIsSearchOpen]);

  const handleSearch = useCallback(
    (term: string): boolean => {
      const searchAddon = searchAddonRef.current;
      if (!searchAddon || !term) {
        runReset();
        if (termRef.current) installSearchDecorationTracker(termRef.current);
        getSearchDecorationTracker(termRef.current)?.noteEmptyQueryReset();
        setSearchMatchCount(null);
        return false;
      }

      searchTermRef.current = term;
      revivalGuardRef.current?.dispose();
      // Incremental typing (ro -> root) can leave the previous term's
      // decorations in xterm even after clearDecorations(). Drop our tracked
      // leftovers before painting the new matches.
      if (termRef.current) installSearchDecorationTracker(termRef.current);
      getSearchDecorationTracker(termRef.current)?.markSearched();
      disposeStaleSearchDecorations(termRef.current);
      searchAddon.clearDecorations();

      const found = searchAddon.findNext(term, SEARCH_OPTIONS);

      if (found) {
        setSearchMatchCount({ current: 1, total: 1 });
      } else {
        setSearchMatchCount({ current: 0, total: 0 });
      }

      return found;
    },
    [runReset, searchAddonRef, termRef],
  );

  const handleFindNext = useCallback((): boolean => {
    const searchAddon = searchAddonRef.current;
    const term = searchTermRef.current;
    if (!searchAddon || !term) return false;
    return searchAddon.findNext(term, SEARCH_OPTIONS);
  }, [searchAddonRef]);

  const handleFindPrevious = useCallback((): boolean => {
    const searchAddon = searchAddonRef.current;
    const term = searchTermRef.current;
    if (!searchAddon || !term) return false;
    return searchAddon.findPrevious(term, SEARCH_OPTIONS);
  }, [searchAddonRef]);

  const handleCloseSearch = useCallback(() => {
    setIsSearchOpen(false);
    setSearchMatchCount(null);
    runReset();
    termRef.current?.focus();
  }, [runReset, setIsSearchOpen, termRef]);

  return {
    isSearchOpen,
    setIsSearchOpen,
    searchMatchCount,
    searchFocusToken,
    requestSearchFocus,
    handleToggleSearch,
    handleSearch,
    handleFindNext,
    handleFindPrevious,
    handleCloseSearch,
  };
};
