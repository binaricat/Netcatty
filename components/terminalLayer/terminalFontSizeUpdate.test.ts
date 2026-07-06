import assert from "node:assert/strict";
import test from "node:test";

import type { Host, TerminalSession } from "../../types";
import { resolveTerminalFontSizeUpdateTarget } from "./terminalFontSizeUpdate";

const host = (overrides: Partial<Host> = {}): Host => ({
  id: "host-1",
  label: "Host",
  hostname: "example.com",
  username: "alice",
  group: "",
  tags: [],
  os: "linux",
  protocol: "ssh",
  ...overrides,
});

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

test("ephemeral sessions keep font zoom on the session when the host is missing", () => {
  assert.deepEqual(
    resolveTerminalFontSizeUpdateTarget({
      session: session({ ephemeralHost: true }),
      sessionHost: host(),
      rawHost: null,
    }),
    { kind: "session" },
  );
});

test("workspace sessions keep font zoom on the session", () => {
  assert.deepEqual(
    resolveTerminalFontSizeUpdateTarget({
      session: session({ workspaceId: "workspace-1" }),
      sessionHost: host(),
      rawHost: host(),
    }),
    { kind: "session" },
  );
});

test("local sessions update the global font size", () => {
  assert.deepEqual(
    resolveTerminalFontSizeUpdateTarget({
      session: session({ protocol: "local" }),
      sessionHost: host({ id: "local-session-1", protocol: "local" }),
      rawHost: null,
    }),
    { kind: "global" },
  );
});

test("saved remote hosts update the host override", () => {
  const savedHost = host();

  assert.deepEqual(
    resolveTerminalFontSizeUpdateTarget({
      session: session(),
      sessionHost: savedHost,
      rawHost: savedHost,
    }),
    { kind: "host", host: savedHost },
  );
});

test("in-memory ephemeral hosts keep font zoom on the session", () => {
  assert.deepEqual(
    resolveTerminalFontSizeUpdateTarget({
      session: session(),
      sessionHost: host({ ephemeral: true }),
      rawHost: host({ ephemeral: true }),
    }),
    { kind: "session" },
  );
});
