/**
 * Smoke: UI re-export surface stays wired to domain paste policy.
 * Full policy coverage lives in domain/notes/clipboardPaste.test.ts.
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  convertClipboardHtmlToMarkdown,
  resolveNoteClipboardPaste,
  shouldInsertClipboardTextAsMarkdown,
} from "./noteClipboardPaste.ts";

test("noteClipboardPaste re-exports domain resolve + convert helpers", () => {
  assert.equal(shouldInsertClipboardTextAsMarkdown("# Title\n\n- item"), true);
  assert.equal(shouldInsertClipboardTextAsMarkdown("plain only"), false);

  const payload = resolveNoteClipboardPaste({
    plainText: "# From re-export\n\n- a",
    htmlText: "",
  });
  assert.equal(payload.kind, "markdown");
  assert.match(payload.text, /# From re-export/);

  const md = convertClipboardHtmlToMarkdown(
    "<html><body><!--StartFragment--><h1>Hi</h1><!--EndFragment--></body></html>",
  );
  assert.match(md, /^# Hi/m);
});
