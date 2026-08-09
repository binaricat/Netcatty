import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("useNoteMarkdownPaste owns paste intercept and recovery orchestration", () => {
  const source = readFileSync(new URL("./useNoteMarkdownPaste.ts", import.meta.url), "utf8");

  assert.match(source, /shouldInterceptNoteMarkdownPaste/);
  assert.match(
    source,
    /pasteInsideLexicalContentSurface:\s*adapters\.isPasteInsideLexicalContentSurface\(\s*event\.target\s*,?\s*\)/,
  );
  assert.match(
    source,
    /if \(\s*!shouldInterceptNoteMarkdownPaste\([\s\S]*?\)\s*\{\s*return;\s*\}/,
  );
  assert.match(
    source,
    /shouldInterceptNoteMarkdownPaste\([\s\S]*?\)[\s\S]*?event\.preventDefault\(\)/,
  );
  assert.match(source, /mergeNoteMarkdownDocumentPaste/);
  assert.match(source, /shouldRecoverNoteMarkdownPasteAfterUnchangedInsert/);
  assert.match(source, /didNoteMarkdownPasteApply/);
  assert.match(source, /editor\.setMarkdown\(next\)/);
  assert.match(source, /editor\.insertMarkdown\(markdown\)/);
  // Root focus steals nested Lexical editors (table cells) before insertMarkdown.
  assert.doesNotMatch(source, /editor\.focus\(\)/);
  assert.match(
    source,
    /if\s*\(\s*!canInsertAtSelection\s*\)\s*\{\s*(?:\/\/[^\n]*\n\s*)*applyDocumentPaste\(\)/,
  );
  // Concurrent draft changes must not short-circuit recovery by themselves.
  assert.doesNotMatch(
    source,
    /if\s*\(\s*getLatestMarkdown\(\)\s*!==\s*before\s*\)\s*return/,
  );
  // Recovery after a no-op insert must merge from the editor snapshot when it
  // diverged (typed during rAF) so a lagging draft ref cannot wipe that input.
  assert.match(
    source,
    /applyDocumentPaste\(\s*editorMarkdown\s*!==\s*before\s*\?\s*editorMarkdown\s*:\s*undefined\s*,?\s*\)/,
  );
  assert.doesNotMatch(source, /shouldUseDocumentNoteMarkdownPaste/);
});
