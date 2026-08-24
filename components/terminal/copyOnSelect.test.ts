import assert from "node:assert/strict";
import test from "node:test";

import {
  COPY_ON_SELECT_USER_GESTURE_RELEASE_MS,
  createCopyOnSelectUserGestureTracker,
  pulseCopyOnSelectUserCommand,
  shouldWriteCopyOnSelect,
  subscribeCopyOnSelectUserCommand,
  subscribeCopyOnSelectUserGesture,
} from "./copyOnSelect.ts";

test("copy-on-select writes only after a user selection gesture", () => {
  assert.equal(shouldWriteCopyOnSelect({
    hasText: true,
    copyOnSelect: true,
    isRestoringSelection: false,
    isUserSelection: true,
  }), true);
});

test("copy-on-select skips SearchAddon and other programmatic selections", () => {
  assert.equal(shouldWriteCopyOnSelect({
    hasText: true,
    copyOnSelect: true,
    isRestoringSelection: false,
    isUserSelection: false,
  }), false);
});

test("copy-on-select still skips restore and attach snapshots", () => {
  assert.equal(shouldWriteCopyOnSelect({
    allowCopy: false,
    hasText: true,
    copyOnSelect: true,
    isRestoringSelection: false,
    isUserSelection: true,
  }), false);
  assert.equal(shouldWriteCopyOnSelect({
    hasText: true,
    copyOnSelect: true,
    isRestoringSelection: true,
    isUserSelection: true,
  }), false);
  assert.equal(shouldWriteCopyOnSelect({
    hasText: false,
    copyOnSelect: true,
    isRestoringSelection: false,
    isUserSelection: true,
  }), false);
  assert.equal(shouldWriteCopyOnSelect({
    hasText: true,
    copyOnSelect: false,
    isRestoringSelection: false,
    isUserSelection: true,
  }), false);
});

test("user gesture stays armed until shortly after pointer-up", () => {
  assert.ok(COPY_ON_SELECT_USER_GESTURE_RELEASE_MS < 200);

  const scheduled: Array<{ cb: () => void; ms: number }> = [];
  const tracker = createCopyOnSelectUserGestureTracker({
    setTimeoutFn: ((cb: () => void, ms?: number) => {
      scheduled.push({ cb, ms: ms ?? 0 });
      return scheduled.length as unknown as ReturnType<typeof setTimeout>;
    }) as typeof setTimeout,
    clearTimeoutFn: (() => {}) as typeof clearTimeout,
  });

  assert.equal(tracker.isActive(), false);
  tracker.mark();
  assert.equal(tracker.isActive(), true);

  tracker.release();
  assert.equal(tracker.isActive(), true);
  assert.equal(scheduled.at(-1)?.ms, COPY_ON_SELECT_USER_GESTURE_RELEASE_MS);

  // A later SearchAddon revival (200ms) must not still look like a drag.
  scheduled.at(-1)?.cb();
  assert.equal(tracker.isActive(), false);

  tracker.dispose();
});

test("marking again cancels a pending release so a new drag can copy", () => {
  const cleared: number[] = [];
  let nextId = 1;
  const tracker = createCopyOnSelectUserGestureTracker({
    setTimeoutFn: ((cb: () => void) => {
      const id = nextId;
      nextId += 1;
      void cb;
      return id as unknown as ReturnType<typeof setTimeout>;
    }) as typeof setTimeout,
    clearTimeoutFn: ((id: ReturnType<typeof setTimeout>) => {
      cleared.push(id as unknown as number);
    }) as typeof clearTimeout,
  });

  tracker.mark();
  tracker.release();
  tracker.mark();

  assert.deepEqual(cleared, [1]);
  assert.equal(tracker.isActive(), true);
  tracker.dispose();
});

const listenerKey = (
  type: string,
  options?: boolean | AddEventListenerOptions,
): string => {
  const capture = options === true || (
    typeof options === "object" && options?.capture === true
  );
  return `${type}:${capture ? "capture" : "bubble"}`;
};

const createEventTargetStub = () => {
  const listeners = new Map<string, Set<EventListener>>();
  return {
    addEventListener(
      type: string,
      listener: EventListener,
      options?: boolean | AddEventListenerOptions,
    ) {
      const key = listenerKey(type, options);
      const set = listeners.get(key) ?? new Set();
      set.add(listener);
      listeners.set(key, set);
    },
    removeEventListener(
      type: string,
      listener: EventListener,
      options?: boolean | AddEventListenerOptions,
    ) {
      listeners.get(listenerKey(type, options))?.delete(listener);
    },
    dispatch(type: string, event: Event, phase: "capture" | "bubble") {
      for (const listener of listeners.get(`${type}:${phase}`) ?? []) {
        listener(event);
      }
    },
  };
};

const eventOn = (type: string, target: EventTarget): Event => {
  const event = new Event(type);
  Object.defineProperty(event, "target", { value: target });
  return event;
};

