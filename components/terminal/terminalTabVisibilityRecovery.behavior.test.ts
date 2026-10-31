/* eslint-disable @typescript-eslint/no-explicit-any, react-hooks/exhaustive-deps */
import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { useTerminalEffects } from './useTerminalEffects';
import { TERMINAL_SESSION_RESTORE_FOCUS_EVENT } from './focusTerminalSession';

// Exercise the real hook's reveal and settling effects. The injected effect
// hooks omit unrelated backend/auth/font setup; no recovery logic is copied.
function visibilityEffect(effect: React.EffectCallback) {
  const body = effect.toString();
  return body.includes('const becameVisible')
    || (/hiddenAtRef\.current\s*=\s*Date\.now\(\)/.test(body))
    || ((/hiddenAtRef\.current\s*=\s*null/.test(body)) && body.includes('const timer'))
    || (body.includes('const timer1') && body.includes('const timer2'))
    || body.includes('const handleRestoreFocus')
    || body.includes('const recoverTerminalOnAppResume');
}

function harness(t: any, initiallyHasRuntime = true) {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  let now = 10_000;
  let nextId = 0;
  const timers = new Map<number, { at: number; run: () => void }>();
  const schedule = (run: () => void, delay = 0) => {
    const id = ++nextId;
    timers.set(id, { at: now + delay, run });
    return id;
  };
  t.mock.method(Date, 'now', () => now);
  t.mock.method(globalThis, 'setTimeout', schedule);
  t.mock.method(globalThis, 'clearTimeout', (id: number) => timers.delete(id));
  const win = new EventTarget();
  const doc = Object.assign(new EventTarget(), { visibilityState: 'visible', querySelector: () => null });
  let fullscreen: ((value: boolean) => void) | undefined;
  let renderer: ReactTestRenderer;
  const documentBefore = Object.getOwnPropertyDescriptor(globalThis, 'document');
  Object.defineProperty(globalThis, 'document', { configurable: true, value: doc });
  const windowBefore = Object.getOwnPropertyDescriptor(globalThis, 'window');
  Object.defineProperty(globalThis, 'window', { configurable: true, value: Object.assign(win, { setTimeout: schedule }) });
  t.after(() => {
    if (renderer) act(() => renderer.unmount());
    if (documentBefore) Object.defineProperty(globalThis, 'document', documentBefore);
    else delete (globalThis as any).document;
    if (windowBefore) Object.defineProperty(globalThis, 'window', windowBefore);
    else delete (globalThis as any).window;
  });
  const fitTimes: number[] = [];
  const calls = { ensure: 0, clear: 0, fit: 0, forcedFit: 0, render: 0, focus: 0 };
  const term = { options: {}, focus() { calls.focus++; }, rows: 24, cols: 80, buffer: { active: { type: 'normal' } }, scrollToBottom() {}, _core: { _renderService: { _renderRows() { calls.render++; } } } };
  const runtime = { ensureWebglRenderer() { calls.ensure++; }, clearTextureAtlas() { calls.clear++; } };
  const values: Record<string, any> = {
    host: { id: 'host', protocol: 'ssh' }, auth: {}, zmodem: {}, effectiveTheme: { id: 'theme', colors: {} },
    terminalSettings: {}, terminalSettingsRef: { current: {} },
    terminalBackend: { onWindowFullScreenChanged(callback: (value: boolean) => void) { fullscreen = callback; return () => { fullscreen = undefined; }; } },
    pluginDecorationRules: [], sessionId: 'session', paneLayoutKey: 'layout',
    isVisible: false, isVisibleRef: { current: false }, splitResizeActive: false, inWorkspace: false,
    termRef: { current: initiallyHasRuntime ? term : null }, xtermRuntimeRef: { current: initiallyHasRuntime ? runtime : null },
    fitAddonRef: { current: {} }, sessionRef: { current: 'pty' },
    containerRef: { current: { clientWidth: 800, clientHeight: 480 } },
    lastFittedSizeRef: { current: { width: 800, height: 480 } }, pendingOutputScrollRef: { current: false },
    safeFit(options: any) {
      calls.fit++;
      fitTimes.push(now);
      if (options?.force) calls.forcedFit++;
      const container = values.containerRef.current;
      values.lastFittedSizeRef.current = { width: container.clientWidth, height: container.clientHeight };
    },
    forceSyncRenderAfterResize() { calls.render++; }, resizeSession() {},
    useEffect(effect: React.EffectCallback, deps: React.DependencyList) {
      React.useEffect(visibilityEffect(effect) ? effect : () => {}, deps);
    },
    useLayoutEffect(effect: React.EffectCallback, deps: React.DependencyList) {
      React.useLayoutEffect(visibilityEffect(effect) ? effect : () => {}, deps);
    },
  };
  const ctx = new Proxy(values, { get(target, key: string) {
    if (!(key in target)) target[key] = key.endsWith('Ref') ? { current: null } : (() => {});
    return target[key];
  } });
  function Component() { useTerminalEffects(ctx); return null; }
  act(() => { renderer = create(React.createElement(Component)); });
  function advance(ms: number) {
    const end = now + ms;
    while (true) {
      const next = [...timers.entries()].filter(([, item]) => item.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!next) break;
      now = next[1].at;
      timers.delete(next[0]);
      act(() => next[1].run());
    }
    now = end;
  }
  return { calls, fitTimes, advance, values,
    focus() { const event = Object.assign(new Event(TERMINAL_SESSION_RESTORE_FOCUS_EVENT), { detail: { sessionId: 'session' } }); act(() => { win.dispatchEvent(event); }); },
    resume() { act(() => { doc.dispatchEvent(new Event('visibilitychange')); }); },
    fullscreen() { act(() => fullscreen?.(true)); },
    reveal() { values.isVisible = true; values.isVisibleRef.current = true; act(() => renderer.update(React.createElement(Component))); },
    publishRuntime() { values.termRef.current = term; values.xtermRuntimeRef.current = runtime; },
  };
}

