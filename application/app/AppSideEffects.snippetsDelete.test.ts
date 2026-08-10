import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("./AppSideEffects.tsx", import.meta.url), "utf8");

test("snippets delete handler cleans host bindings via deleteSelectedSnippets", () => {
  assert.match(source, /collectSnippetDeleteIds/);
  assert.match(source, /deleteSelectedSnippets/);
  assert.match(
    source,
    /netcatty:snippets:delete[\s\S]*void deleteSelectedSnippets\(ids\)/,
  );
  assert.doesNotMatch(
    source,
    /updateSnippets\(snippets\.filter\(\(s\) => !ids\.has\(s\.id\)\)\)/,
  );
});

test("snippets delete handler uses vault live snapshot instead of component refs", () => {
  // Component-level snippetsRef/hostsRef lag concurrent vault mutations that
  // already advanced useVaultState refs before React re-renders AppSideEffects.
  // Deletion must go through the vault hook's atomic live-snapshot path.
  assert.match(source, /deleteSelectedSnippets,/);
  assert.doesNotMatch(source, /snippetsRef\.current\s*=\s*snippets/);
  assert.doesNotMatch(
    source,
    /deleteSelectedSnippetsFromVault\(\s*snippetsRef\.current/,
  );
});
