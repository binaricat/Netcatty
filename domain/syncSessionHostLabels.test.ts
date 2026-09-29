import assert from "node:assert/strict";
import test from "node:test";

import type { TerminalSession } from "./models";
import { syncSessionHostLabels } from "./syncSessionHostLabels";

const session = (overrides: Partial<TerminalSession>): TerminalSession => ({
  id: "s1",
  hostId: "h1",
  hostLabel: "old-label",
  hostname: "10.0.0.1",
  username: "root",
  status: "connected",
  ...overrides,
} as TerminalSession);

test("syncSessionHostLabels mirrors the vault host label onto open sessions", () => {
  const sessions = [session({ id: "s1", hostId: "h1", hostLabel: "old" })];
  const next = syncSessionHostLabels(sessions, [{ id: "h1", label: "web-01" }]);
  assert.equal(next[0].hostLabel, "web-01");
  assert.notEqual(next, sessions);
});

test("syncSessionHostLabels returns the same array when labels already match", () => {
  const sessions = [session({ hostLabel: "web-01" })];
  assert.equal(syncSessionHostLabels(sessions, [{ id: "h1", label: "web-01" }]), sessions);
});

test("syncSessionHostLabels leaves sessions without a matching vault host untouched", () => {
  const sessions = [
    session({ id: "local", hostId: "local-terminal", hostLabel: "Local Terminal" }),
    session({ id: "serial", hostId: "serial-abc", hostLabel: "Serial: ttyUSB0" }),
    session({ id: "eph", hostId: "ephemeral-host", hostLabel: "Quick Connect" }),
  ];
  const next = syncSessionHostLabels(sessions, [{ id: "h9", label: "other" }]);
  assert.equal(next, sessions);
});

test("syncSessionHostLabels keeps a renamed pane's custom name authoritative", () => {
  const sessions = [session({ customName: "my pane", hostLabel: "old" })];
  const next = syncSessionHostLabels(sessions, [{ id: "h1", label: "web-01" }]);
  assert.equal(next, sessions);
});

test("syncSessionHostLabels updates only hosts present in the vault", () => {
  const sessions = [
    session({ id: "s1", hostId: "h1", hostLabel: "old-a" }),
    session({ id: "s2", hostId: "h2", hostLabel: "old-b" }),
  ];
  const next = syncSessionHostLabels(sessions, [{ id: "h1", label: "new-a" }]);
  assert.equal(next[0].hostLabel, "new-a");
  assert.equal(next[1].hostLabel, "old-b");
});

test("syncSessionHostLabels preserves unknown labels for hosts with empty labels", () => {
  const sessions = [session({ hostId: "h1", hostLabel: "Serial: ttyS0" })];
  const next = syncSessionHostLabels(sessions, [{ id: "h1", label: "" }]);
  assert.equal(next, sessions);
});

test("syncSessionHostLabels is a no-op without hosts", () => {
  const sessions = [session({})];
  assert.equal(syncSessionHostLabels(sessions, []), sessions);
});
