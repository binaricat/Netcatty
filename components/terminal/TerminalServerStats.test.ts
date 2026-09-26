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

test("GPU chip only renders when the remote reports GPU utilization", () => {
  const source = readFileSync(new URL("./TerminalServerStats.tsx", import.meta.url), "utf8");

  // Conditional render — hosts without nvidia-smi must not show an empty GPU chip.
  assert.match(source, /\{serverStats\.gpu !== null && \(/);
  // Sits directly after the CPU chip, before the memory chip.
  assert.match(
    source,
    /terminal\.serverStats\.gpu[\s\S]{0,2000}terminal\.serverStats\.memory/,
  );
});
