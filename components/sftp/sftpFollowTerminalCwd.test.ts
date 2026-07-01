import test from "node:test";
import assert from "node:assert/strict";
import {
  mergeLatestFollowTerminalCwdHostSetting,
  resolveHostFollowTerminalCwd,
  resolveSftpFollowTerminalCwdTargetHost,
  shouldClearBlockedFollowOnReach,
  shouldFollowTerminalCwdNavigate,
} from "./sftpFollowTerminalCwd";

const base = {
  followEnabled: true,
  isVisible: true,
  terminalCwd: "/home/user/project",
  currentPath: "/home/user",
  connectionId: "conn-1",
  hasActiveWork: false,
  isConnected: true,
};

test("shouldFollowTerminalCwdNavigate returns true when follow is on and paths differ", () => {
  assert.equal(shouldFollowTerminalCwdNavigate(base), true);
});

test("shouldFollowTerminalCwdNavigate returns false when paths already match", () => {
  assert.equal(
    shouldFollowTerminalCwdNavigate({ ...base, currentPath: "/home/user/project" }),
    false,
  );
});

test("shouldFollowTerminalCwdNavigate returns false when follow is disabled", () => {
  assert.equal(shouldFollowTerminalCwdNavigate({ ...base, followEnabled: false }), false);
});

test("shouldFollowTerminalCwdNavigate returns false while interactive work is active", () => {
  assert.equal(shouldFollowTerminalCwdNavigate({ ...base, hasActiveWork: true }), false);
});

test("shouldFollowTerminalCwdNavigate returns false without a known terminal cwd", () => {
  assert.equal(shouldFollowTerminalCwdNavigate({ ...base, terminalCwd: null }), false);
});

test("shouldFollowTerminalCwdNavigate returns false when cwd is blocked after a failed follow", () => {
  assert.equal(
    shouldFollowTerminalCwdNavigate({
      ...base,
      blockedFollow: { connectionId: "conn-1", terminalCwd: "/home/user/project" },
    }),
    false,
  );
});

test("shouldFollowTerminalCwdNavigate ignores blocked cwd for a different connection", () => {
  assert.equal(
    shouldFollowTerminalCwdNavigate({
      ...base,
      connectionId: "conn-2",
      blockedFollow: { connectionId: "conn-1", terminalCwd: "/home/user/project" },
    }),
    true,
  );
});

test("shouldFollowTerminalCwdNavigate ignores blocked cwd when terminal cwd changed", () => {
  assert.equal(
    shouldFollowTerminalCwdNavigate({
      ...base,
      terminalCwd: "/home/user/other",
      blockedFollow: { connectionId: "conn-1", terminalCwd: "/home/user/project" },
    }),
    true,
  );
});

test("resolveHostFollowTerminalCwd inherits the global setting until the host overrides it", () => {
  assert.equal(resolveHostFollowTerminalCwd(undefined, true), true);
  assert.equal(resolveHostFollowTerminalCwd(undefined, false), false);
  assert.equal(resolveHostFollowTerminalCwd(true, false), true);
  assert.equal(resolveHostFollowTerminalCwd(false, true), false);
});

test("resolveSftpFollowTerminalCwdTargetHost prefers the visible SFTP host", () => {
  const terminalHost = { id: "terminal-host" };
  const visibleHost = { id: "visible-sftp-host" };

  assert.equal(
    resolveSftpFollowTerminalCwdTargetHost(visibleHost, terminalHost),
    visibleHost,
  );
  assert.equal(
    resolveSftpFollowTerminalCwdTargetHost(null, terminalHost),
    terminalHost,
  );
});

test("visible SFTP host override can enable follow when terminal host inherits global off", () => {
  const terminalHost = { id: "terminal-host", sftpFollowTerminalCwd: undefined };
  const visibleHost = { id: "visible-sftp-host", sftpFollowTerminalCwd: true };
  const followHost = resolveSftpFollowTerminalCwdTargetHost(visibleHost, terminalHost);

  assert.equal(resolveHostFollowTerminalCwd(followHost?.sftpFollowTerminalCwd, false), true);
});

test("mergeLatestFollowTerminalCwdHostSetting refreshes the follow flag without losing display overrides", () => {
  const connectedHost = {
    id: "host-1",
    hostname: "session.example.com",
    sftpFollowTerminalCwd: false,
  };
  const latestHost = {
    id: "host-1",
    hostname: "vault.example.com",
    sftpFollowTerminalCwd: true,
  };

  assert.deepEqual(
    mergeLatestFollowTerminalCwdHostSetting(connectedHost, latestHost),
    {
      id: "host-1",
      hostname: "session.example.com",
      sftpFollowTerminalCwd: true,
    },
  );
});

test("mergeLatestFollowTerminalCwdHostSetting keeps optimistic session override until vault updates", () => {
  const connectedHost = {
    id: "host-1",
    hostname: "session.example.com",
    sftpFollowTerminalCwd: false,
  };
  const latestHost = {
    id: "host-1",
    hostname: "vault.example.com",
  };

  assert.deepEqual(
    mergeLatestFollowTerminalCwdHostSetting(connectedHost, latestHost, false),
    {
      id: "host-1",
      hostname: "session.example.com",
      sftpFollowTerminalCwd: false,
    },
  );
});

test("mergeLatestFollowTerminalCwdHostSetting drops stale session override when vault clears the follow flag", () => {
  const connectedHost = {
    id: "host-1",
    hostname: "session.example.com",
    sftpFollowTerminalCwd: true,
  };
  const latestHost = {
    id: "host-1",
    hostname: "vault.example.com",
  };

  assert.deepEqual(
    mergeLatestFollowTerminalCwdHostSetting(connectedHost, latestHost),
    {
      id: "host-1",
      hostname: "session.example.com",
      sftpFollowTerminalCwd: undefined,
    },
  );
});

test("shouldClearBlockedFollowOnReach clears when the active connection reaches the blocked cwd", () => {
  assert.equal(
    shouldClearBlockedFollowOnReach(
      { connectionId: "conn-1", terminalCwd: "/home/user/project" },
      "conn-1",
      "/home/user/project",
      false,
    ),
    true,
  );
});

test("shouldClearBlockedFollowOnReach keeps block while navigation is still loading", () => {
  assert.equal(
    shouldClearBlockedFollowOnReach(
      { connectionId: "conn-1", terminalCwd: "/home/user/project" },
      "conn-1",
      "/home/user/project",
      true,
    ),
    false,
  );
});
