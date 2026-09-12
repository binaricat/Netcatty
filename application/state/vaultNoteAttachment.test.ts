import assert from "node:assert/strict";
import test from "node:test";
import { createVaultNoteAttachment, formatVaultNoteReferences, vaultNoteReferencesFit } from "./vaultNoteAttachment.ts";
import { buildPromptWithTerminalSelectionAttachments, createTerminalSelectionAttachment, isInlineTextAttachment } from "./terminalSelectionAttachment.ts";

test("mentions carry identity without copying even large note bodies", () => {
  const note = { id: "note-1", title: "Runbook", content: "secret body".repeat(200_000) };
  const attachment = createVaultNoteAttachment(note)!;
  assert.equal(attachment.vaultNoteId, note.id);
  assert.equal(attachment.base64Data, "");
  assert.equal(attachment.dataUrl, "");
  assert.ok(JSON.stringify(attachment).length < 400);
  assert.ok(isInlineTextAttachment(attachment));
  const prompt = buildPromptWithTerminalSelectionAttachments("summarize", [attachment]);
  assert.match(prompt, /vault_notes_get/);
  assert.match(prompt, /latest content/);
  assert.doesNotMatch(prompt, /secret body/);
});

test("same titled notes keep distinct exact IDs including imported special characters", () => {
  for (const id of ["note-a", "note-b", ' quoted"\\id\r\n ']) {
    const attachment = createVaultNoteAttachment({ id, title: "Same title" })!;
    const reference = formatVaultNoteReferences([attachment]).split("\n")[0];
    const [metadata] = JSON.parse(reference.slice("[Vault note references: ".length, -1));
    assert.equal(metadata.noteId, id);
    assert.equal(metadata.title, "Same title");
  }
});

test("invalid IDs are rejected and displayed titles remain bounded without broken emoji", () => {
  assert.equal(createVaultNoteAttachment({ id: "  ", title: "x" }), null);
  assert.equal(createVaultNoteAttachment({ id: "a".repeat(201), title: "x" }), null);
  const attachment = createVaultNoteAttachment({ id: "ok", title: "😀".repeat(200) })!;
  assert.equal(Array.from(attachment.vaultNoteTitle!).length, 120);
});

test("note-only sends and mixed terminal selections retain both kinds of context", () => {
  const note = createVaultNoteAttachment({ id: "empty-note", title: "" })!;
  const terminal = createTerminalSelectionAttachment("systemctl status nginx")!;
  assert.match(buildPromptWithTerminalSelectionAttachments("", [note]), /empty-note/);
  const prompt = buildPromptWithTerminalSelectionAttachments("compare", [note, terminal]);
  assert.match(prompt, /systemctl status nginx/);
  assert.match(prompt, /empty-note/);
  assert.match(prompt, /^compare/);
});

test("reference limit reserves replay space and does not count ordinary files", () => {
  const notes = Array.from({length: 10}, (_, i) => createVaultNoteAttachment({id: String(i).padEnd(200, "x"), title: "t".repeat(120)})!);
  assert.equal(vaultNoteReferencesFit(notes), false);
  const accepted = notes.filter((_, index) => vaultNoteReferencesFit(notes.slice(0, index + 1)));
  assert.ok(accepted.length > 0);
  assert.ok(formatVaultNoteReferences(accepted).length <= 1000);
  assert.equal(vaultNoteReferencesFit([...accepted, {id: "file", filename: "file", mediaType: "text/plain", dataUrl: "", base64Data: "x".repeat(2_000_000)}]), true);
});
