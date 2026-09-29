import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";

import type { Host } from "../../domain/models";
import { EMPTY_VAULT_SNAPSHOT, publishVaultSnapshot } from "./vaultSnapshotStore";
import { useSessionState } from "./useSessionState.ts";

type SessionState = ReturnType<typeof useSessionState>;

const testHost = (overrides: Partial<Host> = {}): Host => ({
  id: "host-1",
  label: "web-01",
  hostname: "10.0.0.1",
  port: 22,
  username: "root",
  os: "linux",
  tags: [],
  ...overrides,
} as Host);

test("rewriting the host label updates already-open session tabs on that host", async (t) => {
  publishVaultSnapshot(EMPTY_VAULT_SNAPSHOT);
  t.after(() => publishVaultSnapshot(EMPTY_VAULT_SNAPSHOT));

  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  const eventTarget = new EventTarget() as EventTarget & Record<string, unknown>;
  Object.assign(eventTarget, { setTimeout, clearTimeout });
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: eventTarget,
  });
  t.after(() => {
    if (previousWindow) Object.defineProperty(globalThis, "window", previousWindow);
    else Reflect.deleteProperty(globalThis, "window");
  });

  const actEnvironment = globalThis as typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT?: boolean;
  };
  const previousActEnvironment = actEnvironment.IS_REACT_ACT_ENVIRONMENT;
  actEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
  t.after(() => {
    actEnvironment.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
  });

  let state: SessionState | null = null;
  let renderer: ReactTestRenderer | null = null;
  const current = (): SessionState => {
    assert.ok(state);
    return state;
  };
  function Probe() {
    state = useSessionState({ persistSessionRestore: false });
    return null;
  }

  await act(async () => {
    renderer = create(React.createElement(Probe));
  });

  let sessionId = "";
  await act(async () => {
    sessionId = current().connectToHost(testHost());
  });
  const sessionOf = () => current().sessions.find((s) => s.id === sessionId);
  assert.ok(sessionOf());
  assert.equal(sessionOf()?.hostLabel, "web-01");

  // The host is renamed in the vault while the session stays open.
  await act(async () => {
    publishVaultSnapshot({
      ...EMPTY_VAULT_SNAPSHOT,
      hosts: [testHost({ label: "web-01-renamed" })],
    });
  });

  assert.equal(sessionOf()?.hostLabel, "web-01-renamed");

  // Renaming the pane afterwards hands the title to the user rename.
  await act(async () => {
    current().submitSessionRename(sessionId, "my pane");
  });
  const renamed = sessionOf();
  assert.ok(renamed);
  assert.equal(renamed!.customName, "my pane");

  // A later vault rename must not clobber the user-authored pane name.
  await act(async () => {
    publishVaultSnapshot({
      ...EMPTY_VAULT_SNAPSHOT,
      hosts: [testHost({ label: "web-01-again" })],
    });
  });
  const after = sessionOf();
  assert.ok(after);
  assert.equal(after!.customName, "my pane");

  await act(async () => {
    renderer?.unmount();
  });
});
