import test from "node:test";
import assert from "node:assert/strict";

import type { SftpPane } from "../../application/state/sftp/types.ts";
import {
  canDuplicateSftpTab,
  getSftpTabDuplicateRequest,
  isSftpTabKeyboardContextMenuShortcut,
  isSftpTabKeyboardSelectShortcut,
  shouldHandleSftpTabKeyboardEvent,
  SFTP_TAB_DUPLICATE_MENU_ITEMS,
} from "./sftpTabDuplication.ts";

const connectedPane = (overrides: Partial<NonNullable<SftpPane["connection"]>> = {}): SftpPane => ({
  id: "tab-1",
  connection: {
    id: "conn-1",
    hostId: "host-1",
    hostLabel: "Prod",
    isLocal: false,
    status: "connected",
    currentPath: "/var/www/app",
    homeDir: "/home/deploy",
    ...overrides,
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
});

test("default-path SFTP tab duplication keeps only the remote host identity", () => {
  assert.deepEqual(getSftpTabDuplicateRequest(connectedPane(), "defaultPath"), {
    kind: "remote",
    hostId: "host-1",
  });
});

test("current-path SFTP tab duplication carries the active directory", () => {
  assert.deepEqual(getSftpTabDuplicateRequest(connectedPane(), "currentPath"), {
    kind: "remote",
    hostId: "host-1",
    path: "/var/www/app",
  });
});

test("local SFTP tab duplication targets the local filesystem", () => {
  assert.deepEqual(
    getSftpTabDuplicateRequest(
      connectedPane({
        hostId: "local",
        hostLabel: "Local",
        isLocal: true,
        currentPath: "/Users/damao/projects",
        homeDir: "/Users/damao",
      }),
      "currentPath",
    ),
    {
      kind: "local",
      path: "/Users/damao/projects",
    },
  );
});

test("SFTP tab duplication is unavailable before a tab is connected", () => {
  assert.equal(getSftpTabDuplicateRequest({ ...connectedPane(), connection: null }, "defaultPath"), null);
  assert.equal(
    getSftpTabDuplicateRequest(connectedPane({ status: "connecting" }), "currentPath"),
    null,
  );
});

test("SFTP tab duplicate menu exposes separate default and current path actions", () => {
  assert.deepEqual(
    SFTP_TAB_DUPLICATE_MENU_ITEMS.map((item) => item.mode),
    ["defaultPath", "currentPath"],
  );
  assert.deepEqual(
    SFTP_TAB_DUPLICATE_MENU_ITEMS.map((item) => item.labelKey),
    ["sftp.tabs.copyDefaultPath", "sftp.tabs.copyCurrentPath"],
  );
});

test("SFTP tab duplicate menu is disabled without a connected tab and handler", () => {
  assert.equal(canDuplicateSftpTab({ canDuplicate: true }, true), true);
  assert.equal(canDuplicateSftpTab({ canDuplicate: true }, false), false);
  assert.equal(canDuplicateSftpTab({ canDuplicate: false }, true), false);
  assert.equal(canDuplicateSftpTab(connectedPane(), true), true);
  assert.equal(canDuplicateSftpTab(connectedPane({ status: "connecting" }), true), false);
});

test("SFTP tab duplicate menu has keyboard shortcuts for selection and menu access", () => {
  assert.equal(isSftpTabKeyboardSelectShortcut("Enter"), true);
  assert.equal(isSftpTabKeyboardSelectShortcut(" "), true);
  assert.equal(isSftpTabKeyboardSelectShortcut("Escape"), false);
  assert.equal(isSftpTabKeyboardContextMenuShortcut("ContextMenu"), true);
  assert.equal(isSftpTabKeyboardContextMenuShortcut("F10", true), true);
  assert.equal(isSftpTabKeyboardContextMenuShortcut("F10", false), false);
});

test("SFTP tab keyboard shortcuts do not intercept nested close button events", () => {
  const tab = new EventTarget();
  const closeButton = new EventTarget();

  assert.equal(shouldHandleSftpTabKeyboardEvent(tab, tab), true);
  assert.equal(shouldHandleSftpTabKeyboardEvent(closeButton, tab), false);
});
