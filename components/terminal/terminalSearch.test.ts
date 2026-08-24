import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { notifyTerminalSearchTermChange } from "./TerminalSearchBar.tsx";
import {
  armSearchHighlightRevivalGuard,
  disarmSearchAddonRevival,
  disposeStaleSearchDecorations,
  installSearchDecorationTracker,
  resetTerminalSearch,
  SEARCH_HIGHLIGHT_REVIVAL_GUARD_MS,
  settleTerminalSearchAfterLayout,
  shouldResetOnSharedSearchClose,
  stripStaleSearchDecorationNodes,
  subscribeTerminalUserSelection,
} from "./hooks/useTerminalSearch.ts";

test("clearing the search input notifies the terminal search handler", () => {
  const terms: string[] = [];
  const onSearch = (term: string) => {
    terms.push(term);
    return false;
  };

  let previousTerm = notifyTerminalSearchTermChange("needle", "", onSearch);
  previousTerm = notifyTerminalSearchTermChange("", previousTerm, onSearch);

  assert.equal(previousTerm, "");
  assert.deepEqual(terms, ["needle", ""]);
});

test("unchanged search input does not repeat a search", () => {
  const terms: string[] = [];

  const previousTerm = notifyTerminalSearchTermChange("needle", "needle", (term) => {
    terms.push(term);
    return false;
  });

  assert.equal(previousTerm, "needle");
  assert.deepEqual(terms, []);
});

test("resetting terminal search clears both match decorations and active selection", () => {
  let decorationsVisible = true;
  let activeSelectionVisible = true;
  const searchedTerms: string[] = [];
  const searchAddon = {
    findNext(term: string) {
      searchedTerms.push(term);
      if (term === "") {
        decorationsVisible = false;
        activeSelectionVisible = false;
      }
      return false;
    },
    clearDecorations() {
      decorationsVisible = false;
    },
  };
  const term = {
    rows: 24,
    refresh() {},
    clearSelection() {
      activeSelectionVisible = false;
    },
  };
  const searchTermRef = { current: "needle" };

  resetTerminalSearch(searchAddon, searchTermRef, term);

  assert.equal(searchTermRef.current, "");
  assert.deepEqual(searchedTerms, [""]);
  assert.equal(decorationsVisible, false);
  assert.equal(activeSelectionVisible, false);
});

test("resetting terminal search clears cache before empty find and refreshes", () => {
  // SearchAddon keeps a 200ms onWriteParsed/onResize timer that can revive
  // highlights after reset if cachedSearchTerm was not cleared first. Also,
  // findNext("", { decorations }) re-arms lastSearchOptions.decorations — so
  // the empty find must not pass decoration options. clearDecorations alone
  // leaves the active-match selection; clear it explicitly and refresh so
  // Windows/WebGL does not keep yellow match backgrounds.
  const calls: string[] = [];
  const findNextArgs: unknown[] = [];
  const searchAddon = {
    findNext(term: string, options?: unknown) {
      calls.push(`findNext:${term}`);
      findNextArgs.push(options);
      return false;
    },
    clearDecorations() {
      calls.push("clearDecorations");
    },
  };
  const term = {
    rows: 24,
    refresh(start: number, end: number) {
      calls.push(`refresh:${start}:${end}`);
    },
    clearSelection() {
      calls.push("clearSelection");
    },
  };
  const searchTermRef = { current: "needle" };

  resetTerminalSearch(searchAddon, searchTermRef, term);

  assert.equal(searchTermRef.current, "");
  assert.deepEqual(calls, [
    "clearDecorations",
    "clearSelection",
    "findNext:",
    "clearDecorations",
    "refresh:0:23",
  ]);
  assert.equal(findNextArgs[0], undefined);
});

