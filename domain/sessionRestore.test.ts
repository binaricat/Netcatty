import test from "node:test";
import assert from "node:assert/strict";

import {
  buildSessionRestorePayload,
  isRestoredDisconnectedSession,
  quoteRestoreCwdForShell,
  resolveRestoredActiveTabId,
  resolveRestoreCwdIntent,
  sanitizeSessionRestorePayload,
  shouldAttemptRestoreCwd,
} from "./sessionRestore.ts";
import type { TerminalSession, Workspace } from "./models.ts";

const session = (id: string, workspaceId?: string): TerminalSession => ({
  id,
  hostId: `host-${id}`,
  hostLabel: `Host ${id}`,
  hostname: `${id}.example.test`,
  username: "root",
  status: "connected",
  protocol: "ssh",
  workspaceId,
});

test("buildSessionRestorePayload stores restored sessions as disconnected and drops reuse pointers", () => {
  const payload = buildSessionRestorePayload({
    sessions: [{ ...session("s1"), reuseConnectionFromSessionId: "source" }],
    workspaces: [],
    tabOrder: ["s1"],
    activeTabId: "s1",
    now: 123,
  });

  assert.equal(payload.version, 1);
  assert.equal(payload.savedAt, 123);
  assert.equal(payload.sessions[0].status, "disconnected");
  assert.equal(payload.sessions[0].reuseConnectionFromSessionId, undefined);
  assert.equal(payload.sessions[0].restoreState, "restored-disconnected");
});

test("buildSessionRestorePayload only stores allowlisted session fields", () => {
  const payload = buildSessionRestorePayload({
    sessions: [{
      ...session("s1"),
      terminalData: "do-not-store",
      reuseConnectionFromSessionId: "source",
    } as TerminalSession & { terminalData: string }],
    workspaces: [],
    tabOrder: ["s1"],
    activeTabId: "s1",
    now: 123,
  });

  assert.deepEqual(Object.keys(payload.sessions[0]).sort(), [
    "hostId",
    "hostLabel",
    "hostname",
    "id",
    "protocol",
    "restoreState",
    "status",
    "username",
  ].sort());
});

test("buildSessionRestorePayload deeply allowlists serial config fields", () => {
  const payload = buildSessionRestorePayload({
    sessions: [{
      ...session("s1"),
      protocol: "serial",
      serialConfig: {
        path: "/dev/tty.usbserial",
        baudRate: 115200,
        dataBits: 8,
        stopBits: 1,
        parity: "none",
        flowControl: "none",
        localEcho: true,
        lineMode: true,
        password: "do-not-store",
      },
    } as TerminalSession & { serialConfig: TerminalSession["serialConfig"] & { password: string } }],
    workspaces: [],
    tabOrder: ["s1"],
    activeTabId: "s1",
    now: 123,
  });

  assert.deepEqual(payload.sessions[0].serialConfig, {
    path: "/dev/tty.usbserial",
    baudRate: 115200,
    dataBits: 8,
    stopBits: 1,
    parity: "none",
    flowControl: "none",
    localEcho: true,
    lineMode: true,
  });
});

test("buildSessionRestorePayload preserves serial sessions with empty usernames", () => {
  const payload = buildSessionRestorePayload({
    sessions: [{
      ...session("s1"),
      username: "",
      protocol: "serial",
      serialConfig: {
        path: "/dev/tty.usbserial",
        baudRate: 115200,
      },
    }],
    workspaces: [],
    tabOrder: ["s1"],
    activeTabId: "s1",
    now: 123,
  });

  assert.equal(payload.sessions.length, 1);
  assert.equal(payload.sessions[0].username, "");
  assert.equal(payload.sessions[0].protocol, "serial");
});

test("buildSessionRestorePayload preserves serial-only workspaces", () => {
  const payload = buildSessionRestorePayload({
    sessions: [{
      ...session("s1", "ws-1"),
      username: "",
      protocol: "serial",
      serialConfig: {
        path: "/dev/tty.usbserial",
        baudRate: 115200,
      },
    }],
    workspaces: [{
      id: "ws-1",
      title: "Serial workspace",
      root: { id: "pane-1", type: "pane", sessionId: "s1" },
    }],
    tabOrder: ["ws-1"],
    activeTabId: "ws-1",
    now: 123,
  });

  assert.equal(payload.sessions.length, 1);
  assert.equal(payload.workspaces.length, 1);
  assert.equal(payload.activeTabId, "ws-1");
});

