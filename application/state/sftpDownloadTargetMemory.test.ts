import assert from "node:assert/strict";
import test from "node:test";

import {
  DOWNLOAD_TARGET_MEMORY_LIMIT,
  getRememberedDownloadTarget,
  makeDownloadTargetMemoryKey,
  rememberDownloadTarget,
} from "./sftpDownloadTargetMemory.ts";

test("target memory keys on host + source path and is LRU-bounded", () => {
  const key = makeDownloadTargetMemoryKey("host-1", "/tmp/f.log");
  assert.equal(getRememberedDownloadTarget(key), undefined);

  rememberDownloadTarget(key, "/downloads/f.log");
  assert.equal(getRememberedDownloadTarget(key), "/downloads/f.log");
  // Re-remembering refreshes instead of failing.
  rememberDownloadTarget(key, "/other/renamed.log");
  assert.equal(getRememberedDownloadTarget(key), "/other/renamed.log");

  const first = makeDownloadTargetMemoryKey("host-1", "/first");
  rememberDownloadTarget(first, "/a");
  for (let i = 0; i < DOWNLOAD_TARGET_MEMORY_LIMIT; i++) {
    rememberDownloadTarget(makeDownloadTargetMemoryKey("host-2", `/p/${i}`), `/d/${i}`);
  }
  // Oldest entry was evicted; the most recent insertions survive.
  assert.equal(getRememberedDownloadTarget(first), undefined);
  const lastKey = makeDownloadTargetMemoryKey("host-2", `/p/${DOWNLOAD_TARGET_MEMORY_LIMIT - 1}`);
  assert.equal(getRememberedDownloadTarget(lastKey), `/d/${DOWNLOAD_TARGET_MEMORY_LIMIT - 1}`);
});
