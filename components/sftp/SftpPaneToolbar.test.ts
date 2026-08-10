import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import {
  getSftpBookmarkButtonLabelKey,
  getNextSftpViewMode,
  copySftpCurrentPathToClipboard,
  getNextSftpToolbarDisplayPath,
  getSftpViewModeToggleTarget,
  getSftpViewModeToggleLabelKey,
  resolveSftpToolbarVisibleIds,
  shouldToggleSftpBookmarkFromButton,
  SftpBookmarkList,
  SftpPaneToolbar,
} from "./SftpPaneToolbar.tsx";
import type { SftpPane } from "../../application/state/sftp/types.ts";
import { TooltipProvider } from "../ui/tooltip.tsx";

const toolbarSource = fs.readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), "SftpPaneToolbar.tsx"),
  "utf8",
);

test("single SFTP view-mode button toggles to the other mode", () => {
  assert.equal(getNextSftpViewMode("list"), "tree");
  assert.equal(getNextSftpViewMode("tree"), "list");
});

test("narrow SFTP toolbar spills non-pinned show items into overflow without changing hide/collapse", () => {
  const shown = ["bookmark", "copyPath", "viewMode", "filter", "newFolder", "newFile", "refresh"];
  const collapsed = ["encoding"];
  const wide = resolveSftpToolbarVisibleIds({ shown, collapsed, narrow: false });
  assert.deepEqual(wide.inlineIds, shown);
  assert.deepEqual(wide.overflowIds, collapsed);

  const narrow = resolveSftpToolbarVisibleIds({ shown, collapsed, narrow: true });
  assert.ok(narrow.inlineIds.includes("bookmark"));
  assert.ok(narrow.inlineIds.includes("filter"));
  assert.ok(!narrow.inlineIds.includes("newFolder"));
  assert.ok(narrow.overflowIds.includes("newFolder"));
  assert.ok(narrow.overflowIds.includes("encoding"));
  // hide is already excluded from shown/collapsed by partition - not reintroduced here
  assert.ok(!narrow.inlineIds.includes("encoding"));
});

test("single SFTP view-mode button describes the target mode", () => {
  assert.equal(getSftpViewModeToggleLabelKey("list"), "sftp.viewMode.switchToTree");
  assert.equal(getSftpViewModeToggleLabelKey("tree"), "sftp.viewMode.switchToList");
});

test("single SFTP view-mode button exposes the mode it will switch to", () => {
  assert.deepEqual(getSftpViewModeToggleTarget("list"), {
    nextViewMode: "tree",
    labelKey: "sftp.viewMode.switchToTree",
  });
  assert.deepEqual(getSftpViewModeToggleTarget("tree"), {
    nextViewMode: "list",
    labelKey: "sftp.viewMode.switchToList",
  });
});

test("bookmark button keeps one-click add only when there are no saved paths", () => {
  assert.equal(shouldToggleSftpBookmarkFromButton({ bookmarkCount: 0, isCurrentPathBookmarked: false }), true);
  assert.equal(shouldToggleSftpBookmarkFromButton({ bookmarkCount: 1, isCurrentPathBookmarked: false }), false);
  assert.equal(shouldToggleSftpBookmarkFromButton({ bookmarkCount: 1, isCurrentPathBookmarked: true }), false);
});

test("bookmark button label matches whether it opens saved paths or adds current path", () => {
  assert.equal(
    getSftpBookmarkButtonLabelKey({ bookmarkCount: 0, isCurrentPathBookmarked: false }),
    "sftp.bookmark.add",
  );
  assert.equal(
    getSftpBookmarkButtonLabelKey({ bookmarkCount: 1, isCurrentPathBookmarked: false }),
    "sftp.bookmark.list",
  );
  assert.equal(
    getSftpBookmarkButtonLabelKey({ bookmarkCount: 1, isCurrentPathBookmarked: true }),
    "sftp.bookmark.list",
  );
});

