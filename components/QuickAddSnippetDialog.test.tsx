import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { getQuickAddSnippetInitialCommand } from "./QuickAddSnippetDialog.tsx";

const source = readFileSync(new URL("./QuickAddSnippetDialog.tsx", import.meta.url), "utf8");

test("quick add snippet event can prefill command", () => {
  const event = {
    detail: { command: "ls -la\npwd" },
  } as CustomEvent<{ command?: string }>;

  assert.equal(getQuickAddSnippetInitialCommand(event), "ls -la\npwd");
});

test("quick add snippet event defaults to an empty command", () => {
  assert.equal(getQuickAddSnippetInitialCommand({} as Event), "");
  assert.equal(
    getQuickAddSnippetInitialCommand({
      detail: { command: 123 },
    } as unknown as Event),
    "",
  );
});

test("quick add snippet form binds shortkeys and uses a centered Dialog modal", () => {
  assert.match(source, /DialogContent/);
  assert.match(source, /from '\.\/ui\/dialog'/);
  assert.doesNotMatch(source, /AsidePanel/);
  assert.match(source, /snippets\.field\.shortkey/);
  assert.match(source, /keyEventToString/);
  assert.match(source, /shortkey: shortkey \|\| undefined/);
  assert.match(source, /if \(e\.defaultPrevented\) return/);
  // Escape while recording a shortkey cancels capture instead of closing
  assert.match(source, /onEscapeKeyDown/);
  assert.match(source, /isRecordingShortkey/);
  // Pointer dismissals must close even while recording (no stale-recording gate)
  assert.doesNotMatch(
    source,
    /if\s*\(\s*isRecordingShortkey\s*\)\s*\{\s*setIsRecordingShortkey\(false\);\s*setShortkeyError\(null\);\s*return;/,
  );
});

test("shared Dialog exposes data-dialog-close for Cmd+W / hasOpenAppDialog", () => {
  const dialogSource = readFileSync(new URL("./ui/dialog.tsx", import.meta.url), "utf8");
  assert.match(dialogSource, /data-dialog-close="true"/);
});
