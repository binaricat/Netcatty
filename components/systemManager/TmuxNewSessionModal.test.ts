import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const modalSource = readFileSync(new URL("./TmuxNewSessionModal.tsx", import.meta.url), "utf8");
const editorSource = readFileSync(new URL("../snippets/SnippetScriptEditor.tsx", import.meta.url), "utf8");

test("tmux new session modal is only modestly wider than the default dialog", () => {
  assert.match(modalSource, /w-\[min\(92vw,560px\)\]/);
  assert.match(modalSource, /max-w-none/);
  assert.doesNotMatch(modalSource, /bg-background\/95/);
  assert.doesNotMatch(modalSource, /bg-muted\/10/);
  assert.doesNotMatch(modalSource, /border-b border-border\/60/);
  assert.doesNotMatch(modalSource, /border-t border-border\/60/);
});

test("tmux command editor does not inherit the global snippet editor height", () => {
  assert.match(modalSource, /defaultHeight=\{150\}/);
  assert.match(modalSource, /maxHeight=\{260\}/);
  assert.match(modalSource, /persistHeight=\{false\}/);
  assert.match(editorSource, /persistHeight\?: boolean/);
});
