import test from "node:test";
import assert from "node:assert/strict";
import { applyPosixCwdFromCommand, normalizePosixCwd } from "./posixCwdFromCommand.ts";

test("applyPosixCwdFromCommand tracks simple cd paths", () => {
  assert.equal(applyPosixCwdFromCommand({ command: "cd /data/docker" }), "/data/docker");
  assert.equal(applyPosixCwdFromCommand({ command: "cd -- /tmp" }), "/tmp");
  assert.equal(applyPosixCwdFromCommand({
    command: "cd docker",
    currentCwd: "/data",
  }), "/data/docker");
  assert.equal(applyPosixCwdFromCommand({
    command: "cd ..",
    currentCwd: "/data/docker",
  }), "/data");
  assert.equal(applyPosixCwdFromCommand({
    command: "cd",
    homeDir: "/root",
  }), "/root");
  assert.equal(applyPosixCwdFromCommand({
    command: "cd ~",
    homeDir: "/root",
  }), "/root");
  assert.equal(applyPosixCwdFromCommand({ command: "ls" }), null);
  assert.equal(applyPosixCwdFromCommand({ command: "cd /tmp && ls" }), null);
});

test("normalizePosixCwd collapses dot segments", () => {
  assert.equal(normalizePosixCwd("/data/docker/../bin"), "/data/bin");
  assert.equal(normalizePosixCwd("/"), "/");
});
