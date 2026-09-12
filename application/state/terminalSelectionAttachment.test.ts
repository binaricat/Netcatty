import test from "node:test";
import assert from "node:assert/strict";

import {
  TERMINAL_SELECTION_ATTACHMENT_MEDIA_TYPE,
  buildPromptWithTerminalSelectionAttachments,
  createTerminalSelectionAttachment,
  decodeTerminalSelectionAttachment,
} from "./terminalSelectionAttachment.ts";
import { createVaultNoteAttachment, formatVaultNoteReferences } from "./vaultNoteAttachment.ts";

test("createTerminalSelectionAttachment returns null for blank selections", () => {
  assert.equal(createTerminalSelectionAttachment("   \n\t"), null);
});

test("createTerminalSelectionAttachment creates a compact terminal log attachment", () => {
  const attachment = createTerminalSelectionAttachment("line one\nline two");

  assert.ok(attachment);
  assert.equal(attachment.mediaType, TERMINAL_SELECTION_ATTACHMENT_MEDIA_TYPE);
  assert.match(attachment.filename, /^terminal-selection-\d{4}-\d{2}-\d{2}-\d{2}-\d{2}-\d{2}\.log$/);
  assert.equal(attachment.terminalSelection, true);
  assert.equal(attachment.previewText, "line one");
  assert.equal(attachment.lineCount, 2);
  assert.equal(decodeTerminalSelectionAttachment(attachment), "line one\nline two");
});

test("createTerminalSelectionAttachment preserves utf-8 terminal output", () => {
  const attachment = createTerminalSelectionAttachment("错误: 权限不足\n路径: /tmp/测试");

  assert.ok(attachment);
  assert.equal(decodeTerminalSelectionAttachment(attachment), "错误: 权限不足\n路径: /tmp/测试");
});

test("buildPromptWithTerminalSelectionAttachments expands terminal selections into prompt text", () => {
  const attachment = createTerminalSelectionAttachment("docker ps -a\npermission denied");

  assert.ok(attachment);
  assert.equal(
    buildPromptWithTerminalSelectionAttachments("帮我看看", [attachment]),
    `帮我看看\n\n[Terminal selection: ${attachment.filename}]\ndocker ps -a\npermission denied`,
  );
});

test("buildPromptWithTerminalSelectionAttachments supports terminal-only prompts", () => {
  const attachment = createTerminalSelectionAttachment("systemctl status nginx");

  assert.ok(attachment);
  assert.equal(
    buildPromptWithTerminalSelectionAttachments("", [attachment]),
    `[Terminal selection: ${attachment.filename}]\nsystemctl status nginx`,
  );
});

test("buildPromptWithTerminalSelectionAttachments keeps empty Vault note blocks", () => {
  const attachment = createVaultNoteAttachment({ id: "note-1", title: "Runbook" });

  assert.ok(attachment);
  assert.equal(
    buildPromptWithTerminalSelectionAttachments("add deployment steps to this note", [attachment]),
    `add deployment steps to this note\n\n${formatVaultNoteReferences([attachment])}`,
  );
});