test("buildSessionRestorePayload drops startup commands from restored sessions", () => {
  const payload = buildSessionRestorePayload({
    sessions: [{
      ...session("s1"),
      startupCommand: "rm -rf /tmp/example",
      noAutoRun: false,
    }],
    workspaces: [],
    tabOrder: ["s1"],
    activeTabId: "s1",
    now: 123,
  });

  assert.equal(payload.sessions[0].startupCommand, undefined);
  assert.equal(payload.sessions[0].noAutoRun, undefined);
});

test("sanitizeSessionRestorePayload prunes invalid workspace panes and drops empty workspaces", () => {
  const workspace: Workspace = {
    id: "ws-1",
    title: "Workspace",
    root: {
      id: "split-1",
      type: "split",
      direction: "vertical",
      children: [
        { id: "pane-1", type: "pane", sessionId: "s1" },
        { id: "pane-2", type: "pane", sessionId: "missing" },
      ],
      sizes: [0.25, 0.75],
    },
    focusedSessionId: "missing",
    focusSessionOrder: ["missing", "s1"],
  };

  const sanitized = sanitizeSessionRestorePayload({
    version: 1,
    savedAt: 1,
    activeTabId: "missing",
    tabOrder: ["missing", "ws-1", "s1"],
    sessions: [session("s1", "ws-1")],
    workspaces: [workspace],
  });

  assert.equal(sanitized.sessions.length, 1);
  assert.equal(sanitized.workspaces.length, 1);
  assert.equal(sanitized.workspaces[0].root.type, "pane");
  assert.equal(sanitized.workspaces[0].focusedSessionId, "s1");
  assert.deepEqual(sanitized.workspaces[0].focusSessionOrder, ["s1"]);
  assert.deepEqual(sanitized.tabOrder, ["ws-1"]);
  assert.equal(sanitized.activeTabId, "ws-1");
});

test("sanitizeSessionRestorePayload drops malformed session and workspace records", () => {
  const sanitized = sanitizeSessionRestorePayload({
    version: 1,
    savedAt: 1,
    activeTabId: "ws-1",
    tabOrder: ["ws-1", "s1"],
    sessions: [null, session("s1")],
    workspaces: [{ id: "ws-1" }],
  } as unknown);

  assert.deepEqual(sanitized.sessions.map((item) => item.id), ["s1"]);
  assert.deepEqual(sanitized.workspaces, []);
  assert.deepEqual(sanitized.tabOrder, ["s1"]);
  assert.equal(sanitized.activeTabId, "s1");
});

test("sanitizeSessionRestorePayload enforces workspace session ownership", () => {
  const workspace: Workspace = {
    id: "ws-1",
    title: "Workspace",
    root: {
      id: "split-1",
      type: "split",
      direction: "horizontal",
      children: [
        { id: "pane-1", type: "pane", sessionId: "owned" },
        { id: "pane-2", type: "pane", sessionId: "standalone" },
        { id: "pane-3", type: "pane", sessionId: "other-workspace" },
      ],
      sizes: [0.2, 0.3, 0.5],
    },
    focusedSessionId: "standalone",
    focusSessionOrder: ["standalone", "owned", "other-workspace"],
  };

  const sanitized = sanitizeSessionRestorePayload({
    version: 1,
    savedAt: 1,
    activeTabId: "ws-1",
    tabOrder: ["ws-1", "standalone", "ws-2"],
    sessions: [
      session("owned", "ws-1"),
      session("standalone"),
      session("other-workspace", "ws-2"),
    ],
    workspaces: [
      workspace,
      {
        id: "ws-2",
        title: "Other",
        root: { id: "pane-4", type: "pane", sessionId: "other-workspace" },
      },
    ],
  });

  assert.equal(sanitized.workspaces[0].root.type, "pane");
  assert.equal(sanitized.workspaces[0].root.sessionId, "owned");
  assert.equal(sanitized.workspaces[0].focusedSessionId, "owned");
  assert.deepEqual(sanitized.workspaces[0].focusSessionOrder, ["owned"]);
  assert.deepEqual(sanitized.tabOrder, ["ws-1", "standalone", "ws-2"]);
});

