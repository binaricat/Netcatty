import assert from "node:assert/strict";
import test from "node:test";

import {
  normalizeHibernateKeepRendererCount,
  normalizeHibernateReplayChunkBytes,
  resolveHibernateSkipAltScreen,
} from "./terminalHibernate.ts";

test("normalizeHibernateReplayChunkBytes clamps to allowed range", () => {
  assert.equal(normalizeHibernateReplayChunkBytes(undefined), 16 * 1024);
  assert.equal(normalizeHibernateReplayChunkBytes(8 * 1024), 8 * 1024);
  assert.equal(normalizeHibernateReplayChunkBytes(1), 4 * 1024);
  assert.equal(normalizeHibernateReplayChunkBytes(999_999), 64 * 1024);
});

test("normalizeHibernateKeepRendererCount clamps to allowed range", () => {
  assert.equal(normalizeHibernateKeepRendererCount(undefined), 2);
  assert.equal(normalizeHibernateKeepRendererCount(4), 4);
  assert.equal(normalizeHibernateKeepRendererCount(-1), 0);
  assert.equal(normalizeHibernateKeepRendererCount(99), 12);
});

test("resolveHibernateSkipAltScreen defaults to enabled", () => {
  assert.equal(resolveHibernateSkipAltScreen(), true);
  assert.equal(resolveHibernateSkipAltScreen({ hibernateSkipAltScreen: false }), false);
});
