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

test("promoteFromModal creates a new tab and returns its id", () => {
  const store = new EditorTabStore();
  const id = store.promoteFromModal({
    sessionId: "conn_1",
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

test("promoteFromModal focuses existing tab for same sessionId+normalized path and overrides content", () => {
  const store = new EditorTabStore();
  const first = store.promoteFromModal({
    sessionId: "conn_1",
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
    hostId: "host_1",
    remotePath: "/etc/hosts",
    fileName: "hosts",
    languageId: "plaintext",
    content: "", baselineContent: "", wordWrap: false, viewState: null,
  });
  const b = store.promoteFromModal({
    sessionId: "conn_B",
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
