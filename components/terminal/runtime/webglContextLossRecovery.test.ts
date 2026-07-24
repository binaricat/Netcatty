import assert from "node:assert/strict";
import test from "node:test";
import { createWebglRendererController } from "./webglRendererController";

class FakeAddon {
  contextLoss: (() => void) | null = null;
  disposeCalls = 0;

  onContextLoss(callback: () => void) {
    this.contextLoss = callback;
  }

  dispose() {
    this.disposeCalls += 1;
  }

  loseContext() {
    assert.ok(this.contextLoss, "addon must install a context-loss handler");
    this.contextLoss();
  }
}

function createHarness(options: { failLoads?: Set<number>; enabled?: boolean } = {}) {
  let time = 0;
  let nextTimerId = 1;
  const timers = new Map<number, () => void>();
  const addons: FakeAddon[] = [];
  const loadedStates: boolean[] = [];
  const warnings: string[] = [];
  let repaintCalls = 0;
  let loadCalls = 0;

  const controller = createWebglRendererController({
    enabled: options.enabled ?? true,
    createAddon: () => {
      const addon = new FakeAddon();
      addons.push(addon);
      return addon;
    },
    loadAddon: () => {
      loadCalls += 1;
      if (options.failLoads?.has(loadCalls)) throw new Error(`load ${loadCalls} failed`);
    },
    repaint: () => {
      repaintCalls += 1;
    },
    setLoaded: (loaded) => loadedStates.push(loaded),
    warn: (message) => warnings.push(message),
    now: () => time,
    setTimer: (callback) => {
      const id = nextTimerId++;
      timers.set(id, callback);
      return id as unknown as ReturnType<typeof setTimeout>;
    },
    clearTimer: (id) => timers.delete(id as unknown as number),
  });

  return {
    controller,
    addons,
    loadedStates,
    warnings,
    get repaintCalls() { return repaintCalls; },
    get loadCalls() { return loadCalls; },
    get pendingTimers() { return timers.size; },
    setTime(value: number) { time = value; },
    runNextTimer() {
      const entry = timers.entries().next().value as [number, () => void] | undefined;
      assert.ok(entry, "expected a pending timer");
      timers.delete(entry[0]);
      entry[1]();
    },
  };
}

test("context loss schedules one recovery and repaints the DOM fallback", () => {
  const harness = createHarness();
  harness.controller.ensure();

  harness.addons[0].loseContext();
  harness.addons[0].loseContext();

  assert.equal(harness.pendingTimers, 1);
  assert.equal(harness.addons[0].disposeCalls, 1);
  assert.equal(harness.repaintCalls, 1);
  assert.equal(harness.loadedStates.at(-1), false);

  harness.runNextTimer();
  assert.equal(harness.loadCalls, 2);
  assert.equal(harness.repaintCalls, 2);
  assert.equal(harness.loadedStates.at(-1), true);
});

test("burst losses trip a persistent breaker that ensure and suspend cannot rearm", () => {
  const harness = createHarness();
  harness.controller.ensure();
  for (let loss = 0; loss < 3; loss += 1) {
    harness.setTime(loss * 100);
    harness.addons[loss].loseContext();
    if (loss < 2) harness.runNextTimer();
  }

  assert.equal(harness.pendingTimers, 0);
  assert.ok(harness.warnings.some((warning) => warning.includes("staying on DOM renderer")));
  assert.equal(harness.loadCalls, 3);

  harness.controller.ensure();
  harness.controller.suspend();
  harness.controller.ensure();
  assert.equal(harness.loadCalls, 3);
  assert.equal(harness.loadedStates.at(-1), false);
});

// Periodic GPU context loss (~every 15s on some Linux drivers) must still trip the
// breaker. A short recovery window ages each prior loss out, so WebGL keeps
// dispose -> rebuild cycling and the terminal flashes forever (#2436).
test("periodic losses spaced ~15s apart trip the breaker instead of flashing forever", () => {
  const harness = createHarness();
  harness.controller.ensure();

  for (let loss = 0; loss < 3; loss += 1) {
    harness.setTime(loss * 15_000);
    harness.addons[loss].loseContext();
    if (loss < 2) harness.runNextTimer();
  }

  assert.equal(harness.pendingTimers, 0);
  assert.ok(harness.warnings.some((warning) => warning.includes("staying on DOM renderer")));
  assert.equal(harness.loadCalls, 3);
  assert.equal(harness.controller.getAddon(), null);
  assert.equal(harness.loadedStates.at(-1), false);

  harness.controller.ensure();
  assert.equal(harness.loadCalls, 3);
});

test("a quiet gap longer than the recovery window allows a fresh recovery", () => {
  const harness = createHarness();
  harness.controller.ensure();

  harness.setTime(0);
  harness.addons[0].loseContext();
  harness.runNextTimer();
  harness.setTime(15_000);
  harness.addons[1].loseContext();
  harness.runNextTimer();

  // After the recovery window elapses with no further losses, a later single
  // loss should recover once rather than staying broken forever.
  harness.setTime(15_000 + 60_001);
  harness.addons[2].loseContext();
  assert.equal(harness.pendingTimers, 1);
  harness.runNextTimer();
  assert.equal(harness.loadCalls, 4);
  assert.equal(harness.loadedStates.at(-1), true);
});

test("suspend and dispose cancel pending recovery callbacks", () => {
  for (const action of ["suspend", "dispose"] as const) {
    const harness = createHarness();
    harness.controller.ensure();
    harness.addons[0].loseContext();
    assert.equal(harness.pendingTimers, 1);

    harness.controller[action]();
    assert.equal(harness.pendingTimers, 0);
    assert.equal(harness.loadCalls, 1);
  }
});

test("a stale context-loss callback from a replaced addon is ignored", () => {
  const harness = createHarness();
  harness.controller.ensure();
  const staleAddon = harness.addons[0];
  staleAddon.loseContext();
  harness.runNextTimer();
  const repaintCalls = harness.repaintCalls;

  staleAddon.loseContext();
  assert.equal(harness.pendingTimers, 0);
  assert.equal(harness.repaintCalls, repaintCalls);
  assert.equal(staleAddon.disposeCalls, 1);
  assert.equal(harness.controller.getAddon(), harness.addons[1]);
});

test("recovery load failure stays on DOM and still repaints the viewport", () => {
  const harness = createHarness({ failLoads: new Set([2]) });
  harness.controller.ensure();
  harness.addons[0].loseContext();
  harness.runNextTimer();

  assert.equal(harness.controller.getAddon(), null);
  assert.equal(harness.loadedStates.at(-1), false);
  assert.equal(harness.addons[1].disposeCalls, 1);
  assert.equal(harness.repaintCalls, 2);
  assert.ok(harness.warnings.some((warning) => warning.includes("using DOM renderer")));
});

test("disabled WebGL ensure is a no-op", () => {
  const harness = createHarness({ enabled: false });
  harness.controller.ensure();
  assert.equal(harness.loadCalls, 0);
  assert.equal(harness.addons.length, 0);
});