test("sanitizeSessionRestorePayload drops workspace sessions missing from the restored root", () => {
  const sanitized = sanitizeSessionRestorePayload({
    version: 1,
    savedAt: 1,
    activeTabId: "ws-1",
    tabOrder: ["ws-1"],
    sessions: [
      session("s1", "ws-1"),
      session("s2", "ws-1"),
    ],
    workspaces: [{
      id: "ws-1",
      title: "Workspace",
      root: { id: "pane-1", type: "pane", sessionId: "s1" },
      focusedSessionId: "s2",
      focusSessionOrder: ["s2", "s1"],
    }],
  });

  assert.deepEqual(sanitized.sessions.map((entry) => entry.id), ["s1"]);
  assert.equal(sanitized.workspaces[0].focusedSessionId, "s1");
  assert.deepEqual(sanitized.workspaces[0].focusSessionOrder, ["s1"]);
  assert.deepEqual(sanitized.tabOrder, ["ws-1"]);
});

test("sanitizeSessionRestorePayload allowlists workspace node fields", () => {
  const sanitized = sanitizeSessionRestorePayload({
    version: 1,
    savedAt: 1,
    activeTabId: "ws-1",
    tabOrder: ["ws-1"],
    sessions: [session("s1", "ws-1"), session("s2", "ws-1")],
    workspaces: [{
      id: "ws-1",
      title: "Workspace",
      root: {
        id: "split-1",
        type: "split",
        direction: "horizontal",
        terminalData: "do-not-store",
        children: [
          { id: "pane-1", type: "pane", sessionId: "s1", terminalData: "do-not-store" },
          { id: "pane-2", type: "pane", sessionId: "s2", secret: "do-not-store" },
        ],
        sizes: [0.4, 0.6],
      },
    }],
  });

  const root = sanitized.workspaces[0].root;
  assert.equal("terminalData" in root, false);
  assert.equal(root.type, "split");
  assert.equal("terminalData" in root.children[0], false);
  assert.equal("secret" in root.children[1], false);
});

test("sanitizeSessionRestorePayload deeply allowlists unknown serial config fields", () => {
  const sanitized = sanitizeSessionRestorePayload({
    version: 1,
    savedAt: 1,
    activeTabId: "s1",
    tabOrder: ["s1"],
    sessions: [{
      ...session("s1"),
      protocol: "serial",
      serialConfig: {
        path: "/dev/tty.usbserial",
        baudRate: 115200,
        dataBits: 8,
        stopBits: 1,
        parity: "none",
        flowControl: "none",
        localEcho: true,
        lineMode: true,
        secret: "do-not-store",
      },
    }],
    workspaces: [],
  });

  assert.deepEqual(sanitized.sessions[0].serialConfig, {
    path: "/dev/tty.usbserial",
    baudRate: 115200,
    dataBits: 8,
    stopBits: 1,
    parity: "none",
    flowControl: "none",
    localEcho: true,
    lineMode: true,
  });
});

test("sanitizeSessionRestorePayload drops invalid protocol and shell type enum values", () => {
  const sanitized = sanitizeSessionRestorePayload({
    version: 1,
    savedAt: 1,
    activeTabId: "s1",
    tabOrder: ["s1"],
    sessions: [{
      ...session("s1"),
      protocol: "ftp",
      shellType: "bash",
    }],
    workspaces: [],
  });

  assert.equal(sanitized.sessions[0].protocol, undefined);
  assert.equal(sanitized.sessions[0].shellType, undefined);
});

