import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("./VaultPageHeader.tsx", import.meta.url), "utf8");

test("vault page headers wrap their actions instead of clipping them on narrow windows", () => {
  // Half-screen tiling can hand the content a ~520px-wide surface. The fixed
  // action buttons must move to a second row there instead of being cut off
  // by the window edge.
  assert.match(source, /min-h-14[^"]*flex-wrap/);
  assert.match(source, /gap-y-2/);
  assert.doesNotMatch(source, /"h-14 px-4 py-2 flex items-center gap-3 app-no-drag"/);
});
