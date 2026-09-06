import test from "node:test";
import assert from "node:assert/strict";

import {
  MAX_VAULT_NOTE_ATTACHMENT_CHARS,
  MAX_VAULT_NOTE_ID_CHARS,
  MAX_VAULT_NOTE_TOTAL_ATTACHMENT_BYTES,
  VAULT_NOTE_ATTACHMENT_MEDIA_TYPE,
  attachVaultNoteMention,
  createVaultNoteAttachment,
  decodeVaultNoteAttachment,
  isVaultNoteAttachment,
} from "./vaultNoteAttachment.ts";
import { buildPromptWithTerminalSelectionAttachments } from "./terminalSelectionAttachment.ts";

test("createVaultNoteAttachment returns null without a note id", () => {
  assert.equal(createVaultNoteAttachment({ id: "  ", title: "T", content: "c" }), null);
});

test("createVaultNoteAttachment preserves a note id with surrounding whitespace", () => {
  // `sanitizeVaultNote` keeps imported/synced ids verbatim and the Vault
  // agent bridge resolves notes by exact id equality, so the attachment must
  // carry the original id (trim only for validation).
  const attachment = createVaultNoteAttachment({ id: " note-ws ", title: "T", content: "abc".repeat(70_001) });

  assert.ok(attachment);
  assert.equal(attachment.vaultNoteId, " note-ws ");
  const decoded = decodeVaultNoteAttachment(attachment) ?? "";
  assert.match(decoded, /noteId {2}note-ws /);

  const prompt = buildPromptWithTerminalSelectionAttachments("summarize", [attachment]);
  assert.match(prompt, /\[Vault Note: T \(id: {2}note-ws \)\]/);
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

test("attachVaultNoteMention attaches a new note within the aggregate budget", () => {
  const result = attachVaultNoteMention([], { id: "note-a", title: "A", content: "hello" });

  assert.equal(result.status, "attached");
  assert.ok(result.upload);
  assert.equal(result.upload.vaultNoteId, "note-a");
});

test("attachVaultNoteMention reports a duplicate for an already mentioned note and still produces a fresh upload", () => {
  const first = attachVaultNoteMention([], { id: "note-a", title: "A", content: "v1" });
  assert.ok(first.upload);

  const second = attachVaultNoteMention([first.upload], { id: "note-a", title: "A", content: "v2" });

  assert.equal(second.status, "duplicate");
  assert.ok(second.upload);
  assert.equal(decodeVaultNoteAttachment(second.upload), "v2");
});

test("attachVaultNoteMention rejects a note that would exceed the aggregate budget", () => {
  // Each note fits the per-note char cap, but a fifth pushes the aggregate
  // decoded payload past MAX_VAULT_NOTE_TOTAL_ATTACHMENT_BYTES.
  const noteBody = "a".repeat(Math.floor(MAX_VAULT_NOTE_TOTAL_ATTACHMENT_BYTES / 4) - 1000);
  assert.ok(noteBody.length <= MAX_VAULT_NOTE_ATTACHMENT_CHARS);
  let attachments: ReturnType<typeof createVaultNoteAttachment>[] = [];
  for (const id of ["n1", "n2", "n3", "n4"]) {
    const result = attachVaultNoteMention(attachments, { id, title: id, content: noteBody });
    assert.equal(result.status, "attached", `note ${id} should fit`);
    attachments = [...attachments, result.upload!];
  }

  const overflow = attachVaultNoteMention(
    attachments,
    { id: "n5", title: "n5", content: noteBody },
  );
  assert.equal(overflow.status, "budget");
  assert.equal(overflow.upload, null);
});

test("attachVaultNoteMention counts emoji-heavy notes by byte size, not character count", () => {
  // 100_000 emoji characters = 400_000 UTF-8 bytes; two of them would exceed
  // the 768 KiB aggregate budget even though each fits the per-note char cap.
  const emojiBody = "😀".repeat(100_000);
  const first = attachVaultNoteMention([], { id: "e1", title: "E", content: emojiBody });
  assert.equal(first.status, "attached");
  assert.ok(first.upload);

  const second = attachVaultNoteMention([first.upload], { id: "e2", title: "E", content: emojiBody });
  assert.equal(second.status, "budget");
  assert.equal(second.upload, null);

  const duplicate = attachVaultNoteMention([first.upload], { id: "e1", title: "E", content: emojiBody });
  assert.equal(duplicate.status, "duplicate");
});

test("attachVaultNoteMention applies the budget when refreshing a duplicate that grew", () => {
  // Fill most of the budget with other notes, then try to refresh a small
  // mention into one that fills the per-note char cap.
  const fillerBody = "a".repeat(Math.floor(MAX_VAULT_NOTE_TOTAL_ATTACHMENT_BYTES / 4));
  let attachments: ReturnType<typeof createVaultNoteAttachment>[] = [];
  for (const id of ["f1", "f2", "f3"]) {
    const filler = attachVaultNoteMention(attachments, { id, title: id, content: fillerBody });
    assert.equal(filler.status, "attached");
    attachments = [...attachments, filler.upload!];
  }
  const small = attachVaultNoteMention(attachments, { id: "g1", title: "G", content: "tiny" });
  assert.equal(small.status, "attached");
  assert.ok(small.upload);
  attachments = [...attachments, small.upload!];

  const grown = attachVaultNoteMention(
    attachments,
    { id: "g1", title: "G", content: "a".repeat(MAX_VAULT_NOTE_ATTACHMENT_CHARS) },
  );
  assert.equal(grown.status, "budget");
  assert.equal(grown.upload, null);
});

test("attachVaultNoteMention counts non-vault attachments toward the budget", () => {
  // Ordinary files are persisted with the same `base64Data`/`dataUrl` shape
  // as note attachments, so their payload must consume the same budget.
  const plain = {
    id: crypto.randomUUID(),
    filename: "image.png",
    dataUrl: "data:image/png;base64,AAAA",
    base64Data: "A".repeat(4 * 1024 * 1024), // far above the budget
    mediaType: "image/png",
  };
  const blocked = attachVaultNoteMention([plain], { id: "note-x", title: "X", content: "body" });

  assert.equal(blocked.status, "budget");
  assert.equal(blocked.upload, null);

  const small = { ...plain, base64Data: "AAAA", dataUrl: "data:image/png;base64,AAAA" };
  const result = attachVaultNoteMention([small], { id: "note-x", title: "X", content: "body" });

  assert.equal(result.status, "attached");
  assert.ok(result.upload);
});

test("attachVaultNoteMention rejects notes without an id", () => {
  const result = attachVaultNoteMention([], { id: "  ", title: "T", content: "c" });

  assert.equal(result.status, "invalid");
  assert.equal(result.upload, null);
});

test("createVaultNoteAttachment rejects unreasonably long note ids", () => {
  // A multi-megabyte id is persisted verbatim in `vaultNoteId` and could push
  // the newest session past its storage budget on its own.
  const result = attachVaultNoteMention([], {
    id: "id-" + "a".repeat(2 * 1024 * 1024),
    title: "T",
    content: "c",
  });

  assert.equal(result.status, "invalid");
  assert.equal(result.upload, null);
  assert.equal(createVaultNoteAttachment({ id: "a".repeat(MAX_VAULT_NOTE_ID_CHARS + 1), title: "T", content: "c" }), null);
  assert.ok(createVaultNoteAttachment({ id: "a".repeat(MAX_VAULT_NOTE_ID_CHARS), title: "T", content: "c" }));
});

test("createVaultNoteAttachment rejects ids outside the prompt-header grammar", () => {
  // An embedded newline splits the single-line `[Vault Note: ...]` header
  // across lines, so `boundPromptForExternalSdk` could never match or
  // restore it.
  assert.equal(createVaultNoteAttachment({ id: "note\nmulti", title: "T", content: "c" }), null);
});

test("createVaultNoteAttachment flattens newlines in note titles", () => {
  const result = createVaultNoteAttachment({ id: "note-1", title: "Multi\nline\r\ntitle", content: "c" });

  assert.ok(result);
  assert.equal(result!.vaultNoteTitle, "Multi line title");
});

test("attachVaultNoteMention counts the persisted note id toward the aggregate budget", () => {
  // A long (but accepted) id adds persisted bytes beyond the decoded body;
  // three of these must trip the budget instead of silently passing.
  const longId = "i".repeat(MAX_VAULT_NOTE_ID_CHARS);
  const noteBody = "a".repeat(Math.floor(MAX_VAULT_NOTE_TOTAL_ATTACHMENT_BYTES / 4) - 100);
  assert.ok(noteBody.length <= MAX_VAULT_NOTE_ATTACHMENT_CHARS);
  let attachments: ReturnType<typeof createVaultNoteAttachment>[] = [];
  for (const [index, suffix] of ["a", "b", "c"].entries()) {
    const id = longId.slice(0, MAX_VAULT_NOTE_ID_CHARS - 1) + suffix;
    const result = attachVaultNoteMention(attachments, { id, title: suffix, content: noteBody });
    assert.equal(result.status, "attached", `note ${index} should fit`);
    attachments = [...attachments, result.upload!];
  }

  const overflow = attachVaultNoteMention(
    attachments,
    { id: longId, title: "x4", content: noteBody },
  );
  assert.equal(overflow.status, "budget");
  assert.equal(overflow.upload, null);
});
