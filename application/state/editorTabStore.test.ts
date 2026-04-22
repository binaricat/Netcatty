import test from "node:test";
import assert from "node:assert/strict";

import { EditorTabStore, type EditorTab } from "./editorTabStore.ts";

const makeTab = (overrides: Partial<EditorTab> = {}): EditorTab => ({
  id: "edt_1",
  kind: "editor",
  sessionId: "conn_1",
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