test("toolbar renders one view-mode toggle instead of separate list and tree buttons", () => {
  const pane: SftpPane = {
    id: "pane-1",
    connection: {
      id: "conn-1",
      hostId: "host-1",
      name: "Example",
      currentPath: "/home/app",
      homeDir: "/home/app",
      isLocal: false,
    },
    files: [],
    loading: false,
    reconnecting: false,
    error: null,
    connectionLogs: [],
    selectedFiles: new Set(),
    filter: "",
    filenameEncoding: "auto",
    showHiddenFiles: false,
    transferMutationToken: 0,
  };

  const t = (key: string) => ({
    "sftp.viewMode.switchToTree": "Switch to tree view",
    "sftp.viewMode.list": "List view",
    "sftp.viewMode.tree": "Tree view",
    "sftp.bookmark.list": "Bookmarked paths",
  }[key] ?? key);

  const markup = renderToStaticMarkup(
    React.createElement(SftpPaneToolbar, {
      t,
      pane,
      onNavigateTo: () => {},
      onSetFilter: () => {},
      onSetFilenameEncoding: () => {},
      onRefresh: () => {},
      showFilterBar: false,
      setShowFilterBar: () => {},
      filterInputRef: { current: null },
      isEditingPath: false,
      editingPathValue: "",
      setEditingPathValue: () => {},
      setShowPathSuggestions: () => {},
      showPathSuggestions: false,
      setPathSuggestionIndex: () => {},
      pathSuggestions: [],
      pathSuggestionIndex: -1,
      pathInputRef: { current: null },
      pathDropdownRef: { current: null },
      handlePathBlur: () => {},
      handlePathKeyDown: () => {},
      handlePathDoubleClick: () => {},
      handlePathSubmit: () => {},
      getNextUntitledName: () => "untitled",
      setNewFileName: () => {},
      setFileNameError: () => {},
      setShowNewFileDialog: () => {},
      setShowNewFolderDialog: () => {},
      setNewFolderName: () => {},
      bookmarks: [{ id: "bm-1", path: "/srv/www", label: "/srv/www" }],
      isCurrentPathBookmarked: false,
      onToggleBookmark: () => {},
      onAddGlobalBookmark: () => {},
      isCurrentPathGlobalBookmarked: false,
      onNavigateToBookmark: () => {},
      onDeleteBookmark: () => {},
      showHiddenFiles: false,
      onToggleShowHiddenFiles: () => {},
      viewMode: "list",
      onSetViewMode: () => {},
    }),
  );

  assert.match(markup, /aria-label="Switch to tree view"/);
  assert.doesNotMatch(markup, /aria-label="List view"/);
  assert.doesNotMatch(markup, /aria-label="Tree view"/);
  assert.match(markup, /aria-label="Bookmarked paths"/);
});

test("toolbar exposes locate-path-in-terminal when the callback is provided", () => {
  const pane: SftpPane = {
    id: "pane-1",
    connection: {
      id: "conn-1",
      hostId: "host-1",
      name: "Example",
      currentPath: "/var/www/app",
      homeDir: "/home/app",
      isLocal: false,
    },
    files: [],
    loading: false,
    reconnecting: false,
    error: null,
    connectionLogs: [],
    selectedFiles: new Set(),
    filter: "",
    filenameEncoding: "auto",
    showHiddenFiles: false,
    transferMutationToken: 0,
  };

  const markup = renderToStaticMarkup(
    React.createElement(TooltipProvider, {
      children: React.createElement(SftpPaneToolbar, {
        t: (key: string) => ({
          "sftp.locatePathInTerminal": "Open path in terminal",
          "sftp.viewMode.switchToTree": "Switch to tree view",
          "sftp.bookmark.add": "Bookmark current path",
        }[key] ?? key),
        pane,
        onNavigateTo: () => {},
        onSetFilter: () => {},
        onSetFilenameEncoding: () => {},
        onRefresh: () => {},
        showFilterBar: false,
        setShowFilterBar: () => {},
        filterInputRef: { current: null },
        isEditingPath: false,
        editingPathValue: "",
        setEditingPathValue: () => {},
        setShowPathSuggestions: () => {},
        showPathSuggestions: false,
        setPathSuggestionIndex: () => {},
        pathSuggestions: [],
        pathSuggestionIndex: -1,
        pathInputRef: { current: null },
        pathDropdownRef: { current: null },
        handlePathBlur: () => {},
        handlePathKeyDown: () => {},
        handlePathDoubleClick: () => {},
        handlePathSubmit: () => {},
        getNextUntitledName: () => "untitled",
        setNewFileName: () => {},
        setFileNameError: () => {},
        setShowNewFileDialog: () => {},
        setShowNewFolderDialog: () => {},
        setNewFolderName: () => {},
        bookmarks: [],
        isCurrentPathBookmarked: false,
        onToggleBookmark: () => {},
        onAddGlobalBookmark: () => {},
        isCurrentPathGlobalBookmarked: false,
        onNavigateToBookmark: () => {},
        onDeleteBookmark: () => {},
        showHiddenFiles: false,
        onToggleShowHiddenFiles: () => {},
        onLocatePathInTerminal: () => {},
        viewMode: "list",
        onSetViewMode: () => {},
      }),
    }),
  );

  assert.match(markup, /aria-label="Open path in terminal"/);
});

