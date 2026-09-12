import test from "node:test";
import assert from "node:assert/strict";

import type { SftpPane } from "./types";
import {
  assertUploadEndpointUnchanged,
  captureUploadEndpoint,
  resolveUploadTargetPane,
} from "./uploadTargetPin";

const pane = (overrides: Partial<SftpPane> & { id: string; connectionId: string; hostId?: string }): SftpPane => ({
  id: overrides.id,
  files: [],
  selectedFiles: new Set(),
  filter: "",
  loading: false,
  reconnecting: false,
  error: null,
  showHiddenFiles: false,
  filenameEncoding: "auto",
  connectionLogs: [],
  transferMutationToken: 0,
  connection: {
    id: overrides.connectionId,
    hostId: overrides.hostId ?? "host-a",
    hostLabel: "A",
    isLocal: false,
    status: "connected",
    currentPath: "/home",
  },
  ...overrides,
});

test("resolveUploadTargetPane prefers tabId over active pane", () => {
  const pinned = pane({ id: "tab-1", connectionId: "conn-1", hostId: "host-a" });
  const active = pane({ id: "tab-2", connectionId: "conn-2", hostId: "host-b" });
  const resolved = resolveUploadTargetPane({
    side: "left",
    tabId: "tab-1",
    connectionId: "conn-stale",
    getActivePane: () => active,
    getPaneByTabId: (id) => (id === "tab-1" ? pinned : null),
    getPaneByConnectionId: () => null,
  });
  assert.equal(resolved.id, "tab-1");
  assert.equal(resolved.connection?.id, "conn-1");
});

test("resolveUploadTargetPane falls back to connectionId then active", () => {
  const byConn = pane({ id: "tab-c", connectionId: "conn-c" });
  const active = pane({ id: "tab-a", connectionId: "conn-a" });
  assert.equal(
    resolveUploadTargetPane({
      side: "left",
      connectionId: "conn-c",
      getActivePane: () => active,
      getPaneByTabId: () => null,
      getPaneByConnectionId: (id) => (id === "conn-c" ? byConn : null),
    }).id,
    "tab-c",
  );
  assert.equal(
    resolveUploadTargetPane({
      side: "left",
      getActivePane: () => active,
      getPaneByTabId: () => null,
      getPaneByConnectionId: () => null,
    }).id,
    "tab-a",
  );
});

test("assertUploadEndpointUnchanged rejects host switch on same tab", () => {
  const map = new Map<string, string>([["conn-1", "key-a"]]);
  const expected = captureUploadEndpoint(
    pane({ id: "t", connectionId: "conn-1", hostId: "host-a" }).connection!,
    map,
  );
  assert.throws(
    () => assertUploadEndpointUnchanged(
      pane({ id: "t", connectionId: "conn-2", hostId: "host-b" }).connection!,
      expected,
      map,
    ),
    /Upload target changed/,
  );
});

test("assertUploadEndpointUnchanged allows same-host reconnect with new connection id", () => {
  const map = new Map<string, string>([
    ["conn-old", "key-a"],
    ["conn-new", "key-a"],
  ]);
  const expected = captureUploadEndpoint(
    pane({ id: "t", connectionId: "conn-old", hostId: "host-a" }).connection!,
    map,
  );
  assert.doesNotThrow(() => assertUploadEndpointUnchanged(
    pane({ id: "t", connectionId: "conn-new", hostId: "host-a" }).connection!,
    expected,
    map,
  ));
});

test("a strict upload pin rejects a same-endpoint connection replacement", () => {
  const map = new Map<string, string>([
    ["conn-old", "key-a"],
    ["conn-new", "key-a"],
  ]);
  const expected = captureUploadEndpoint(
    pane({ id: "t", connectionId: "conn-old", hostId: "host-a" }).connection!,
    map,
    { pinConnectionId: true },
  );
  assert.throws(() => assertUploadEndpointUnchanged(
    pane({ id: "t", connectionId: "conn-new", hostId: "host-a" }).connection!,
    expected,
    map,
  ), /Upload target changed/);
});

test("a slow strict upload probe cannot continue after its tab is rebound", async () => {
  const map = new Map<string, string>([
    ["conn-old", "key-a"],
    ["conn-new", "key-a"],
  ]);
  let livePane = pane({ id: "t", connectionId: "conn-old", hostId: "host-a" });
  const expected = captureUploadEndpoint(livePane.connection!, map, {
    pinConnectionId: true,
  });
  let resolveProbe!: () => void;
  const probe = new Promise<void>((resolve) => { resolveProbe = resolve; });
  let uploadCreated = false;
  const start = async () => {
    await probe;
    assertUploadEndpointUnchanged(livePane.connection!, expected, map);
    uploadCreated = true;
  };

  const pending = start();
  livePane = pane({ id: "t", connectionId: "conn-new", hostId: "host-a" });
  resolveProbe();

  await assert.rejects(pending, /Upload target changed/);
  assert.equal(uploadCreated, false);
});

test("carried endpoint pin rejects a retargeted tab mid multi-folder upload", () => {
  // Simulate paste-time pin for host-a; later folder call resolves tab on host-b.
  const mapAtPaste = new Map<string, string>([["conn-1", "key-a"]]);
  const pastePin = captureUploadEndpoint(
    pane({ id: "tab-1", connectionId: "conn-1", hostId: "host-a" }).connection!,
    mapAtPaste,
  );
  const mapAfterRetarget = new Map<string, string>([["conn-2", "key-b"]]);
  assert.throws(
    () => assertUploadEndpointUnchanged(
      pane({ id: "tab-1", connectionId: "conn-2", hostId: "host-b" }).connection!,
      pastePin,
      mapAfterRetarget,
    ),
    /Upload target changed/,
  );
});
