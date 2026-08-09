import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("InlineMarkdownEditor paste handler stays view glue over domain + application layers", () => {
  const editorSource = readFileSync(new URL("./InlineMarkdownEditor.tsx", import.meta.url), "utf8");
  const hookSource = readFileSync(
    new URL("../../application/state/useNoteMarkdownPaste.ts", import.meta.url),
    "utf8",
  );
  const domainSource = readFileSync(
    new URL("../../domain/noteMarkdownPaste.ts", import.meta.url),
    "utf8",
  );
  const lexicalSource = readFileSync(
    new URL("./noteMarkdownPasteLexical.ts", import.meta.url),
    "utf8",
  );

  assert.match(editorSource, /useNoteMarkdownPaste/);
  assert.match(editorSource, /from "\.\/noteMarkdownPasteLexical"/);
  assert.match(editorSource, /from "\.\.\/\.\.\/domain\/noteMarkdownPaste"/);
  assert.match(editorSource, /onPasteCapture=\{handlePasteCapture\}/);
  // Pure markdown/selection logic must not live in the presentation component.
  assert.doesNotMatch(editorSource, /serializeLexicalSelectionAsMarkdown/);
  assert.doesNotMatch(editorSource, /shouldRecoverNoteMarkdownPasteAfterUnchangedInsert/);
  assert.doesNotMatch(editorSource, /mergeNoteMarkdownDocumentPaste/);
  assert.doesNotMatch(editorSource, /doesSelectionEncompassLexicalBlock/);

  assert.match(domainSource, /export const serializeLexicalSelectionAsMarkdown/);
  assert.match(domainSource, /export const mergeNoteMarkdownDocumentPaste/);
  assert.match(domainSource, /export const shouldRecoverNoteMarkdownPasteAfterUnchangedInsert/);
  assert.match(domainSource, /export const doesSelectionEncompassLexicalBlock/);
  assert.match(domainSource, /getChecked/);
  assert.match(
    domainSource,
    /if\s*\(\s*!input\.pasteInsideLexicalContentSurface\s*\)\s*return\s*false/,
  );

  assert.match(hookSource, /shouldInterceptNoteMarkdownPaste/);
  assert.match(hookSource, /mergeNoteMarkdownDocumentPaste/);
  assert.match(hookSource, /shouldRecoverNoteMarkdownPasteAfterUnchangedInsert/);
  assert.match(hookSource, /event\.preventDefault\(\)/);
  assert.match(
    hookSource,
    /if\s*\(\s*!canInsertAtSelection\s*\)\s*\{\s*(?:\/\/[^\n]*\n\s*)*applyDocumentPaste\(\)/,
  );
  assert.doesNotMatch(hookSource, /shouldUseDocumentNoteMarkdownPaste/);
  assert.doesNotMatch(hookSource, /from ["']lexical["']/);
  assert.doesNotMatch(hookSource, /@mdxeditor\/editor/);

  assert.match(lexicalSource, /isNotePasteInsideLexicalContentSurface/);
  assert.match(lexicalSource, /hasActiveLexicalTextSelection/);
  assert.match(lexicalSource, /getActiveLexicalPasteSelection/);
  assert.match(lexicalSource, /serializeLexicalSelectionAsMarkdown/);
});
