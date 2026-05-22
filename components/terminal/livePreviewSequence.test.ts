import test from "node:test";
import assert from "node:assert/strict";
import { computeLivePreviewWrite } from "./autocomplete/livePreviewSequence.ts";

test("appends only the tail when the candidate continues the current line", () => {
  assert.equal(
    computeLivePreviewWrite({ currentLine: "do", candidate: "docker", os: "linux" }),
    "cker",
  );
});

test("returns empty when the line already equals the candidate", () => {
  assert.equal(
    computeLivePreviewWrite({ currentLine: "docker", candidate: "docker", os: "linux" }),
    "",
  );
});

test("clears with Ctrl-U then writes the full candidate on a non-prefix change", () => {
  assert.equal(
    computeLivePreviewWrite({ currentLine: "docker", candidate: "df", os: "linux" }),
    "\x15df",
  );
});

test("clears when switching to a shorter prefix candidate", () => {
  assert.equal(
    computeLivePreviewWrite({ currentLine: "docker-compose", candidate: "docker", os: "linux" }),
    "\x15docker",
  );
});

test("reverting to the typed baseline clears then rewrites the baseline", () => {
  assert.equal(
    computeLivePreviewWrite({ currentLine: "docker", candidate: "do", os: "linux" }),
    "\x15do",
  );
});

test("Windows uses backspaces sized to the current line, not Ctrl-U", () => {
  assert.equal(
    computeLivePreviewWrite({ currentLine: "abc", candidate: "xy", os: "windows" }),
    "\b\b\bxy",
  );
});
