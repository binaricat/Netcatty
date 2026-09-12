import { test } from "node:test";
import assert from "node:assert/strict";
import { copySessionWithCurrentShellImpl, copyWorkspaceWithCurrentShellImpl, duplicateSessionWithCurrentShellImpl, splitSessionWithCurrentShellImpl } from "./AppHandlers";
import { createCopiedTerminalSessionClone } from "../state/terminalConnectionReuse";
import type { TerminalSession } from "../../domain/models";

type CloneOpts = { localShellType?: string; inheritedCwd?: string; reuseConnection?: boolean };
type Calls = {
  copy?: { id: string; opts: CloneOpts };
  split?: { id: string; dir: string; opts: CloneOpts };
  probed: boolean;
};

function ctxFactory(overrides: Record<string, unknown>) {
  const calls: Calls = { probed: false };
  const base = {
    classifyLocalShellType: () => "posix",
    discoveredShells: [],
    resolveShellSetting: () => ({ command: "/bin/bash", args: [] }),
    terminalSettings: { localShell: "bash" },
    sessions: [{ id: "src", protocol: "ssh", status: "connected", lastCwd: "/var/log" }],
    // hostById is a Map of saved hosts in the real App — the impl must use
    // .get(), not call it as a function.
    hostById: new Map<string, { id: string; distro?: string; deviceType?: string }>(),
    terminalHosts: [] as Array<{ id: string; distro?: string; deviceType?: string }>,
    getSessionRestoreCwd: () => undefined,
    netcattyBridge: {
      get: () => ({
        getSessionPwd: async () => { calls.probed = true; return { success: true, cwd: "/live/probed" }; },
        getSessionRemoteInfo: async () => ({ success: true, remoteSshVersion: "OpenSSH_9.6" }),
      }),
    },
    copySession: (id: string, opts: CloneOpts) => { calls.copy = { id, opts }; },
    splitSession: (id: string, dir: string, opts: CloneOpts) => { calls.split = { id, dir, opts }; },
    ...overrides,
  };
  return { getCtx: () => base, calls };
}

test("copySessionWithCurrentShell does not throw when hostById is a Map and probes live cwd", async () => {
  const { getCtx, calls } = ctxFactory({});
  await copySessionWithCurrentShellImpl(getCtx, "src");
  assert.equal(calls.copy?.opts.inheritedCwd, "/live/probed");
  assert.equal(calls.probed, true);
});

test("splitSessionWithCurrentShell passes inheritedCwd", async () => {
  const { getCtx, calls } = ctxFactory({});
  await splitSessionWithCurrentShellImpl(getCtx, "src", "horizontal");
  assert.equal(calls.split?.opts.inheritedCwd, "/live/probed");
});

test("live tracked cwd is preferred over the probe", async () => {
  const { getCtx, calls } = ctxFactory({ getSessionRestoreCwd: () => "/live/tracked" });
  await copySessionWithCurrentShellImpl(getCtx, "src");
  assert.equal(calls.copy?.opts.inheritedCwd, "/live/tracked");
  assert.equal(calls.probed, false, "must not probe when live cwd is known");
});

for (const protocol of ["ssh", undefined] as const) {
  for (const liveCwd of ["/srv/old-target", undefined]) {
    test(`duplicate SSH session does not capture or inject the old target directory (${protocol}, ${liveCwd})`, async () => {
      const source: TerminalSession = {
        id: "src", hostId: "bastion", hostLabel: "Bastion", hostname: "bastion.test",
        username: "alice", protocol, status: "connected", lastCwd: "/saved/old-target",
      };
      let cwdReads = 0;
      let bridgeReads = 0;
      const { getCtx, calls } = ctxFactory({
        sessions: [source],
        getSessionRestoreCwd: () => { cwdReads += 1; return liveCwd; },
        netcattyBridge: { get: () => { bridgeReads += 1; return {}; } },
      });
      await duplicateSessionWithCurrentShellImpl(getCtx, "src");
      assert.equal(calls.copy?.id, "src");
      assert.equal(calls.copy?.opts.reuseConnection, false);
      assert.equal(calls.copy?.opts.inheritedCwd, undefined);
      assert.equal(cwdReads, 0, "fresh remote login must not read the previous target's directory");
      assert.equal(bridgeReads, 0, "fresh remote login must not probe the previous target");
      const clone = createCopiedTerminalSessionClone(source, {
        id: "duplicate",
        inheritedCwd: calls.copy?.opts.inheritedCwd,
        reuseConnection: calls.copy?.opts.reuseConnection,
      });
      assert.equal(clone.requireFreshConnection, true);
      assert.equal(clone.pendingInitialCwd, undefined);
    });
  }
}

test("duplicate local session retains the current working directory", async () => {
  const { getCtx, calls } = ctxFactory({
    sessions: [{ id: "src", protocol: "local", status: "connected", localStartDir: "/home/alice" }],
    getSessionRestoreCwd: () => "/home/alice/project",
  });
  await duplicateSessionWithCurrentShellImpl(getCtx, "src");
  assert.equal(calls.copy?.opts.inheritedCwd, "/home/alice/project");
  assert.equal(calls.probed, false);
});

test("network device (by deviceType) is never probed", async () => {
  const { getCtx, calls } = ctxFactory({
    hostById: new Map([["h1", { id: "h1", deviceType: "network" }]]),
    sessions: [{ id: "src", hostId: "h1", protocol: "ssh", status: "connected", lastCwd: "/vrp" }],
  });
  await copySessionWithCurrentShellImpl(getCtx, "src");
  assert.equal(calls.probed, false, "must not open a probe channel on a network device");
  assert.equal(calls.copy?.opts.inheritedCwd, "/vrp");
});

