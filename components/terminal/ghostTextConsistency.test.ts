import test from "node:test";
import assert from "node:assert/strict";

import { lineHasUntrackedTrailingInput } from "./autocomplete/ghostTextConsistency.ts";

test("keeps the ghost when the line matches the tracked input (in sync)", () => {
  assert.equal(lineHasUntrackedTrailingInput("network int", "ecOS# network int"), false);
});

test("hides the ghost when the device echoed untracked trailing input (#1013)", () => {
  // Tracked is one char behind what the device actually shows.
  assert.equal(lineHasUntrackedTrailingInput("network in", "ecOS# network int"), true);
});

test("keeps the ghost during echo latency (line is behind the tracked input)", () => {
  // The tracked input hasn't been fully echoed yet — reality being behind
  // never corrupts, so the ghost must stay.
  assert.equal(lineHasUntrackedTrailingInput("network int", "ecOS# network in"), false);
});

test("ignores trailing whitespace after the tracked input", () => {
  assert.equal(lineHasUntrackedTrailingInput("git", "$ git "), false);
});

test("hides when untracked non-space input follows the tracked input", () => {
  assert.equal(lineHasUntrackedTrailingInput("git", "$ git push"), true);
});

test("uses the last occurrence so a repeated token earlier on the line is ignored", () => {
  // Prompt contains 'int'; the real typed 'int' is the one at the end.
  assert.equal(lineHasUntrackedTrailingInput("int", "user@int-host:~$ int"), false);
  assert.equal(lineHasUntrackedTrailingInput("int", "user@int-host:~$ intf"), true);
});

test("skips non-ASCII input (wide-char column mapping is ambiguous)", () => {
  assert.equal(lineHasUntrackedTrailingInput("网络", "$ 网络口"), false);
});

test("skips single-character input", () => {
  assert.equal(lineHasUntrackedTrailingInput("l", "$ lx"), false);
});

test("returns false when the tracked input isn't on the line yet (latency)", () => {
  assert.equal(lineHasUntrackedTrailingInput("systemctl", "$ sys"), false);
});
