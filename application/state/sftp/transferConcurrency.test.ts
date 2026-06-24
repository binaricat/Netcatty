import test from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_SFTP_FILE_TRANSFER_CONCURRENCY,
  resolveSftpTransferConcurrency,
  runSftpTransferWorkers,
} from "./transferConcurrency";

test("defaults folder file transfers to two concurrent files", () => {
  assert.equal(resolveSftpTransferConcurrency(() => null), DEFAULT_SFTP_FILE_TRANSFER_CONCURRENCY);
  assert.equal(DEFAULT_SFTP_FILE_TRANSFER_CONCURRENCY, 2);
});

test("keeps explicit folder transfer concurrency within the supported range", () => {
  assert.equal(resolveSftpTransferConcurrency(() => 1), 1);
  assert.equal(resolveSftpTransferConcurrency(() => 16), 16);
  assert.equal(resolveSftpTransferConcurrency(() => 0), DEFAULT_SFTP_FILE_TRANSFER_CONCURRENCY);
  assert.equal(resolveSftpTransferConcurrency(() => 17), DEFAULT_SFTP_FILE_TRANSFER_CONCURRENCY);
});

test("limits default multi-file transfer scheduling to two concurrent workers", async () => {
  let active = 0;
  let maxActive = 0;

  await runSftpTransferWorkers([1, 2, 3, 4], () => null, async () => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    await new Promise((resolve) => setTimeout(resolve, 5));
    active -= 1;
  });

  assert.equal(maxActive, 2);
});
