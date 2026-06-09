import test from "node:test";
import assert from "node:assert/strict";

import { fitTerminalExecuteResultForModel } from "./tools.ts";

test("fitTerminalExecuteResultForModel keeps command output compact for model replay", () => {
  const result = fitTerminalExecuteResultForModel({
    stdout: "A".repeat(200_000),
    stderr: "B".repeat(50_000),
    exitCode: 0,
  });

  assert.ok(result.stdout.length < 25_000);
  assert.ok(result.stderr.length < 12_000);
  assert.match(result.stdout, /output truncated for request size/);
  assert.equal(result.exitCode, 0);
});
