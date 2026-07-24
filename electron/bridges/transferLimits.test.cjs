const test = require("node:test");
const assert = require("node:assert/strict");

const {
  FAST_DOWNLOAD_CHANNELS_PER_SESSION,
  DOWNLOAD_TRANSFER_CONCURRENCY,
  UPLOAD_TRANSFER_CONCURRENCY,
  TRANSFER_CHUNK_SIZE,
} = require("./transferLimits.cjs");

test("SFTP transfer limits preserve upload safety and the pre-regression download window", () => {
  assert.equal(UPLOAD_TRANSFER_CONCURRENCY, 32);
  assert.equal(DOWNLOAD_TRANSFER_CONCURRENCY, 64);
  assert.equal(FAST_DOWNLOAD_CHANNELS_PER_SESSION, 1);
  // Keep ssh2's default chunk size — larger packets can corrupt uploads on
  // servers that do not honour non-default WRITE sizes (#2022).
  assert.equal(TRANSFER_CHUNK_SIZE, 32 * 1024);
  // #2449: upload window is 1MB (32 × 32KB). Raising only concurrency keeps
  // the safe packet size while matching measured throughput on ~10–40ms paths.
  assert.equal(UPLOAD_TRANSFER_CONCURRENCY * TRANSFER_CHUNK_SIZE, 1 * 1024 * 1024);
  // #2030 reduced the shared chunk size from 512KB to 32KB. Downloads need
  // enough parallel reads to preserve the 2MB in-flight window that existed
  // after #1533, otherwise high-latency proxy paths collapse to KB/s speeds.
  assert.equal(DOWNLOAD_TRANSFER_CONCURRENCY * TRANSFER_CHUNK_SIZE, 2 * 1024 * 1024);
});
