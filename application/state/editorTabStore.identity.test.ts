import assert from "node:assert/strict";
import test from "node:test";

test("independent renderers creating editors in the same millisecond get distinct identities", async (t) => {
  t.mock.method(Date, "now", () => 1234567890);
  const [firstRenderer, secondRenderer] = await Promise.all([
    import(new URL("./editorTabStore.ts?renderer=first", import.meta.url).href),
    import(new URL("./editorTabStore.ts?renderer=second", import.meta.url).href),
  ]);
  assert.notEqual(firstRenderer.EditorTabStore, secondRenderer.EditorTabStore, "use independent renderer module state");
  const snapshot = { sessionId: "session", sftpTabId: "pane", hostId: "host", remotePath: "/file.txt", fileName: "file.txt", languageId: "plaintext", content: "edits", baselineContent: "original", wordWrap: false, viewState: null };
  const first = new firstRenderer.EditorTabStore().promoteFromModal(snapshot);
  const second = new secondRenderer.EditorTabStore().promoteFromModal(snapshot);
  assert.notEqual(first, second, "process-wide ownership must not collide across renderer-local counters");
  assert.match(first, /^edt_[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i);
});
