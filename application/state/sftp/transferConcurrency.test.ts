import test from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_SFTP_DIRECTORY_LISTING_CONCURRENCY,
  DEFAULT_SFTP_FILE_TRANSFER_CONCURRENCY,
  DEFAULT_SFTP_SKIP_UNCHANGED,
  resolveSftpDirectoryListingConcurrency,
  resolveSftpSkipUnchangedEnabled,
  resolveSftpTransferConcurrency,
  runBoundedConcurrency,
  runSftpTransferWorkers,
} from "./transferConcurrency";

test("defaults folder file transfers to six concurrent files", () => {
  assert.equal(resolveSftpTransferConcurrency(() => null), DEFAULT_SFTP_FILE_TRANSFER_CONCURRENCY);
  assert.equal(DEFAULT_SFTP_FILE_TRANSFER_CONCURRENCY, 6);
});

test("defaults directory listing fanout to four concurrent readdirs", () => {
  assert.equal(
    resolveSftpDirectoryListingConcurrency(() => null),
    DEFAULT_SFTP_DIRECTORY_LISTING_CONCURRENCY,
  );
  assert.equal(DEFAULT_SFTP_DIRECTORY_LISTING_CONCURRENCY, 4);
});

test("defaults skip-unchanged to enabled", () => {
  assert.equal(resolveSftpSkipUnchangedEnabled(() => null), DEFAULT_SFTP_SKIP_UNCHANGED);
  assert.equal(DEFAULT_SFTP_SKIP_UNCHANGED, true);
  assert.equal(resolveSftpSkipUnchangedEnabled(() => false), false);
});

test("keeps explicit folder transfer concurrency within the supported range", () => {
  assert.equal(resolveSftpTransferConcurrency(() => 1), 1);
  assert.equal(resolveSftpTransferConcurrency(() => 16), 16);
  assert.equal(resolveSftpTransferConcurrency(() => 1.5), DEFAULT_SFTP_FILE_TRANSFER_CONCURRENCY);
  assert.equal(resolveSftpTransferConcurrency(() => 0), DEFAULT_SFTP_FILE_TRANSFER_CONCURRENCY);
  assert.equal(resolveSftpTransferConcurrency(() => 17), DEFAULT_SFTP_FILE_TRANSFER_CONCURRENCY);
});

test("keeps directory listing concurrency within the supported range", () => {
  assert.equal(resolveSftpDirectoryListingConcurrency(() => 1), 1);
  assert.equal(resolveSftpDirectoryListingConcurrency(() => 8), 8);
  assert.equal(
    resolveSftpDirectoryListingConcurrency(() => 0),
    DEFAULT_SFTP_DIRECTORY_LISTING_CONCURRENCY,
  );
  assert.equal(
    resolveSftpDirectoryListingConcurrency(() => 9),
    DEFAULT_SFTP_DIRECTORY_LISTING_CONCURRENCY,
  );
});

test("limits default multi-file transfer scheduling to six concurrent workers", async () => {
  let active = 0;
  let maxActive = 0;

  await runSftpTransferWorkers([1, 2, 3, 4, 5, 6, 7], () => null, async () => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    await new Promise((resolve) => setTimeout(resolve, 5));
    active -= 1;
  });

  assert.equal(maxActive, 6);
});

test("runBoundedConcurrency respects an explicit limit", async () => {
  let active = 0;
  let maxActive = 0;
  await runBoundedConcurrency([1, 2, 3, 4, 5, 6], 3, async () => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    await new Promise((resolve) => setTimeout(resolve, 5));
    active -= 1;
  });
  assert.equal(maxActive, 3);
});

test("runBoundedConcurrency drains siblings and stops new claims after an error", async () => {
  const started: number[] = [];
  const finished: number[] = [];
  let releaseSlow!: () => void;
  const slowGate = new Promise<void>((resolve) => {
    releaseSlow = resolve;
  });

  const run = runBoundedConcurrency([0, 1, 2, 3, 4], 2, async (item) => {
    started.push(item);
    if (item === 0) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      throw new Error("boom");
    }
    if (item === 1) {
      await slowGate;
    }
    finished.push(item);
  });

  await new Promise((resolve) => setTimeout(resolve, 30));

  let settledWhileSiblingRunning = false;
  await Promise.race([
    run.then(
      () => {
        settledWhileSiblingRunning = true;
      },
      () => {
        settledWhileSiblingRunning = true;
      },
    ),
    new Promise((resolve) => setTimeout(resolve, 5)),
  ]);
  assert.equal(
    settledWhileSiblingRunning,
    false,
    "must wait for in-flight siblings before propagating the error",
  );
  assert.ok(started.includes(1));
  assert.equal(finished.includes(1), false);

  releaseSlow();
  await assert.rejects(run, /boom/);
  assert.ok(finished.includes(1), "in-flight sibling must finish before reject");
  assert.deepEqual(
    [...started].sort((a, b) => a - b),
    [0, 1],
    "must not claim additional queue items after the first error",
  );
});

test("runSftpTransferWorkers drains siblings and stops new claims after an error", async () => {
  const started: number[] = [];
  const finished: number[] = [];
  let releaseSlow!: () => void;
  const slowGate = new Promise<void>((resolve) => {
    releaseSlow = resolve;
  });

  const run = runSftpTransferWorkers([0, 1, 2, 3, 4], () => 2, async (item) => {
    started.push(item);
    if (item === 0) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      throw new Error("session lost");
    }
    if (item === 1) {
      await slowGate;
    }
    finished.push(item);
  });

  await new Promise((resolve) => setTimeout(resolve, 30));
  let settledEarly = false;
  await Promise.race([
    run.then(
      () => { settledEarly = true; },
      () => { settledEarly = true; },
    ),
    new Promise((resolve) => setTimeout(resolve, 5)),
  ]);
  assert.equal(settledEarly, false);
  releaseSlow();
  await assert.rejects(run, /session lost/);
  assert.ok(finished.includes(1));
  assert.deepEqual([...started].sort((a, b) => a - b), [0, 1]);
});

test("beforeClaim runs before claiming the next queue index", async () => {
  const events: string[] = [];
  let paused = true;

  const run = runSftpTransferWorkers(
    ["a", "b"],
    () => 1,
    async (item) => {
      events.push(`work:${item}`);
    },
    {
      beforeClaim: async () => {
        events.push("claim-gate");
        while (paused) {
          await new Promise((resolve) => setTimeout(resolve, 5));
        }
      },
    },
  );

  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(events, ["claim-gate"]);
  paused = false;
  await run;
  assert.deepEqual(events, ["claim-gate", "work:a", "claim-gate", "work:b"]);
});
