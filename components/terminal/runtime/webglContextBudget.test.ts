import assert from "node:assert/strict";
import test from "node:test";
import {
  createWebglContextBudget,
  type WebglContextBudgetMember,
} from "./webglContextBudget";

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

class FakeMember implements WebglContextBudgetMember {
  hiddenSince: number | null = null;
  releases = 0;
  constructor(readonly name: string) {}
  getHiddenSince() { return this.hiddenSince; }
  release() { this.releases += 1; }
}

function setup(maxActiveContexts = 3) {
  const clock = createClock();
  const budget = createWebglContextBudget({
    maxActiveContexts,
    minHiddenMs: 3_000,
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  });
  return { clock, budget };
}

test("below the cap every pane keeps its renderer, hidden or not", () => {
  const { clock, budget } = setup(3);
  const members = ["a", "b", "c"].map((name) => new FakeMember(name));
  for (const member of members) assert.equal(budget.tryAcquire(member), true);
  for (const member of members) member.hiddenSince = clock.now();
  clock.advance(60_000);
  for (const member of members) budget.noteHidden(member);
  clock.advance(60_000);

  assert.deepEqual(members.map((member) => member.releases), [0, 0, 0]);
  assert.equal(budget.getActiveCount(), 3);
  assert.equal(clock.pendingTimers, 0);
});

test("a visible pane past the cap releases the least recently seen hidden pane", () => {
  const { clock, budget } = setup(3);
  const [a, b, c] = ["a", "b", "c"].map((name) => new FakeMember(name));
  budget.tryAcquire(a);
  budget.tryAcquire(b);
  budget.tryAcquire(c);
  b.hiddenSince = 1_000;
  a.hiddenSince = 2_000;
  clock.advance(10_000);

  const shown = new FakeMember("shown");
  assert.equal(budget.tryAcquire(shown), true);

  assert.equal(b.releases, 1, "hidden longest goes first");
  assert.equal(a.releases, 0);
  assert.equal(c.releases, 0, "visible panes are never released");
  assert.equal(budget.getActiveCount(), 3);
});

test("new visible panes are refused when visible holders fill the cap", () => {
  const { budget } = setup(2);
  const members = ["a", "b", "c", "d"].map((name) => new FakeMember(name));
  assert.deepEqual(members.map((member) => budget.tryAcquire(member)), [true, true, false, false]);
  assert.equal(budget.tryAcquire(members[0]), true, "an existing holder keeps its slot");
  assert.equal(budget.getActiveCount(), 2);
  assert.deepEqual(members.map((member) => member.releases), [0, 0, 0, 0]);
});

test("recently hidden panes are released only once they stay hidden long enough", () => {
  const { clock, budget } = setup(2);
  const [a, b] = ["a", "b"].map((name) => new FakeMember(name));
  budget.tryAcquire(a);
  budget.tryAcquire(b);
  clock.advance(5_000);
  a.hiddenSince = clock.now();
  budget.noteHidden(a);

  budget.tryAcquire(new FakeMember("shown"));
  assert.equal(a.releases, 0, "a quick tab flip must not lose the renderer");
  assert.equal(budget.getActiveCount(), 3);
  assert.equal(budget.tryAcquire(new FakeMember("overflow")), false);
  assert.equal(budget.getActiveCount(), 3, "one hidden holder allows only one extra context");

  clock.advance(2_999);
  assert.equal(a.releases, 0);
  clock.advance(1);
  assert.equal(a.releases, 1);
  assert.equal(budget.getActiveCount(), 2);
  assert.equal(clock.pendingTimers, 0);
});

test("a pane hidden after a grace overshoot is released once eligible", () => {
  const { clock, budget } = setup(2);
  const [a, b, c] = ["a", "b", "c"].map((name) => new FakeMember(name));
  budget.tryAcquire(a);
  budget.tryAcquire(b);
  assert.equal(budget.tryAcquire(c), false);
  assert.equal(budget.getActiveCount(), 2);
  assert.equal(clock.pendingTimers, 0);

  a.hiddenSince = clock.now();
  budget.noteHidden(a);
  assert.equal(budget.tryAcquire(c), true);
  assert.equal(budget.getActiveCount(), 3, "recently hidden holders allow a grace overshoot");
  a.hiddenSince = null;
  b.hiddenSince = clock.now();
  budget.noteHidden(b);
  clock.advance(3_000);

  assert.equal(b.releases, 1);
  assert.equal(a.releases, 0, "a holder shown again keeps its renderer");
  assert.equal(budget.getActiveCount(), 2);
});

test("a hidden pane cannot take a context once the budget is full", () => {
  const { clock, budget } = setup(2);
  const a = new FakeMember("a");
  budget.tryAcquire(a);
  budget.tryAcquire(new FakeMember("b"));

  const hidden = new FakeMember("hidden");
  hidden.hiddenSince = 0;
  assert.equal(budget.tryAcquire(hidden), false);
  assert.equal(budget.getActiveCount(), 2);

  hidden.hiddenSince = null;
  assert.equal(budget.tryAcquire(hidden), false, "visible holders still fill the cap");
  a.hiddenSince = clock.now();
  budget.noteHidden(a);
  clock.advance(3_000);
  assert.equal(budget.tryAcquire(hidden), true, "a shown pane can replace an eligible hidden holder");
  assert.equal(a.releases, 1);
  assert.equal(budget.getActiveCount(), 2);
});

test("released and forgotten panes free their slot", () => {
  const { budget } = setup(1);
  const a = new FakeMember("a");
  budget.tryAcquire(a);
  budget.forget(a);
  budget.forget(a);
  assert.equal(budget.getActiveCount(), 0);

  const hidden = new FakeMember("hidden");
  hidden.hiddenSince = 0;
  assert.equal(budget.tryAcquire(hidden), true);
  assert.equal(budget.tryAcquire(hidden), true, "acquiring twice keeps one slot");
  assert.equal(budget.getActiveCount(), 1);
});
