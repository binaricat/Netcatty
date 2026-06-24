import test from "node:test";
import assert from "node:assert/strict";
import type { SftpPane } from "../../application/state/sftp/types";
import {
  findReusableSftpSidePanelTab,
  isRemoteSftpTabHealthy,
  shouldResetSftpSidePanelSourceSession,
  shouldSkipSftpSidePanelAutoConnect,
} from "./sftpSidePanelAutoConnect";

const remoteConnectedTab = (overrides: Partial<SftpPane> = {}): SftpPane => ({
  id: "tab-1",
  connection: {
    id: "conn-1",
    hostId: "host-1",
    hostLabel: "server",
    isLocal: false,
    status: "connected",
    currentPath: "/var/www",
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
  ...overrides,
});

test("isRemoteSftpTabHealthy rejects loading tabs", () => {
  const tab = remoteConnectedTab({ loading: true });
  assert.equal(isRemoteSftpTabHealthy(tab, true), false);
});

test("isRemoteSftpTabHealthy rejects tabs without a backend SFTP session", () => {
  const tab = remoteConnectedTab();
  assert.equal(isRemoteSftpTabHealthy(tab, false), false);
});

test("isRemoteSftpTabHealthy rejects connecting tabs", () => {
  const tab = remoteConnectedTab({
    connection: {
      ...remoteConnectedTab().connection!,
      status: "connecting",
    },
  });
  assert.equal(isRemoteSftpTabHealthy(tab, true), false);
});

test("shouldSkipSftpSidePanelAutoConnect returns false for stale connected keys", () => {
  const tab = remoteConnectedTab({ loading: true });
  assert.equal(
    shouldSkipSftpSidePanelAutoConnect("host-key", "host-key", tab, true),
    false,
  );
});

test("findReusableSftpSidePanelTab ignores tabs stuck in loading after SSH disconnect", () => {
  const tab = remoteConnectedTab({ loading: true });
  const map = new Map([[tab.id, "host-key"]]);
  assert.equal(
    findReusableSftpSidePanelTab([tab], "host-1", "host-key", map, () => true),
    null,
  );
});

test("findReusableSftpSidePanelTab returns healthy tabs", () => {
  const tab = remoteConnectedTab();
  const map = new Map([[tab.id, "host-key"]]);
  assert.equal(
    findReusableSftpSidePanelTab([tab], "host-1", "host-key", map, () => true),
    tab,
  );
});

test("shouldResetSftpSidePanelSourceSession detects terminal session changes", () => {
  assert.equal(shouldResetSftpSidePanelSourceSession("sess-a", "sess-b"), true);
  assert.equal(shouldResetSftpSidePanelSourceSession("sess-a", "sess-a"), false);
  assert.equal(shouldResetSftpSidePanelSourceSession(null, "sess-a"), false);
  assert.equal(shouldResetSftpSidePanelSourceSession("sess-a", null), false);
});

test("shouldSkipSftpSidePanelAutoConnect returns false after terminal session changes", () => {
  const tab = remoteConnectedTab();
  assert.equal(
    shouldSkipSftpSidePanelAutoConnect("host-key", "host-key", tab, true),
    true,
  );
  // Caller gates on sessionChanged before invoking skip — stale reuse must not win.
  assert.equal(
    shouldResetSftpSidePanelSourceSession("sess-a", "sess-b"),
    true,
  );
});
