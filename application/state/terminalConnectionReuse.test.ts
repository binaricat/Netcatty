import test from "node:test";
import assert from "node:assert/strict";

import type { TerminalSession } from "../../domain/models";
import {
  canReuseTerminalConnection,
  createCopiedTerminalSessionClone,
  createSplitTerminalSessionClone,
  isTerminalSessionEligibleForSftpReuse,
  resolveSftpReuseSourceSessionId,
} from "./terminalConnectionReuse";

const session = (overrides: Partial<TerminalSession> = {}): TerminalSession => ({
  id: "session-1",
  hostId: "host-1",
  hostLabel: "Host",
  hostname: "example.com",
  username: "alice",
  status: "connected",
  protocol: "ssh",
  ...overrides,
});

test("connected SSH sessions can reuse their authenticated connection", () => {
  assert.equal(canReuseTerminalConnection(session()), true);
  assert.equal(canReuseTerminalConnection(session({ protocol: undefined })), true);
});

test("SSH sessions stay SFTP-linkable while reconnecting", () => {
  assert.equal(isTerminalSessionEligibleForSftpReuse(session({ status: "connecting" })), true);
  assert.equal(isTerminalSessionEligibleForSftpReuse(session({ status: "disconnected" })), true);
  assert.equal(isTerminalSessionEligibleForSftpReuse(session({ protocol: "local" })), false);
  assert.equal(isTerminalSessionEligibleForSftpReuse(session({ moshEnabled: true })), false);
  assert.equal(isTerminalSessionEligibleForSftpReuse(session({ etEnabled: true })), false);
});

test("Mosh and ET drops keep their origin but do not request SSH session reuse", () => {
  assert.equal(resolveSftpReuseSourceSessionId(session(), "session-1"), "session-1");
  assert.equal(
    resolveSftpReuseSourceSessionId(session({ moshEnabled: true }), "session-1"),
    undefined,
  );
  assert.equal(
    resolveSftpReuseSourceSessionId(session({ etEnabled: true }), "session-1"),
    undefined,
  );
});

test("non-SSH or unavailable sessions do not reuse a connection", () => {
  assert.equal(canReuseTerminalConnection(session({ status: "connecting" })), false);
  assert.equal(canReuseTerminalConnection(session({ status: "disconnected" })), false);
  assert.equal(canReuseTerminalConnection(session({ protocol: "local" })), false);
  assert.equal(canReuseTerminalConnection(session({ protocol: "serial" })), false);
  assert.equal(canReuseTerminalConnection(session({ protocol: "telnet" })), false);
  assert.equal(canReuseTerminalConnection(session({ moshEnabled: true })), false);
  assert.equal(canReuseTerminalConnection(session({ etEnabled: true })), false);
});

test("split session clones reuse only connected SSH sources", () => {
  assert.equal(
    createSplitTerminalSessionClone(session(), { id: "split-1", workspaceId: "workspace-1" }).reuseConnectionFromSessionId,
    "session-1",
  );
  assert.equal(
    createSplitTerminalSessionClone(session({ etEnabled: true }), { id: "split-2" }).reuseConnectionFromSessionId,
    undefined,
  );
  assert.equal(
    createSplitTerminalSessionClone(session({ moshEnabled: true }), { id: "split-3" }).reuseConnectionFromSessionId,
    undefined,
  );
});

test("session clones preserve the ephemeral-host marker", () => {
  assert.equal(
    createSplitTerminalSessionClone(session({ ephemeralHost: true }), { id: "split-1" }).ephemeralHost,
    true,
  );
  assert.equal(
    createCopiedTerminalSessionClone(session({ ephemeralHost: true }), { id: "copy-1" }).ephemeralHost,
    true,
  );
  assert.equal(
    createSplitTerminalSessionClone(session(), { id: "split-2" }).ephemeralHost,
    undefined,
  );
});

test("copy session clones reuse SSH sources and preserve serial config", () => {
  const copied = createCopiedTerminalSessionClone(
    session({
      serialConfig: { path: "/dev/tty.usbserial", baudRate: 115200 },
    }),
    { id: "copy-1" },
  );

  assert.equal(copied.reuseConnectionFromSessionId, "session-1");
  assert.deepEqual(copied.serialConfig, { path: "/dev/tty.usbserial", baudRate: 115200 });
});

test("copy session clones open a fresh connection when reuseConnection is false", () => {
  const fresh = createCopiedTerminalSessionClone(session(), { id: "copy-fresh", reuseConnection: false });
  assert.equal(fresh.reuseConnectionFromSessionId, undefined);
  // The explicit fresh flag must survive: without it the bridge treats the
  // clone as eligible for general endpoint reuse and can still borrow the
  // source's live authenticated transport.
  assert.equal(fresh.requireFreshConnection, true);
  // Local sources never had reuse to drop — behavior is unchanged.
  assert.equal(
    createCopiedTerminalSessionClone(session({ protocol: "local" }), { id: "copy-local-fresh", reuseConnection: false }).reuseConnectionFromSessionId,
    undefined,
  );
});

