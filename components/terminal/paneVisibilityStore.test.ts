import assert from "node:assert/strict";
import test from "node:test";

import {
  getPaneVisible,
  hasPaneVisibilityEntry,
  removePaneVisible,
  resolvePaneVisible,
  setPaneVisible,
} from "./paneVisibilityStore.ts";

const SESSION_ID = "test-session-popup-fallback";

test("resolvePaneVisible falls back to the prop when the store has no entry", () => {
  removePaneVisible(SESSION_ID);
  assert.equal(hasPaneVisibilityEntry(SESSION_ID), false);
  assert.equal(getPaneVisible(SESSION_ID), false);
  assert.equal(resolvePaneVisible(SESSION_ID, true), true);
  assert.equal(resolvePaneVisible(SESSION_ID, false), false);
});

test("resolvePaneVisible prefers the store when an entry exists", () => {
  setPaneVisible(SESSION_ID, false);
  assert.equal(resolvePaneVisible(SESSION_ID, true), false);
  setPaneVisible(SESSION_ID, true);
  assert.equal(resolvePaneVisible(SESSION_ID, false), true);
  removePaneVisible(SESSION_ID);
});
