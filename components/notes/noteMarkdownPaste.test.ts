import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  insertClipboardTextAtActiveLexicalSelection,
  mergeNoteMarkdownDocumentPaste,
  NOTE_MARKDOWN_PASTE_INSERT_MAX_CHARS,
  resolveNoteMarkdownPasteSettleAttempts,
  resolveNoteMarkdownPasteStrategy,
  shouldInterceptNoteMarkdownPaste,
} from "./InlineMarkdownEditor.tsx";

test("markdown paste intercepts structured clipboard text in edit mode even without a Lexical selection", () => {
  assert.equal(
    shouldInterceptNoteMarkdownPaste({
      editorMode: "edit",
      pasteInsideCodeBlock: false,
      clipboardText: "# Heading\n\n- item",
      canInsertMarkdownAtSelection: true,
    }),
    true,
  );
  assert.equal(
    shouldInterceptNoteMarkdownPaste({
      editorMode: "edit",
      pasteInsideCodeBlock: false,
      clipboardText: "# Heading\n\n- item",
      canInsertMarkdownAtSelection: false,
    }),
    true,
  );
  assert.equal(
    shouldInterceptNoteMarkdownPaste({
      editorMode: "preview",
      pasteInsideCodeBlock: false,
      clipboardText: "# Heading\n\n- item",
      canInsertMarkdownAtSelection: true,
    }),
    false,
  );
});

test("document paste merge preserves first-line indentation and appends after current body", () => {
  assert.equal(
    mergeNoteMarkdownDocumentPaste("Existing note", "# Pasted\n\n- item"),
    "Existing note\n\n# Pasted\n\n- item",
  );
  assert.equal(
    mergeNoteMarkdownDocumentPaste("   ", "# Only paste"),
    "# Only paste",
  );
  assert.equal(
    mergeNoteMarkdownDocumentPaste("- parent", "  - child"),
    "- parent\n\n  - child",
  );
  assert.equal(
    mergeNoteMarkdownDocumentPaste("Existing", "\n\n# Pasted\n"),
    "Existing\n\n# Pasted",
  );
});

test("paste strategy preserves caret: long paste with selection still inserts at selection", () => {
  assert.equal(
    resolveNoteMarkdownPasteStrategy({
      canInsertMarkdownAtSelection: false,
      clipboardText: "# short",
    }),
    "document-merge",
  );
  assert.equal(
    resolveNoteMarkdownPasteStrategy({
      canInsertMarkdownAtSelection: true,
      clipboardText: "# short body",
    }),
    "insert-at-selection",
  );
  const longMarkdown = `# Title\n\n${"paragraph text ".repeat(400)}`;
  assert.ok(longMarkdown.length >= NOTE_MARKDOWN_PASTE_INSERT_MAX_CHARS);
  // Long paste must NOT force document-merge when a caret exists (would append at EOF).
  assert.equal(
    resolveNoteMarkdownPasteStrategy({
      canInsertMarkdownAtSelection: true,
      clipboardText: longMarkdown,
    }),
    "insert-at-selection",
  );
});

test("paste settle attempts scale with clipboard size", () => {
  assert.equal(resolveNoteMarkdownPasteSettleAttempts(100), 6);
  assert.equal(resolveNoteMarkdownPasteSettleAttempts(3_000), 6);
  assert.equal(resolveNoteMarkdownPasteSettleAttempts(12_000), 10);
  assert.ok(resolveNoteMarkdownPasteSettleAttempts(100_000) <= 40);
  assert.ok(resolveNoteMarkdownPasteSettleAttempts(100_000) >= 6);
});

test("selection paste recovery helper rejects empty text or missing target", () => {
  assert.equal(insertClipboardTextAtActiveLexicalSelection(null, "# Heading"), false);
  assert.equal(insertClipboardTextAtActiveLexicalSelection(null, ""), false);
});

test("InlineMarkdownEditor only preventDefaults markdown paste after a successful intercept guard", () => {
  const source = readFileSync(new URL("./InlineMarkdownEditor.tsx", import.meta.url), "utf8");

  assert.match(source, /resolveNoteClipboardPaste/);
  assert.match(source, /shouldInterceptResolvedNotePaste/);
  assert.match(source, /hasActiveLexicalTextSelection/);
  assert.match(source, /mergeNoteMarkdownDocumentPaste/);
  assert.match(source, /setMarkdown\(/);
  assert.match(source, /resolveNoteMarkdownPasteStrategy/);
  assert.match(source, /text\/html/);
  assert.match(
    source,
    /shouldInterceptResolvedNotePaste\([\s\S]*?\)[\s\S]*?event\.preventDefault\(\)/,
  );
  assert.match(
    source,
    /if \(\s*!shouldInterceptResolvedNotePaste\([\s\S]*?\)\s*\{\s*return;\s*\}/,
  );
  assert.match(source, /strategy === "document-merge"/);
  assert.match(source, /editor\.insertMarkdown\(markdown\)/);
  assert.match(source, /pasteRecoveryGenerationRef/);
  assert.match(source, /tryCommitSettledPaste/);
  assert.match(source, /editor\.getMarkdown\(\)/);
  // With caret: settle failure must not blindly append (emptyDoc gate).
  assert.match(source, /if \(emptyDoc\) applyDocumentPaste\(\)/);
  assert.match(
    source,
    /const currentMarkdown = editor\.getMarkdown\(\);[\s\S]*mergeNoteMarkdownDocumentPaste\(currentMarkdown, markdown\)/,
  );
  // Do not re-queue insertMarkdown at the settle midpoint (double-insert risk).
  assert.doesNotMatch(
    source,
    /attempt === Math\.floor\(maxAttempts \/ 2\)/,
  );
  // Non-empty settle failure must recover at the selection, not discard after preventDefault.
  assert.match(source, /recoverInterceptedPasteAtSelection/);
  assert.match(
    source,
    /if \(attempt >= maxAttempts\)[\s\S]*emptyDoc[\s\S]*applyDocumentPaste[\s\S]*recoverInterceptedPasteAtSelection/,
  );
});
