import assert from "node:assert/strict";
import test from "node:test";

import {
  createGlobalSftpTransferScheduler,
} from "./globalTransferScheduler";
import { resolveProgressiveFolderUploadConcurrency } from "../../../lib/progressiveFolderUpload";
import {
  DEFAULT_SFTP_FILE_TRANSFER_CONCURRENCY,
  resolveSftpTransferConcurrency,
} from "./transferConcurrency";

test("scheduler limits each remote host independently", async () => {
  const scheduler = createGlobalSftpTransferScheduler();
  const releases: Array<() => void> = [];
  let active = 0;
  let maxActive = 0;
  let id = 0;
  const run = (ownerId: string, hostId: string) => scheduler.run(ownerId, `${ownerId}-${id += 1}`, [hostId], () => 1, async () => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    await new Promise<void>((resolve) => releases.push(resolve));
    active -= 1;
  });

  const jobs = [run("a", "host-a"), run("a", "host-a"), run("b", "host-b")];
  while (releases.length < 2) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(maxActive, 2);
  releases.splice(0).forEach((release) => release());
  while (releases.length < 1) await new Promise((resolve) => setImmediate(resolve));
  releases.splice(0).forEach((release) => release());
  await jobs;
  assert.equal(maxActive, 2);
});

test("progressive folder uploads use six slots by default and preserve a saved limit", async () => {
  const displayedDefault = resolveSftpTransferConcurrency(() => null);
  const effectiveDefault = resolveProgressiveFolderUploadConcurrency(null);
  assert.equal(displayedDefault, DEFAULT_SFTP_FILE_TRANSFER_CONCURRENCY);
  assert.equal(effectiveDefault, displayedDefault);
  assert.equal(effectiveDefault, 6);
  assert.equal(resolveProgressiveFolderUploadConcurrency(3), 3);
  assert.equal(resolveProgressiveFolderUploadConcurrency(99), 6);

  const scheduler = createGlobalSftpTransferScheduler();
  const releases: Array<() => void> = [];
  let active = 0;
  let maxActive = 0;
  const jobs = Array.from({ length: 8 }, (_, index) => scheduler.run(
    "progressive",
    `file-${index}`,
    ["host:one"],
    () => null,
    async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise<void>((resolve) => releases.push(resolve));
      active -= 1;
    },
  ));

  while (releases.length < 6) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(maxActive, 6);
  releases.splice(0).forEach((release) => release());
  while (releases.length < 2) await new Promise((resolve) => setImmediate(resolve));
  releases.splice(0).forEach((release) => release());
  await Promise.all(jobs);
});

test("scheduler alternates owners when both have queued work", async () => {
  const scheduler = createGlobalSftpTransferScheduler();
  const order: string[] = [];
  let releaseFirst: (() => void) | undefined;

  const first = scheduler.run("a", "a1", ["host"], () => 1, async () => {
    order.push("a1");
    await new Promise<void>((resolve) => { releaseFirst = resolve; });
  });
  const a2 = scheduler.run("a", "a2", ["host"], () => 1, async () => { order.push("a2"); });
  const b1 = scheduler.run("b", "b1", ["host"], () => 1, async () => { order.push("b1"); });

  while (!releaseFirst) await new Promise((resolve) => setImmediate(resolve));
  releaseFirst();
  await Promise.all([first, a2, b1]);
  assert.deepEqual(order, ["a1", "b1", "a2"]);
});

test("prioritize moves a queued transfer ahead of fairness ordering", async () => {
  const scheduler = createGlobalSftpTransferScheduler();
  const order: string[] = [];
  let releaseFirst: (() => void) | undefined;
  const first = scheduler.run("a", "a1", ["host"], () => 1, async () => {
    order.push("a1");
    await new Promise<void>((resolve) => { releaseFirst = resolve; });
  });
  const b1 = scheduler.run("b", "b1", ["host"], () => 1, async () => { order.push("b1"); });
  const a2 = scheduler.run("a", "a2", ["host"], () => 1, async () => { order.push("a2"); });
  scheduler.prioritize("a2");
  while (!releaseFirst) await new Promise((resolve) => setImmediate(resolve));
  releaseFirst();
  await Promise.all([first, b1, a2]);
  assert.deepEqual(order, ["a1", "a2", "b1"]);
});

test("queued work stays paused until resumed and can be cancelled", async () => {
  const scheduler = createGlobalSftpTransferScheduler();
  const order: string[] = [];
  let releaseFirst: (() => void) | undefined;
  const first = scheduler.run("a", "a1", ["host"], () => 1, async () => {
    await new Promise<void>((resolve) => { releaseFirst = resolve; });
  });
  const paused = scheduler.run("b", "b1", ["host"], () => 1, async () => { order.push("b1"); });
  const cancelled = scheduler.run("c", "c1", ["host"], () => 1, async () => { order.push("c1"); });
  assert.equal(scheduler.pause("b1"), true);
  assert.equal(scheduler.cancel("c1"), true);
  while (!releaseFirst) await new Promise((resolve) => setImmediate(resolve));
  releaseFirst();
  await first;
  await assert.rejects(cancelled, /Transfer cancelled/);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(order, []);
  assert.equal(scheduler.resume("b1"), true);
  await paused;
  assert.deepEqual(order, ["b1"]);
});

test("enqueuing a large blocked batch does not repeatedly inspect the existing queue", async () => {
  const scheduler = createGlobalSftpTransferScheduler();
  let release: (() => void) | undefined;
  let limitReads = 0;
  const readLimit = () => { limitReads += 1; return 1; };
  const blocker = scheduler.run("panel", "active", ["host"], readLimit, () => (
    new Promise<void>((resolve) => { release = resolve; })
  ));
  const count = 2_000;
  const completed: number[] = [];
  const jobs = Array.from({ length: count }, (_, index) => scheduler.run(
    "panel", `queued-${index}`, ["host"], readLimit,
    async () => { completed.push(index); },
  ));
  await new Promise((resolve) => setImmediate(resolve));
  const readsWhileBlocked = limitReads;
  release?.();
  await Promise.all([blocker, ...jobs]);

  assert.deepEqual(completed, Array.from({ length: count }, (_, index) => index));
  assert.ok(readsWhileBlocked <= count * 3,
    `a blocked batch should be inspected linearly, got ${readsWhileBlocked} limit reads for ${count} files`);
});

test("large batches of immediately completed files yield to user input", async () => {
  const scheduler = createGlobalSftpTransferScheduler();
  let completed = 0;
  const count = 1_000;
  const inputTurn = new Promise<number>((resolve) => setTimeout(() => resolve(completed), 0));
  const jobs = Array.from({ length: count }, (_, index) => scheduler.run(
    "panel", `tiny-${index}`, ["host"], () => 2, async () => { completed += 1; },
  ));
  const completedAtInput = await inputTurn;
  await Promise.all(jobs);
  assert.ok(completedAtInput < count, "input must run before the entire batch drains");
  assert.equal(completed, count);
});

test("a synchronous job failure releases its slot for queued work", async () => {
  const scheduler = createGlobalSftpTransferScheduler();
  const failed = scheduler.run("panel", "failed", ["host"], () => 1, () => { throw new Error("read failed"); });
  const next = scheduler.run("panel", "next", ["host"], () => 1, async () => "completed");
  await assert.rejects(failed, /read failed/);
  assert.equal(await next, "completed");
});
