import assert from "node:assert/strict";
import test from "node:test";

import type { Host, TerminalSession, Workspace } from "./models";
import { collectSessionIds } from "./workspace";
import {
  DEFAULT_CLOSED_TAB_HISTORY_LIMIT,
  createClosedSessionEntry,
  createClosedSessionSnapshot,
  createClosedWorkspaceEntry,
  isClosedSessionSnapshotRestorable,
  materializeClosedTabEntry,
  popClosedTabEntry,
  pruneClosedTabEntries,
  pushClosedTabEntry,
  type ClosedTabEntry,
} from "./closedTabHistory";

const makeSession = (
  id: string,
  overrides: Partial<TerminalSession> = {},
): TerminalSession => ({
  id,
  hostId: `host-${id}`,
  hostLabel: `Host ${id}`,
  hostname: `${id}.example.test`,
  username: "ops",
  status: "connected",
  protocol: "ssh",
  port: 22,
  ...overrides,
});

const makeHost = (id: string, overrides: Partial<Host> = {}): Host => ({
  id,
  label: `Vault ${id}`,
  hostname: `${id}.vault.test`,
  username: "admin",
  port: 22,
  os: "linux",
  group: "",
  tags: [],
  protocol: "ssh",
  ...overrides,
});

test("createClosedSessionSnapshot strips transient, secret-adjacent, and script fields", () => {
  const hidden = createClosedSessionSnapshot(makeSession("s-hidden", { hiddenFromTabs: true }));
  assert.equal(hidden, null);

  const source = makeSession("s1", {
    customName: "Prod Web",
    fontSize: 15,
    fontSizeOverride: true,
    localShell: "/bin/zsh",
    localShellArgs: ["-l"],
    startupCommand: "rm -rf /tmp/foo",
    noAutoRun: false,
    pendingScriptId: "script-1",
    reuseConnectionFromSessionId: "prev-session",
    restoreState: "restored-disconnected",
    pendingInitialCwd: "/var/log",
    dynamicTitle: "vim",
    requireFreshConnection: true,
  });

  const snapshot = createClosedSessionSnapshot(source, { lastCwd: "/srv/app" });
  assert.ok(snapshot);
  assert.equal(snapshot.sourceSessionId, "s1");
  assert.equal(snapshot.customName, "Prod Web");
  assert.equal(snapshot.fontSize, 15);
  assert.equal(snapshot.fontSizeOverride, true);
  assert.equal(snapshot.lastCwd, "/srv/app");
  assert.equal(snapshot.requireFreshConnection, true);
  assert.deepEqual(snapshot.localShellArgs, ["-l"]);

  // Mutating source arrays after snapshotting does not mutate the snapshot.
  source.localShellArgs?.push("-i");
  assert.deepEqual(snapshot.localShellArgs, ["-l"]);

  assert.equal("startupCommand" in snapshot, false);
  assert.equal("pendingScriptId" in snapshot, false);
  assert.equal("pendingScript" in snapshot, false);
  assert.equal("reuseConnectionFromSessionId" in snapshot, false);
  assert.equal("restoreState" in snapshot, false);
  assert.equal("pendingInitialCwd" in snapshot, false);
  assert.equal("dynamicTitle" in snapshot, false);
});

test("pushClosedTabEntry enforces bounded LIFO limit and deduplicates by sourceId", () => {
  let history: ClosedTabEntry[] = [];
  for (let i = 1; i <= DEFAULT_CLOSED_TAB_HISTORY_LIMIT + 5; i++) {
    const entry = createClosedSessionEntry(makeSession(`s-${i}`), { closedAt: i });
    history = pushClosedTabEntry(history, entry);
  }

  assert.equal(history.length, DEFAULT_CLOSED_TAB_HISTORY_LIMIT);
  assert.equal(history[0].sourceId, "s-6");
  assert.equal(history[history.length - 1].sourceId, "s-25");

  // Duplicate push of an already-recorded close event is ignored.
  const dup = createClosedSessionEntry(makeSession("s-25"), { closedAt: 999 });
  const afterDup = pushClosedTabEntry(history, dup);
  assert.equal(afterDup.length, DEFAULT_CLOSED_TAB_HISTORY_LIMIT);
  assert.equal(afterDup[afterDup.length - 1].closedAt, 25);

  // Pop returns most recently closed entry first (LIFO).
  const firstPop = popClosedTabEntry(afterDup);
  assert.equal(firstPop.entry?.sourceId, "s-25");
  assert.equal(firstPop.nextHistory.length, DEFAULT_CLOSED_TAB_HISTORY_LIMIT - 1);

  const secondPop = popClosedTabEntry(firstPop.nextHistory);
  assert.equal(secondPop.entry?.sourceId, "s-24");
});

