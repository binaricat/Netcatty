import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

test("host tree list keeps slight top padding", () => {
  const source = readFileSync(new URL("./vault/VaultHostListSection.tsx", import.meta.url), "utf8");

  assert.match(source, /viewMode === "tree"\s*\?\s*"pt-1\.5"\s*:\s*"pt-0"/);
});
