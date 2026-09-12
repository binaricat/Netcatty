import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

test("terminal font dropdown always preserves an explicit default option", () => {
  const source = readFileSync(new URL("./TerminalFontSelect.tsx", import.meta.url), "utf8");
  assert.match(source, /font\.id === "" \|\| font\.id === value/);
});