test("isClosedSessionSnapshotRestorable handles vault hosts, local terminals, quick serial, and ephemeral hosts", () => {
  const availableHostIds = new Set(["host-live"]);

  assert.equal(
    isClosedSessionSnapshotRestorable(
      createClosedSessionSnapshot(makeSession("s1", { hostId: "host-live" }))!,
      availableHostIds,
    ),
    true,
  );
  assert.equal(
    isClosedSessionSnapshotRestorable(
      createClosedSessionSnapshot(makeSession("s2", { hostId: "host-deleted" }))!,
      availableHostIds,
    ),
    false,
  );
  assert.equal(
    isClosedSessionSnapshotRestorable(
      createClosedSessionSnapshot(makeSession("local-1", {
        hostId: "local-terminal",
        protocol: "local",
        hostname: "localhost",
        username: "local",
      }))!,
      availableHostIds,
    ),
    true,
  );
  assert.equal(
    isClosedSessionSnapshotRestorable(
      createClosedSessionSnapshot(makeSession("serial-1", {
        hostId: "serial-abc",
        protocol: "serial",
        hostname: "/dev/ttyUSB0",
        username: "",
        serialConfig: { path: "/dev/ttyUSB0", baudRate: 115200 },
      }))!,
      availableHostIds,
    ),
    true,
  );
  assert.equal(
    isClosedSessionSnapshotRestorable(
      createClosedSessionSnapshot(makeSession("eph-1", {
        hostId: "ephemeral-1",
        ephemeralHost: true,
        hostname: "jump.example.test",
      }))!,
      availableHostIds,
    ),
    true,
  );
});

test("createClosedWorkspaceEntry captures nested layout ratios, focus, and view mode, and skips empty workspaces", () => {
  const emptyWs: Workspace = {
    id: "ws-empty",
    title: "Empty",
    root: { id: "r", type: "split", direction: "vertical", children: [], sizes: [] },
  };
  assert.equal(createClosedWorkspaceEntry(emptyWs, []), null);

  const ws: Workspace = {
    id: "ws-1",
    title: "Prod Cluster",
    autoTitle: false,
    viewMode: "split",
    focusedSessionId: "s3",
    focusSessionOrder: ["s2", "s3", "s1"],
    anchorChatId: "chat-should-not-carry",
    root: {
      id: "split-root",
      type: "split",
      direction: "vertical",
      sizes: [0.35, 0.65],
      children: [
        { id: "pane-1", type: "pane", sessionId: "s1" },
        {
          id: "split-right",
          type: "split",
          direction: "horizontal",
          sizes: [0.3, 0.7],
          children: [
            { id: "pane-2", type: "pane", sessionId: "s2" },
            { id: "pane-3", type: "pane", sessionId: "s3" },
          ],
        },
      ],
    },
  };
  const members = [
    makeSession("s1", { workspaceId: "ws-1" }),
    makeSession("s2", { workspaceId: "ws-1" }),
    makeSession("s3", { workspaceId: "ws-1", protocol: "local", hostId: "local-terminal" }),
  ];

  const entry = createClosedWorkspaceEntry(ws, members, {
    closedAt: 1000,
    cwdBySessionId: new Map([["s3", "/Users/dev/project"]]),
  });
  assert.ok(entry);
  assert.equal(entry.kind, "workspace");
  assert.equal(entry.title, "Prod Cluster");
  assert.equal(entry.autoTitle, false);
  assert.equal(entry.viewMode, "split");
  assert.equal(entry.focusedSessionId, "s3");
  assert.deepEqual(entry.focusSessionOrder, ["s2", "s3", "s1"]);
  assert.equal(entry.sessions.length, 3);
  assert.equal(entry.sessions[2].lastCwd, "/Users/dev/project");
  assert.equal(entry.root.type, "split");
  assert.deepEqual(entry.root.sizes, [0.35, 0.65]);
  assert.equal("anchorChatId" in entry, false);
});

