import assert from "node:assert/strict";
import test from "node:test";

import {
  flattenSnippetCommandPreview,
  formatSnippetCommandTooltip,
} from "./snippetPreview.ts";

test("formatSnippetCommandTooltip truncates long single-line commands with ellipsis", () => {
  const command = "a".repeat(400);
  const preview = formatSnippetCommandTooltip(command, { maxChars: 120, maxLines: 4 });
  assert.equal(preview.endsWith("…"), true);
  assert.ok(preview.length <= 121);
});

test("formatSnippetCommandTooltip truncates multi-line commands", () => {
  const command = Array.from({ length: 12 }, (_, index) => `line-${index}`).join("\n");
  const preview = formatSnippetCommandTooltip(command, { maxChars: 280, maxLines: 4 });
  assert.match(preview, /^line-0\nline-1\nline-2\nline-3…$/);
});

test("flattenSnippetCommandPreview collapses whitespace", () => {
  assert.equal(flattenSnippetCommandPreview("whoami\n  id -u"), "whoami id -u");
});
