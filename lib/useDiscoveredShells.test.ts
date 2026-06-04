import test from "node:test";
import assert from "node:assert/strict";

import { resolveShellSetting } from "./useDiscoveredShells";

const DISCOVERED: DiscoveredShell[] = [
  { id: "git-bash", name: "Git Bash", command: "C:\\Git\\bin\\bash.exe", args: ["--login", "-i"], icon: "git-bash" },
];

test("resolveShellSetting returns null for empty value", () => {
  assert.equal(resolveShellSetting("", DISCOVERED), null);
});

test("resolveShellSetting passes custom args through for a custom path", () => {
  const resolved = resolveShellSetting("C:\\msys64\\usr\\bin\\bash.exe", DISCOVERED, ["--login", "-i"]);
  assert.equal(resolved?.command, "C:\\msys64\\usr\\bin\\bash.exe");
  assert.deepEqual(resolved?.args, ["--login", "-i"]);
});

test("resolveShellSetting omits args when custom args are empty (preserves bridge fallback)", () => {
  const resolved = resolveShellSetting("/usr/local/bin/fish", DISCOVERED, []);
  assert.equal(resolved?.command, "/usr/local/bin/fish");
  assert.equal(resolved?.args, undefined);
});

test("resolveShellSetting omits args when no custom args are given", () => {
  const resolved = resolveShellSetting("/usr/local/bin/fish", DISCOVERED);
  assert.equal(resolved?.command, "/usr/local/bin/fish");
  assert.equal(resolved?.args, undefined);
});

test("resolveShellSetting uses discovered shell args when value matches and no custom args are given", () => {
  const resolved = resolveShellSetting("git-bash", DISCOVERED);
  assert.equal(resolved?.command, "C:\\Git\\bin\\bash.exe");
  assert.deepEqual(resolved?.args, ["--login", "-i"]);
});

test("resolveShellSetting prefers explicit custom args when value collides with a discovered shell id", () => {
  const resolved = resolveShellSetting("git-bash", DISCOVERED, ["--private"]);
  assert.equal(resolved?.command, "C:\\Git\\bin\\bash.exe");
  assert.deepEqual(resolved?.args, ["--private"]);
});
