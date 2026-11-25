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
  const win = Object.assign(new EventTarget(), { setTimeout: schedule, devicePixelRatio: 1 });
  const doc = Object.assign(new EventTarget(), { visibilityState: 'visible', querySelector: () => null });
  let fullscreen: ((value: boolean) => void) | undefined;
  let windowShown: (() => void) | undefined;
  let renderer: ReactTestRenderer;
  const documentBefore = Object.getOwnPropertyDescriptor(globalThis, 'document');
  Object.defineProperty(globalThis, 'document', { configurable: true, value: doc });
  const windowBefore = Object.getOwnPropertyDescriptor(globalThis, 'window');
  Object.defineProperty(globalThis, 'window', { configurable: true, value: win });
  t.after(() => {
    if (renderer) act(() => renderer.unmount());
    if (documentBefore) Object.defineProperty(globalThis, 'document', documentBefore);
    else delete (globalThis as any).document;
    if (windowBefore) Object.defineProperty(globalThis, 'window', windowBefore);
    else delete (globalThis as any).window;
  });
  const fitTimes: number[] = [];
  const calls = { ensure: 0, clear: 0, fit: 0, forcedFit: 0, render: 0, focus: 0, resize: 0, scroll: 0 };
  let recreateWebglOnNextEnsure = false;
  const term = {
    options: {},
    focus() { calls.focus++; },
    rows: 24,
    cols: 80,
    buffer: { active: { type: 'normal' } },
    scrollToBottom() { calls.scroll++; },
    _core: { _renderService: { _renderRows() { calls.render++; } } },
  };
  const runtime = {
    ensureWebglRenderer() {
      calls.ensure++;
      const recreated = recreateWebglOnNextEnsure;
      recreateWebglOnNextEnsure = false;
      return recreated;
    },
    clearTextureAtlas() { calls.clear++; },
  };
  const values: Record<string, any> = {
    host: { id: 'host', protocol: 'ssh' }, auth: {}, zmodem: {}, effectiveTheme: { id: 'theme', colors: {} },
    terminalSettings: {}, terminalSettingsRef: { current: {} },
    terminalBackend: {
      onWindowFullScreenChanged(callback: (value: boolean) => void) { fullscreen = callback; return () => { fullscreen = undefined; }; },
      onWindowShown(callback: () => void) { windowShown = callback; return () => { windowShown = undefined; }; },
    },
    pluginDecorationRules: [], sessionId: 'session', paneLayoutKey: 'layout',
    isVisible: false, isVisibleRef: { current: false }, splitResizeActive: false, inWorkspace: false,
    termRef: { current: initiallyHasRuntime ? term : null }, xtermRuntimeRef: { current: initiallyHasRuntime ? runtime : null },
    fitAddonRef: { current: {} }, sessionRef: { current: 'pty' },
    containerRef: { current: { clientWidth: 800, clientHeight: 480 } },
    lastFittedSizeRef: { current: { width: 800, height: 480, dpr: 1 } }, pendingOutputScrollRef: { current: false },
    safeFit(options: any) {
      calls.fit++;
      fitTimes.push(now);
      if (options?.force) calls.forcedFit++;
      const container = values.containerRef.current;
      values.lastFittedSizeRef.current = { width: container.clientWidth, height: container.clientHeight, dpr: win.devicePixelRatio };
    },
    forceSyncRenderAfterResize() { calls.render++; },
    resizeSession() { calls.resize++; },
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
    windowFocus() { act(() => { win.dispatchEvent(new Event('focus')); }); },
    hideDocument() { doc.visibilityState = 'hidden'; act(() => { doc.dispatchEvent(new Event('visibilitychange')); }); },
    resume() { doc.visibilityState = 'visible'; act(() => { doc.dispatchEvent(new Event('visibilitychange')); }); },
    showWindow() { act(() => windowShown?.()); },
    fullscreen() { act(() => fullscreen?.(true)); },
    setDpr(dpr: number) { win.devicePixelRatio = dpr; },
    setRecreateWebglOnNextEnsure(value: boolean) { recreateWebglOnNextEnsure = value; },
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
    // Every reveal asks for the WebGL renderer once: a no-op while it is live,
    // a rebuild when Chromium or the context budget took it while hidden.
    assert.equal(h.calls.ensure, 1);
    h.advance(600);
    assert.equal(h.calls.clear, hiddenMs >= 3000 ? 1 : 0);
    assert.equal(h.calls.ensure, 1);
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
  assert.deepEqual(h.values.lastFittedSizeRef.current, { width: 800, height: 460, dpr: 1 });
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

test('focus restoration recovers changed bounds once and skips settled follow-up timer', t => {
  const h = harness(t);
  h.advance(4000); h.reveal(); h.advance(600);
  const resizesBefore = h.calls.resize;
  h.values.containerRef.current.clientWidth = 780;
  h.focus(); h.advance(50); h.focus(); h.advance(100);
  assert.equal(h.calls.focus, 2);
  assert.equal(h.calls.fit, 1);
  assert.equal(h.calls.forcedFit, 1);
  assert.equal(h.calls.resize - resizesBefore, 1, 'settled 100ms follow-up skips finishLayoutRecoveryAfterFit');
  assert.deepEqual(h.values.lastFittedSizeRef.current, { width: 780, height: 480, dpr: 1 });
});

for (const source of ['resume', 'fullscreen'] as const) {
  test(`fitted focus retries preserve pending ${source} recovery timers for late layout shifts`, t => {
    const h = harness(t);
    h.advance(4000); h.reveal(); h.advance(600);
    h[source](); h.advance(0);
    assert.equal(h.calls.forcedFit, 1);
    h.focus(); h.advance(50); h.focus();
    // Simulate late container changes before each settling pass to prove focus
    // retries kept the original recovery schedule alive.
    h.values.containerRef.current.clientWidth = 780;
    h.advance(source === 'resume' ? 100 : 150);
    h.values.containerRef.current.clientWidth = 760;
    h.advance(300);
    assert.equal(h.calls.focus, 2);
    assert.equal(h.calls.fit, 3, 'all three explicit recovery passes must survive focus retries when bounds continue changing');
    assert.equal(h.calls.forcedFit, 1, 'follow-up timers use force:false rather than forcing redundant atlas wipes');
    assert.deepEqual(h.fitTimes.map(at => at - h.fitTimes[0]), source === 'resume' ? [0, 100, 300] : [0, 150, 400]);
  });
}

for (const source of ['resume', 'fullscreen'] as const) {
  test(`focus during changed bounds preserves pending ${source} settling passes and skips settled trailing pass`, t => {
    const h = harness(t);
    h.advance(4000); h.reveal(); h.advance(600);
    h[source](); h.advance(0);
    const resizesAfterInitial = h.calls.resize;
    h.advance(50);
    h.values.containerRef.current.clientWidth = 780;
    h.focus(); h.advance(500);
    assert.equal(h.calls.focus, 1);
    assert.equal(h.calls.fit, 2, 'initial forced pass plus one settling pass for the changed width; settled trailing pass is skipped');
    assert.equal(h.calls.forcedFit, 1);
    assert.equal(h.calls.resize - resizesAfterInitial, 1, 'skipped trailing pass must not run finishLayoutRecoveryAfterFit');
    assert.deepEqual(h.fitTimes.map(at => at - h.fitTimes[0]), source === 'resume' ? [0, 100] : [0, 150]);
    assert.equal(h.values.lastFittedSizeRef.current.width, 780);
  });
}

test('window.focus with unchanged bounds, unchanged DPR, and live WebGL skips refit and PTY resize', t => {
  const h = harness(t);
  h.advance(1000); h.reveal(); h.advance(600);
  const ensureBefore = h.calls.ensure;
  const clearBefore = h.calls.clear;
  const fitBefore = h.calls.fit;
  const resizeBefore = h.calls.resize;
  const renderBefore = h.calls.render;
  h.values.pendingOutputScrollRef.current = true;

  h.windowFocus();
  h.advance(500);

  assert.equal(h.calls.ensure, ensureBefore + 1, 'still verifies WebGL renderer on focus');
  assert.equal(h.calls.scroll, 1, 'still flushes pending output scroll on focus');
  assert.equal(h.calls.clear, clearBefore, 'must not wipe texture atlas when bounds/DPR are unchanged and WebGL is live');
  assert.equal(h.calls.fit, fitBefore, 'must not schedule recovery refits on unchanged window.focus');
  assert.equal(h.calls.resize, resizeBefore, 'must not send redundant PTY resize on unchanged window.focus');
  assert.equal(h.calls.render, renderBefore, 'must not force sync repaint when WebGL is live and bounds are unchanged');
});

test('window.focus runs full recovery when ensureWebglRenderer recreates an evicted context', t => {
  const h = harness(t);
  h.advance(1000); h.reveal(); h.advance(600);
  const fitBefore = h.calls.fit;
  const resizeBefore = h.calls.resize;
  const renderBefore = h.calls.render;
  h.setRecreateWebglOnNextEnsure(true);

  h.windowFocus();
  h.advance(500);

  assert.equal(h.calls.forcedFit, 1, 'recreated WebGL context must trigger full recovery refit');
  assert.equal(h.calls.fit - fitBefore, 1, 'follow-up timers skip once bounds are already settled');
  assert.equal(h.calls.resize - resizeBefore, 1, 'initial recovery pass still syncs PTY size');
  assert.ok(h.calls.render > renderBefore, 'recreated WebGL context still forces immediate repaint');
});

test('window.focus runs full recovery when window.devicePixelRatio changes across displays', t => {
  const h = harness(t);
  h.advance(1000); h.reveal(); h.advance(600);
  const fitBefore = h.calls.fit;
  const resizeBefore = h.calls.resize;

  // Move to a Retina display: same CSS clientWidth/clientHeight, new DPR.
  h.setDpr(2);
  h.windowFocus();
  h.advance(500);

  assert.equal(h.calls.forcedFit, 1, 'DPR change must force refit and atlas clear');
  assert.equal(h.calls.fit - fitBefore, 1);
  assert.equal(h.calls.resize - resizeBefore, 1);
  assert.equal(h.values.lastFittedSizeRef.current.dpr, 2);

  // Subsequent focus at the new DPR with unchanged bounds is a no-op again.
  h.windowFocus();
  h.advance(500);
  assert.equal(h.calls.fit - fitBefore, 1);
  assert.equal(h.calls.resize - resizeBefore, 1);
});

test('window.focus after document became hidden still runs full app-resume recovery', t => {
  const h = harness(t);
  h.advance(1000); h.reveal(); h.advance(600);
  const fitBefore = h.calls.fit;
  const resizeBefore = h.calls.resize;

  h.hideDocument();
  h.windowFocus();
  h.advance(500);

  assert.equal(h.calls.forcedFit, 1, 'returning from hidden document must run full recovery');
  assert.equal(h.calls.fit - fitBefore, 1);
  assert.equal(h.calls.resize - resizeBefore, 1);
});

test('changed-bounds tab reveal skips settled [100, 350] follow-up timers and still catches late resize', t => {
  const h = harness(t);
  h.advance(4000);
  h.values.containerRef.current.clientWidth = 760;
  h.reveal();
  h.advance(0);
  assert.equal(h.calls.fit, 1);
  assert.equal(h.calls.forcedFit, 1);
  assert.equal(h.calls.resize, 1);
  const resizesAfterImmediate = h.calls.resize;

  // Let the 100ms follow-up fire with unchanged bounds -> skipped completely.
  h.advance(150);
  assert.equal(h.calls.fit, 1);
  assert.equal(h.calls.resize, resizesAfterImmediate);

  // Change bounds before the 350ms follow-up -> caught with force:false.
  h.values.containerRef.current.clientWidth = 740;
  h.advance(300);
  assert.equal(h.calls.fit, 2);
  assert.equal(h.calls.forcedFit, 1);
  assert.equal(h.calls.resize, resizesAfterImmediate + 1);
  assert.equal(h.values.lastFittedSizeRef.current.width, 740);
});
