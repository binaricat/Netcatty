import test from "node:test";
import assert from "node:assert/strict";

import { EditorTabStore, type EditorTab } from "./editorTabStore.ts";
import { createEditorTabSaveService } from "./editorTabSave.ts";

const deferred = <T = void>() => {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

const makeTab = (overrides: Partial<EditorTab> = {}): EditorTab => ({
  id: "edt_1",
  kind: "editor",
  sessionId: "conn_1",
  hostId: "host_1",
  remotePath: "/tmp/file.txt",
  fileName: "file.txt",
  languageId: "plaintext",
  content: "v1",
  baselineContent: "old",
  wordWrap: false,
  viewState: null,
  savingState: "idle",
  saveError: null,
  ...overrides,
});

test("editor tab save service joins duplicate saves for the same content", async () => {
  const store = new EditorTabStore();
  store._debugInsert(makeTab());
  const pending = deferred();
  const writes: string[] = [];
  const service = createEditorTabSaveService({
    store,
    write: async (_sessionId, _hostId, _remotePath, content) => {
      writes.push(content);
      await pending.promise;
    },
  });

  const first = service.saveTab("edt_1");
  const second = service.saveTab("edt_1", "v1");

  assert.deepEqual(writes, ["v1"]);
  pending.resolve();

  assert.equal(await first, true);
  assert.equal(await second, true);
  assert.deepEqual(writes, ["v1"]);
  assert.equal(store.getTab("edt_1")?.baselineContent, "v1");
  assert.equal(store.getTab("edt_1")?.savingState, "idle");
});

test("editor tab save service queues newer tab content after an in-flight save", async () => {
  const store = new EditorTabStore();
  store._debugInsert(makeTab());
  const firstSave = deferred();
  const secondSave = deferred();
  const writes: string[] = [];
  const service = createEditorTabSaveService({
    store,
    write: async (_sessionId, _hostId, _remotePath, content) => {
      writes.push(content);
      await (content === "v1" ? firstSave.promise : secondSave.promise);
    },
  });

  const first = service.saveTab("edt_1");
  store.updateContent("edt_1", "v2", null);
  const second = service.saveTab("edt_1");

  assert.deepEqual(writes, ["v1"]);
  firstSave.resolve();
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(writes, ["v1", "v2"]);
  secondSave.resolve();

  assert.equal(await first, true);
  assert.equal(await second, true);
  assert.equal(store.getTab("edt_1")?.baselineContent, "v2");
  assert.equal(store.getTab("edt_1")?.content, "v2");
});
