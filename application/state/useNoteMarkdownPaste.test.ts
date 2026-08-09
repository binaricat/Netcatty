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
  assert.match(
    source,
    /if\s*\(\s*!canInsertAtSelection\s*\)\s*\{\s*(?:\/\/[^\n]*\n\s*)*applyDocumentPaste\(\)/,
  );
  // Concurrent draft changes must not short-circuit recovery by themselves.
  assert.doesNotMatch(
    source,
    /if\s*\(\s*getLatestMarkdown\(\)\s*!==\s*before\s*\)\s*return/,
  );
  assert.doesNotMatch(source, /shouldUseDocumentNoteMarkdownPaste/);
});
