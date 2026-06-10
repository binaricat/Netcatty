import test from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import {
  getSftpBookmarkButtonLabelKey,
  getNextSftpViewMode,
  getSftpViewModeToggleTarget,
  getSftpViewModeToggleLabelKey,
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