test("copy and split clones default to no fresh-connection requirement", () => {
  assert.equal(createCopiedTerminalSessionClone(session(), { id: "copy-default" }).requireFreshConnection, undefined);
  assert.equal(createSplitTerminalSessionClone(session(), { id: "split-default" }).requireFreshConnection, undefined);
  assert.equal(
    createCopiedTerminalSessionClone(session(), { id: "copy-reuse", reuseConnection: true }).requireFreshConnection,
    undefined,
  );
});

test("fresh SSH clones discard inherited directories even when a caller supplies one", () => {
  for (const protocol of ["ssh", undefined] as const) {
    const clone = createCopiedTerminalSessionClone(session({ protocol }), {
      id: "fresh-no-cwd", reuseConnection: false, inheritedCwd: "/srv/old-target",
    });
    assert.equal(clone.pendingInitialCwd, undefined);
    assert.equal(clone.requireFreshConnection, true);
  }
  const localClone = createCopiedTerminalSessionClone(session({ protocol: "local" }), {
    id: "local-cwd", reuseConnection: false, inheritedCwd: "/home/alice/project",
  });
  assert.equal(localClone.localStartDir, "/home/alice/project");
});

test("copy session clones default to connection reuse when reuseConnection is unset", () => {
  assert.equal(
    createCopiedTerminalSessionClone(session(), { id: "copy-default" }).reuseConnectionFromSessionId,
    "session-1",
  );
});

test("split and copy session clones preserve local start directory", () => {
  const source = session({
    protocol: "local",
    localStartDir: "/Users/alice/project with spaces ",
  });

  assert.equal(
    createSplitTerminalSessionClone(source, { id: "split-local" }).localStartDir,
    "/Users/alice/project with spaces ",
  );
  assert.equal(
    createCopiedTerminalSessionClone(source, { id: "copy-local" }).localStartDir,
    "/Users/alice/project with spaces ",
  );
});

test("split clone applies remote inheritedCwd as pendingInitialCwd without touching localStartDir", () => {
  const clone = createSplitTerminalSessionClone(session({ protocol: "ssh" }), {
    id: "split-remote-cwd",
    inheritedCwd: "/var/log",
  });

  assert.equal(clone.pendingInitialCwd, "/var/log");
  assert.equal(clone.localStartDir, undefined);
});

test("split clone applies local inheritedCwd as localStartDir without pendingInitialCwd", () => {
  const clone = createSplitTerminalSessionClone(
    session({ protocol: "local", localStartDir: "/home/u", status: "connecting" }),
    { id: "split-local-cwd", localShellType: "posix", inheritedCwd: "/tmp/work" },
  );

  assert.equal(clone.localStartDir, "/tmp/work");
  assert.equal(clone.pendingInitialCwd, undefined);
});

test("clone does not set pendingInitialCwd for protocols that never inject a cd", () => {
  for (const overrides of [
    { protocol: "telnet" as const },
    { protocol: "serial" as const },
    { protocol: "ssh" as const, moshEnabled: true },
    { protocol: "ssh" as const, etEnabled: true },
  ]) {
    const clone = createSplitTerminalSessionClone(session(overrides), {
      id: "split-no-inject",
      inheritedCwd: "/var/log",
    });
    assert.equal(clone.pendingInitialCwd, undefined, `${JSON.stringify(overrides)} should not set pendingInitialCwd`);
  }
});

test("copy clone without inheritedCwd keeps localStartDir and sets no pendingInitialCwd", () => {
  const clone = createCopiedTerminalSessionClone(
    session({ protocol: "local", localStartDir: "/home/u", status: "connecting" }),
    { id: "copy-no-cwd", localShellType: "posix" },
  );

  assert.equal(clone.localStartDir, "/home/u");
  assert.equal(clone.pendingInitialCwd, undefined);
});

test("split and copy session clones preserve isolated plugin connection snapshots", () => {
  const pluginConnection = {
    providerId: "com.example.transport.connection",
    configuration: { endpoint: "gateway.example", options: ["fast"] },
    credentialId: "credential-reference-1234",
  };
  const source = session({
    protocol: `plugin:${pluginConnection.providerId}`,
    pluginConnection,
  });

  const split = createSplitTerminalSessionClone(source, { id: "split-plugin" });
  const copied = createCopiedTerminalSessionClone(source, { id: "copy-plugin" });

  assert.deepEqual(split.pluginConnection, pluginConnection);
  assert.deepEqual(copied.pluginConnection, pluginConnection);
  assert.notEqual(split.pluginConnection, pluginConnection);
  assert.notEqual(copied.pluginConnection, pluginConnection);
  assert.equal(split.reuseConnectionFromSessionId, undefined);
  assert.equal(copied.reuseConnectionFromSessionId, undefined);
});
