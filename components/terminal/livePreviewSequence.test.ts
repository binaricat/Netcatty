import test from "node:test";
import assert from "node:assert/strict";
import {
  computeLivePreviewWrite,
  isWindowsShellLineInput,
  shouldWriteAutocompleteLivePreview,
} from "./autocomplete/livePreviewSequence.ts";

test("network-device sessions skip live-preview PTY writes (#1193)", () => {
  assert.equal(shouldWriteAutocompleteLivePreview(true, false), true);
  assert.equal(shouldWriteAutocompleteLivePreview(true, true), false);
  assert.equal(shouldWriteAutocompleteLivePreview(false, false), false);
  assert.equal(shouldWriteAutocompleteLivePreview(false, true), false);
});

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

test("a Windows prompt clears with backspaces even when the host OS flag is mislabeled (#3184)", () => {
  // PowerShell on Windows SSH with the saved host left at the os:"linux"
  // default: Ctrl-U renders literally and visited suggestions accumulate.
  assert.equal(
    computeLivePreviewWrite({
      currentLine: "uv run tkauto video sync-fs",
      candidate: "uv run tkauto video daily",
      os: "linux",
      promptText: "(base) PS C:\\Users\\Administrator>",
    }),
    "\b".repeat("uv run tkauto video sync-fs".length) + "uv run tkauto video daily",
  );
  // cmd.exe prompt form.
  assert.equal(
    computeLivePreviewWrite({
      currentLine: "echo",
      candidate: "cls",
      os: "linux",
      promptText: "C:\\Users\\Administrator>",
    }),
    "\b\b\b\bcls",
  );
});

test("a POSIX prompt keeps the Ctrl-U clear when the host OS flag is linux", () => {
  assert.equal(
    computeLivePreviewWrite({
      currentLine: "docker",
      candidate: "df",
      os: "linux",
      promptText: "root@web:~#",
    }),
    "\x15df",
  );
  assert.equal(
    computeLivePreviewWrite({
      currentLine: "docker",
      candidate: "df",
      os: "linux",
      promptText: "user@host:/mnt/c/Users",
    }),
    "\x15df",
  );
});

test("isWindowsShellLineInput treats an explicit windows flag as authoritative", () => {
  assert.equal(isWindowsShellLineInput("windows", "root@web:~#"), true);
  assert.equal(isWindowsShellLineInput("linux"), false);
  assert.equal(isWindowsShellLineInput("linux", null), false);
});