test("search highlight revival guard re-clears decorations and the addon selection", () => {
  assert.ok(SEARCH_HIGHLIGHT_REVIVAL_GUARD_MS > 200);

  const calls: string[] = [];
  let scheduled: { cb: () => void; ms: number } | null = null;
  const searchAddon = {
    clearDecorations() {
      calls.push("clearDecorations");
    },
  };
  const term = {
    rows: 10,
    refresh(start: number, end: number) {
      calls.push(`refresh:${start}:${end}`);
    },
    clearSelection() {
      calls.push("clearSelection");
    },
  };

  const guard = armSearchHighlightRevivalGuard({
    getSearchAddon: () => searchAddon,
    getTerm: () => term,
    setTimeoutFn: ((cb: () => void, ms: number) => {
      scheduled = { cb, ms };
      return 1 as unknown as ReturnType<typeof setTimeout>;
    }) as typeof setTimeout,
    clearTimeoutFn: (() => {}) as typeof clearTimeout,
  });

  guard.arm();
  assert.ok(scheduled);
  assert.equal(scheduled?.ms, SEARCH_HIGHLIGHT_REVIVAL_GUARD_MS);
  assert.deepEqual(calls, []);

  // SearchAddon._updateMatches can revive decorations and re-select the
  // previous active match. With no user selection in the window, clear both.
  calls.push("revived");
  scheduled?.cb();

  assert.deepEqual(calls, [
    "revived",
    "clearDecorations",
    "refresh:0:9",
    "clearSelection",
  ]);

  guard.dispose();
});

test("search highlight revival guard keeps a user selection made during the window", () => {
  const calls: string[] = [];
  let scheduled: { cb: () => void; ms: number } | null = null;
  const searchAddon = {
    clearDecorations() {
      calls.push("clearDecorations");
    },
  };
  const term = {
    rows: 10,
    refresh(start: number, end: number) {
      calls.push(`refresh:${start}:${end}`);
    },
    clearSelection() {
      calls.push("clearSelection");
    },
  };

  const guard = armSearchHighlightRevivalGuard({
    getSearchAddon: () => searchAddon,
    getTerm: () => term,
    setTimeoutFn: ((cb: () => void, ms: number) => {
      scheduled = { cb, ms };
      return 1 as unknown as ReturnType<typeof setTimeout>;
    }) as typeof setTimeout,
    clearTimeoutFn: (() => {}) as typeof clearTimeout,
  });

  guard.arm();
  guard.markUserSelection();
  scheduled?.cb();

  assert.deepEqual(calls, [
    "clearDecorations",
    "refresh:0:9",
  ]);

  guard.dispose();
});

test("subscribeTerminalUserSelection marks on pointer down and unsubscribes", () => {
  const marks: string[] = [];
  const listeners = new Map<string, EventListener>();
  const element = {
    addEventListener(type: string, listener: EventListener) {
      listeners.set(type, listener);
    },
    removeEventListener(type: string) {
      listeners.delete(type);
    },
  };
  const unsubscribe = subscribeTerminalUserSelection(
    { element: element as unknown as HTMLElement },
    () => marks.push("mark"),
  );

  listeners.get("mousedown")?.(new Event("mousedown"));
  listeners.get("touchstart")?.(new Event("touchstart"));
  assert.deepEqual(marks, ["mark", "mark"]);

  unsubscribe();
  assert.equal(listeners.size, 0);
});

test("revival guard subscribes to user selection only while armed", () => {
  let subscribed = 0;
  let unsubscribed = 0;
  let scheduled: { cb: () => void } | null = null;
  const guard = armSearchHighlightRevivalGuard({
    getSearchAddon: () => ({
      clearDecorations() {},
    }),
    getTerm: () => ({
      rows: 1,
      refresh() {},
      clearSelection() {},
    }),
    subscribeUserSelection: () => {
      subscribed += 1;
      return () => {
        unsubscribed += 1;
      };
    },
    setTimeoutFn: ((cb: () => void) => {
      scheduled = { cb };
      return 1 as unknown as ReturnType<typeof setTimeout>;
    }) as typeof setTimeout,
    clearTimeoutFn: (() => {}) as typeof clearTimeout,
  });

  guard.arm();
  assert.equal(subscribed, 1);
  assert.equal(unsubscribed, 0);

  scheduled?.cb();
  assert.equal(unsubscribed, 1);

  guard.dispose();
});

test("shared search close only resets terminals that have a local query", () => {
  assert.equal(shouldResetOnSharedSearchClose(""), false);
  assert.equal(shouldResetOnSharedSearchClose("needle"), true);
});

const leftoverDecoration = (className: string) => {
  const node = {
    className,
    removed: false,
    remove() {
      this.removed = true;
    },
  };
  return node;
};

