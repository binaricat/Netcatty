import test from "node:test";
import assert from "node:assert/strict";

import { createTextEditorModalSnapshot } from "./TextEditorModal.tsx";
import { createTextEditorSaveCoordinator } from "../application/state/textEditorSaveCoordinator.ts";

test("promotion snapshot uses the latest saved baseline after a save", async () => {
  let baselineContent = "old";
  let content = "saved";
  const coordinator = createTextEditorSaveCoordinator({
    onSave: async () => {},
    onSaveSuccess: (savedContent) => {
      baselineContent = savedContent;
    },
  });

  await coordinator.save(content);

  const snapshot = createTextEditorModalSnapshot({
    fileName: "file.txt",
    getBaselineContent: () => baselineContent,
    getContent: () => content,
    languageId: "plaintext",
    wordWrap: false,
    getViewState: () => null,
    isSaving: () => false,
  });

  assert.equal(snapshot?.baselineContent, "saved");
  assert.equal(snapshot?.content, "saved");
});

test("promotion snapshot is blocked while saving", () => {
  const snapshot = createTextEditorModalSnapshot({
    fileName: "file.txt",
    getBaselineContent: () => "old",
    getContent: () => "new",
    languageId: "plaintext",
    wordWrap: false,
    getViewState: () => null,
    isSaving: () => true,
  });

  assert.equal(snapshot, null);
});
