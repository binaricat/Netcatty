import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';

import {
  AI_COMPOSER_IDLE_MS,
  AI_MARKDOWN_WARMUP_INITIAL_DELAY_MS,
  AI_MARKDOWN_WARMUP_RESUME_DELAY_MS,
  isAiComposerBusy,
  isAiComposerTarget,
  markAiComposerActivity,
  resolveAiMarkdownWarmupDelay,
  scheduleAiMarkdownWarmup,
  scheduleWhenAiComposerIdle,
  shouldDeferAiMarkdownWarmup,
} from './aiMarkdownWarmup';

test('defers markdown warmup while the composer is focused, composing, or recently active', () => {
  assert.equal(shouldDeferAiMarkdownWarmup({}), false);
  assert.equal(shouldDeferAiMarkdownWarmup({ composerFocused: true }), true);
  assert.equal(shouldDeferAiMarkdownWarmup({ isComposing: true }), true);
  assert.equal(shouldDeferAiMarkdownWarmup({ recentlyActive: true }), true);
});

test('recent composer activity counts as busy', () => {
  markAiComposerActivity();
  assert.equal(isAiComposerBusy(), true);
  assert.ok(AI_COMPOSER_IDLE_MS >= 2000);
});

test('recognizes the chat composer as a busy warmup target', () => {
  const body = { closest: (sel: string) => (sel.includes('ai-chat-input-body') ? {} : null) };
  assert.equal(isAiComposerTarget(body as unknown as EventTarget), true);
  assert.equal(isAiComposerTarget(null), false);
});

