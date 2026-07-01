import assert from "node:assert/strict";
import test from "node:test";

import type { Terminal as XTerm } from "@xterm/xterm";

import { writeTerminalPayloadChunked } from "./terminalReplay.ts";

test("writeTerminalPayloadChunked writes large payloads in multiple chunks", async () => {
  const writes: string[] = [];
  const term = {
    write: (data: string, cb: () => void) => {
      writes.push(data);
      cb();
    },
  } as unknown as XTerm;

  const payload = "x".repeat(40_000);
  await writeTerminalPayloadChunked(term, payload, { chunkBytes: 16_384 });

  assert.ok(writes.length >= 2);
  assert.equal(writes.join(""), payload);
});
