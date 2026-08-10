import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const previewSource = readFileSync(new URL("./NoteMarkdownPreview.tsx", import.meta.url), "utf8");
const editorSource = readFileSync(new URL("./InlineMarkdownEditor.tsx", import.meta.url), "utf8");

test("note preview uses GitHub-style react-markdown stack, not Streamdown", () => {
  assert.match(previewSource, /from "react-markdown"/);
  assert.match(previewSource, /remark-gfm/);
  assert.match(previewSource, /rehype-raw/);
  assert.match(previewSource, /rehype-sanitize/);
  assert.match(previewSource, /github-markdown-css/);
  assert.match(previewSource, /markdown-body/);
  assert.match(previewSource, /data-note-preview-engine="github-markdown"/);
  assert.match(previewSource, /prepareNoteMarkdownForGithubPreview/);
  assert.match(previewSource, /NOTE_GITHUB_PREVIEW_SANITIZE_SCHEMA/);
  assert.doesNotMatch(previewSource, /from ["']streamdown["']/);
  assert.doesNotMatch(previewSource, /from ["']@mdxeditor\/editor["']/);
});

test("InlineMarkdownEditor mounts GitHub preview only in preview mode", () => {
  assert.match(editorSource, /lazy\(\(\) =>\s*\n\s*import\("\.\/NoteMarkdownPreview"\)/);
  assert.match(editorSource, /editorMode === "preview"/);
  assert.match(editorSource, /<NoteMarkdownPreview markdown=\{value\}/);
  assert.match(editorSource, /<MDXEditor/);
  assert.doesNotMatch(editorSource, /readOnly=\{editorMode === "preview"\}/);
  assert.doesNotMatch(editorSource, /key=\{editorMode\}/);
});
