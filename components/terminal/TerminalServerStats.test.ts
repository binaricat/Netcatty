import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

test("CPU per-core stats list can scroll when many cores are reported", () => {
  const source = readFileSync(new URL("./TerminalServerStats.tsx", import.meta.url), "utf8");

  assert.match(
    source,
    /className="grid gap-1\.5 max-h-\[\d+px\] overflow-y-auto/,
  );
});

test("server stats stay subscribed while the terminal is in the background", () => {
  const source = readFileSync(new URL("./TerminalServerStats.tsx", import.meta.url), "utf8");

  assert.doesNotMatch(source, /usePaneVisible/);
  assert.doesNotMatch(source, /isVisible,/);
});
