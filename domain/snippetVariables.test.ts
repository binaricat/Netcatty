import test from "node:test";
import assert from "node:assert/strict";

import {
  applySnippetVariables,
  parseSnippetVariables,
  previewSnippetCommand,
  snippetHasVariables,
} from "./snippetVariables.ts";

test("parseSnippetVariables finds all vars after snippetHasVariables (shared-regex lastIndex)", () => {
  const command = "echo '{{test}}'\necho '{{test2}}'";
  assert.equal(snippetHasVariables(command), true);
  assert.deepEqual(parseSnippetVariables(command).map((v) => v.name), ["test", "test2"]);
});

test("parseSnippetVariables returns empty for plain command", () => {
  assert.deepEqual(parseSnippetVariables("ls -la"), []);
  assert.equal(snippetHasVariables("ls -la"), false);
});

test("parseSnippetVariables dedupes by first occurrence order", () => {
  assert.deepEqual(parseSnippetVariables("echo {{a}} and {{b}} and {{a}}"), [
    { name: "a" },
    { name: "b" },
  ]);
});

test("parseSnippetVariables reads default after colon", () => {
  assert.deepEqual(parseSnippetVariables("fallocate -l {{内存大小:4}}G"), [
    { name: "内存大小", defaultValue: "4" },
  ]);
});

test("applySnippetVariables replaces all occurrences", () => {
  const result = applySnippetVariables(
    "fallocate -l {{内存大小:4}}G\nswapon {{内存大小:4}}",
    { 内存大小: "8" },
  );
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.command, "fallocate -l 8G\nswapon 8");
  }
});

test("applySnippetVariables uses default when value empty", () => {
  const result = applySnippetVariables("size {{n:2}}", { n: "" });
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.command, "size 2");
});

test("applySnippetVariables reports missing required vars", () => {
  const result = applySnippetVariables("echo {{name}}", {});
  assert.equal(result.ok, false);
  if (!result.ok) assert.deepEqual(result.missing, ["name"]);
});

test("applySnippetVariables passes through command without variables", () => {
  const result = applySnippetVariables("uptime", { x: "1" });
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.command, "uptime");
});

test("previewSnippetCommand keeps placeholder for unfilled required", () => {
  assert.equal(
    previewSnippetCommand("echo {{a}}", {}),
    "echo {{a}}",
  );
});

test("previewSnippetCommand shows resolved values", () => {
  assert.equal(
    previewSnippetCommand("echo {{a:hi}}", {}),
    "echo hi",
  );
});