test("pruneClosedTabEntries and popClosedTabEntry skip deleted hosts and prune partial workspace panes while preserving ratios", () => {
  const ws: Workspace = {
    id: "ws-1",
    title: "Mixed",
    focusedSessionId: "s2",
    focusSessionOrder: ["s1", "s2", "s3"],
    root: {
      id: "root",
      type: "split",
      direction: "vertical",
      sizes: [0.2, 0.3, 0.5],
      children: [
        { id: "p1", type: "pane", sessionId: "s1" },
        { id: "p2", type: "pane", sessionId: "s2" },
        { id: "p3", type: "pane", sessionId: "s3" },
      ],
    },
  };
  const wsEntry = createClosedWorkspaceEntry(ws, [
    makeSession("s1", { workspaceId: "ws-1", hostId: "h-keep-1" }),
    makeSession("s2", { workspaceId: "ws-1", hostId: "h-deleted" }),
    makeSession("s3", { workspaceId: "ws-1", hostId: "h-keep-3" }),
  ])!;
  const deletedStandalone = createClosedSessionEntry(makeSession("s-del", { hostId: "h-deleted" }))!;

  let history: ClosedTabEntry[] = [];
  history = pushClosedTabEntry(history, wsEntry);
  history = pushClosedTabEntry(history, deletedStandalone);

  const availableHostIds = new Set(["h-keep-1", "h-keep-3"]);

  const pruned = pruneClosedTabEntries(history, { availableHostIds });
  assert.equal(pruned.length, 1);
  assert.equal(pruned[0].kind, "workspace");
  assert.deepEqual(collectSessionIds(pruned[0].root), ["s1", "s3"]);
  assert.equal(pruned[0].focusedSessionId, "s1");
  assert.deepEqual(pruned[0].focusSessionOrder, ["s1", "s3"]);
  assert.equal(pruned[0].root.type, "split");
  // Ratios 0.2 and 0.5 renormalized to 2/7 and 5/7.
  assert.ok(Math.abs((pruned[0].root.sizes?.[0] ?? 0) - 2 / 7) < 1e-9);
  assert.ok(Math.abs((pruned[0].root.sizes?.[1] ?? 0) - 5 / 7) < 1e-9);

  // popClosedTabEntry skips the deleted standalone entry at the top and pops the pruned workspace.
  const popped = popClosedTabEntry(history, { availableHostIds });
  assert.ok(popped.entry);
  assert.equal(popped.entry.kind, "workspace");
  assert.deepEqual(collectSessionIds(popped.entry.root), ["s1", "s3"]);
  assert.equal(popped.nextHistory.length, 0);

  // If all hosts are deleted, pop returns null cleanly.
  const emptyPop = popClosedTabEntry(history, { availableHostIds: new Set() });
  assert.equal(emptyPop.entry, null);
  assert.equal(emptyPop.nextHistory.length, 0);
});

test("materializeClosedTabEntry mints fresh ids, reconnects immediately, and refreshes live host metadata", () => {
  let seq = 0;
  const createId = () => `new-${++seq}`;
  const hostsById = new Map<string, Host>([
    ["host-s1", makeHost("host-s1", { label: "Renamed Prod", hostname: "prod-new.test", username: "deploy" })],
  ]);

  const sessionEntry = createClosedSessionEntry(
    makeSession("s1", { customName: "My Tab", status: "disconnected" }),
  )!;
  const reopenedSolo = materializeClosedTabEntry(sessionEntry, { hostsById, createId });
  assert.ok(reopenedSolo && reopenedSolo.kind === "session");
  assert.equal(reopenedSolo.tabId, "new-1");
  assert.equal(reopenedSolo.session.id, "new-1");
  assert.equal(reopenedSolo.session.status, "connecting");
  assert.equal(reopenedSolo.session.restoreState, undefined);
  assert.equal(reopenedSolo.session.hostLabel, "Renamed Prod");
  assert.equal(reopenedSolo.session.hostname, "prod-new.test");
  assert.equal(reopenedSolo.session.username, "deploy");
  assert.equal(reopenedSolo.session.customName, "My Tab");

  const ws: Workspace = {
    id: "ws-old",
    title: "Dual",
    viewMode: "split",
    focusedSessionId: "s2",
    focusSessionOrder: ["s1", "s2"],
    root: {
      id: "split-old",
      type: "split",
      direction: "vertical",
      sizes: [0.7, 0.3],
      children: [
        { id: "p1-old", type: "pane", sessionId: "s1" },
        { id: "p2-old", type: "pane", sessionId: "s2" },
      ],
    },
  };
  const wsEntry = createClosedWorkspaceEntry(ws, [
    makeSession("s1", { workspaceId: "ws-old" }),
    makeSession("s2", {
      workspaceId: "ws-old",
      hostId: "local-terminal",
      protocol: "local",
      hostname: "localhost",
      username: "local",
      localStartDir: "/home/initial",
    }),
  ], { cwdBySessionId: new Map([["s2", "/home/current"]]) })!;

  const reopenedWs = materializeClosedTabEntry(wsEntry, { hostsById, createId });
  assert.ok(reopenedWs && reopenedWs.kind === "workspace");
  assert.notEqual(reopenedWs.workspace.id, "ws-old");
  assert.equal(reopenedWs.tabId, reopenedWs.workspace.id);
  assert.equal(reopenedWs.workspace.title, "Dual");
  assert.equal(reopenedWs.workspace.viewMode, "split");
  assert.equal(reopenedWs.sessions.length, 2);
  assert.ok(reopenedWs.sessions.every((s) => s.workspaceId === reopenedWs.workspace.id));
  assert.ok(reopenedWs.sessions.every((s) => s.status === "connecting"));
  assert.equal(reopenedWs.sessions[0].hostLabel, "Renamed Prod");
  assert.equal(reopenedWs.sessions[1].localStartDir, "/home/current");

  const newPaneIds = collectSessionIds(reopenedWs.workspace.root);
  assert.deepEqual(newPaneIds, reopenedWs.sessions.map((s) => s.id));
  assert.equal(reopenedWs.workspace.focusedSessionId, reopenedWs.sessions[1].id);
  assert.deepEqual(reopenedWs.workspace.focusSessionOrder, reopenedWs.sessions.map((s) => s.id));
  assert.equal(reopenedWs.workspace.root.type, "split");
  assert.deepEqual(reopenedWs.workspace.root.sizes, [0.7, 0.3]);
});
