import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("gpu tab keeps loading while accelerator query is pending", () => {
  const source = readFileSync(new URL("./GpuManagerTab.tsx", import.meta.url), "utf8");
  assert.match(source, /setGpuListPending\(true\)/);
  assert.match(source, /if \(result\.pending\)/);
  assert.match(source, /isRefreshActive = loading \|\| gpuListPending/);
  assert.match(source, /if \(!data\)/);
  assert.doesNotMatch(
    source,
    /if \(result\.pending\) return null;\s*\n\s*if \(!result\.success\)/,
  );
});

test("gpu tab still renders compute processes when device list is empty", () => {
  const source = readFileSync(new URL("./GpuManagerTab.tsx", import.meta.url), "utf8");
  assert.match(source, /if \(!devices\.length && !processes\.length\)/);
  assert.match(source, /processes\.map\(\(process\) =>/);
});

test("gpu tab passes null utilization to ResourceBar instead of zero", () => {
  const source = readFileSync(new URL("./GpuManagerTab.tsx", import.meta.url), "utf8");
  assert.match(source, /value=\{util\}/);
  assert.match(source, /value=\{memPct\}/);
  assert.doesNotMatch(source, /value=\{util \?\? 0\}/);
  assert.doesNotMatch(source, /value=\{memPct \?\? 0\}/);
});

test("gpu tab keeps a compact sparkline history like overview/nvtop charts", () => {
  const source = readFileSync(new URL("./GpuManagerTab.tsx", import.meta.url), "utf8");
  assert.match(source, /HISTORY_LIMIT/);
  assert.match(source, /GpuSparkline/);
  assert.match(source, /historyByDevice/);
  assert.match(source, /setHistoryByDevice/);
});

test("resource bar animates width and uses load-aware tones", () => {
  const source = readFileSync(new URL("./ResourceBar.tsx", import.meta.url), "utf8");
  assert.match(source, /transition-\[width,background-color\]/);
  assert.match(source, /bg-amber-500/);
  assert.match(source, /bg-destructive/);
});
