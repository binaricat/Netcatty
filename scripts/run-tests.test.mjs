import assert from "node:assert/strict";
import test from "node:test";
import { batchTestFiles } from "./run-tests.mjs";

test("batchTestFiles splits large test suites safely under the Windows 32,767-char CreateProcessW limit", () => {
  const files = Array.from(
    { length: 1400 },
    (_, i) => `components/settings/tabs/ai/verySpecificFeatureModule${String(i).padStart(4, "0")}.test.tsx`,
  );
  const baseArgsLength = 200;
  const batches = batchTestFiles(files, baseArgsLength, 20_000);

  assert.ok(batches.length > 1, "expected multiple batches for 1,400 paths");
  assert.deepEqual(batches.flat(), files, "all files must be preserved in order");

  for (const batch of batches) {
    const estimatedCmdLen =
      baseArgsLength + batch.reduce((sum, f) => sum + f.length + 3, 0);
    assert.ok(
      estimatedCmdLen <= 20_000,
      `batch exceeded budget: ${estimatedCmdLen}`,
    );
  }
});

test("batchTestFiles keeps a single batch when total command length fits within budget", () => {
  const files = ["a.test.ts", "b.test.ts", "c.test.ts"];
  const batches = batchTestFiles(files, 100, 20_000);
  assert.deepEqual(batches, [files]);
});

test("batchTestFiles never drops or loops on a single path longer than the remaining budget", () => {
  const longFile = `${"a".repeat(200)}.test.ts`;
  const batches = batchTestFiles([longFile, "short.test.ts"], 150, 200);
  assert.deepEqual(batches, [[longFile], ["short.test.ts"]]);
});
