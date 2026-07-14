import test from "node:test";
import assert from "node:assert/strict";
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
  // hide is already excluded from shown/collapsed by partition — not reintroduced here
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
      startTransition: (callback: () => void) => callback(),
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
      startTransition: (callback: () => void) => callback(),
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
