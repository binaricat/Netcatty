import test from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";

import {
  editorTabStore,
  EditorTabStore,
  useHasEditorTabForSessions,
  type EditorTab,
} from "./editorTabStore.ts";

const makeTab = (overrides: Partial<EditorTab> = {}): EditorTab => ({
  id: "edt_1",
  kind: "editor",
  sessionId: "conn_1",
  sftpTabId: "pane_1",
  hostId: "host_1",
  remotePath: "/etc/nginx/nginx.conf",
  fileName: "nginx.conf",
  languageId: "ini",
  content: "worker_processes auto;",
  baselineContent: "worker_processes auto;",
  wordWrap: false,
  viewState: null,
  savingState: "idle",
  saveError: null,
  ...overrides,
});

test("clean modal reuses a detached tab without changing its dirty state or content", () => {
  const store = new EditorTabStore();
  const tab = makeTab({ placement: "window", windowDirty: true, content: "", baselineContent: "" });
  store._debugInsert(tab);
  const id = store.promoteFromModal({
    ...makeTab(),
    remotePath: "/etc//nginx/./nginx.conf",
  });
  assert.equal(id, tab.id);
  assert.equal(store.getTab(id), tab);
  assert.equal(store.isDirty(id), true);
  assert.equal(store.getTabs().length, 1);
});

test("updateContent stores content and viewState; dirty flag derives from baseline", () => {
  const store = new EditorTabStore();
  store._debugInsert(makeTab());
  store.updateContent("edt_1", "worker_processes 4;", null);
  const tab = store.getTab("edt_1")!;
  assert.equal(tab.content, "worker_processes 4;");
  assert.equal(store.isDirty("edt_1"), true);
});

test("markSaved moves baseline to current content and clears dirty", () => {
  const store = new EditorTabStore();
  store._debugInsert(makeTab({ content: "changed", baselineContent: "orig" }));
  assert.equal(store.isDirty("edt_1"), true);
  store.markSaved("edt_1", "changed");
  assert.equal(store.isDirty("edt_1"), false);
  assert.equal(store.getTab("edt_1")!.baselineContent, "changed");
});

test("setWordWrap updates only that tab", () => {
  const store = new EditorTabStore();
  store._debugInsert(makeTab({ id: "edt_1" }));
  store._debugInsert(makeTab({ id: "edt_2", remotePath: "/b.txt", fileName: "b.txt" }));
  store.setWordWrap("edt_1", true);
  assert.equal(store.getTab("edt_1")!.wordWrap, true);
  assert.equal(store.getTab("edt_2")!.wordWrap, false);
});

test("setSavingState transitions and clears error on idle", () => {
  const store = new EditorTabStore();
  store._debugInsert(makeTab());
  store.setSavingState("edt_1", "saving");
  assert.equal(store.getTab("edt_1")!.savingState, "saving");
  store.setSavingState("edt_1", "error", "EACCES");
  assert.equal(store.getTab("edt_1")!.saveError, "EACCES");
  store.setSavingState("edt_1", "idle");
  assert.equal(store.getTab("edt_1")!.saveError, null);
});

test("close removes the tab and returns remaining ids in order", () => {
  const store = new EditorTabStore();
  store._debugInsert(makeTab({ id: "edt_1" }));
  store._debugInsert(makeTab({ id: "edt_2", remotePath: "/b.txt", fileName: "b.txt" }));
  store.close("edt_1");
  assert.equal(store.getTab("edt_1"), undefined);
  assert.deepEqual(store.getTabs().map((t) => t.id), ["edt_2"]);
});

test("subscribers fire on change and not on read", () => {
  const store = new EditorTabStore();
  store._debugInsert(makeTab());
  let count = 0;
  const unsub = store.subscribe(() => { count++; });
  store.getTab("edt_1");
  store.getTabs();
  assert.equal(count, 0);
  store.updateContent("edt_1", "x", null);
  // notifications are microtask-deferred, flush via awaiting a resolved promise
  return Promise.resolve().then(() => {
    assert.equal(count, 1);
    unsub();
  });
});

test("promoteFromModal creates a new tab and returns its id", () => {
  const store = new EditorTabStore();
  const id = store.promoteFromModal({
    sessionId: "conn_1",
    sftpTabId: "pane_1",
    hostId: "host_1",
    remotePath: "/etc/nginx/nginx.conf",
    fileName: "nginx.conf",
    languageId: "ini",
    content: "x",
    baselineContent: "x",
    wordWrap: false,
    viewState: null,
  });
  const tab = store.getTab(id)!;
  assert.equal(tab.remotePath, "/etc/nginx/nginx.conf");
  assert.equal(tab.fileName, "nginx.conf");
  assert.equal(tab.kind, "editor");
});

