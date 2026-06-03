const test = require("node:test");
const assert = require("node:assert/strict");
const { mergeLoginShellPath } = require("./shellUtils.cjs");

test("mergeLoginShellPath unions login-shell PATH ahead of base, dedup", () => {
  const merged = mergeLoginShellPath({
    basePath: "/usr/bin:/bin",
    runLoginShellPath: () => "/opt/homebrew/bin:/usr/bin:/Users/me/.local/bin",
    platform: "darwin",
    delimiter: ":",
  });
  const parts = merged.split(":");
  assert.ok(parts.includes("/opt/homebrew/bin"));
  assert.ok(parts.includes("/Users/me/.local/bin"));
  assert.ok(parts.includes("/bin"));
  // no duplicate /usr/bin
  assert.equal(parts.filter((p) => p === "/usr/bin").length, 1);
});

test("mergeLoginShellPath returns basePath untouched on win32", () => {
  const merged = mergeLoginShellPath({
    basePath: "C:\\Windows", runLoginShellPath: () => "X", platform: "win32", delimiter: ";",
  });
  assert.equal(merged, "C:\\Windows");
});

test("mergeLoginShellPath tolerates login-shell failure", () => {
  const merged = mergeLoginShellPath({
    basePath: "/usr/bin", runLoginShellPath: () => { throw new Error("no shell"); },
    platform: "darwin", delimiter: ":",
  });
  assert.equal(merged, "/usr/bin");
});
