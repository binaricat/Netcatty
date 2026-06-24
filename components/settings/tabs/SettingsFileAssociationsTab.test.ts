import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("./SettingsFileAssociationsTab.tsx", import.meta.url), "utf8");

test("SFTP settings imports the shared Toggle used by its option rows", () => {
  assert.match(source, /<Toggle\b/);
  assert.match(source, /Toggle,\s*\n\s*Select,/);
});