test("pointer listeners mark on capture down and release on document up", () => {
  const el = createEventTargetStub();
  const root = createEventTargetStub();
  const view = createEventTargetStub();
  let marked = 0;
  let pulsed = 0;
  let released = 0;
  const unsubscribe = subscribeCopyOnSelectUserGesture(
    { element: el },
    {
      mark: () => {
        marked += 1;
      },
      release: () => {
        released += 1;
      },
      pulse: () => {
        pulsed += 1;
      },
    },
    root,
    view,
  );

  root.dispatch("mousedown", eventOn("mousedown", el), "capture");
  root.dispatch("mouseup", eventOn("mouseup", el), "bubble");
  root.dispatch("contextmenu", eventOn("contextmenu", el), "capture");
  root.dispatch("touchcancel", eventOn("touchcancel", el), "bubble");
  view.dispatch("blur", eventOn("blur", el), "bubble");
  assert.equal(marked, 1);
  assert.equal(released, 3);
  assert.equal(pulsed, 1);

  unsubscribe();
  root.dispatch("mousedown", eventOn("mousedown", el), "capture");
  root.dispatch("mouseup", eventOn("mouseup", el), "bubble");
  root.dispatch("touchcancel", eventOn("touchcancel", el), "bubble");
  view.dispatch("blur", eventOn("blur", el), "bubble");
  assert.equal(marked, 1);
  assert.equal(released, 3);
  assert.equal(pulsed, 1);
});

test("late contextmenu after mouseup is a one-shot and then releases", () => {
  const scheduled: Array<() => void> = [];
  const tracker = createCopyOnSelectUserGestureTracker({
    setTimeoutFn: ((cb: () => void) => {
      scheduled.push(cb);
      return scheduled.length as unknown as ReturnType<typeof setTimeout>;
    }) as typeof setTimeout,
    clearTimeoutFn: (() => {}) as typeof clearTimeout,
  });

  tracker.mark();
  tracker.release();
  // Windows: contextmenu after mouseup used to cancel this timer and stick.
  tracker.pulse();
  assert.equal(tracker.isActive(), true);
  scheduled.at(-1)?.();
  assert.equal(tracker.isActive(), false);

  tracker.dispose();
});

test("document-capture contextmenu still counts when the terminal never sees the bubble", () => {
  const el = createEventTargetStub();
  const outside = createEventTargetStub();
  const root = createEventTargetStub();
  let pulsed = 0;
  subscribeCopyOnSelectUserGesture(
    { element: el },
    {
      mark: () => {},
      release: () => {},
      pulse: () => {
        pulsed += 1;
      },
    },
    root,
  );

  // tmux/vim capture handler on the container stops the event before
  // term.element bubble listeners would run.
  root.dispatch("contextmenu", eventOn("contextmenu", el), "capture");
  root.dispatch("contextmenu", eventOn("contextmenu", outside), "capture");
  assert.equal(pulsed, 1);
});

test("user-invoked Select All pulses only the selected terminal", () => {
  let pulsedA = 0;
  let pulsedB = 0;
  const terminalA = { id: "a" };
  const terminalB = { id: "b" };
  const unsubscribeA = subscribeCopyOnSelectUserCommand(terminalA, () => {
    pulsedA += 1;
  });
  const unsubscribeB = subscribeCopyOnSelectUserCommand(terminalB, () => {
    pulsedB += 1;
  });

  pulseCopyOnSelectUserCommand(terminalA);
  assert.equal(pulsedA, 1);
  assert.equal(pulsedB, 0);

  unsubscribeA();
  unsubscribeB();
  pulseCopyOnSelectUserCommand(terminalA);
  assert.equal(pulsedA, 1);
  assert.equal(pulsedB, 0);
});

test("issue 3007: search match then later revival does not copy", () => {
  const scheduled: Array<() => void> = [];
  const tracker = createCopyOnSelectUserGestureTracker({
    setTimeoutFn: ((cb: () => void) => {
      scheduled.push(cb);
      return scheduled.length as unknown as ReturnType<typeof setTimeout>;
    }) as typeof setTimeout,
    clearTimeoutFn: (() => {}) as typeof clearTimeout,
  });

  // Typing in the search bar selects the match with no terminal pointer.
  assert.equal(shouldWriteCopyOnSelect({
    hasText: true,
    copyOnSelect: true,
    isRestoringSelection: false,
    isUserSelection: tracker.isActive(),
  }), false);

  // User drag-selects a docker image id in the buffer.
  tracker.mark();
  assert.equal(shouldWriteCopyOnSelect({
    hasText: true,
    copyOnSelect: true,
    isRestoringSelection: false,
    isUserSelection: tracker.isActive(),
  }), true);
  tracker.release();
  scheduled.at(-1)?.();

  // Opening the snippet dialog resizes the terminal; SearchAddon re-selects
  // the search term. Clipboard must stay on the image id.
  assert.equal(shouldWriteCopyOnSelect({
    hasText: true,
    copyOnSelect: true,
    isRestoringSelection: false,
    isUserSelection: tracker.isActive(),
  }), false);

  tracker.dispose();
});
