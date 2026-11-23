import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";

import type { Host } from "../../domain/models";
import { collectSessionIds } from "../../domain/workspace";
import { activeTabStore } from "./activeTabStore";
import { useSessionState } from "./useSessionState";

const makeHost = (id: string, label: string): Host => ({
  id,
  label,
  hostname: `${id}.example.test`,
  username: "ubuntu",
  port: 22,
  os: "linux",
  group: "",
  tags: [],
  protocol: "ssh",
});

function setupDom(t: test.TestContext) {
  const dom = new JSDOM('<div id="root"></div>', { url: "http://localhost" });
  const globals = {
    window: dom.window,
    document: dom.window.document,
    localStorage: dom.window.localStorage,
    CustomEvent: dom.window.CustomEvent,
    Event: dom.window.Event,
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const previous = new Map<string, PropertyDescriptor | undefined>();
  for (const [key, value] of Object.entries(globals)) {
    previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, value });
  }
  const root = createRoot(document.getElementById("root")!);
  t.after(async () => {
    activeTabStore.setActiveTabId("vault");
    await new Promise((resolve) => dom.window.setTimeout(resolve, 0));
    await act(async () => root.unmount());
    dom.window.close();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  });
  return { root };
}

test("useSessionState reopens closed standalone tabs and 2-pane split workspaces in LIFO order", async (t) => {
  const { root } = setupDom(t);
  let state!: ReturnType<typeof useSessionState>;
  function Probe() {
    state = useSessionState({ persistSessionRestore: false });
    return null;
  }
  await act(async () => {
    root.render(React.createElement(React.StrictMode, null, React.createElement(Probe)));
  });

  const hostA = makeHost("h-a", "App Server");
  const hostB = makeHost("h-b", "DB Server");
  const hostsById = new Map<string, Host>([
    [hostA.id, hostA],
    [hostB.id, hostB],
  ]);
  const availableHostIds = new Set(hostsById.keys());

  // 1. Open and close a standalone SSH host tab and a local terminal tab.
  let soloId = "";
  let localId = "";
  await act(async () => {
    soloId = state.connectToHost(hostA);
    localId = state.createLocalTerminal({ shellName: "Zsh", localStartDir: "/tmp" });
  });
  await act(async () => {
    state.updateSessionRestoreCwd(localId, "/Users/dev/workspace");
    state.renameSessionInline(soloId, "Custom Prod");
  });

  await act(async () => {
    state.closeSession(soloId);
  });
  await act(async () => {
    state.closeSession(localId);
  });

  assert.equal(state.sessions.length, 0);
  assert.equal(state.getClosedTabHistoryCount(), 2);

  // 2. Create a 2-pane split workspace, customize split sizes & focus, then close it.
  await act(async () => {
    state.createWorkspaceWithHosts("Ops Split", [hostA, hostB]);
  });
  const origWorkspace = state.workspaces[0];
  assert.ok(origWorkspace);
  assert.equal(origWorkspace.root.type, "split");
  const origPaneIds = collectSessionIds(origWorkspace.root);
  assert.equal(origPaneIds.length, 2);

  await act(async () => {
    state.updateSplitSizes(origWorkspace.id, origWorkspace.root.id, [0.7, 0.3]);
    state.setWorkspaceFocusedSession(origWorkspace.id, origPaneIds[1]);
  });

  await act(async () => {
    state.closeWorkspace(origWorkspace.id);
  });

  assert.equal(state.workspaces.length, 0);
  assert.equal(state.sessions.length, 0);
  assert.equal(activeTabStore.getActiveTabId(), "vault");
  assert.equal(state.getClosedTabHistoryCount(), 3);

  // 3. First reopen: restores the 2-pane split workspace with ratios, title, and focused pane.
  await act(async () => {
    const reopened = state.reopenLastClosedTab({ availableHostIds, hostsById });
    assert.ok(reopened && reopened.kind === "workspace");
  });
  assert.equal(state.workspaces.length, 1);
  assert.equal(state.sessions.length, 2);
  const restoredWs = state.workspaces[0];
  assert.notEqual(restoredWs.id, origWorkspace.id);
  assert.equal(restoredWs.title, "Ops Split");
  assert.equal(restoredWs.viewMode, "split");
  assert.equal(restoredWs.root.type, "split");
  assert.deepEqual(restoredWs.root.sizes, [0.7, 0.3]);
  assert.equal(activeTabStore.getActiveTabId(), restoredWs.id);

  const restoredPaneIds = collectSessionIds(restoredWs.root);
  assert.equal(restoredPaneIds.length, 2);
  assert.equal(restoredWs.focusedSessionId, restoredPaneIds[1]);
  assert.deepEqual(
    state.sessions.map((s) => s.hostId),
    [hostA.id, hostB.id],
  );
  assert.ok(state.sessions.every((s) => s.status === "connecting" && s.workspaceId === restoredWs.id));

  // 4. Second reopen: restores the local terminal tab with its last tracked CWD.
  await act(async () => {
    const reopened = state.reopenLastClosedTab({ availableHostIds, hostsById });
    assert.ok(reopened && reopened.kind === "session");
  });
  assert.equal(state.sessions.length, 3);
  const restoredLocal = state.sessions.find((s) => !s.workspaceId && s.protocol === "local");
  assert.ok(restoredLocal);
  assert.notEqual(restoredLocal.id, localId);
  assert.equal(restoredLocal.localStartDir, "/Users/dev/workspace");
  assert.equal(restoredLocal.status, "connecting");
  assert.equal(activeTabStore.getActiveTabId(), restoredLocal.id);

  // 5. Third reopen: restores the standalone SSH host tab with customName preserved.
  await act(async () => {
    const reopened = state.reopenLastClosedTab({ availableHostIds, hostsById });
    assert.ok(reopened && reopened.kind === "session");
  });
  assert.equal(state.sessions.length, 4);
  const restoredSolo = state.sessions.find((s) => !s.workspaceId && s.hostId === hostA.id);
  assert.ok(restoredSolo);
  assert.notEqual(restoredSolo.id, soloId);
  assert.equal(restoredSolo.customName, "Custom Prod");
  assert.equal(restoredSolo.status, "connecting");
  assert.equal(activeTabStore.getActiveTabId(), restoredSolo.id);

  // 6. Fourth reopen on empty stack is a clean no-op.
  await act(async () => {
    const empty = state.reopenLastClosedTab({ availableHostIds, hostsById });
    assert.equal(empty, null);
  });
  assert.equal(state.sessions.length, 4);
});

