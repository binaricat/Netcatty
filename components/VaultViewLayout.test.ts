import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const vaultViewLayoutSource = readFileSync(new URL("./vault/VaultViewLayout.tsx", import.meta.url), "utf8");

test("vault stage aligns its content to the top tab bar", () => {
  assert.match(vaultViewLayoutSource, /className="flex min-w-0 flex-1 py-0 pr-2 pb-2 pl-0"/);
  assert.doesNotMatch(vaultViewLayoutSource, /className="flex min-w-0 flex-1 p-2 pl-0"/);
});

test("vault notes stay mounted while switching sections", () => {
  assert.match(vaultViewLayoutSource, /data-section="vault-notes-retained"/);
  assert.match(vaultViewLayoutSource, /currentSection !== "notes" && "hidden"/);
  assert.doesNotMatch(vaultViewLayoutSource, /currentSection === "notes" && \(\s*<NotesManager/);
});

test("vault header collapsed actions cannot retain hidden focus", () => {
  assert.match(vaultViewLayoutSource, /newHostActionsRef\.current\?\.contains\(activeElement\)/);
  assert.match(vaultViewLayoutSource, /sessionActionsRef\.current\?\.contains\(activeElement\)/);
  assert.match(vaultViewLayoutSource, /activeElement\.blur\(\)/);
  assert.match(vaultViewLayoutSource, /aria-hidden=\{isHostPanelOpen \? true : undefined\}/);
  assert.match(vaultViewLayoutSource, /inert=\{isHostPanelOpen \? true : undefined\}/);
});
