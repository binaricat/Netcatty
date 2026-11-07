"use strict";

const assert = require("node:assert/strict");
const { Buffer } = require("node:buffer");
const test = require("node:test");

function bytes(...parts) { return Buffer.concat(parts.map((part) => Buffer.from(part))); }
function text(value) { return bytes(Buffer.from(value), [0]); }
function packet(sequence, payload) { return bytes([payload.length & 255, payload.length >>> 8, 0, sequence], payload); }
function greeting(plugin = "mysql_native_password") {
  const flags = 1 | 4 | 8 | 0x200 | 0x2000 | 0x8000 | 0x80000;
  return bytes([10], text("synthetic-offline-server"), [1, 0, 0, 0], new Uint8Array(8).fill(1),
    [0, flags & 255, (flags >>> 8) & 255, 45, 0, 0, (flags >>> 16) & 255, (flags >>> 24) & 255, 21],
    new Uint8Array(10), new Uint8Array(12).fill(2), [0], text(plugin));
}
function streamFixture(plugin) {
  const column = bytes(...["def", "synthetic", "", "", "value"].map((value) => bytes([value.length], Buffer.from(value))));
  const eof = [0xfe, 0, 0, 2, 0];
  let pending = bytes(packet(0, greeting(plugin)), packet(2, [0]), packet(1, [1]),
    packet(2, column), packet(3, eof), packet(4, [1, 49]), packet(5, eof));
  const writes = [];
  let closes = 0;
  return {
    writes, get closes() { return closes; },
    stream: {
      async read() { const value = pending; pending = null; return value; },
      async write(value) { writes.push(Buffer.from(value)); },
      async close() { closes++; },
    },
  };
}

test("owned fixture and public Rfam entries each send only their fixed database and query offline", async () => {
  const { queryExample, queryRfamReadOnly, READ_QUERY } = await import("./protocol.mjs");
  for (const profile of [
    { run: (stream) => queryExample(stream, "plugin_demo", ""), user: "plugin_demo", database: "plugin_demo", query: READ_QUERY },
    { run: queryRfamReadOnly, user: "rfamro", database: "Rfam", query: "SELECT 1 AS value" },
  ]) {
    const f = streamFixture();
    assert.deepEqual(await profile.run(f.stream), { columns: ["value"], rows: [["1"]] });
    assert.equal(f.writes.length, 2);
    const response = f.writes[0].subarray(4);
    const expectedTail = bytes(text(profile.user), [0], text(profile.database), text("mysql_native_password"));
    assert.deepEqual(response.subarray(32), expectedTail);
    assert.equal(f.writes[1][4], 3);
    assert.equal(f.writes[1].subarray(5).toString(), profile.query);
    assert.equal(f.closes, 1);
  }
});

test("public profile rejects unsupported authentication offline without a fallback", async () => {
  const { queryRfamReadOnly } = await import("./protocol.mjs");
  const f = streamFixture("caching_sha2_password");
  await assert.rejects(queryRfamReadOnly(f.stream), /Unsupported or invalid/u);
  assert.equal(f.writes.length, 0);
  assert.equal(f.closes, 1);
});