test("sanitizeSessionRestorePayload falls back to equal split sizes when saved sizes are non-positive", () => {
  const sanitized = sanitizeSessionRestorePayload({
    version: 1,
    savedAt: 1,
    activeTabId: "ws-1",
    tabOrder: ["ws-1"],
    sessions: [session("s1", "ws-1"), session("s2", "ws-1")],
    workspaces: [{
      id: "ws-1",
      title: "Workspace",
      root: {
        id: "split-1",
        type: "split",
        direction: "horizontal",
        children: [
          { id: "pane-1", type: "pane", sessionId: "s1" },
          { id: "pane-2", type: "pane", sessionId: "s2" },
        ],
        sizes: [-1, 2],
      },
    }],
  });

  assert.equal(sanitized.workspaces[0].root.type, "split");
  if (sanitized.workspaces[0].root.type === "split") {
    assert.deepEqual(sanitized.workspaces[0].root.sizes, [0.5, 0.5]);
  }
});

test("sanitizeSessionRestorePayload preserves split sizes when nested splits collapse", () => {
  const sanitized = sanitizeSessionRestorePayload({
    version: 1,
    savedAt: 1,
    activeTabId: "ws-1",
    tabOrder: ["ws-1"],
    sessions: [session("s1", "ws-1"), session("s3", "ws-1")],
    workspaces: [{
      id: "ws-1",
      title: "Workspace",
      root: {
        id: "root-split",
        type: "split",
        direction: "horizontal",
        sizes: [0.7, 0.3],
        children: [
          {
            id: "left-split",
            type: "split",
            direction: "vertical",
            sizes: [0.4, 0.6],
            children: [
              { id: "pane-1", type: "pane", sessionId: "s1" },
              { id: "pane-missing", type: "pane", sessionId: "missing" },
            ],
          },
          { id: "pane-3", type: "pane", sessionId: "s3" },
        ],
      },
    }],
  });

  const root = sanitized.workspaces[0].root;
  assert.equal(root.type, "split");
  if (root.type === "split") {
    assert.deepEqual(root.children.map((child) => child.type === "pane" ? child.sessionId : "split"), ["s1", "s3"]);
    assert.deepEqual(root.sizes, [0.7, 0.3]);
    assert.ok(root.sizes?.every((size) => size > 0));
  }
});

test("resolveRestoredActiveTabId falls back to vault when no restored tab is valid", () => {
  assert.equal(resolveRestoredActiveTabId("missing", [], [], []), "vault");
});

test("resolveRestoredActiveTabId does not restore sftp as an active startup tab", () => {
  assert.equal(resolveRestoredActiveTabId("sftp", ["sftp"], [], []), "vault");
});

test("isRestoredDisconnectedSession detects only explicit restored sessions", () => {
  assert.equal(
    isRestoredDisconnectedSession({
      ...session("s1"),
      status: "disconnected",
      restoreState: "restored-disconnected",
    }),
    true,
  );
  assert.equal(isRestoredDisconnectedSession({ ...session("s1"), status: "disconnected" }), false);
});

test("shouldAttemptRestoreCwd allows restored local and unix ssh sessions only when enabled", () => {
  assert.equal(shouldAttemptRestoreCwd({
    enabled: true,
    session: { ...session("s1"), status: "disconnected", restoreState: "restored-disconnected", lastCwd: "/srv/app" },
    isNetworkDevice: false,
  }), true);
  assert.equal(shouldAttemptRestoreCwd({
    enabled: false,
    session: { ...session("s1"), status: "disconnected", restoreState: "restored-disconnected", lastCwd: "/srv/app" },
    isNetworkDevice: false,
  }), false);
});

test("shouldAttemptRestoreCwd skips ineligible protocols and network devices", () => {
  const base = { ...session("s1"), status: "disconnected" as const, restoreState: "restored-disconnected" as const, lastCwd: "/srv/app" };

  assert.equal(shouldAttemptRestoreCwd({ enabled: true, session: { ...base, protocol: "telnet" }, isNetworkDevice: false }), false);
  assert.equal(shouldAttemptRestoreCwd({ enabled: true, session: { ...base, protocol: "serial" }, isNetworkDevice: false }), false);
  assert.equal(shouldAttemptRestoreCwd({ enabled: true, session: { ...base, protocol: "ssh" }, isNetworkDevice: true }), false);
  assert.equal(shouldAttemptRestoreCwd({ enabled: true, session: { ...base, protocol: "ssh", moshEnabled: true }, isNetworkDevice: false }), false);
  assert.equal(shouldAttemptRestoreCwd({ enabled: true, session: { ...base, protocol: "ssh", etEnabled: true }, isNetworkDevice: false }), false);
});

