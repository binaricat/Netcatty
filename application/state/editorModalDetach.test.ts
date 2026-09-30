import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { editorTabStore } from "../../application/state/editorTabStore.ts";
import { netcattyBridge } from "../../infrastructure/services/netcattyBridge.ts";
import { toast } from "../../components/ui/toast.tsx";
import { useSftpViewFileOps } from "../../components/sftp/hooks/useSftpViewFileOps.ts";
import type { UseSftpViewFileOpsParams, UseSftpViewFileOpsResult } from "../../components/sftp/hooks/useSftpViewFileOps.types.ts";

for (const action of ["onPopOut", "onPromoteToTab"] as const) {
  test(`${action} preserves a modified modal when the file is already detached`, async (t) => {
    const environment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
    const previous = environment.IS_REACT_ACT_ENVIRONMENT;
    environment.IS_REACT_ACT_ENVIRONMENT = true;
    let ops!: UseSftpViewFileOpsResult;
    const params = {
      sftpRef: { current: {
        leftPane: { id: "pane", connection: { id: "conn", hostId: "host" } },
        readTextFile: async () => "original",
      } },
      behaviorRef: { current: "" }, autoSyncRef: { current: false },
      getOpenerForFileRef: { current: () => null }, setOpenerForExtension: () => {},
      t: (key: string) => key,
    } as unknown as UseSftpViewFileOpsParams;
    const original = {
      editorId: "modal-test", sessionId: "conn", sftpTabId: "pane", hostId: "host",
      remotePath: "/file.txt", fileName: "file.txt", languageId: "plaintext",
      content: "window edits", baselineContent: "original", wordWrap: false, viewState: null,
    };
    editorTabStore.upsertFromSnapshot(original, "window");
    const before = editorTabStore.getTab(original.editorId);
    t.after(() => editorTabStore.close(original.editorId));
    let focusCount = 0;
    t.mock.method(netcattyBridge, "get", () => ({
      focusEditorWindow: async () => { focusCount++; return { success: true }; },
    }));
    const errors = t.mock.method(toast, "error", () => {});
    function Harness() { ops = useSftpViewFileOps(params); return null; }
    let renderer!: ReactTestRenderer;
    await act(async () => { renderer = create(React.createElement(Harness)); });
    t.after(async () => {
      await act(async () => renderer.unmount());
      environment.IS_REACT_ACT_ENVIRONMENT = previous;
    });
    await act(async () => {
      await ops.onEditFileLeft({ name: "file.txt", size: 8 } as Parameters<typeof ops.onEditFileLeft>[0], "/./file.txt");
    });
    const modal = { ...original, content: "modal edits" };
    await act(async () => { ops[action](modal); });
    assert.equal(ops.showTextEditor, true);
    assert.equal(ops.textEditorTarget?.fullPath, "/./file.txt");
    assert.equal(ops.textEditorContent, "original");
    assert.equal(modal.content, "modal edits");
    assert.equal(editorTabStore.getTab(original.editorId), before);
    assert.equal(focusCount, 0);
    assert.equal(errors.mock.callCount(), 1);
  });
}
