import test from "node:test";
import assert from "node:assert/strict";

import {
  MAX_VAULT_NOTE_ATTACHMENT_CHARS,
  VAULT_NOTE_ATTACHMENT_MEDIA_TYPE,
  createVaultNoteAttachment,
  decodeVaultNoteAttachment,
  isVaultNoteAttachment,
} from "./vaultNoteAttachment.ts";
import { buildPromptWithTerminalSelectionAttachments } from "./terminalSelectionAttachment.ts";

test("createVaultNoteAttachment returns null without a note id", () => {
  assert.equal(createVaultNoteAttachment({ id: "  ", title: "T", content: "c" }), null);
});

test("createVaultNoteAttachment attaches the note entity with content roundtrip", () => {
  const attachment = createVaultNoteAttachment({
    id: "note-1",
    title: "维护记录",
    content: "# 维护记录\n第一步：检查磁盘。",
  });

  assert.ok(attachment);
  assert.equal(attachment.mediaType, VAULT_NOTE_ATTACHMENT_MEDIA_TYPE);
  assert.equal(attachment.filename, "维护记录.md");
  assert.equal(attachment.vaultNoteId, "note-1");
  assert.equal(attachment.vaultNoteTitle, "维护记录");
  assert.equal(attachment.lineCount, 2);
  assert.equal(decodeVaultNoteAttachment(attachment), "# 维护记录\n第一步：检查磁盘。");
});

test("createVaultNoteAttachment sanitizes unsafe filename characters", () => {
  const attachment = createVaultNoteAttachment({
    id: "note-2",
    title: 'a/b\\c:d*e?f"g<h>i|j',
    content: "body",
  });

  assert.ok(attachment);
  assert.doesNotMatch(attachment.filename, /[/\\<>:"|?*]/);
  assert.ok(attachment.filename.endsWith(".md"));
});

test("createVaultNoteAttachment falls back to a safe filename for blank titles", () => {
  const attachment = createVaultNoteAttachment({ id: "note-3", title: "   ", content: "" });

  assert.ok(attachment);
  assert.equal(attachment.filename, "Untitled note.md");
  assert.equal(attachment.vaultNoteTitle, "Untitled note");
});

test("createVaultNoteAttachment bounds oversized note bodies and keeps the note id addressable", () => {
  const oversized = "a".repeat(MAX_VAULT_NOTE_ATTACHMENT_CHARS + 10_000);
  const attachment = createVaultNoteAttachment({ id: "note-big", title: "Big", content: oversized });

  assert.ok(attachment);
  const decoded = decodeVaultNoteAttachment(attachment) ?? "";
  assert.ok(decoded.length < oversized.length, "oversized body must be truncated");
  assert.ok(decoded.startsWith("a".repeat(MAX_VAULT_NOTE_ATTACHMENT_CHARS)));
  assert.match(decoded, /vault_notes_get with noteId note-big/);

  const prompt = buildPromptWithTerminalSelectionAttachments("summarize", [attachment]);
  assert.match(prompt, /\[Vault Note: Big \(id: note-big\)\]/);
  assert.match(prompt, /vault_notes_get with noteId note-big/);
});

test("createVaultNoteAttachment does not split surrogate pairs at the truncation boundary", () => {
  const content = "a".repeat(MAX_VAULT_NOTE_ATTACHMENT_CHARS - 1) + "😀".repeat(5_000);
  const attachment = createVaultNoteAttachment({ id: "note-emoji", title: "E", content });

  assert.ok(attachment);
  const decoded = decodeVaultNoteAttachment(attachment) ?? "";
  assert.doesNotMatch(decoded, /[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
});

test("isVaultNoteAttachment and decode reject plain attachments", () => {
  const attachment = createVaultNoteAttachment({ id: "note-4", title: "T", content: "c" });
  assert.ok(attachment);
  assert.equal(isVaultNoteAttachment({ vaultNoteId: undefined }), false);
  assert.equal(decodeVaultNoteAttachment({ base64Data: attachment.base64Data, vaultNoteId: undefined }), null);
});

test("buildPromptWithTerminalSelectionAttachments expands note mentions with the note id", () => {
  const attachment = createVaultNoteAttachment({
    id: "note-5",
    title: "Server notes",
    content: "- nginx running\n- disk 80%",
  });

  assert.ok(attachment);
  assert.equal(
    buildPromptWithTerminalSelectionAttachments("总结这条笔记", [attachment]),
    "总结这条笔记\n\n[Vault Note: Server notes (id: note-5)]\n- nginx running\n- disk 80%",
  );
});

test("buildPromptWithTerminalSelectionAttachments supports note-only prompts", () => {
  const attachment = createVaultNoteAttachment({ id: "note-6", title: "Runbook", content: "restart nginx" });

  assert.ok(attachment);
  assert.equal(
    buildPromptWithTerminalSelectionAttachments("", [attachment]),
    "[Vault Note: Runbook (id: note-6)]\nrestart nginx",
  );
});

test("buildPromptWithTerminalSelectionAttachments keeps plain prompts untouched without inline attachments", () => {
  assert.equal(buildPromptWithTerminalSelectionAttachments("hello", []), "hello");
});
