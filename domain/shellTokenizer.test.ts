import assert from "node:assert/strict";
import test from "node:test";

import { tokenizeShellLike } from "./shellTokenizer.ts";

test("tokenizeShellLike splits unquoted tokens and preserves trailing space indicator", () => {
  assert.deepEqual(tokenizeShellLike(""), [""]);
  assert.deepEqual(tokenizeShellLike("git status"), ["git", "status"]);
  assert.deepEqual(tokenizeShellLike("git status "), ["git", "status", ""]);
  assert.deepEqual(tokenizeShellLike("git   commit  -m"), ["git", "commit", "-m"]);
  assert.deepEqual(tokenizeShellLike("  ls -la"), ["ls", "-la"]);
});

test("tokenizeShellLike preserves single and double quoted segments", () => {
  assert.deepEqual(
    tokenizeShellLike(`git commit -m "hello world"`),
    ["git", "commit", "-m", `"hello world"`],
  );
  assert.deepEqual(
    tokenizeShellLike(`grep 'foo bar' "baz 'qux'"`),
    ["grep", `'foo bar'`, `"baz 'qux'"`],
  );
  assert.deepEqual(
    tokenizeShellLike(`echo "unclosed quote `),
    ["echo", `"unclosed quote `],
  );
});

test("tokenizeShellLike preserves backslash-escaped spaces and quotes", () => {
  assert.deepEqual(
    tokenizeShellLike("cd My\\ Folder/sub\\ dir"),
    ["cd", "My\\ Folder/sub\\ dir"],
  );
  assert.deepEqual(
    tokenizeShellLike(`echo \\"quoted\\" 'a b'`),
    ["echo", `\\"quoted\\"`, `'a b'`],
  );
});
