const test = require("node:test");
const assert = require("node:assert/strict");

const {
  TRANSFER_CONCURRENCY,
  TRANSFER_CHUNK_SIZE,
} = require("./transferLimits.cjs");

test("SFTP transfer limits keep default per-file request fanout conservative", () => {
  assert.equal(TRANSFER_CONCURRENCY, 4);
  assert.equal(TRANSFER_CHUNK_SIZE, 512 * 1024);
});