for (const hiddenMs of [2000, 4000]) {
  test(`unchanged reveal after ${hiddenMs}ms does not repeat recovery in settling timers`, t => {
    const h = harness(t);
    h.advance(hiddenMs);
    h.reveal();
    assert.equal(h.calls.clear, hiddenMs >= 3000 ? 1 : 0);
    h.advance(600);
    assert.equal(h.calls.clear, hiddenMs >= 3000 ? 1 : 0);
    assert.equal(h.calls.fit, 0);
  });
}

test('late changed bounds still receive a settling fit', t => {
  const h = harness(t);
  h.advance(4000); h.reveal(); h.advance(200);
  h.values.containerRef.current.clientHeight = 460;
  h.advance(400);
  assert.equal(h.calls.fit, 1);
  assert.equal(h.calls.forcedFit, 0);
  assert.deepEqual(h.values.lastFittedSizeRef.current, { width: 800, height: 460 });
});

test('runtime published after reveal still receives delayed recovery', t => {
  const h = harness(t, false);
  h.advance(4000); h.reveal();
  assert.equal(h.calls.clear, 0);
  h.advance(25); h.publishRuntime(); h.advance(575);
  assert.equal(h.calls.ensure, 1);
  assert.equal(h.calls.clear, 1);
  assert.equal(h.calls.forcedFit, 1);
});


test('focus restoration and its 50ms retry do not refit unchanged bounds', t => {
  const h = harness(t);
  h.advance(4000); h.reveal(); h.advance(600);
  h.focus(); h.advance(50); h.focus(); h.advance(500);
  assert.equal(h.calls.focus, 2);
  assert.equal(h.calls.fit, 0);
  assert.equal(h.calls.clear, 1);
});

test('restore focus events leave inline rename input focused until editing finishes', t => {
  const h = harness(t);
  h.advance(4000); h.reveal(); h.advance(600);
  let editing = true;
  t.mock.method(document as any, 'querySelector', (selector: string) => (
    editing && selector === '[data-session-inline-rename="true"]' ? {} : null
  ));
  h.focus(); h.advance(50); h.focus();
  assert.equal(h.calls.focus, 0);
  editing = false;
  h.focus();
  assert.equal(h.calls.focus, 1);
});

test('focus restoration still recovers changed bounds', t => {
  const h = harness(t);
  h.advance(4000); h.reveal(); h.advance(600);
  h.values.containerRef.current.clientWidth = 780;
  h.focus(); h.advance(50); h.focus(); h.advance(100);
  assert.equal(h.calls.focus, 2);
  assert.equal(h.calls.forcedFit, 2);
  assert.deepEqual(h.values.lastFittedSizeRef.current, { width: 780, height: 480 });
});

for (const source of ['resume', 'fullscreen'] as const) {
  test(`fitted focus retries preserve pending ${source} recovery timers`, t => {
    const h = harness(t);
    h.advance(4000); h.reveal(); h.advance(600);
    h[source](); h.advance(0);
    assert.equal(h.calls.forcedFit, 1);
    h.focus(); h.advance(50); h.focus(); h.advance(500);
    assert.equal(h.calls.focus, 2);
    assert.equal(h.calls.forcedFit, 3, 'all three explicit recovery passes must survive focus retries');
    assert.deepEqual(h.fitTimes.map(at => at - h.fitTimes[0]), source === 'resume' ? [0, 100, 300] : [0, 150, 400]);
  });
}

for (const source of ['resume', 'fullscreen'] as const) {
  test(`focus during changed bounds preserves pending ${source} settling passes`, t => {
    const h = harness(t);
    h.advance(4000); h.reveal(); h.advance(600);
    h[source](); h.advance(0);
    h.advance(50);
    h.values.containerRef.current.clientWidth = 780;
    h.focus(); h.advance(500);
    assert.equal(h.calls.focus, 1);
    assert.equal(h.calls.forcedFit, 3);
    assert.deepEqual(h.fitTimes.map(at => at - h.fitTimes[0]), source === 'resume' ? [0, 100, 300] : [0, 150, 400]);
    assert.equal(h.values.lastFittedSizeRef.current.width, 780);
  });
}
