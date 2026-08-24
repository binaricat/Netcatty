import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  CONNECTION_PROGRESS_CAP,
  CONNECTION_PROGRESS_START,
  advanceIndeterminateConnectionProgress,
  advanceMonotonicConnectionProgress,
  resolveHopConnectionProgress,
} from "./connectionProgress";

test("indeterminate connection progress only moves forward toward the cap", () => {
  assert.equal(advanceIndeterminateConnectionProgress(CONNECTION_PROGRESS_CAP), CONNECTION_PROGRESS_CAP);
  assert.equal(advanceIndeterminateConnectionProgress(94), CONNECTION_PROGRESS_CAP);
  const first = advanceIndeterminateConnectionProgress(CONNECTION_PROGRESS_START);
  assert.ok(first > CONNECTION_PROGRESS_START);
  assert.ok(first < CONNECTION_PROGRESS_CAP);
  const second = advanceIndeterminateConnectionProgress(first);
  assert.ok(second > first);
});

test("hop connection progress stays within the visual cap", () => {
  assert.equal(resolveHopConnectionProgress(1, 1), 90);
  assert.equal(resolveHopConnectionProgress(1, 2), 50);
  assert.equal(resolveHopConnectionProgress(2, 2), 90);
  assert.equal(resolveHopConnectionProgress(0, 1), 10);
});

test("connection progress updates never rewind", () => {
  assert.equal(advanceMonotonicConnectionProgress(40, 10), 40);
  assert.equal(advanceMonotonicConnectionProgress(40, 90), 90);
  assert.equal(advanceMonotonicConnectionProgress(5, 5), 5);
});

test("connecting seeds progress once and hop/phase changes do not snap it back", () => {
  const effectsSource = readFileSync(new URL("./useTerminalEffects.ts", import.meta.url), "utf8");
  assert.match(
    effectsSource,
    /if \(status === "connecting"\) \{\s*setIsDisconnectedDialogDismissed\(false\);\s*setProgressValue\(CONNECTION_PROGRESS_START\);/,
  );
  assert.match(effectsSource, /setProgressValue\(advanceIndeterminateConnectionProgress\)/);
  assert.doesNotMatch(effectsSource, /setProgressValue\(5\)/);

  const starterSource = readFileSync(
    new URL("./runtime/createTerminalSessionStarters.ts", import.meta.url),
    "utf8",
  );
  assert.match(starterSource, /advanceMonotonicConnectionProgress/);
  assert.match(starterSource, /resolveHopConnectionProgress/);
});