test('composer-idle IPC waits the expand grace unless overridden', () => {
  const warmup = readFileSync(new URL('./aiMarkdownWarmup.ts', import.meta.url), 'utf8');
  assert.match(warmup, /initialDelayMs:\s*options\?\.initialDelayMs \?\? AI_MARKDOWN_WARMUP_INITIAL_DELAY_MS/);
  assert.match(warmup, /isBusy:\s*options\?\.isBusy \?\? isAiComposerBusy/);
  assert.match(warmup, /markAiComposerActivity\(\);\n\s*arm\(\);/);
  assert.match(warmup, /if \(isAiComposerTyping\(\)\) \{\s*hydrateScheduled = true;/s);
});

test('history markdown waits after expand, then resumes quickly after blur', () => {
  assert.equal(AI_MARKDOWN_WARMUP_INITIAL_DELAY_MS, 4000);
  assert.equal(AI_MARKDOWN_WARMUP_RESUME_DELAY_MS, 600);
  assert.equal(resolveAiMarkdownWarmupDelay({
    hasArmed: false,
    initialDelayMs: AI_MARKDOWN_WARMUP_INITIAL_DELAY_MS,
    resumeDelayMs: AI_MARKDOWN_WARMUP_RESUME_DELAY_MS,
  }), 4000);
  assert.equal(resolveAiMarkdownWarmupDelay({
    hasArmed: true,
    initialDelayMs: AI_MARKDOWN_WARMUP_INITIAL_DELAY_MS,
    resumeDelayMs: AI_MARKDOWN_WARMUP_RESUME_DELAY_MS,
  }), 600);
});

test('AI panel no longer starts Streamdown just because it became visible', () => {
  const panel = readFileSync(new URL('../AIChatSidePanel.tsx', import.meta.url), 'utf8');
  assert.doesNotMatch(panel, /scheduleAiMarkdownWarmup/);
  assert.match(panel, /warmAiMarkdownRenderer/);
  assert.doesNotMatch(panel, /timeout:\s*2500/);
  assert.doesNotMatch(panel, /import\('\.\/ai-elements\/messageResponse'\)/);
  assert.doesNotMatch(panel, /@streamdown\/code/);
});

test('chat history renders markdown immediately once assistant content is shown', () => {
  const list = readFileSync(new URL('./ChatMessageList.tsx', import.meta.url), 'utf8');
  assert.match(list, /warmAiMarkdownRenderer/);
  assert.doesNotMatch(list, /deferUntilWarm/);
  assert.doesNotMatch(list, /scheduleAiMarkdownWarmup/);
});

test('composer focus alone does not count as typing', () => {
  assert.equal(shouldDeferAiMarkdownWarmup({ composerFocused: true }), true);
  assert.equal(shouldDeferAiMarkdownWarmup({ composerFocused: true, isComposing: false, recentlyActive: false }), true);
  assert.equal(shouldDeferAiMarkdownWarmup({ isComposing: false, recentlyActive: false }), false);
});

test('LazyMessageResponse warms immediately by default and still supports opt-in deferUntilWarm', () => {
  const source = readFileSync(new URL('../ai-elements/LazyMessageResponse.tsx', import.meta.url), 'utf8');
  assert.match(source, /deferUntilWarm/);
  assert.match(source, /warmAiMarkdownRenderer/);
  assert.match(source, /enqueueChatMarkdownHydrate/);
  assert.match(source, /isAiMarkdownRendererReady/);
  assert.doesNotMatch(source, /scheduleWhenAiComposerIdle/);
});

function createFakeWarmupWindow() {
  type ListenerEntry = {
    type: string;
    listener: EventListenerOrEventListenerObject;
    capture: boolean;
  };
  const listeners: ListenerEntry[] = [];
  const timeouts = new Map<number, () => void>();
  const idleCallbacks = new Map<number, () => void>();
  let nextTimeoutId = 1;
  let nextIdleId = 1;
  let removeCalls = 0;

  const toCapture = (options?: boolean | AddEventListenerOptions) =>
    typeof options === 'boolean' ? options : Boolean(options?.capture);

  const fakeWindow = {
    addEventListener(
      type: string,
      listener: EventListenerOrEventListenerObject,
      options?: boolean | AddEventListenerOptions,
    ) {
      listeners.push({ type, listener, capture: toCapture(options) });
    },
    removeEventListener(
      type: string,
      listener: EventListenerOrEventListenerObject,
      options?: boolean | AddEventListenerOptions,
    ) {
      removeCalls += 1;
      const capture = toCapture(options);
      const index = listeners.findIndex(
        (entry) => entry.type === type && entry.listener === listener && entry.capture === capture,
      );
      if (index >= 0) listeners.splice(index, 1);
    },
    setTimeout(callback: () => void) {
      const id = nextTimeoutId++;
      timeouts.set(id, callback);
      return id;
    },
    clearTimeout(id: number) {
      timeouts.delete(id);
    },
  };

  const dispatch = (type: string, target: EventTarget) => {
    const event = { target } as unknown as Event;
    for (const entry of [...listeners]) {
      if (entry.type !== type) continue;
      if (typeof entry.listener === 'function') {
        entry.listener(event);
      } else {
        entry.listener.handleEvent(event);
      }
    }
  };

  const flushNextTimeout = () => {
    const next = timeouts.entries().next().value;
    if (!next) return false;
    const [id, fn] = next;
    timeouts.delete(id);
    fn();
    return true;
  };

  const flushNextIdle = () => {
    const next = idleCallbacks.entries().next().value;
    if (!next) return false;
    const [id, fn] = next;
    idleCallbacks.delete(id);
    fn();
    return true;
  };

  return {
    fakeWindow,
    requestIdleCallback: (callback: () => void) => {
      const id = nextIdleId++;
      idleCallbacks.set(id, callback);
      return id;
    },
    cancelIdleCallback: (id: number) => {
      idleCallbacks.delete(id);
    },
    dispatch,
    flushNextTimeout,
    flushNextIdle,
    getListenerCount: () => listeners.length,
    getListenerKeys: () => listeners.map((entry) => `${entry.type}:${entry.capture}`).sort(),
    getPendingTimerCount: () => timeouts.size + idleCallbacks.size,
    getRemoveCalls: () => removeCalls,
  };
}

test('scheduleAiMarkdownWarmup removes all 5 window listeners and runs load strictly once', () => {
  const globals = globalThis as typeof globalThis & {
    window?: Window;
    requestIdleCallback?: typeof globalThis.requestIdleCallback;
    cancelIdleCallback?: typeof globalThis.cancelIdleCallback;
  };
  const originalWindow = globals.window;
  const originalRequestIdle = globals.requestIdleCallback;
  const originalCancelIdle = globals.cancelIdleCallback;

  const env = createFakeWarmupWindow();
  globals.window = env.fakeWindow as unknown as Window & typeof globalThis;
  globals.requestIdleCallback = env.requestIdleCallback as unknown as typeof globalThis.requestIdleCallback;
  globals.cancelIdleCallback = env.cancelIdleCallback as unknown as typeof globalThis.cancelIdleCallback;

  const composerTarget = {
    closest: (selector: string) => (selector.includes('ai-chat-input-body') ? {} : null),
  } as unknown as EventTarget;

  try {
    let busy = true;
    let loadCalls = 0;
    let listenersRemainingDuringLoad = -1;

    const cancel = scheduleAiMarkdownWarmup({
      isBusy: () => busy,
      load: () => {
        loadCalls += 1;
        listenersRemainingDuringLoad = env.getListenerCount();
      },
      initialDelayMs: 4000,
      resumeDelayMs: 600,
    });

    assert.deepEqual(env.getListenerKeys(), [
      'compositionstart:true',
      'compositionupdate:true',
      'focusin:false',
      'focusout:false',
      'keydown:true',
    ]);

    // While busy, timer/idle callbacks defer without removing listeners or calling load.
    assert.equal(env.flushNextTimeout(), true);
    assert.equal(env.flushNextIdle(), true);
    assert.equal(loadCalls, 0);
    assert.equal(env.getListenerCount(), 5);

    // Once idle, firing load immediately detaches all 5 window listeners before load() runs.
    busy = false;
    assert.equal(env.flushNextTimeout(), true);
    assert.equal(env.flushNextIdle(), true);
    assert.equal(loadCalls, 1);
    assert.equal(listenersRemainingDuringLoad, 0);
    assert.equal(env.getListenerCount(), 0);
    assert.equal(env.getPendingTimerCount(), 0);

    // Subsequent composer events must not re-arm timers or re-execute load().
    env.dispatch('focusin', composerTarget);
    env.dispatch('keydown', composerTarget);
    env.dispatch('compositionstart', composerTarget);
    env.dispatch('compositionupdate', composerTarget);
    env.dispatch('focusout', composerTarget);
    assert.equal(env.getPendingTimerCount(), 0);
    assert.equal(loadCalls, 1);

    // Unmount cancel after completion is an idempotent no-op.
    const removeCallsAfterLoad = env.getRemoveCalls();
    cancel();
    assert.equal(env.getRemoveCalls(), removeCallsAfterLoad);
  } finally {
    if (originalWindow !== undefined) globals.window = originalWindow;
    else delete globals.window;
    if (originalRequestIdle !== undefined) globals.requestIdleCallback = originalRequestIdle;
    else delete globals.requestIdleCallback;
    if (originalCancelIdle !== undefined) globals.cancelIdleCallback = originalCancelIdle;
    else delete globals.cancelIdleCallback;
  }
});

test('scheduleWhenAiComposerIdle cancel detaches listeners and prevents execution', () => {
  const globals = globalThis as typeof globalThis & {
    window?: Window;
    requestIdleCallback?: typeof globalThis.requestIdleCallback;
    cancelIdleCallback?: typeof globalThis.cancelIdleCallback;
  };
  const originalWindow = globals.window;
  const originalRequestIdle = globals.requestIdleCallback;
  const originalCancelIdle = globals.cancelIdleCallback;

  const env = createFakeWarmupWindow();
  globals.window = env.fakeWindow as unknown as Window & typeof globalThis;
  globals.requestIdleCallback = env.requestIdleCallback as unknown as typeof globalThis.requestIdleCallback;
  globals.cancelIdleCallback = env.cancelIdleCallback as unknown as typeof globalThis.cancelIdleCallback;

  try {
    let ran = 0;
    const cancel = scheduleWhenAiComposerIdle(() => {
      ran += 1;
    }, { isBusy: () => false });

    assert.equal(env.getListenerCount(), 5);
    assert.equal(env.getPendingTimerCount(), 1);

    cancel();

    assert.equal(env.getListenerCount(), 0);
    assert.equal(env.getPendingTimerCount(), 0);
    assert.equal(env.flushNextTimeout(), false);
    assert.equal(env.flushNextIdle(), false);
    assert.equal(ran, 0);
  } finally {
    if (originalWindow !== undefined) globals.window = originalWindow;
    else delete globals.window;
    if (originalRequestIdle !== undefined) globals.requestIdleCallback = originalRequestIdle;
    else delete globals.requestIdleCallback;
    if (originalCancelIdle !== undefined) globals.cancelIdleCallback = originalCancelIdle;
    else delete globals.cancelIdleCallback;
  }
});
