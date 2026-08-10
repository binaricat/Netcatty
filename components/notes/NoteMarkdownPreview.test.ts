import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const previewSource = readFileSync(new URL("./NoteMarkdownPreview.tsx", import.meta.url), "utf8");
const editorSource = readFileSync(new URL("./InlineMarkdownEditor.tsx", import.meta.url), "utf8");

test("note preview is a static Streamdown path without MDXEditor", () => {
  assert.match(previewSource, /from "streamdown"/);
  assert.match(previewSource, /mode="static"/);
  assert.match(previewSource, /linkSafety=\{\{\s*enabled:\s*false\s*\}\}/);
  assert.match(previewSource, /normalizeHtmlIndentation/);
  assert.match(previewSource, /allowedTags/);
  assert.match(previewSource, /annotateNoteImageSizes/);
  assert.match(previewSource, /prepareNoteMarkdownForStreamdownPreview/);
  assert.doesNotMatch(previewSource, /from ["']@mdxeditor\/editor["']|from ["']lexical["']/);
  assert.doesNotMatch(previewSource, /<MDXEditor\b/);
});

test("InlineMarkdownEditor mounts Streamdown only in preview mode", () => {
  assert.match(editorSource, /lazy\(\(\) =>\s*\n\s*import\("\.\/NoteMarkdownPreview"\)/);
  assert.match(editorSource, /editorMode === "preview"/);
  assert.match(editorSource, /<NoteMarkdownPreview markdown=\{value\}/);
  // Edit path keeps MDX; preview does not pass readOnly dual-mode.
  assert.match(editorSource, /<MDXEditor/);
  assert.doesNotMatch(editorSource, /readOnly=\{editorMode === "preview"\}/);
  assert.doesNotMatch(editorSource, /key=\{editorMode\}/);
});
