import assert from "node:assert/strict";
import test from "node:test";
import { createWebglContextBudget } from "./webglContextBudget";
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

function createClock() {
  let time = 0;
  let nextTimerId = 1;
  const timers = new Map<number, { at: number; run: () => void }>();
  return {
    now: () => time,
    setTimer: (run: () => void, delayMs: number) => {
      const id = nextTimerId++;
      timers.set(id, { at: time + delayMs, run });
      return id as unknown as ReturnType<typeof setTimeout>;
    },
    clearTimer: (id: ReturnType<typeof setTimeout>) => {
      timers.delete(id as unknown as number);
    },
    get pendingTimers() { return timers.size; },
    advance(ms: number) {
      const end = time + ms;
      for (;;) {
        const next = [...timers.entries()]
          .filter(([, timer]) => timer.at <= end)
          .sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) break;
        timers.delete(next[0]);
        time = next[1].at;
        next[1].run();
      }
      time = end;
    },
  };
}

function setup(maxActiveContexts = 12) {
  const clock = createClock();
  const budget = createWebglContextBudget({
    maxActiveContexts,
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  });

  const createPane = (initiallyVisible = true) => {
    let visible = initiallyVisible;
    const addons: FakeAddon[] = [];
    const warnings: string[] = [];
    let loaded = false;
    const controller = createWebglRendererController({
      enabled: true,
      createAddon: () => {
        const addon = new FakeAddon();
        addons.push(addon);
        return addon;
      },
      loadAddon: () => {},
      repaint: () => {},
      setLoaded: (value) => { loaded = value; },
      warn: (message) => warnings.push(message),
      now: clock.now,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
      budget,
      isVisible: () => visible,
    });
    return {
      controller,
      addons,
      warnings,
      get loaded() { return loaded; },
      /** Change visibility the way useTerminalEffects does: ref, then sync. */
      setVisible(value: boolean) {
        visible = value;
        controller.syncVisibility();
      },
      /** Change only the live ref, as if a sync never reached this runtime. */
      setVisibleWithoutSync(value: boolean) {
        visible = value;
      },
      reveal() {
        this.setVisible(true);
        controller.ensure();
      },
    };
  };

  return { clock, budget, createPane };
}

test("a context lost while hidden waits for the pane to be shown", () => {
  const { clock, createPane } = setup();
  const pane = createPane();
  pane.controller.ensure();
  pane.setVisible(false);

  pane.addons[0].loseContext();

  assert.equal(pane.loaded, false);
  assert.equal(clock.pendingTimers, 0, "no rebuild while nothing is drawn");
  assert.ok(pane.warnings.some((warning) => warning.includes("rebuilding when shown")));

  clock.advance(60_000);
  assert.equal(pane.addons.length, 1);

  pane.reveal();
  assert.equal(pane.addons.length, 2);
  assert.equal(pane.loaded, true);
});

test("a recovery scheduled while visible is dropped if the pane is hidden first", () => {
  const { clock, createPane } = setup();
  const pane = createPane();
  pane.controller.ensure();
  pane.addons[0].loseContext();
  assert.equal(clock.pendingTimers, 1);

  pane.setVisible(false);
  clock.advance(50);
  assert.equal(pane.addons.length, 1);
  assert.equal(pane.loaded, false);

  pane.reveal();
  assert.equal(pane.addons.length, 2);
});

test("evictions while hidden do not trip the context-loss breaker", () => {
  const { clock, createPane } = setup();
  const pane = createPane();
  pane.controller.ensure();

  for (let round = 0; round < 5; round += 1) {
    pane.setVisible(false);
    pane.addons.at(-1)!.loseContext();
    clock.advance(1_000);
    pane.reveal();
    assert.equal(pane.loaded, true, `round ${round} rebuilt on reveal`);
  }
  assert.ok(!pane.warnings.some((warning) => warning.includes("staying on DOM renderer")));
});

test("panes past the budget give up WebGL after staying hidden, and get it back when shown", () => {
  const { clock, budget, createPane } = setup(2);
  const background = createPane();
  const other = createPane();
  background.controller.ensure();
  other.controller.ensure();
  background.setVisible(false);

  clock.advance(3_000);
  const front = createPane();
  front.controller.ensure();

  assert.equal(background.loaded, false);
  assert.equal(background.addons[0].disposeCalls, 1);
  assert.equal(other.loaded, true);
  assert.equal(front.loaded, true);
  assert.equal(budget.getActiveCount(), 2);

  front.setVisible(false);
  background.reveal();
  assert.equal(background.loaded, true);
  assert.equal(budget.getActiveCount(), 3, "the pane just hidden keeps WebGL for a while");

  clock.advance(3_000);
  assert.equal(front.loaded, false);
  assert.equal(budget.getActiveCount(), 2);
});

test("simultaneous visible ensures stay within the context budget", () => {
  const { budget, createPane } = setup();
  const panes = Array.from({ length: 13 }, () => createPane());
  for (const pane of panes) pane.controller.ensure();

  assert.deepEqual(panes.map((pane) => pane.loaded), [...Array(12).fill(true), false]);
  assert.equal(panes[12].addons.length, 0);
  assert.equal(budget.getActiveCount(), 12);
});

