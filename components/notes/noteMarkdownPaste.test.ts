import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  mergeNoteMarkdownDocumentPaste,
  noteMarkdownClipboardToPlainText,
  shouldInterceptNoteMarkdownPaste,
  shouldRecoverNoteMarkdownPasteAfterUnchangedInsert,
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
  // After a prior insertMarkdown clears the caret, continuous paste must still
  // be recoverable via document setMarkdown rather than a swallowed preventDefault.
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

test("document markdown paste merge appends when recovering without a selection", () => {
  assert.equal(
    mergeNoteMarkdownDocumentPaste("Existing note", "# Pasted\n\n- item"),
    "Existing note\n\n# Pasted\n\n- item",
  );
  assert.equal(
    mergeNoteMarkdownDocumentPaste("   ", "# Only paste"),
    "# Only paste",
  );
});

test("document markdown paste merge preserves leading indentation on the first content line", () => {
  assert.equal(
    mergeNoteMarkdownDocumentPaste("- parent", "  - child"),
    "- parent\n\n  - child",
  );
  assert.equal(
    mergeNoteMarkdownDocumentPaste("- parent", "\n\n  - child\n"),
    "- parent\n\n  - child",
  );
  // Blank lines that only contain spaces are stripped; content indent is kept.
  assert.equal(
    mergeNoteMarkdownDocumentPaste("- parent", "  \n\t\n  - child"),
    "- parent\n\n  - child",
  );
});

test("clipboard markdown plain-text approx matches Lexical selection text", () => {
  assert.equal(noteMarkdownClipboardToPlainText("**Hello**"), "Hello");
  assert.equal(noteMarkdownClipboardToPlainText("[docs](https://example.com)"), "docs");
  assert.equal(noteMarkdownClipboardToPlainText("- item"), "item");
});

test("unchanged insert recovery skips identical replacements but recovers lost-selection no-ops", () => {
  assert.equal(
    shouldRecoverNoteMarkdownPasteAfterUnchangedInsert({
      beforeMarkdown: "# Note\n\nHello",
      clipboardText: "# Note\n\nHello",
      selectedText: "Note\n\nHello",
    }),
    false,
  );
  // Structured markdown that would pass shouldInsertClipboardTextAsMarkdown:
  // selecting rendered bold "Hello" and pasting **Hello** must not append.
  assert.equal(
    shouldRecoverNoteMarkdownPasteAfterUnchangedInsert({
      beforeMarkdown: "# Note\n\n**Hello** world",
      clipboardText: "**Hello**",
      selectedText: "Hello",
    }),
    false,
  );
  assert.equal(
    shouldRecoverNoteMarkdownPasteAfterUnchangedInsert({
      beforeMarkdown: "# Note\n\nHello",
      clipboardText: "**Goodbye**",
      selectedText: "Hello",
    }),
    true,
  );
  assert.equal(
    shouldRecoverNoteMarkdownPasteAfterUnchangedInsert({
      beforeMarkdown: "# Note\n\nHello",
      clipboardText: "- item",
      selectedText: "",
    }),
    true,
  );
});

test("InlineMarkdownEditor only preventDefaults markdown paste after a successful intercept guard", () => {
  const source = readFileSync(new URL("./InlineMarkdownEditor.tsx", import.meta.url), "utf8");

  assert.match(source, /shouldInterceptNoteMarkdownPaste/);
  assert.match(source, /hasActiveLexicalTextSelection/);
  assert.match(source, /mergeNoteMarkdownDocumentPaste/);
  assert.match(source, /shouldRecoverNoteMarkdownPasteAfterUnchangedInsert/);
  assert.match(source, /setMarkdown\(/);
  assert.match(
    source,
    /shouldInterceptNoteMarkdownPaste\([\s\S]*?\)[\s\S]*?event\.preventDefault\(\)/,
  );
  assert.match(
    source,
    /if \(\s*!shouldInterceptNoteMarkdownPaste\([\s\S]*?\)\s*\{\s*return;\s*\}/,
  );
  // Document merge is reserved for missing selection / insert no-op recovery —
  // never forced solely by clipboard length while a selection exists.
  assert.doesNotMatch(source, /shouldUseDocumentNoteMarkdownPaste/);
  assert.match(
    source,
    /if\s*\(\s*!canInsertAtSelection\s*\)\s*\{\s*(?:\/\/[^\n]*\n\s*)*applyDocumentPaste\(\)/,
  );
});