test("useSessionState skips deleted vault hosts and ignores hidden MCP sessions on reopen", async (t) => {
  const { root } = setupDom(t);
  let state!: ReturnType<typeof useSessionState>;
  function Probe() {
    state = useSessionState({ persistSessionRestore: false });
    return null;
  }
  await act(async () => {
    root.render(React.createElement(React.StrictMode, null, React.createElement(Probe)));
  });

  const keepHost = makeHost("h-keep", "Keep");
  const deleteHost = makeHost("h-delete", "Delete Me");

  let keepId = "";
  let deleteId = "";
  let hiddenId = "";
  await act(async () => {
    keepId = state.connectToHost(keepHost);
    deleteId = state.connectToHost(deleteHost);
    hiddenId = state.connectToHost(keepHost, { hidden: true });
  });

  await act(async () => {
    state.closeSession(keepId);
  });
  await act(async () => {
    state.closeSession(deleteId);
  });
  await act(async () => {
    state.closeSession(hiddenId);
  });

  // Hidden session was never added to history.
  assert.equal(state.getClosedTabHistoryCount(), 2);

  // Delete `h-delete` from the vault before reopening.
  const remainingHosts = new Map<string, Host>([[keepHost.id, keepHost]]);
  const availableHostIds = new Set(remainingHosts.keys());

  await act(async () => {
    const reopened = state.reopenLastClosedTab({ availableHostIds, hostsById: remainingHosts });
    assert.ok(reopened && reopened.kind === "session");
    assert.equal(reopened.session.hostId, keepHost.id);
  });

  assert.equal(state.sessions.length, 1);
  assert.equal(state.sessions[0].hostId, keepHost.id);
  assert.equal(state.getClosedTabHistoryCount(), 0);
});

test("useSessionState prunes deleted hosts from a closed split workspace on reopen without persisting history to localStorage", async (t) => {
  const { root } = setupDom(t);
  let state!: ReturnType<typeof useSessionState>;
  function Probe() {
    state = useSessionState({ persistSessionRestore: false });
    return null;
  }
  await act(async () => {
    root.render(React.createElement(React.StrictMode, null, React.createElement(Probe)));
  });

  const hostA = makeHost("h-a", "Web");
  const hostB = makeHost("h-b", "Worker");
  const hostC = makeHost("h-c", "Cache");

  await act(async () => {
    state.createWorkspaceWithHosts("Cluster", [hostA, hostB, hostC]);
  });
  const ws = state.workspaces[0];
  assert.ok(ws && ws.root.type === "split");
  await act(async () => {
    state.updateSplitSizes(ws.id, ws.root.id, [0.2, 0.3, 0.5]);
  });
  await act(async () => {
    state.closeWorkspace(ws.id);
  });

  assert.equal(window.localStorage.length, 0, "closed tab history must stay in-memory only");

  // Delete hostB from the vault before reopening.
  const survivingHosts = new Map<string, Host>([
    [hostA.id, hostA],
    [hostC.id, hostC],
  ]);
  await act(async () => {
    const reopened = state.reopenLastClosedTab({
      availableHostIds: new Set(survivingHosts.keys()),
      hostsById: survivingHosts,
    });
    assert.ok(reopened && reopened.kind === "workspace");
  });

  assert.equal(state.workspaces.length, 1);
  const restored = state.workspaces[0];
  assert.equal(restored.title, "Cluster");
  assert.equal(restored.root.type, "split");
  assert.equal(collectSessionIds(restored.root).length, 2);
  assert.deepEqual(state.sessions.map((s) => s.hostId), [hostA.id, hostC.id]);
  assert.ok(Math.abs((restored.root.sizes?.[0] ?? 0) - 2 / 7) < 1e-9);
  assert.ok(Math.abs((restored.root.sizes?.[1] ?? 0) - 5 / 7) < 1e-9);
});
