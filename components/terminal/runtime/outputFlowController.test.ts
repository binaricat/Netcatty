import test from "node:test";
import assert from "node:assert/strict";

import { createOutputFlowController } from "./outputFlowController.ts";

function make(high = 100, low = 30) {
  const events: string[] = [];
  const controller = createOutputFlowController({
    highWaterMark: high,
    lowWaterMark: low,
    onPause: () => events.push("pause"),
    onResume: () => events.push("resume"),
  });
  return { controller, events };
}

test("does not pause while below the high watermark", () => {
  const { controller, events } = make(100, 30);
  controller.received(50);
  controller.received(49); // 99 < 100
  assert.deepEqual(events, []);
  assert.equal(controller.isPaused(), false);
});

test("pauses once when crossing the high watermark", () => {
  const { controller, events } = make(100, 30);
  controller.received(60);
  controller.received(60); // 120 >= 100 -> pause
  assert.deepEqual(events, ["pause"]);
  assert.equal(controller.isPaused(), true);
  // Further received while already paused must not re-fire pause.
  controller.received(100);
  assert.deepEqual(events, ["pause"]);
});

test("resumes once when draining to at/below the low watermark", () => {
  const { controller, events } = make(100, 30);
  controller.received(120); // pause
  controller.written(50); // 70 still > 30, no resume
  assert.deepEqual(events, ["pause"]);
  controller.written(50); // 20 <= 30 -> resume
  assert.deepEqual(events, ["pause", "resume"]);
  assert.equal(controller.isPaused(), false);
});

test("does not resume when still above the low watermark", () => {
  const { controller, events } = make(100, 30);
  controller.received(120); // pause
  controller.written(80); // 40 > 30
  assert.deepEqual(events, ["pause"]);
  assert.equal(controller.isPaused(), true);
});

test("never lets pending go negative", () => {
  const { controller } = make(100, 30);
  controller.received(10);
  controller.written(50); // over-written
  assert.equal(controller.pendingBytes(), 0);
});

test("supports repeated pause/resume cycles", () => {
  const { controller, events } = make(100, 30);
  controller.received(120); // pause
  controller.written(120); // resume (0 <= 30)
  controller.received(120); // pause again
  controller.written(120); // resume again
  assert.deepEqual(events, ["pause", "resume", "pause", "resume"]);
});

test("reset clears state and resumes when paused", () => {
  const { controller, events } = make(100, 30);
  controller.received(120); // pause
  controller.reset();
  assert.equal(controller.isPaused(), false);
  assert.equal(controller.pendingBytes(), 0);
  assert.deepEqual(events, ["pause", "resume"]);
  controller.received(120);
  assert.deepEqual(events, ["pause", "resume", "pause"]);
});

test("ignores non-positive amounts", () => {
  const { controller, events } = make(100, 30);
  controller.received(0);
  controller.written(0);
  controller.received(-5);
  assert.equal(controller.pendingBytes(), 0);
  assert.deepEqual(events, []);
});