test("resetting terminal search strips leftover find-result decoration nodes", () => {
  // Esc close disposes SearchAddon decorations, but the last match's HTML
  // overlay can remain — typically the first two cells of the previous hit.
  const leftover = leftoverDecoration("xterm-find-result-decoration");
  const searchAddon = {
    findNext() {
      return false;
    },
    clearDecorations() {},
  };
  const term = {
    rows: 24,
    refresh() {},
    clearSelection() {},
    element: {
      querySelectorAll(selector: string) {
        assert.match(selector, /xterm-find-result-decoration/);
        return [leftover];
      },
    },
  };

  resetTerminalSearch(searchAddon, { current: "pro" }, term);

  assert.equal(leftover.removed, true);
});

test("stripStaleSearchDecorationNodes removes both result and active overlays", () => {
  const resultNode = leftoverDecoration("xterm-find-result-decoration");
  const activeNode = leftoverDecoration("xterm-find-active-result-decoration");
  stripStaleSearchDecorationNodes({
    element: {
      querySelectorAll() {
        return [resultNode, activeNode];
      },
    },
  });
  assert.equal(resultNode.removed, true);
  assert.equal(activeNode.removed, true);
});

test("settling search after an emptied query keeps a later manual selection", () => {
  const leftover = leftoverDecoration("xterm-find-result-decoration");
  const calls: string[] = [];
  const term = {
    rows: 12,
    registerDecoration() {
      return undefined;
    },
    refresh() {
      calls.push("refresh");
    },
    clearSelection() {
      calls.push("clearSelection");
    },
    element: {
      querySelectorAll() {
        return [leftover];
      },
    },
  };
  const tracker = installSearchDecorationTracker(term);
  tracker.markSearched();
  tracker.noteEmptyQueryReset();
  settleTerminalSearchAfterLayout(
    {
      clearDecorations() {
        calls.push("clearDecorations");
      },
    },
    term,
    () => calls.push("atlas"),
  );
  assert.equal(calls.includes("clearSelection"), false);
  assert.ok(calls.includes("clearDecorations"));
  assert.ok(calls.includes("atlas"));
  assert.equal(leftover.removed, true);
});

test("settling search after layout skips terminals that never searched", () => {
  const leftover = leftoverDecoration("xterm-find-result-decoration");
  const calls: string[] = [];
  const term = {
    rows: 12,
    registerDecoration() {
      return undefined;
    },
    refresh() {
      calls.push("refresh");
    },
    clearSelection() {
      calls.push("clearSelection");
    },
    element: {
      querySelectorAll() {
        return [leftover];
      },
    },
  };
  installSearchDecorationTracker(term);
  settleTerminalSearchAfterLayout(
    {
      clearDecorations() {
        calls.push("clearDecorations");
      },
    },
    term,
    () => calls.push("atlas"),
  );
  assert.deepEqual(calls, []);
  assert.equal(leftover.removed, false);
});

test("settling search after layout re-clears decorations, selection, leftover nodes, and repaints", () => {
  const leftover = leftoverDecoration("xterm-find-result-decoration");
  const calls: string[] = [];
  const searchAddon = {
    clearDecorations() {
      calls.push("clearDecorations");
    },
  };
  const term = {
    rows: 12,
    refresh(start: number, end: number) {
      calls.push(`refresh:${start}:${end}`);
    },
    clearSelection() {
      calls.push("clearSelection");
    },
    element: {
      querySelectorAll() {
        calls.push("queryLeftover");
        return [leftover];
      },
    },
  };

  settleTerminalSearchAfterLayout(searchAddon, term, () => {
    calls.push("atlas");
  });

  assert.equal(leftover.removed, true);
  assert.deepEqual(calls, [
    "clearDecorations",
    "queryLeftover",
    "refresh:0:11",
    "clearSelection",
    "atlas",
  ]);
});

test("disposeStaleSearchDecorations drops leaked search backgrounds and keeps others", () => {
  const searchMatch = {
    disposed: false,
    options: { backgroundColor: "#FFFF0044" },
    dispose() {
      this.disposed = true;
    },
  };
  const activeMatch = {
    disposed: false,
    options: { backgroundColor: "#FF880088" },
    dispose() {
      this.disposed = true;
    },
  };
  const cursorLine = {
    disposed: false,
    options: { backgroundColor: "#1e293b" },
    dispose() {
      this.disposed = true;
    },
  };
  const count = disposeStaleSearchDecorations({
    _core: {
      _decorationService: {
        decorations: [searchMatch, activeMatch, cursorLine],
      },
    },
  });
  assert.equal(count, 2);
  assert.equal(searchMatch.disposed, true);
  assert.equal(activeMatch.disposed, true);
  assert.equal(cursorLine.disposed, false);
});

