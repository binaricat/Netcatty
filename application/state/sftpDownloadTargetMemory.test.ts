import assert from "node:assert/strict";
import test from "node:test";

import {
  DOWNLOAD_TARGET_MEMORY_LIMIT,
  createSftpDownloadTargetMemory,
  makeDownloadTargetMemoryKey,
} from "./sftpDownloadTargetMemory.ts";

test("target memory keys on host + source path and is LRU-bounded", () => {
  const memory = createSftpDownloadTargetMemory();
  const key = makeDownloadTargetMemoryKey("host-1", "/tmp/f.log");
  assert.equal(memory.getRememberedDownloadTarget(key), undefined);

  memory.rememberDownloadTarget(key, "/downloads/f.log");
  assert.equal(memory.getRememberedDownloadTarget(key), "/downloads/f.log");
  // Re-remembering refreshes instead of failing.
  memory.rememberDownloadTarget(key, "/other/renamed.log");
  assert.equal(memory.getRememberedDownloadTarget(key), "/other/renamed.log");

  const first = makeDownloadTargetMemoryKey("host-1", "/first");
  memory.rememberDownloadTarget(first, "/a");
  for (let i = 0; i < DOWNLOAD_TARGET_MEMORY_LIMIT; i++) {
    memory.rememberDownloadTarget(makeDownloadTargetMemoryKey("host-2", `/p/${i}`), `/d/${i}`);
  }
  // Oldest entry was evicted; the most recent insertions survive.
  assert.equal(memory.getRememberedDownloadTarget(first), undefined);
  const lastKey = makeDownloadTargetMemoryKey("host-2", `/p/${DOWNLOAD_TARGET_MEMORY_LIMIT - 1}`);
  assert.equal(memory.getRememberedDownloadTarget(lastKey), `/d/${DOWNLOAD_TARGET_MEMORY_LIMIT - 1}`);
});

test("successful reads refresh recency so active entries survive eviction", () => {
  // Without a read, the entry is evicted once the limit is reached again.
  const plain = createSftpDownloadTargetMemory();
  const staleKey = makeDownloadTargetMemoryKey("host-1", "/stale");
  plain.rememberDownloadTarget(staleKey, "/stale-path");
  for (let i = 0; i < DOWNLOAD_TARGET_MEMORY_LIMIT; i++) {
    plain.rememberDownloadTarget(makeDownloadTargetMemoryKey("host-2", `/p/${i}`), `/d/${i}`);
  }
  // The stale (oldest) entry was evicted.
  assert.equal(plain.getRememberedDownloadTarget(staleKey), undefined);

  // With a successful read, the entry is refreshed and survives the same churn.
  const memory = createSftpDownloadTargetMemory();
  const keptKey = makeDownloadTargetMemoryKey("host-1", "/keep");
  memory.rememberDownloadTarget(keptKey, "/keep-path");
  memory.rememberDownloadTarget(makeDownloadTargetMemoryKey("host-1", "/filler"), "/filler");
  assert.equal(memory.getRememberedDownloadTarget(keptKey), "/keep-path");
  for (let i = 0; i < DOWNLOAD_TARGET_MEMORY_LIMIT - 1; i++) {
    memory.rememberDownloadTarget(makeDownloadTargetMemoryKey("host-2", `/p/${i}`), `/d/${i}`);
  }
  assert.equal(memory.getRememberedDownloadTarget(keptKey), "/keep-path");
});

test("instances are independent so surfaces do not share destinations", () => {
  const view = createSftpDownloadTargetMemory();
  const sidePanel = createSftpDownloadTargetMemory();
  const key = makeDownloadTargetMemoryKey("host-1", "/tmp/f.log");

  view.rememberDownloadTarget(key, "/view-path");
  assert.equal(view.getRememberedDownloadTarget(key), "/view-path");
  assert.equal(sidePanel.getRememberedDownloadTarget(key), undefined);

  sidePanel.rememberDownloadTarget(key, "/panel-path");
  assert.equal(sidePanel.getRememberedDownloadTarget(key), "/panel-path");
  assert.equal(view.getRememberedDownloadTarget(key), "/view-path");
});