test("toolbar exposes copy-current-path action for the active directory", () => {
  const pane: SftpPane = {
    id: "pane-1",
    connection: {
      id: "conn-1",
      hostId: "host-1",
      name: "Example",
      currentPath: "/var/www/app",
      homeDir: "/home/app",
      isLocal: false,
    },
    files: [],
    loading: false,
    reconnecting: false,
    error: null,
    connectionLogs: [],
    selectedFiles: new Set(),
    filter: "",
    filenameEncoding: "auto",
    showHiddenFiles: false,
    transferMutationToken: 0,
  };

  const markup = renderToStaticMarkup(
    React.createElement(SftpPaneToolbar, {
      t: (key: string) => ({
        "sftp.copyCurrentPath": "Copy current path",
        "sftp.viewMode.switchToTree": "Switch to tree view",
        "sftp.bookmark.list": "Bookmarked paths",
      }[key] ?? key),
      pane,
      onNavigateTo: () => {},
      onSetFilter: () => {},
      onSetFilenameEncoding: () => {},
      onRefresh: () => {},
      showFilterBar: false,
      setShowFilterBar: () => {},
      filterInputRef: { current: null },
      isEditingPath: false,
      editingPathValue: "",
      setEditingPathValue: () => {},
      setShowPathSuggestions: () => {},
      showPathSuggestions: false,
      setPathSuggestionIndex: () => {},
      pathSuggestions: [],
      pathSuggestionIndex: -1,
      pathInputRef: { current: null },
      pathDropdownRef: { current: null },
      handlePathBlur: () => {},
      handlePathKeyDown: () => {},
      handlePathDoubleClick: () => {},
      handlePathSubmit: () => {},
      getNextUntitledName: () => "untitled",
      setNewFileName: () => {},
      setFileNameError: () => {},
      setShowNewFileDialog: () => {},
      setShowNewFolderDialog: () => {},
      setNewFolderName: () => {},
      bookmarks: [],
      isCurrentPathBookmarked: false,
      onToggleBookmark: () => {},
      onAddGlobalBookmark: () => {},
      isCurrentPathGlobalBookmarked: false,
      onNavigateToBookmark: () => {},
      onDeleteBookmark: () => {},
      showHiddenFiles: false,
      onToggleShowHiddenFiles: () => {},
      viewMode: "list",
      onSetViewMode: () => {},
    }),
  );

  assert.match(markup, /aria-label="Copy current path"/);
});

test("copy-current-path action writes the displayed path and reports success", async () => {
  let copiedText = "";
  let successMessage = "";

  await copySftpCurrentPathToClipboard({
    currentPath: "/srv/current",
    writeText: async (text) => {
      copiedText = text;
    },
    onSuccess: (message) => {
      successMessage = message;
    },
    onError: () => {},
    t: (key) => ({
      "sftp.copyCurrentPath.success": "Current path copied",
    }[key] ?? key),
  });

  assert.equal(copiedText, "/srv/current");
  assert.equal(successMessage, "Current path copied");
});

test("copy-current-path action reports clipboard failures", async () => {
  let errorMessage = "";

  await copySftpCurrentPathToClipboard({
    currentPath: "/srv/current",
    writeText: async () => {
      throw new Error("denied");
    },
    onSuccess: () => {},
    onError: (message) => {
      errorMessage = message;
    },
    t: (key) => ({
      "sftp.copyCurrentPath.error": "Could not copy current path",
    }[key] ?? key),
  });

  assert.equal(errorMessage, "Could not copy current path");
});

