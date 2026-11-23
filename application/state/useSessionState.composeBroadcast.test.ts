import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";

import { useSessionState } from "./useSessionState.ts";
import { installTestLocalStorage } from "./testSupport/localStorage.ts";

test.beforeEach((t) => { t.after(installTestLocalStorage()); });

type SessionState = ReturnType<typeof useSessionState>;

test("compose send target follows toolbar broadcast and then flips independently", async () => {
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  const eventTarget = new EventTarget() as EventTarget & Record<string, unknown>;
  Object.assign(eventTarget, { setTimeout, clearTimeout });
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: eventTarget,
  });
  const actEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
  const previousActEnvironment = actEnvironment.IS_REACT_ACT_ENVIRONMENT;
  actEnvironment.IS_REACT_ACT_ENVIRONMENT = true;

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

  try {
    await act(async () => {
      renderer = create(React.createElement(Probe));
    });
    await act(async () => { current().createLocalTerminal({ shellName: "01" }); });
    await act(async () => { current().createLocalTerminal({ shellName: "02" }); });
    const [first, second] = current().orphanSessions;
    await act(async () => {
      current().createWorkspaceFromSessions(first.id, second.id, "right");
    });
    const workspaceId = current().workspaces[0]?.id;
    assert.ok(workspaceId);
    assert.equal(current().isBroadcastEnabled(workspaceId), false);
    assert.equal(current().isComposeSendToAll(workspaceId), false);

    await act(async () => { current().toggleBroadcast(workspaceId); });
    assert.equal(current().isBroadcastEnabled(workspaceId), true);
    assert.equal(current().isComposeSendToAll(workspaceId), true);

    await act(async () => { current().toggleComposeSendTarget(workspaceId); });
    assert.equal(current().isBroadcastEnabled(workspaceId), true);
    assert.equal(current().isComposeSendToAll(workspaceId), false);

    await act(async () => { current().toggleComposeSendTarget(workspaceId); });
    assert.equal(current().isComposeSendToAll(workspaceId), true);
    assert.equal(current().isBroadcastEnabled(workspaceId), true);

    await act(async () => { current().toggleBroadcast(workspaceId); });
    assert.equal(current().isBroadcastEnabled(workspaceId), false);
    assert.equal(current().isComposeSendToAll(workspaceId), false);

    await act(async () => { current().toggleComposeSendTarget(workspaceId); });
    assert.equal(current().isBroadcastEnabled(workspaceId), false);
    assert.equal(current().isComposeSendToAll(workspaceId), true);

    await act(async () => { current().toggleGlobalBroadcast(); });
    assert.equal(current().isGlobalBroadcastEnabled, false);
    assert.equal(current().isGlobalComposeSendToAll, false);
    assert.equal(current().canUseGlobalBroadcast, false);
  } finally {
    await act(async () => { renderer?.unmount(); });
    actEnvironment.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
    if (previousWindow) Object.defineProperty(globalThis, "window", previousWindow);
    else Reflect.deleteProperty(globalThis, "window");
  }
});

test("global compose send target follows the toolbar switch for orphan sessions", async () => {
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  const eventTarget = new EventTarget() as EventTarget & Record<string, unknown>;
  Object.assign(eventTarget, { setTimeout, clearTimeout });
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: eventTarget,
  });
  const actEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
  const previousActEnvironment = actEnvironment.IS_REACT_ACT_ENVIRONMENT;
  actEnvironment.IS_REACT_ACT_ENVIRONMENT = true;

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

  try {
    await act(async () => {
      renderer = create(React.createElement(Probe));
    });
    await act(async () => { current().createLocalTerminal({ shellName: "01" }); });
    await act(async () => { current().createLocalTerminal({ shellName: "02" }); });
    assert.equal(current().canUseGlobalBroadcast, true);
    assert.equal(current().isGlobalComposeSendToAll, false);

    await act(async () => { current().toggleGlobalBroadcast(); });
    assert.equal(current().isGlobalBroadcastEnabled, true);
    assert.equal(current().isGlobalComposeSendToAll, true);

    await act(async () => { current().toggleGlobalComposeSendTarget(); });
    assert.equal(current().isGlobalBroadcastEnabled, true);
    assert.equal(current().isGlobalComposeSendToAll, false);

    await act(async () => { current().toggleGlobalBroadcast(); });
    assert.equal(current().isGlobalBroadcastEnabled, false);
    assert.equal(current().isGlobalComposeSendToAll, false);

    const closedId = current().orphanSessions[1].id;
    await act(async () => { current().toggleGlobalComposeSendTarget(); });
    assert.equal(current().isGlobalComposeSendToAll, true);
    await act(async () => { current().closeSession(closedId); });
    assert.equal(current().canUseGlobalBroadcast, false);
    assert.equal(current().isGlobalBroadcastEnabled, false);
    assert.equal(current().isGlobalComposeSendToAll, false);
  } finally {
    await act(async () => { renderer?.unmount(); });
    actEnvironment.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
    if (previousWindow) Object.defineProperty(globalThis, "window", previousWindow);
    else Reflect.deleteProperty(globalThis, "window");
  }
});