test("visible context loss recovers at the cap, including with a refused visible pane", () => {
  for (const withOverflow of [false, true]) {
    const { clock, budget, createPane } = setup(2);
    const panes = [createPane(), createPane()];
    for (const pane of panes) pane.controller.ensure();
    const overflow = withOverflow ? createPane() : null;
    overflow?.controller.ensure();
    assert.equal(overflow?.addons.length ?? 0, 0);
    assert.equal(budget.getActiveCount(), 2);

    panes[0].addons[0].loseContext();
    assert.equal(budget.getActiveCount(), 1);
    clock.advance(49);
    assert.equal(panes[0].loaded, false);
    clock.advance(1);
    assert.equal(panes[0].loaded, true);
    assert.equal(panes[0].addons.length, 2);
    assert.equal(panes[1].addons.length, 1);
    overflow?.controller.ensure();
    assert.equal(overflow?.addons.length ?? 0, 0);
    assert.equal(budget.getActiveCount(), 2);
    assert.equal(clock.pendingTimers, 0);
    assert.ok(panes.every((pane) => !pane.warnings.some((warning) => warning.includes("staying on DOM renderer"))));
  }
});

test("visible loss stays on DOM if another visible pane takes the freed slot before recovery", () => {
  const { clock, budget, createPane } = setup(2);
  const panes = [createPane(), createPane(), createPane()];
  for (const pane of panes) pane.controller.ensure();
  assert.equal(panes[2].loaded, false);

  panes[0].addons[0].loseContext();
  panes[2].controller.ensure();
  assert.equal(panes[2].loaded, true);
  clock.advance(50);

  assert.equal(panes[0].loaded, false);
  assert.deepEqual(panes.map((pane) => pane.addons.length), [1, 1, 1]);
  assert.equal(budget.getActiveCount(), 2);
  assert.equal(clock.pendingTimers, 0);
  assert.ok(panes.every((pane) => !pane.warnings.some((warning) => warning.includes("staying on DOM renderer"))));
});

test("a hidden pane mounted past the budget keeps the DOM renderer until shown", () => {
  const { clock, budget, createPane } = setup(1);
  const occupant = createPane();
  occupant.controller.ensure();

  const hidden = createPane(false);
  hidden.controller.ensure();
  assert.equal(hidden.addons.length, 0);
  assert.equal(budget.getActiveCount(), 1);

  occupant.setVisible(false);
  clock.advance(3_000);
  hidden.reveal();
  assert.equal(hidden.loaded, true);
  assert.equal(occupant.loaded, false);
  assert.equal(budget.getActiveCount(), 1);
});

test("revealing a hidden pane is refused while visible holders fill the budget", () => {
  const { budget, createPane } = setup(1);
  const occupant = createPane();
  occupant.controller.ensure();
  const hidden = createPane(false);
  hidden.controller.ensure();
  hidden.reveal();

  assert.equal(hidden.loaded, false);
  assert.equal(hidden.addons.length, 0);
  assert.equal(occupant.loaded, true);
  assert.equal(budget.getActiveCount(), 1);
});

test("a holder on screen is never released, even if a sync was missed", () => {
  const { clock, budget, createPane } = setup(1);
  const visible = createPane();
  visible.controller.ensure();
  visible.setVisible(false);
  clock.advance(10_000);

  visible.setVisibleWithoutSync(true);
  createPane().controller.ensure();
  clock.advance(10_000);
  assert.equal(visible.loaded, true);
  assert.equal(budget.getActiveCount(), 1);

  const late = createPane(false);
  late.setVisibleWithoutSync(true);
  late.controller.ensure();
  assert.equal(late.loaded, false);
  assert.equal(late.addons.length, 0);
  assert.equal(budget.getActiveCount(), 1);
});

test("grace overflow never releases a holder shown again without a visibility sync", () => {
  const { clock, budget, createPane } = setup(1);
  const holder = createPane();
  holder.controller.ensure();
  holder.setVisible(false);
  const front = createPane();
  front.controller.ensure();
  assert.equal(budget.getActiveCount(), 2);

  holder.setVisibleWithoutSync(true);
  clock.advance(3_000);
  assert.equal(holder.loaded, true);
  assert.equal(front.loaded, true);
  assert.equal(holder.addons[0].disposeCalls, 0);

  front.addons[0].loseContext();
  clock.advance(50);
  assert.equal(front.loaded, false, "recovery cannot exceed a cap already filled by visible holders");
  assert.equal(front.addons.length, 1);
  assert.equal(budget.getActiveCount(), 1);
  assert.equal(clock.pendingTimers, 0);
});

test("suspend, dispose and failed loads return the budget slot", () => {
  const { budget, createPane } = setup();
  const suspended = createPane();
  suspended.controller.ensure();
  suspended.controller.suspend();
  const disposed = createPane();
  disposed.controller.ensure();
  disposed.controller.dispose();
  assert.equal(budget.getActiveCount(), 0);

  const failing = createWebglRendererController({
    enabled: true,
    createAddon: () => new FakeAddon(),
    loadAddon: () => { throw new Error("no WebGL"); },
    repaint: () => {},
    setLoaded: () => {},
    warn: () => {},
    budget,
  });
  failing.ensure();
  assert.equal(budget.getActiveCount(), 0);
});

test("every teardown goes through disposeAddon so the context can be released", () => {
  const clock = createClock();
  const released: FakeAddon[] = [];
  const make = (failLoad = false) => createWebglRendererController<FakeAddon>({
    enabled: true,
    createAddon: () => new FakeAddon(),
    loadAddon: () => {
      if (failLoad) throw new Error("no WebGL");
    },
    repaint: () => {},
    setLoaded: () => {},
    warn: () => {},
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    disposeAddon: (addon) => { released.push(addon); },
  });

  const suspended = make();
  suspended.ensure();
  suspended.suspend();
  const disposed = make();
  disposed.ensure();
  disposed.dispose();
  make(true).ensure();
  const lost = make();
  lost.ensure();
  lost.getAddon()!.loseContext();

  assert.equal(released.length, 4);
  assert.ok(released.every((addon) => addon.disposeCalls === 0), "the hook replaces addon.dispose()");
});