test("shouldAttemptRestoreCwd skips local Windows-like shell types", () => {
  const base = {
    ...session("s1"),
    status: "disconnected" as const,
    restoreState: "restored-disconnected" as const,
    protocol: "local" as const,
    lastCwd: "/srv/app",
  };

  assert.equal(shouldAttemptRestoreCwd({ enabled: true, session: { ...base, shellType: "posix" }, isNetworkDevice: false }), true);
  assert.equal(shouldAttemptRestoreCwd({ enabled: true, session: { ...base, shellType: "fish" }, isNetworkDevice: false }), true);
  assert.equal(shouldAttemptRestoreCwd({ enabled: true, session: { ...base, shellType: "powershell" }, isNetworkDevice: false }), false);
  assert.equal(shouldAttemptRestoreCwd({ enabled: true, session: { ...base, shellType: "cmd" }, isNetworkDevice: false }), false);
});

test("shouldAttemptRestoreCwd skips missing and windows-like cwd values", () => {
  const base = { ...session("s1"), status: "disconnected" as const, restoreState: "restored-disconnected" as const };

  assert.equal(shouldAttemptRestoreCwd({ enabled: true, session: { ...base }, isNetworkDevice: false }), false);
  assert.equal(shouldAttemptRestoreCwd({ enabled: true, session: { ...base, lastCwd: "C:\\Users\\alice" }, isNetworkDevice: false }), false);
  assert.equal(shouldAttemptRestoreCwd({ enabled: true, session: { ...base, lastCwd: "relative/path" }, isNetworkDevice: false }), false);
  assert.equal(shouldAttemptRestoreCwd({ enabled: true, session: { ...base, lastCwd: "~alice/project" }, isNetworkDevice: false }), false);
});

test("quoteRestoreCwdForShell treats cwd as shell data", () => {
  assert.equal(quoteRestoreCwdForShell("/srv/app"), "'/srv/app'");
  assert.equal(quoteRestoreCwdForShell("/srv/app dir"), "'/srv/app dir'");
  assert.equal(quoteRestoreCwdForShell("/tmp/it's ok; $(rm -rf ~)"), "'/tmp/it'\\''s ok; $(rm -rf ~)'");
});

test("resolveRestoreCwdIntent captures a one-shot restore command", () => {
  assert.deepEqual(resolveRestoreCwdIntent({
    enabled: true,
    session: { ...session("s1"), status: "disconnected", restoreState: "restored-disconnected", lastCwd: "/srv/app dir" },
    isNetworkDevice: false,
  }), {
    cwd: "/srv/app dir",
    command: "cd -- '/srv/app dir'",
  });
});

test("resolveRestoreCwdIntent does not emit POSIX cd for local Windows-like shells", () => {
  assert.equal(resolveRestoreCwdIntent({
    enabled: true,
    session: {
      ...session("s1"),
      status: "disconnected",
      restoreState: "restored-disconnected",
      protocol: "local",
      shellType: "powershell",
      lastCwd: "/srv/app",
    },
    isNetworkDevice: false,
  }), null);
});

test("resolveRestoreCwdIntent keeps home-relative cwd expandable", () => {
  assert.deepEqual(resolveRestoreCwdIntent({
    enabled: true,
    session: { ...session("s1"), status: "disconnected", restoreState: "restored-disconnected", lastCwd: "~/project dir" },
    isNetworkDevice: false,
  }), {
    cwd: "~/project dir",
    command: "cd -- ~/'project dir'",
  });

  assert.deepEqual(resolveRestoreCwdIntent({
    enabled: true,
    session: { ...session("s1"), status: "disconnected", restoreState: "restored-disconnected", lastCwd: "~" },
    isNetworkDevice: false,
  }), {
    cwd: "~",
    command: "cd -- ~",
  });
});
