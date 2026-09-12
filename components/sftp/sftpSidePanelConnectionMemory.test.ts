import assert from "node:assert/strict";
import test from "node:test";
import {
  MAX_SFTP_SIDE_PANEL_REMEMBERED_PATHS,
  canApplySftpSidePanelInitialLocation,
  pruneSftpSidePanelState,
  recallSftpSidePanelPath,
  rememberSftpSidePanelPath,
} from "./sftpSidePanelConnectionMemory";

const initialLocationParams = {
  activeHostId: "host-1",
  initialLocation: { hostId: "host-1", path: "/srv/b" },
  expectedConnectionKey: "host-1:endpoint",
  actualConnectionKey: "host-1:endpoint",
  pendingRequiresExactTarget: true,
  pendingTargetConnectionId: "connection-b",
  connection: {
    id: "connection-b",
    hostId: "host-1",
    isLocal: false,
    status: "connected",
  },
};

test("initial location waits for the exact endpoint and pending target", () => {
  assert.equal(canApplySftpSidePanelInitialLocation(initialLocationParams), true);
  assert.equal(canApplySftpSidePanelInitialLocation({
    ...initialLocationParams,
    connection: {
      ...initialLocationParams.connection,
      id: "connection-a",
    },
  }), false);
  assert.equal(canApplySftpSidePanelInitialLocation({
    ...initialLocationParams,
    pendingTargetConnectionId: null,
  }), false);
  assert.equal(canApplySftpSidePanelInitialLocation({
    ...initialLocationParams,
    actualConnectionKey: "host-1:other-endpoint",
  }), false);
});

test("ordinary initial locations apply once the matching pane is connected", () => {
  assert.equal(canApplySftpSidePanelInitialLocation({
    ...initialLocationParams,
    pendingRequiresExactTarget: false,
    pendingTargetConnectionId: null,
  }), true);
  assert.equal(canApplySftpSidePanelInitialLocation({
    ...initialLocationParams,
    pendingRequiresExactTarget: false,
    pendingTargetConnectionId: null,
    connection: {
      ...initialLocationParams.connection,
      status: "connecting",
    },
  }), false);
});

test("closed SFTP side-panel tabs release their remembered connection keys", () => {
  const connectionKeys = new Map<string, string>();
  for (let index = 0; index < 100; index += 1) {
    connectionKeys.set(`tab-${index}`, `connection-${index}`);
  }

  pruneSftpSidePanelState(connectionKeys, ["tab-97", "tab-98", "tab-99"]);

  assert.deepEqual([...connectionKeys], [
    ["tab-97", "connection-97"],
    ["tab-98", "connection-98"],
    ["tab-99", "connection-99"],
  ]);
});

test("SFTP side-panel path memory stays bounded during endpoint churn", () => {
  const paths = new Map<string, string>();
  for (let index = 0; index < 100; index += 1) {
    rememberSftpSidePanelPath(paths, `endpoint-${index}`, `/path/${index}`);
  }

  assert.equal(paths.size, MAX_SFTP_SIDE_PANEL_REMEMBERED_PATHS);
  assert.equal(paths.has("endpoint-0"), false);
  assert.equal(paths.get("endpoint-99"), "/path/99");
});

test("reading a remembered SFTP path keeps that endpoint in the LRU", () => {
  const paths = new Map<string, string>();
  rememberSftpSidePanelPath(paths, "endpoint-a", "/a", 3);
  rememberSftpSidePanelPath(paths, "endpoint-b", "/b", 3);
  rememberSftpSidePanelPath(paths, "endpoint-c", "/c", 3);

  assert.equal(recallSftpSidePanelPath(paths, "endpoint-a"), "/a");
  rememberSftpSidePanelPath(paths, "endpoint-d", "/d", 3);

  assert.equal(paths.has("endpoint-a"), true);
  assert.equal(paths.has("endpoint-b"), false);
});
