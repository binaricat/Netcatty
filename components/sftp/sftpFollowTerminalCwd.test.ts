import test from "node:test";
import assert from "node:assert/strict";
import {
  mergeLatestFollowTerminalCwdHostSetting,
  resolveHostFollowTerminalCwd,
  resolveSftpFollowTerminalCwdTargetHost,
  shouldFollowTerminalCwdNavigate,
} from "./sftpFollowTerminalCwd";

const base = {
  followEnabled: true,
  isVisible: true,
  terminalCwd: "/home/user/project",
  currentPath: "/home/user",
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