test("hasTabForSessions identifies the SFTP owner of a promoted editor", () => {
  const store = new EditorTabStore();
  store.promoteFromModal({
    sessionId: "conn_owned",
    sftpTabId: "pane_owned",
    hostId: "host_1",
    remotePath: "/tmp/script.sh",
    fileName: "script.sh",
    languageId: "shell",
    content: "echo changed",
    baselineContent: "echo original",
    wordWrap: false,
    viewState: null,
  });

  assert.equal(store.hasTabForSessions(new Set(["conn_owned"])), true);
  assert.equal(store.hasTabForSessions(new Set(["conn_other"])), false);
});

test("useHasEditorTabForSessions updates when the owning editor opens and closes", async () => {
  const actEnvironment = globalThis as typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT?: boolean;
  };
  const previousActEnvironment = actEnvironment.IS_REACT_ACT_ENVIRONMENT;
  actEnvironment.IS_REACT_ACT_ENVIRONMENT = true;

  const ownedSessionIdsRef = { current: new Set(["conn_hook_test"]) };
  const getOwnedSessionIds = () => ownedSessionIdsRef.current;
  let hasOwnedEditorTab = false;
  const Probe = () => {
    hasOwnedEditorTab = useHasEditorTabForSessions(getOwnedSessionIds);
    return null;
  };
  let renderer: ReactTestRenderer | null = null;
  let tabId: string | null = null;

  try {
    await act(async () => {
      renderer = create(React.createElement(Probe));
    });
    assert.equal(hasOwnedEditorTab, false);

    await act(async () => {
      tabId = editorTabStore.promoteFromModal({
        sessionId: "conn_hook_test",
        sftpTabId: "pane_hook_test",
        hostId: "host_1",
        remotePath: "/tmp/hook-test.sh",
        fileName: "hook-test.sh",
        languageId: "shell",
        content: "echo changed",
        baselineContent: "echo original",
        wordWrap: false,
        viewState: null,
      });
      await Promise.resolve();
    });
    assert.equal(hasOwnedEditorTab, true);

    await act(async () => {
      editorTabStore.close(tabId!);
      await Promise.resolve();
    });
    assert.equal(hasOwnedEditorTab, false);
  } finally {
    if (tabId) editorTabStore.close(tabId);
    await act(async () => {
      renderer?.unmount();
    });
    actEnvironment.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
  }
});

test("promoteFromModal focuses existing tab for same sessionId+normalized path and overrides content", () => {
  const store = new EditorTabStore();
  const first = store.promoteFromModal({
    sessionId: "conn_1",
    sftpTabId: "pane_1",
    hostId: "host_1",
    remotePath: "/etc/nginx/./nginx.conf",
    fileName: "nginx.conf",
    languageId: "ini",
    content: "v1",
    baselineContent: "v1",
    wordWrap: false,
    viewState: null,
  });
  const second = store.promoteFromModal({
    sessionId: "conn_1",
    sftpTabId: "pane_1",
    hostId: "host_1",
    remotePath: "/etc/nginx/nginx.conf",
    fileName: "nginx.conf",
    languageId: "ini",
    content: "v2",
    baselineContent: "v1",
    wordWrap: false,
    viewState: null,
  });
  assert.equal(second, first);
  assert.equal(store.getTab(first)!.content, "v2");
  assert.equal(store.getTabs().length, 1);
});

test("dedup scope is per-sessionId — same path on different sessions are distinct tabs", () => {
  const store = new EditorTabStore();
  const a = store.promoteFromModal({
    sessionId: "conn_A",
    sftpTabId: "pane_a",
    hostId: "host_1",
    remotePath: "/etc/hosts",
    fileName: "hosts",
    languageId: "plaintext",
    content: "", baselineContent: "", wordWrap: false, viewState: null,
  });
  const b = store.promoteFromModal({
    sessionId: "conn_B",
    sftpTabId: "pane_b",
    hostId: "host_2",
    remotePath: "/etc/hosts",
    fileName: "hosts",
    languageId: "plaintext",
    content: "", baselineContent: "", wordWrap: false, viewState: null,
  });
  assert.notEqual(a, b);
  assert.equal(store.getTabs().length, 2);
});

test("confirmCloseBySession returns true when no tabs match", async () => {
  const store = new EditorTabStore();
  store._debugInsert(makeTab());
  const ok = await store.confirmCloseBySession("other_conn", async () => "discard");
  assert.equal(ok, true);
  assert.equal(store.getTabs().length, 1);
});

test("confirmCloseBySession discards all dirty matching tabs when prompt returns 'discard'", async () => {
  const store = new EditorTabStore();
  store._debugInsert(makeTab({ id: "edt_1", content: "x", baselineContent: "y" }));
  store._debugInsert(makeTab({ id: "edt_2", remotePath: "/b.txt", fileName: "b.txt", content: "x", baselineContent: "y" }));
  const ok = await store.confirmCloseBySession("conn_1", async () => "discard");
  assert.equal(ok, true);
  assert.equal(store.getTabs().length, 0);
});