test("resetting terminal search disposes leaked WebGL search decorations", () => {
  const leaked = {
    disposed: false,
    options: { backgroundColor: "#ffff0044" },
    dispose() {
      this.disposed = true;
    },
  };
  resetTerminalSearch(
    {
      findNext() {
        return false;
      },
      clearDecorations() {},
    },
    { current: "s" },
    {
      rows: 24,
      refresh() {},
      clearSelection() {},
      _core: {
        _decorationService: {
          decorations: [leaked],
        },
      },
    } as never,
  );
  assert.equal(leaked.disposed, true);
});

test("search decoration tracker disposes leaked incremental matches", () => {
  const live: Array<{
    registeredBackground?: string;
    overlayBackground?: string;
    disposed: boolean;
    dispose: () => void;
    onDispose: (cb: () => void) => { dispose: () => void };
    onRender: (cb: (el: { style: { backgroundColor: string } }) => void) => { dispose: () => void };
  }> = [];
  const registeredBackgrounds: Array<string | undefined> = [];
  const term = {
    registerDecoration(options: { backgroundColor?: string }) {
      registeredBackgrounds.push(options.backgroundColor);
      const disposeListeners: Array<() => void> = [];
      const renderListeners: Array<(el: { style: { backgroundColor: string } }) => void> = [];
      const decoration = {
        registeredBackground: options.backgroundColor,
        overlayBackground: undefined as string | undefined,
        disposed: false,
        dispose() {
          if (this.disposed) return;
          this.disposed = true;
          for (const listener of disposeListeners) listener();
        },
        onDispose(cb: () => void) {
          disposeListeners.push(cb);
          return { dispose() {} };
        },
        onRender(cb: (el: { style: { backgroundColor: string } }) => void) {
          renderListeners.push(cb);
          return { dispose() {} };
        },
        paint() {
          const el = { style: { backgroundColor: "" } };
          for (const listener of renderListeners) listener(el);
          this.overlayBackground = el.style.backgroundColor;
        },
      };
      live.push(decoration);
      return decoration;
    },
  };
  const tracker = installSearchDecorationTracker(term);
  const match = term.registerDecoration({ backgroundColor: "#FFFF0044" });
  term.registerDecoration({ backgroundColor: "#FF880088" });
  term.registerDecoration({ backgroundColor: "#1e293b" });
  match?.paint();
  assert.deepEqual(registeredBackgrounds, [undefined, undefined, "#1e293b"]);
  assert.equal(match?.overlayBackground, "#FFFF0044");
  assert.equal(tracker.size(), 2);
  tracker.markSearched();
  assert.equal(tracker.hasSearched(), true);
  assert.equal(tracker.disposeAll(), 2);
  assert.equal(live.filter((item) => item.disposed).length, 2);
  assert.equal(live.some((item) => item.registeredBackground === "#1e293b" && !item.disposed), true);
  assert.equal(tracker.size(), 0);
});

test("xterm runtime installs the search decoration tracker", () => {
  const source = readFileSync(new URL("./runtime/createXTermRuntime.ts", import.meta.url), "utf8");
  assert.match(source, /installSearchDecorationTracker\(term\)/);
});

test("disarmSearchAddonRevival cancels the addon timer and resets cached state", () => {
  const calls: string[] = [];
  disarmSearchAddonRevival({
    _highlightTimeout: {
      clear() {
        calls.push("clearTimeout");
      },
    },
    _state: {
      reset() {
        calls.push("resetState");
      },
    },
    clearActiveDecoration() {
      calls.push("clearActive");
    },
    clearDecorations() {
      calls.push("clearDecorations");
    },
  });
  assert.deepEqual(calls, [
    "clearTimeout",
    "resetState",
    "clearActive",
    "clearDecorations",
  ]);
});

test("search-bar close fit settles leftover highlights after layout", () => {
  const source = readFileSync(new URL("./useTerminalEffects.ts", import.meta.url), "utf8");
  assert.match(source, /settleTerminalSearchAfterLayout/);
  assert.match(source, /closingSearch = wasSearchOpen && !isSearchOpen/);
  assert.match(source, /if \(!closingSearch \|\| prevIsSearchOpenRef\.current\) return/);
  assert.match(source, /if \(raf\) cancelAnimationFrame\(raf\)/);
  assert.match(
    source,
    /safeFit\(\{ force: true, requireVisible: true \}\);[\s\S]*settleClosedSearch/,
  );
});
