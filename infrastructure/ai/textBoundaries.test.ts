import test from "node:test";
import assert from "node:assert/strict";
import type { ModelMessage } from "ai";

import {
  safeSliceBounds,
  sliceHead,
  sliceTail,
  toWellFormedText,
  toWellFormedValue,
} from "./textBoundaries.ts";
import {
  compressMessagesForRequestTooLargeRetry,
  compressVerboseText,
  truncateTextWithHeadAndTail,
} from "./requestPayloadCompression.ts";

const TROPHY = "\u{1F3C6}";

test("sliceHead never ends inside a surrogate pair", () => {
  const value = `ab${TROPHY}cd`;
  assert.equal(sliceHead(value, 3), "ab");
  assert.equal(sliceHead(value, 4), `ab${TROPHY}`);
  assert.equal(sliceHead(value, 0), "");
  assert.equal(sliceHead(value, 99), value);
});

test("sliceTail never starts inside a surrogate pair", () => {
  const value = `ab${TROPHY}cd`;
  assert.equal(sliceTail(value, 3), "cd");
  assert.equal(sliceTail(value, 4), `${TROPHY}cd`);
  assert.equal(sliceTail(value, 0), "");
  assert.equal(sliceTail(value, 99), value);
});

test("safeSliceBounds moves both edges off a split pair", () => {
  const value = `a${TROPHY}b${TROPHY}c`;
  const [start, end] = safeSliceBounds(value, 2, 5);
  assert.ok(value.slice(start, end).isWellFormed());
});

test("toWellFormedText replaces only lone surrogates", () => {
  assert.equal(toWellFormedText(`ok ${TROPHY}`), `ok ${TROPHY}`);
  assert.equal(toWellFormedText("a\udfc6b\ud83c"), "a�b�");
});

test("toWellFormedValue rewrites nested strings and keeps clean subtrees", () => {
  const clean = { text: TROPHY };
  const input = { clean, parts: [{ value: "\udfc6x" }], data: new Uint8Array([1]) };
  const output = toWellFormedValue(input);
  assert.equal(output.clean, clean);
  assert.equal(output.data, input.data);
  assert.equal(output.parts[0].value, "�x");
  assert.equal(toWellFormedValue(clean), clean);
});

test("toWellFormedValue keeps an own __proto__ key as data", () => {
  const input = JSON.parse('{"__proto__":{"polluted":true},"text":"\\udfc6x"}') as Record<string, unknown>;
  const output = toWellFormedValue(input);
  assert.notEqual(output, input);
  assert.equal(output.text, "�x");
  assert.equal(Object.getPrototypeOf(output), Object.prototype);
  assert.ok(Object.hasOwn(output, "__proto__"));
  assert.deepEqual(Object.getOwnPropertyDescriptor(output, "__proto__")?.value, { polluted: true });
  assert.equal(JSON.stringify(output), '{"__proto__":{"polluted":true},"text":"�x"}');

  const bare = Object.assign(Object.create(null), { text: "\ud83c" });
  assert.equal(Object.getPrototypeOf(toWellFormedValue(bare)), null);
});

// Regression: a mihomo log tail with 🏆 on every line was JSON-stringified
// into one long line; shortening it cut the emoji in half and DeepSeek
// rejected every later request with "lone leading surrogate in hex escape".
test("compressing an emoji-heavy JSON tool result keeps the request well-formed", () => {
  const line = `level=info msg="[TCP] 127.0.0.1:38178 --> raw.githubusercontent.com:443 using ⚡ ${TROPHY}[SOCKS-5006]"`;
  const stdout = Array.from({ length: 40 }, () => line).join("\n");
  // Sweep one full line period so the tail cut lands on every offset, the emoji included.
  for (let pad = 0; pad <= line.length; pad += 1) {
    const value = { stdout, stderr: "x".repeat(pad), exitCode: 0 };
    assert.ok(compressVerboseText(JSON.stringify(value)).isWellFormed(), `pad=${pad}`);
    const messages = [{
      role: "tool",
      content: [{ type: "tool-result", toolCallId: "c", toolName: "t", output: { type: "json", value } }],
    }] as ModelMessage[];
    const { messages: compressed } = compressMessagesForRequestTooLargeRetry(messages, { preserveAttachments: true });
    const serialized = JSON.stringify(compressed);
    assert.doesNotMatch(serialized, /\\ud[89a-f][0-9a-f]{2}/i, `pad=${pad}`);
  }
});

test("truncateTextWithHeadAndTail keeps surrogate pairs whole at every cut", () => {
  const value = TROPHY.repeat(3_000);
  for (const maxChars of [10, 101, 1_001, 4_001]) {
    assert.ok(truncateTextWithHeadAndTail(value, maxChars).isWellFormed(), `maxChars=${maxChars}`);
    assert.ok(
      truncateTextWithHeadAndTail(value, maxChars, { headChars: 7, tailChars: 9 }).isWellFormed(),
      `maxChars=${maxChars} odd edges`,
    );
  }
});
