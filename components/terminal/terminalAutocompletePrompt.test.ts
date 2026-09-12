import test from "node:test";
import assert from "node:assert/strict";

import {
  computeAutocompleteAcceptWrite,
  isSameAutocompleteQuery,
  resolveAutocompleteQueryInput,
  shouldBlockAutocompleteForSensitivePrompt,
} from "./autocomplete/terminalAutocompletePrompt.ts";
import type { PromptDetectionResult } from "./autocomplete/promptDetector.ts";

function atPrompt(userInput: string, promptText = "$ "): PromptDetectionResult {
  return {
    isAtPrompt: true,
    promptText,
    userInput,
    cursorOffset: userInput.length,
  };
}

test("shouldBlockAutocompleteForSensitivePrompt ignores empty-echo alone", () => {
  // Empty-echo shell PS1s are handled by allowExternalProviders:false wait,
  // not by this helper — it only covers explicit sensitive prompts / latches.
  assert.equal(
    shouldBlockAutocompleteForSensitivePrompt({
      sensitiveInputActive: false,
      promptText: "$ ",
    }),
    false,
  );
  assert.equal(
    shouldBlockAutocompleteForSensitivePrompt({
      sensitiveInputActive: false,
      promptText: "➜ ",
    }),
    false,
  );
});

test("shouldBlockAutocompleteForSensitivePrompt blocks marked sensitive input", () => {
  assert.equal(
    shouldBlockAutocompleteForSensitivePrompt({
      sensitiveInputActive: true,
      promptText: "$ ",
    }),
    true,
  );
});

test("shouldBlockAutocompleteForSensitivePrompt blocks auth-challenge prompts", () => {
  assert.equal(
    shouldBlockAutocompleteForSensitivePrompt({
      sensitiveInputActive: false,
      promptText: "Password:",
    }),
    true,
  );
});

test("isSameAutocompleteQuery keeps late paths alive during live preview", () => {
  // Highlighting a candidate rewrites typedInputBuffer to the preview text.
  // Late path listings for the original query must still apply.
  assert.equal(
    isSameAutocompleteQuery({
      queryInput: "cd /u",
      currentInput: "cd /usr/",
      previewActive: true,
      previewBaseline: "cd /u",
    }),
    true,
  );
  assert.equal(
    isSameAutocompleteQuery({
      queryInput: "cd /u",
      currentInput: "cd /var/",
      previewActive: false,
      previewBaseline: "cd /u",
    }),
    false,
  );
  assert.equal(
    isSameAutocompleteQuery({
      queryInput: "cd /u",
      currentInput: "cd /usr/",
      previewActive: true,
      previewBaseline: "ls /u",
    }),
    false,
  );
});

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

test("resolveAutocompleteQueryInput preserves a reliably tracked empty line under echo lag", () => {
  // User typed then deleted everything; remote echo still shows the old char.
  // Autocomplete must not keep matching / accepting against the stale echo.
  assert.equal(
    resolveAutocompleteQueryInput(atPrompt("g"), "", true),
    "",
  );
  // Unreliable empty buffer (history recall / cursor move) still trusts echo.
  assert.equal(
    resolveAutocompleteQueryInput(atPrompt("git status"), "", false),
    "git status",
  );
});

test("resolveAutocompleteQueryInput prefers reliable typed buffer after partial backspace under echo lag", () => {
  // User typed `git` then backspaced to `gi`; remote echo still shows `git`.
  // Completions/accept must track the shorter reliable buffer, not the stale echo.
  assert.equal(
    resolveAutocompleteQueryInput(atPrompt("git"), "gi", true),
    "gi",
  );
  assert.equal(
    resolveAutocompleteQueryInput(atPrompt("git status"), "git ", true),
    "git ",
  );
});

test("computeAutocompleteAcceptWrite does not reinsert deleted text from a lagging echo", () => {
  assert.equal(
    computeAutocompleteAcceptWrite({
      prompt: atPrompt("g"),
      typedBuffer: "",
      typedBufferReliable: true,
      candidate: "git status",
      os: "linux",
    }),
    "git status",
  );
  // Partial delete: typed `gi`, echo still `git`, accept `git status` must
  // only send the missing suffix — never ` status` onto a truncated line.
  assert.equal(
    computeAutocompleteAcceptWrite({
      prompt: atPrompt("git"),
      typedBuffer: "gi",
      typedBufferReliable: true,
      candidate: "git status",
      os: "linux",
    }),
    "t status",
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

test("computeAutocompleteAcceptWrite uses typed buffer under echo lag so accept does not duplicate keystrokes", () => {
  // Remote shell already has the full typed command; only the local echo lags.
  // Accept/preview must extend from the typed buffer, not the short echoed prefix.
  assert.equal(
    computeAutocompleteAcceptWrite({
      prompt: atPrompt("s"),
      typedBuffer: "systemctl",
      typedBufferReliable: true,
      candidate: "systemctl restart nginx",
      os: "linux",
    }),
    " restart nginx",
  );
  assert.equal(
    computeAutocompleteAcceptWrite({
      prompt: atPrompt(""),
      typedBuffer: "systemctl",
      typedBufferReliable: true,
      candidate: "systemctl status",
      os: "linux",
      execute: true,
    }),
    " status\r",
  );
});

test("computeAutocompleteAcceptWrite refuses line replacement when disabled", () => {
  assert.equal(
    computeAutocompleteAcceptWrite({
      prompt: atPrompt("dock"),
      typedBuffer: "dock",
      typedBufferReliable: true,
      candidate: "systemctl status",
      os: "linux",
      allowLineReplacement: false,
    }),
    null,
  );
});

test("computeAutocompleteAcceptWrite clears with backspaces on a mislabeled Windows shell (#3184)", () => {
  // Windows PowerShell host saved with the os:"linux" default: the detected
  // drive-letter prompt must route the clear to backspaces, not Ctrl-U.
  assert.equal(
    computeAutocompleteAcceptWrite({
      prompt: atPrompt("tkn", "(base) PS C:\\Users\\Administrator>"),
      typedBuffer: "tkn",
      typedBufferReliable: true,
      candidate: "uv run tkauto video sync-fs",
      os: "linux",
    }),
    "\b\b\buv run tkauto video sync-fs",
  );
});