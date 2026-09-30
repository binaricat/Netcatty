import assert from "node:assert/strict";
import test from "node:test";
import { netcattyBridge } from "../../infrastructure/services/netcattyBridge.ts";
import { editorTabStore } from "./editorTabStore.ts";
import { installEditorWindowSourceListeners, saveDetachedEditorTab } from "./editorWindowClient.ts";
import { registerEditorSftpWriterScoped } from "./editorSftpBridge.ts";
import { releaseEditorTabSaveCoordinator } from "./editorTabSave.ts";
import type { EditorWindowSaveRequest, EditorWindowSaveResult } from "./editorWindowTypes.ts";

const snapshot = {
  editorId: "save-test", sessionId: "conn", sftpTabId: "pane", hostId: "host",
  remotePath: "/file", fileName: "file", languageId: "plaintext",
  content: "v2", baselineContent: "v1", wordWrap: false, viewState: null,
};

for (const latestContent of ["v3", "v2", "v1"]) {
  test(`detached save reports current dirty state after editing to ${latestContent}`, async (t) => {
    editorTabStore.upsertFromSnapshot(snapshot);
    t.after(() => editorTabStore.close(snapshot.editorId));
    let finish!: (result: { ok: boolean }) => void;
    const pending = new Promise<{ ok: boolean }>((resolve) => { finish = resolve; });
    const reports: boolean[] = [];
    t.mock.method(netcattyBridge, "get", () => ({
      saveEditorWindowTab: (request: { content: string }) => {
        assert.equal(request.content, "v2");
        return pending;
      },
      reportEditorWindowDirty: ({ dirty }: { dirty: boolean }) => reports.push(dirty),
    }));
    const saving = saveDetachedEditorTab(snapshot.editorId);
    editorTabStore.updateContent(snapshot.editorId, latestContent, null);
    finish({ ok: true });
    assert.deepEqual(await saving, { ok: true });
    assert.equal(editorTabStore.getTab(snapshot.editorId)?.baselineContent, "v2");
    assert.equal(editorTabStore.getTab(snapshot.editorId)?.content, latestContent);
    assert.deepEqual(reports, [latestContent !== "v2"]);
  });
}

test("source save receipt preserves dirty until the detached renderer reports it", async (t) => {
  editorTabStore.upsertFromSnapshot(snapshot, "window");
  t.after(() => {
    editorTabStore.close(snapshot.editorId);
    releaseEditorTabSaveCoordinator(snapshot.editorId);
  });
  let finish!: () => void;
  const pending = new Promise<void>((resolve) => { finish = resolve; });
  t.after(registerEditorSftpWriterScoped(async () => { await pending; return "conn"; }));
  let onSave!: (request: EditorWindowSaveRequest) => Promise<void>;
  let onDirty!: (payload: { editorId: string; dirty: boolean }) => void;
  const receipts: EditorWindowSaveResult[] = [];
  t.mock.method(netcattyBridge, "get", () => ({
    onEditorWindowSaveRequest: (cb: typeof onSave) => { onSave = cb; return () => {}; },
    onEditorWindowDirtyChanged: (cb: typeof onDirty) => { onDirty = cb; return () => {}; },
    reportEditorWindowSaveResult: (result: EditorWindowSaveResult) => receipts.push(result),
  }));
  t.after(installEditorWindowSourceListeners());
  const saving = onSave({ ...snapshot, requestId: "request" });
  onDirty({ editorId: snapshot.editorId, dirty: true });
  finish();
  await saving;
  assert.equal(receipts[0]?.ok, true);
  assert.equal(editorTabStore.isDirty(snapshot.editorId), true);
  onDirty({ editorId: snapshot.editorId, dirty: false });
  assert.equal(editorTabStore.isDirty(snapshot.editorId), false);
});
