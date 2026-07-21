import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("./TrayPanel.tsx", import.meta.url), "utf8");

test("tray session close actions are discoverable without mouse hover", () => {
  const keyboardVisible = source.match(/focus-visible:opacity-100/g) ?? [];
  const touchVisible = source.match(/\[@media\(hover:none\)\]:opacity-100/g) ?? [];
  const centeredActions = source.match(/inline-flex items-center justify-center opacity-0/g) ?? [];
  const labelledActions = source.match(/aria-label=\{t\("tray\.closeSession"\)\}/g) ?? [];

  assert.equal(keyboardVisible.length, 2);
  assert.equal(touchVisible.length, 2);
  assert.equal(centeredActions.length, 2);
  assert.equal(labelledActions.length, 2);
});
