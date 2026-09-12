import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";

import { useSessionState } from "./useSessionState.ts";

type SessionState = ReturnType<typeof useSessionState>;

test("merged tab titles follow the workspace lifecycle until the user renames it", async (t) => {
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
  const workspace = (workspaceId: string) => {
    const found = current().workspaces.find((candidate) => candidate.id === workspaceId);
    assert.ok(found);
    return found;
  };
  function Probe() {
    state = useSessionState({ persistSessionRestore: false });
    return null;
  }

  await act(async () => {
    renderer = create(React.createElement(Probe));
  });

  let firstSessionId = "";
  let secondSessionId = "";
  await act(async () => {
    firstSessionId = current().createLocalTerminal({ shellName: "01" });
    secondSessionId = current().createLocalTerminal({ shellName: "02" });
  });

  await act(async () => {
    current().createWorkspaceFromSessions(firstSessionId, secondSessionId, {
      direction: "vertical",
      position: "right",
      targetSessionId: firstSessionId,
    });
  });

  const workspaceId = current().workspaces[0]?.id;
  assert.ok(workspaceId);
  assert.equal(workspace(workspaceId).title, "01/02");
  assert.equal(workspace(workspaceId).autoTitle, false);
  assert.equal(workspace(workspaceId).generatedTitle, true);

  await act(async () => {
    current().startWorkspaceRename(workspaceId);
  });
  assert.equal(current().workspaceRenameValue, "01/02");

  await act(async () => {
    current().resetWorkspaceRename();
    current().renameSessionInline(secondSessionId, "prod");
  });
  assert.equal(workspace(workspaceId).title, "01/prod");

  let thirdSessionId = "";
  await act(async () => {
    thirdSessionId = current().createLocalTerminal({ shellName: "03" });
  });
  await act(async () => {
    current().addSessionToWorkspace(workspaceId, thirdSessionId, {
      direction: "vertical",
      position: "right",
      targetSessionId: secondSessionId,
    });
  });
  assert.equal(workspace(workspaceId).title, "01/prod/03");

  await act(async () => {
    current().removeSessionFromWorkspace(thirdSessionId);
  });
  assert.equal(workspace(workspaceId).title, "01/prod");

  const workspaceIdsBeforeCopy = new Set(current().workspaces.map((candidate) => candidate.id));
  await act(async () => {
    current().copyWorkspace(workspaceId);
  });
  const copiedWorkspace = current().workspaces.find(
    (candidate) => !workspaceIdsBeforeCopy.has(candidate.id),
  );
  assert.ok(copiedWorkspace);
  assert.equal(copiedWorkspace.title, "01/prod");
  assert.equal(copiedWorkspace.autoTitle, false);
  assert.equal(copiedWorkspace.generatedTitle, true);

  await act(async () => {
    current().submitWorkspaceRename(workspaceId, "Pinned");
    current().renameSessionInline(firstSessionId, "ops");
  });
  assert.equal(workspace(workspaceId).title, "Pinned");
  assert.equal(workspace(workspaceId).generatedTitle, false);

  let leftBaseSessionId = "";
  let leftJoiningSessionId = "";
  await act(async () => {
    leftBaseSessionId = current().createLocalTerminal({ shellName: "04" });
    leftJoiningSessionId = current().createLocalTerminal({ shellName: "05" });
  });
  await act(async () => {
    current().createWorkspaceFromSessions(leftBaseSessionId, leftJoiningSessionId, {
      direction: "vertical",
      position: "left",
      targetSessionId: leftBaseSessionId,
    });
  });
  const leftWorkspace = current().workspaces.find((candidate) => candidate.title === "05/04");
  assert.ok(leftWorkspace);
  assert.equal(leftWorkspace.generatedTitle, true);

  await act(async () => {
    renderer?.unmount();
  });
});
