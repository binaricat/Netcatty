import assert from "node:assert/strict";
import test from "node:test";

import type { Terminal as XTerm } from "@xterm/xterm";

import {
  enqueueCoalescedTerminalWrite,
  flushTerminalWriteCoalescer,
  resetTerminalWriteCoalescer,
  setTerminalWriteCoalescerByteCapResolver,
  type CoalescedTerminalWriteOptions,
} from "./terminalWriteCoalescer.ts";
import {
  MAX_TERMINAL_PLAIN_WRITE_CHUNK_BYTES,
  MAX_TERMINAL_UNBROKEN_WRITE_CHUNK_BYTES,
} from "./terminalFlowConstants.ts";

const createFakeTerm = () => ({}) as XTerm;

test("splits a single flood-sized terminal batch before it reaches xterm", () => {
  const term = createFakeTerm();
  const writes: Array<{ data: string; ingressBytes: number }> = [];

  setTerminalWriteCoalescerByteCapResolver(term, () => 8);
  enqueueCoalescedTerminalWrite(
    term,
    "x".repeat(20),
    (data, ingressBytes) => {
      writes.push({ data, ingressBytes });
    },
    30,
  );

  assert.deepEqual(
    writes.map((write) => write.data.length),
    [8, 8, 4],
  );
  assert.deepEqual(
    writes.map((write) => write.ingressBytes),
    [12, 12, 6],
  );

  resetTerminalWriteCoalescer(term);
});

test("splits large plain terminal output into cooperative chunks", () => {
  const term = createFakeTerm();
  const writes: Array<{
    data: string;
    ingressBytes: number;
    options?: CoalescedTerminalWriteOptions;
  }> = [];
  const payload = `${Array.from({ length: 40 }, () => "x".repeat(1000)).join("\n")}\n12345`;

  setTerminalWriteCoalescerByteCapResolver(term, () => payload.length + 100);
  enqueueCoalescedTerminalWrite(
    term,
    payload,
    (data, ingressBytes, options) => {
      writes.push({ data, ingressBytes, options });
    },
    payload.length,
  );
  flushTerminalWriteCoalescer(term);

  assert.deepEqual(
    writes.map((write) => write.data.length),
    [
      MAX_TERMINAL_PLAIN_WRITE_CHUNK_BYTES,
      MAX_TERMINAL_PLAIN_WRITE_CHUNK_BYTES,
      payload.length - (MAX_TERMINAL_PLAIN_WRITE_CHUNK_BYTES * 2),
    ],
  );
  assert.deepEqual(writes.map((write) => write.ingressBytes), writes.map((write) => write.data.length));
  assert.deepEqual(
    writes.map((write) => write.options),
    [
      { deferStart: true, yieldAfter: true },
      { deferStart: true, yieldAfter: true },
      { deferStart: true, yieldAfter: true },
    ],
  );

  resetTerminalWriteCoalescer(term);
});

test("splits long unbroken plain terminal output more conservatively", () => {
  const term = createFakeTerm();
  const writes: Array<{
    data: string;
    ingressBytes: number;
    options?: CoalescedTerminalWriteOptions;
  }> = [];
  const payload = "x".repeat(MAX_TERMINAL_UNBROKEN_WRITE_CHUNK_BYTES * 2 + 11);

  setTerminalWriteCoalescerByteCapResolver(term, () => payload.length + 100);
  enqueueCoalescedTerminalWrite(
    term,
    payload,
    (data, ingressBytes, options) => {
      writes.push({ data, ingressBytes, options });
    },
    payload.length,
  );
  flushTerminalWriteCoalescer(term);

  assert.deepEqual(
    writes.map((write) => write.data.length),
    [
      MAX_TERMINAL_UNBROKEN_WRITE_CHUNK_BYTES,
      MAX_TERMINAL_UNBROKEN_WRITE_CHUNK_BYTES,
      11,
    ],
  );
  assert.deepEqual(writes.map((write) => write.ingressBytes), writes.map((write) => write.data.length));
  assert.equal(writes.every((write) => write.options?.yieldAfter === true), true);

  resetTerminalWriteCoalescer(term);
});

test("splits newline-terminated long plain output more conservatively", () => {
  const term = createFakeTerm();
  const writes: Array<{
    data: string;
    ingressBytes: number;
    options?: CoalescedTerminalWriteOptions;
  }> = [];
  const payload = `${"x".repeat(MAX_TERMINAL_UNBROKEN_WRITE_CHUNK_BYTES * 2)}\n`;

  setTerminalWriteCoalescerByteCapResolver(term, () => payload.length + 100);
  enqueueCoalescedTerminalWrite(
    term,
    payload,
    (data, ingressBytes, options) => {
      writes.push({ data, ingressBytes, options });
    },
    payload.length,
  );
  flushTerminalWriteCoalescer(term);

  assert.deepEqual(
    writes.map((write) => write.data.length),
    [
      MAX_TERMINAL_UNBROKEN_WRITE_CHUNK_BYTES,
      MAX_TERMINAL_UNBROKEN_WRITE_CHUNK_BYTES,
      1,
    ],
  );
  assert.equal(writes.map((write) => write.data).join(""), payload);
  assert.deepEqual(writes.map((write) => write.ingressBytes), writes.map((write) => write.data.length));
  assert.equal(writes.every((write) => write.options?.yieldAfter === true), true);

  resetTerminalWriteCoalescer(term);
});

test("keeps control-sequence terminal batches intact up to the coalescing cap", () => {
  const term = createFakeTerm();
  const writes: Array<{ data: string; options?: CoalescedTerminalWriteOptions }> = [];
  const payload = `\x1b[?2026h${"x".repeat(MAX_TERMINAL_PLAIN_WRITE_CHUNK_BYTES * 2)}\x1b[?2026l`;

  setTerminalWriteCoalescerByteCapResolver(term, () => payload.length + 100);
  enqueueCoalescedTerminalWrite(
    term,
    payload,
    (data, _ingressBytes, options) => {
      writes.push({ data, options });
    },
    payload.length,
  );
  flushTerminalWriteCoalescer(term);

  assert.deepEqual(writes.map((write) => write.data.length), [payload.length]);
  assert.deepEqual(writes.map((write) => write.options), [undefined]);

  resetTerminalWriteCoalescer(term);
});
