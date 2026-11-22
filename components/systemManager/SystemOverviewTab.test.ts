import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

test("overview CPU cores list renders every reported core and can scroll", () => {
  const source = readFileSync(new URL("./SystemOverviewTab.tsx", import.meta.url), "utf8");

  assert.doesNotMatch(source, /cpuPerCore\.slice\(/);
  assert.match(
    source,
    /className="grid grid-cols-2 gap-x-3 gap-y-1\.5 max-h-\[\d+px\] overflow-y-auto pr-1 overscroll-contain"/,
  );
});