test("local sessions do not query remote SSH metadata", async () => {
  let remoteInfoCalls = 0;
  const { getCtx } = ctxFactory({
    sessions: [{ id: "src", protocol: "local", status: "connected", localStartDir: "/tmp" }],
    netcattyBridge: {
      get: () => ({
        getSessionPwd: async () => ({ success: false }),
        getSessionRemoteInfo: async () => { remoteInfoCalls += 1; return { success: true }; },
      }),
    },
  });
  await copySessionWithCurrentShellImpl(getCtx, "src");
  assert.equal(remoteInfoCalls, 0);
});

test("network device detected via distro (ignores cosmetic override) is never probed", async () => {
  const { getCtx, calls } = ctxFactory({
    hostById: new Map([["h1", { id: "h1", distro: "huawei" }]]),
    sessions: [{ id: "src", hostId: "h1", protocol: "ssh", status: "connected", lastCwd: "/vrp" }],
  });
  await copySessionWithCurrentShellImpl(getCtx, "src");
  assert.equal(calls.probed, false);
  assert.equal(calls.copy?.opts.inheritedCwd, "/vrp");
});

test("ephemeral network host (only in terminalHosts) is never probed", async () => {
  const { getCtx, calls } = ctxFactory({
    hostById: new Map(),
    terminalHosts: [{ id: "eph", deviceType: "network" }],
    sessions: [{ id: "src", hostId: "eph", protocol: "ssh", status: "connected", lastCwd: "/vrp" }],
  });
  await copySessionWithCurrentShellImpl(getCtx, "src");
  assert.equal(calls.probed, false);
  assert.equal(calls.copy?.opts.inheritedCwd, "/vrp");
});

type WorkspaceNode =
  | { id: string; type: "pane"; sessionId: string }
  | { id: string; type: "split"; direction: string; children: WorkspaceNode[] };
type CopyWorkspaceOpts = { localShellType?: string; perPaneCwd?: Record<string, string | undefined> };

test("copyWorkspaceWithCurrentShell captures per-pane cwd and copies the workspace", async () => {
  const calls: { copy?: { id: string; opts: CopyWorkspaceOpts } } = {};
  const sessions = [
    { id: "p1", protocol: "local", localStartDir: "/home/a" },
    { id: "p2", protocol: "local", localStartDir: "/home/b" },
  ];
  const workspaces = [{
    id: "ws-1",
    root: {
      id: "sp", type: "split", direction: "vertical",
      children: [
        { id: "n1", type: "pane", sessionId: "p1" },
        { id: "n2", type: "pane", sessionId: "p2" },
      ],
    } as WorkspaceNode,
  }];
  const collectIds = (node: WorkspaceNode): string[] =>
    node.type === "pane" ? [node.sessionId] : node.children.flatMap(collectIds);
  const getCtx = () => ({
    classifyLocalShellType: () => "bash",
    collectSessionIds: collectIds,
    copyWorkspace: (id: string, opts: CopyWorkspaceOpts) => { calls.copy = { id, opts }; },
    discoveredShells: [],
    getSessionRestoreCwd: () => undefined,
    hostById: new Map(),
    terminalHosts: [],
    netcattyBridge: { get: () => ({}) },
    resolveShellSetting: () => ({ command: "bash" }),
    sessions,
    terminalSettings: { localShell: "bash" },
    workspaces,
  });

  await copyWorkspaceWithCurrentShellImpl(getCtx, "ws-1");

  assert.equal(calls.copy?.id, "ws-1");
  assert.deepEqual(calls.copy?.opts.perPaneCwd, { p1: "/home/a", p2: "/home/b" });
  assert.equal(calls.copy?.opts.localShellType, "bash");
});

test("copyWorkspaceWithCurrentShell no-ops when the workspace is gone", async () => {
  let called = false;
  const getCtx = () => ({
    classifyLocalShellType: () => "bash",
    collectSessionIds: () => [],
    copyWorkspace: () => { called = true; },
    discoveredShells: [],
    getSessionRestoreCwd: () => undefined,
    hostById: new Map(),
    terminalHosts: [],
    netcattyBridge: { get: () => ({}) },
    resolveShellSetting: () => ({ command: "bash" }),
    sessions: [],
    terminalSettings: { localShell: "bash" },
    workspaces: [],
  });
  await copyWorkspaceWithCurrentShellImpl(getCtx, "missing");
  assert.equal(called, false);
});

test("copyWorkspaceWithCurrentShell no-ops when the workspace closes during cwd capture", async () => {
  let called = false;
  let workspaces: Array<{ id: string; root: WorkspaceNode }> = [{
    id: "ws-1",
    root: { id: "p", type: "pane", sessionId: "local" },
  }];
  const getCtx = () => ({
    classifyLocalShellType: () => "bash",
    collectSessionIds: () => ["local"],
    copyWorkspace: () => { called = true; },
    discoveredShells: [],
    getSessionRestoreCwd: () => undefined,
    hostById: new Map(),
    terminalHosts: [],
    netcattyBridge: { get: () => ({}) },
    resolveShellSetting: () => ({ command: "bash" }),
    sessions: [{ id: "local", protocol: "local", status: "connected", localStartDir: "/tmp" }],
    terminalSettings: { localShell: "bash" },
    workspaces,
  });

  const pending = copyWorkspaceWithCurrentShellImpl(getCtx, "ws-1");
  workspaces = [];
  await pending;
  assert.equal(called, false);
});
