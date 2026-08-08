import test from "node:test";
import assert from "node:assert/strict";

import { resolveAutocompleteQueryInput } from "./autocomplete/terminalAutocompletePrompt.ts";
import type { PromptDetectionResult } from "./autocomplete/promptDetector.ts";

function atPrompt(userInput: string, promptText = "$ "): PromptDetectionResult {
  return {
    isAtPrompt: true,
    promptText,
    userInput,
    cursorOffset: userInput.length,
  };
}

test("resolveAutocompleteQueryInput prefers reliable typed buffer when remote echo lags", () => {
  assert.equal(
    resolveAutocompleteQueryInput(atPrompt("s"), "systemctl", true),
    "systemctl",
  );
  assert.equal(
    resolveAutocompleteQueryInput(atPrompt("syst"), "systemctl", true),
    "systemctl",
  );
  assert.equal(
    resolveAutocompleteQueryInput(atPrompt(""), "systemctl", true),
    "systemctl",
  );
});

test("resolveAutocompleteQueryInput keeps echoed input when the typed buffer is unreliable", () => {
  assert.equal(
    resolveAutocompleteQueryInput(atPrompt("sys"), "systemctl", false),
    "sys",
  );
});

test("resolveAutocompleteQueryInput returns null when not at a prompt", () => {
  assert.equal(
    resolveAutocompleteQueryInput(
      {
        isAtPrompt: false,
        promptText: "",
        userInput: "",
        cursorOffset: 0,
      },
      "systemctl",
      true,
    ),
    null,
  );
});

test("resolveAutocompleteQueryInput does not invent input from an unrelated typed buffer", () => {
  assert.equal(
    resolveAutocompleteQueryInput(atPrompt("echo hello"), "sudo", true),
    "echo hello",
  );
});
