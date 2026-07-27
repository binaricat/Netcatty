import test from "node:test";
import assert from "node:assert/strict";

import type { TerminalSession } from "../../domain/models";
import {
  canReuseTerminalConnection,
  createCopiedTerminalSessionClone,
  createSplitTerminalSessionClone,
  resolveReusableTerminalSessionIdForSftp,
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

test("non-SSH or unavailable sessions do not reuse a connection", () => {
  assert.equal(canReuseTerminalConnection(session({ status: "connecting" })), false);
  assert.equal(canReuseTerminalConnection(session({ status: "disconnected" })), false);
  assert.equal(canReuseTerminalConnection(session({ protocol: "local" })), false);
  assert.equal(canReuseTerminalConnection(session({ protocol: "serial" })), false);
  assert.equal(canReuseTerminalConnection(session({ protocol: "telnet" })), false);
  assert.equal(canReuseTerminalConnection(session({ moshEnabled: true })), false);
  assert.equal(canReuseTerminalConnection(session({ etEnabled: true })), false);
});

test("SFTP reuse prefers the focused session over a remembered source", () => {
  const rememberedSession = session({ id: "remembered-session" });
  const focusedSession = session({ id: "focused-session" });
  const sourceSessionId = resolveReusableTerminalSessionIdForSftp({
    activeSessionId: focusedSession.id,
    preferredSourceSessionId: rememberedSession.id,
    sftpActiveHost: {
      hostname: focusedSession.hostname,
      port: focusedSession.port,
      username: focusedSession.username,
    },
    sessions: [rememberedSession, focusedSession],
    sessionHostsMap: new Map([
      [
        rememberedSession.id,
        {
          hostname: rememberedSession.hostname,
          port: rememberedSession.port,
          username: rememberedSession.username,
        },
      ],
      [
        focusedSession.id,
        {
          hostname: focusedSession.hostname,
          port: focusedSession.port,
          username: focusedSession.username,
        },
      ],
    ]),
  });

  assert.equal(sourceSessionId, focusedSession.id);
});

test("SFTP reuse rejects a preferred session that is still connecting", () => {
  const pendingRenderSession = session({ status: "connecting" });
  const sourceSessionId = resolveReusableTerminalSessionIdForSftp({
    activeSessionId: pendingRenderSession.id,
    preferredSourceSessionId: pendingRenderSession.id,
    sftpActiveHost: {
      hostname: pendingRenderSession.hostname,
      port: pendingRenderSession.port,
      username: pendingRenderSession.username,
    },
    sessions: [pendingRenderSession],
    sessionHostsMap: new Map([
      [
        pendingRenderSession.id,
        {
          hostname: pendingRenderSession.hostname,
          port: pendingRenderSession.port,
          username: pendingRenderSession.username,
        },
      ],
    ]),
  });

  assert.equal(sourceSessionId, null);
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
