const test = require("node:test");
const assert = require("node:assert/strict");

const {
  TRANSFER_CONCURRENCY,
  TRANSFER_CHUNK_SIZE,
} = require("./transferLimits.cjs");

test("SFTP transfer limits keep default per-file request fanout conservative", () => {
  assert.equal(TRANSFER_CONCURRENCY, 4);
  // Keep ssh2's default chunk size — larger packets can corrupt uploads on
  // servers that do not honour non-default WRITE sizes (#2022).
  assert.equal(TRANSFER_CHUNK_SIZE, 32 * 1024);
});
