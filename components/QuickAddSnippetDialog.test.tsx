import test from "node:test";
import assert from "node:assert/strict";

import { getQuickAddSnippetInitialCommand } from "./QuickAddSnippetDialog.tsx";

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
