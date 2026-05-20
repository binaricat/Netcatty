import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = join(__dirname, "..");

test("Hosts sort mode is persisted with a dedicated storage key", () => {
  const vaultViewSource = readFileSync(join(rootDir, "components", "VaultView.tsx"), "utf8");
  const storageKeysSource = readFileSync(join(rootDir, "infrastructure", "config", "storageKeys.ts"), "utf8");

  assert.match(storageKeysSource, /STORAGE_KEY_VAULT_HOSTS_SORT_MODE/);
  assert.match(vaultViewSource, /STORAGE_KEY_VAULT_HOSTS_SORT_MODE/);
  assert.match(vaultViewSource, /useStoredString<SortMode>/);
  assert.match(vaultViewSource, /"az",\s*isSortMode,\s*\)/);
  assert.doesNotMatch(vaultViewSource, /useState<SortMode>\("az"\)/);
});
