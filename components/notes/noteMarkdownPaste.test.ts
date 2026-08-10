import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  mergeNoteMarkdownDocumentPaste,
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

test("InlineMarkdownEditor only preventDefaults markdown paste after a successful intercept guard", () => {
  const source = readFileSync(new URL("./InlineMarkdownEditor.tsx", import.meta.url), "utf8");

  assert.match(source, /shouldInterceptNoteMarkdownPaste/);
  assert.match(source, /hasActiveLexicalTextSelection/);
  assert.match(source, /mergeNoteMarkdownDocumentPaste/);
  assert.match(source, /setMarkdown\(/);
  assert.match(source, /canInsertAtSelection/);
  assert.match(
    source,
    /shouldInterceptNoteMarkdownPaste\([\s\S]*?\)[\s\S]*?event\.preventDefault\(\)/,
  );
  assert.match(
    source,
    /if \(\s*!shouldInterceptNoteMarkdownPaste\([\s\S]*?\)\s*\{\s*return;\s*\}/,
  );
  // Live selection must keep insertMarkdown; document merge is the no-selection path only.
  assert.match(source, /if\s*\(\s*!canInsertAtSelection\s*\)\s*\{\s*applyDocumentPaste\(\);/);
  assert.match(source, /editor\.insertMarkdown\(markdown\)/);
  assert.match(source, /pasteRecoveryGenerationRef/);
  assert.match(source, /tryCommitSettledPaste/);
  assert.match(source, /editor\.getMarkdown\(\)/);
  // Selection-path recovery must not re-enter applyDocumentPaste (duplicate / stale-note risk).
  assert.doesNotMatch(
    source,
    /insertMarkdown\(markdown\);[\s\S]*applyDocumentPaste\(\)/,
  );
  // Document merge must read live editor markdown, not only the possibly-stale ref.
  assert.match(
    source,
    /const currentMarkdown = editor\.getMarkdown\(\);[\s\S]*mergeNoteMarkdownDocumentPaste\(currentMarkdown, markdown\)/,
  );
});