test("SFTP filter input guards CJK IME composition instead of deferring controlled value writes", () => {
  assert.match(toolbarSource, /onCompositionStart=\{/);
  assert.match(toolbarSource, /onCompositionEnd=\{/);
  assert.match(toolbarSource, /shouldCommitImeControlledChange/);
  assert.match(toolbarSource, /value=\{filterDraft\}/);
  assert.doesNotMatch(
    toolbarSource,
    /onChange=\{\(e\) => startTransition\(\(\) => onSetFilter\(e\.target\.value\)\)\}/,
  );
});

test("SFTP filter honors an external filter change over a stale draft when composition ends", () => {
  // If navigation clears pane.filter mid-composition, compositionEnd must adopt the
  // external value instead of committing the stale draft, preserving the invariant
  // that different-directory navigation clears the filter.
  assert.match(toolbarSource, /filterAtComposeStartRef\.current = pane\.filter;/);
  assert.match(toolbarSource, /filterPathAtComposeStartRef\.current = pane\.connection\?\.currentPath/);
  assert.match(
    toolbarSource,
    /pane\.filter !== filterAtComposeStartRef\.current\s*\|\|\s*pathChangedDuringCompose\s*\|\|\s*filterCompositionSupersededRef\.current/,
  );
  assert.match(toolbarSource, /filterCompositionSupersededRef\.current = true;/);
  assert.match(toolbarSource, /setFilterDraft\(pane\.filter\);/);
});

test("SFTP filter adopts external navigation-cleared filters during an open IME composition", () => {
  // Sync path must pass valueAtComposeStart while composing so pane.filter="" from
  // different-directory navigation supersedes the draft mid-composition.
  assert.match(toolbarSource, /valueAtComposeStart:\s*composing/);
  assert.match(toolbarSource, /filterAtComposeStartRef\.current/);
  assert.match(toolbarSource, /pathChangedDuringCompose/);
  assert.match(
    toolbarSource,
    /filterCompositionSupersededRef\.current = true;/,
  );
});

test("SFTP filter supersedes IME draft on path navigation even when committed filter was already empty", () => {
  // When the filter was already "" at compose start, navigation sets filter to ""
  // again - pane.filter does not change - so path-at-compose-start must drive
  // supersede; otherwise compositionend commits the stale draft.
  assert.match(toolbarSource, /filterPathAtComposeStartRef/);
  assert.match(
    toolbarSource,
    /currentPath !== filterPathAtComposeStartRef\.current/,
  );
  assert.match(
    toolbarSource,
    /\[pane\.filter, pane\.connection\?\.currentPath\]/,
  );
  // Hide-filter reset must still clear composing + supersede and resync draft.
  assert.match(
    toolbarSource,
    /if \(!showFilterBar\) \{\s*filterComposingRef\.current = false;\s*filterCompositionSupersededRef\.current = false;\s*setFilterDraft\(pane\.filter\);/,
  );
});

test("SFTP filter suppresses the post-composition onChange after external supersede", () => {
  // Browsers may fire onChange with composing=false after compositionend; that event
  // must not re-commit the stale composed draft over a navigation-cleared filter.
  assert.match(toolbarSource, /resolveSupersededImeInputEvent/);
  assert.match(toolbarSource, /superseded\.ignoreEventValue/);
  assert.match(toolbarSource, /compositionExternallySuperseded:\s*filterCompositionSupersededRef\.current/);
});

test("SFTP filter clears the supersede latch if no post-composition change arrives", () => {
  // Some IME/browser paths never fire the post-compositionend onChange that would
  // clear filterCompositionSupersededRef; without a deferred clear, the next
  // ordinary keystroke is treated as the stale supersede follow-up and dropped.
  // Guard the clear so an intervening onChange clear or new compositionstart wins.
  assert.match(
    toolbarSource,
    /filterCompositionSupersededRef\.current = true;\s*setFilterDraft\(pane\.filter\);\s*window\.setTimeout\(\(\) => \{/,
  );
  assert.match(
    toolbarSource,
    /if \(\s*filterCompositionSupersededRef\.current\s*&&\s*!filterComposingRef\.current\s*\) \{\s*filterCompositionSupersededRef\.current = false;/,
  );
});

test("SFTP filter commit path clears the IME composing guard so clears/commits can't leave it stuck", () => {
  // commitFilterValue backs composition end, Escape, inline clear and close; it must
  // drop the guard so a programmatic clear mid-composition isn't blocked or undone.
  assert.match(
    toolbarSource,
    /const commitFilterValue = useCallback\(\(value: string\) => \{[\s\S]*?filterComposingRef\.current = false;[\s\S]*?filterCompositionSupersededRef\.current = false;/,
  );
});

test("SFTP filter clears the IME composing guard and resyncs the draft when the filter bar closes", () => {
  // If the input unmounts mid-composition, compositionend never fires; the guard
  // must be reset (or every later onSetFilter is blocked) and the draft resynced to
  // the committed filter so a reopened bar never shows stale, uncommitted text.
  assert.match(
    toolbarSource,
    /if \(!showFilterBar\) \{\s*filterComposingRef\.current = false;\s*filterCompositionSupersededRef\.current = false;\s*setFilterDraft\(pane\.filter\);/,
  );
});

test("toolbar display path keeps the previous confirmed path while loading the same connection", () => {
  assert.equal(
    getNextSftpToolbarDisplayPath({
      previousDisplayPath: "/srv/old",
      previousConnectionId: "conn-1",
      connectionId: "conn-1",
      currentPath: "/srv/new",
      loading: true,
    }),
    "/srv/old",
  );
});

test("bookmark list renders saved paths as selectable rows", () => {
  const markup = renderToStaticMarkup(
    React.createElement(
      TooltipProvider,
      null,
      React.createElement(SftpBookmarkList, {
        bookmarks: [{ id: "bm-1", path: "/srv/www", label: "Web root" }],
        onNavigateToBookmark: () => {},
        onDeleteBookmark: () => {},
        t: (key: string) => ({
          "sftp.bookmark.remove": "Remove bookmark",
        }[key] ?? key),
      }),
    ),
  );

  assert.match(markup, /Web root/);
  assert.match(markup, /\/srv\/www/);
  assert.match(markup, /aria-label="Remove bookmark"/);
  assert.match(markup, /focus-visible:opacity-100/);
});
