import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";

import { useSessionState } from "./useSessionState.ts";

type SessionState = ReturnType<typeof useSessionState>;

test("global broadcast availability follows visible orphan session count", async () => {
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  const eventTarget = new EventTarget() as EventTarget & Record<string, unknown>;
  Object.assign(eventTarget, {
    setTimeout,
    clearTimeout,
  });
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: eventTarget,
  });

  const actEnvironment = globalThis as typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT?: boolean;
  };
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

    assert.equal(current().orphanSessions.length, 0);
    assert.equal(current().canUseGlobalBroadcast, false);
    assert.equal(current().isGlobalBroadcastEnabled, false);

    await act(async () => {
      current().createLocalTerminal({ shellName: "01" });
    });
    assert.equal(current().orphanSessions.length, 1);
    assert.equal(current().canUseGlobalBroadcast, false);

    await act(async () => {
      current().createLocalTerminal({ shellName: "02" });
    });
    assert.equal(current().orphanSessions.length, 2);
    assert.equal(current().canUseGlobalBroadcast, true);

    await act(async () => {
      current().toggleGlobalBroadcast();
    });
    assert.equal(current().isGlobalBroadcastEnabled, true);

    await act(async () => {
      current().toggleGlobalBroadcast();
    });
    assert.equal(current().isGlobalBroadcastEnabled, false);

    await act(async () => { current().toggleGlobalBroadcast(); });
    const closedId = current().orphanSessions[1].id;
    await act(async () => { current().closeSession(closedId); });
    assert.equal(current().canUseGlobalBroadcast, false);
    assert.equal(current().isGlobalBroadcastEnabled, false);
    await act(async () => { current().createLocalTerminal({ shellName: "03" }); });
    assert.equal(current().canUseGlobalBroadcast, true);
    assert.equal(current().isGlobalBroadcastEnabled, false);
    await act(async () => { current().toggleGlobalBroadcast(); });
    const [first, second] = current().orphanSessions;
    await act(async () => {
      current().createWorkspaceFromSessions(first.id, second.id, "right");
    });
    assert.equal(current().canUseGlobalBroadcast, false);
    assert.equal(current().isGlobalBroadcastEnabled, false);
    await act(async () => {
      current().removeSessionFromWorkspace(second.id);
    });
    assert.equal(current().canUseGlobalBroadcast, true);
    assert.equal(current().isGlobalBroadcastEnabled, false);
  } finally {
    await act(async () => {
      renderer?.unmount();
    });
    actEnvironment.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
    if (previousWindow) Object.defineProperty(globalThis, "window", previousWindow);
    else Reflect.deleteProperty(globalThis, "window");
  }
});