test("confirmCloseBySession closes clean tabs without prompting; aborts on cancel", async () => {
  const store = new EditorTabStore();
  store._debugInsert(makeTab({ id: "edt_clean" })); // content == baseline
  store._debugInsert(makeTab({ id: "edt_dirty", remotePath: "/b.txt", fileName: "b.txt", content: "x", baselineContent: "y" }));
  let prompts = 0;
  const ok = await store.confirmCloseBySession("conn_1", async () => { prompts++; return "cancel"; });
  assert.equal(ok, false);
  assert.equal(prompts, 1, "prompt fires only for dirty tab");
  // clean tab was closed before the dirty cancel aborted the batch
  assert.equal(store.getTab("edt_clean"), undefined);
  assert.ok(store.getTab("edt_dirty"));
});

test("confirmCloseBySession invokes save callback for 'save' choice and only closes on save success", async () => {
  const store = new EditorTabStore();
  store._debugInsert(makeTab({ id: "edt_1", content: "new", baselineContent: "old" }));
  let saved = false;
  const ok = await store.confirmCloseBySession("conn_1", async () => "save", async (id) => {
    assert.equal(id, "edt_1");
    saved = true;
    store.markSaved(id, "new");
  });
  assert.equal(saved, true);
  assert.equal(ok, true);
  assert.equal(store.getTab("edt_1"), undefined);
});

test("confirmCloseBySession reports every closed editor tab to cleanup callback", async () => {
  const store = new EditorTabStore();
  store._debugInsert(makeTab({ id: "edt_clean" }));
  store._debugInsert(makeTab({ id: "edt_dirty", remotePath: "/b.txt", fileName: "b.txt", content: "new", baselineContent: "old" }));
  const closed: string[] = [];

  const ok = await store.confirmCloseBySession(
    "conn_1",
    async () => "save",
    async (id) => {
      const tab = store.getTab(id)!;
      store.markSaved(id, tab.content);
    },
    (id) => closed.push(id),
  );

  assert.equal(ok, true);
  assert.deepEqual(closed, ["edt_clean", "edt_dirty"]);
  assert.equal(store.getTabs().length, 0);
});

test("remapSessionId updates editor ownership after browse reconnect", () => {
  const store = new EditorTabStore();
  store._debugInsert(makeTab({ sessionId: "conn_old" }));
  assert.equal(store.hasTabForSessions(new Set(["conn_old"])), true);
  assert.equal(store.hasTabForSessions(new Set(["conn_new"])), false);

  const before = store.getPresenceRevision();
  store.remapSessionId("conn_old", "conn_new");

  assert.equal(store.getTab("edt_1")?.sessionId, "conn_new");
  assert.equal(store.hasTabForSessions(new Set(["conn_new"])), true);
  assert.equal(store.getPresenceRevision(), before + 1);
});

test("hasOwnedEditorForSftpOwner keeps ownership via pane tab id during reconnect gap", () => {
  const store = new EditorTabStore();
  store._debugInsert(makeTab({ sessionId: "conn_old", sftpTabId: "pane_1" }));

  assert.equal(store.hasTabForSessions(new Set(["conn_new"])), false);
  assert.equal(
    store.hasOwnedEditorForSftpOwner({
      sessionIds: new Set(["conn_new"]),
      sftpTabIds: new Set(["pane_1"]),
    }),
    true,
  );
});

test("confirmCloseByOwner matches editors by stable SFTP pane tab id", async () => {
  const store = new EditorTabStore();
  store._debugInsert(makeTab({
    sessionId: "conn_old",
    sftpTabId: "pane_1",
    content: "dirty",
    baselineContent: "clean",
  }));
  let prompted = false;
  const ok = await store.confirmCloseByOwner(
    { sessionId: "conn_new", sftpTabId: "pane_1" },
    async () => {
      prompted = true;
      return "cancel";
    },
  );
  assert.equal(prompted, true);
  assert.equal(ok, false);
  assert.equal(store.getTabs().length, 1);
});

test("forceCloseByOwners closes editors matched by SFTP pane tab id", () => {
  const store = new EditorTabStore();
  store._debugInsert(makeTab({ sessionId: "conn_old", sftpTabId: "pane_1" }));
  const closed = store.forceCloseByOwners({ sftpTabIds: ["pane_1"] });
  assert.deepEqual(closed, ["edt_1"]);
  assert.equal(store.getTabs().length, 0);
});

test("updateContent does not bump editor presence revision", () => {
  const store = new EditorTabStore();
  store._debugInsert(makeTab());
  const before = store.getPresenceRevision();
  store.updateContent("edt_1", "changed", null);
  assert.equal(store.getPresenceRevision(), before);
});
