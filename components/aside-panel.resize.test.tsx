import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import React from 'react';
import { AsidePanel } from './ui/aside-panel';
import { createDomRenderer, dispatchDomEvent, installDomEnvironment, runWithAct } from './test-support/renderReactDom';

function installManualRaf(win: Window & typeof globalThis) {
  let nextId = 1;
  const scheduled = new Map<number, FrameRequestCallback>();
  const cancelledIds: number[] = [];
  let requestCount = 0;

  const originalRequest = win.requestAnimationFrame;
  const originalCancel = win.cancelAnimationFrame;

  win.requestAnimationFrame = (cb: FrameRequestCallback) => {
    requestCount += 1;
    const id = nextId++;
    scheduled.set(id, cb);
    return id;
  };
  win.cancelAnimationFrame = (id: number) => {
    cancelledIds.push(id);
    scheduled.delete(id);
  };

  return {
    get requestCount() { return requestCount; },
    get pendingCount() { return scheduled.size; },
    cancelledIds,
    async flushNext() {
      const entries = Array.from(scheduled.entries());
      scheduled.clear();
      await runWithAct(() => {
        for (const [, cb] of entries) cb(16);
      });
    },
    restore() {
      win.requestAnimationFrame = originalRequest;
      win.cancelAnimationFrame = originalCancel;
    },
  };
}

async function fixture(t: test.TestContext, layout: 'inline' | 'overlay' = 'inline') {
  const env = installDomEnvironment();
  const previousStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: env.window.localStorage });
  env.window.localStorage.setItem('desired-width', '720');
  const renderer = await createDomRenderer(env.document);
  const writes: number[] = [];
  const setItem = env.window.Storage.prototype.setItem;
  t.mock.method(env.window.Storage.prototype, 'setItem', function (this: Storage, key: string, value: string) {
    if (key === 'desired-width') writes.push(Number(value));
    setItem.call(this, key, value);
  });
  const render = (open = true) => renderer.render(<AsidePanel open={open} onClose={() => {}} title="Editor"
    layout={layout} resizable persistWidthStorageKey="desired-width" resizeAriaLabel="Resize details"
    dataSection="test-panel">Content</AsidePanel>);
  await render();
  const panel = env.document.querySelector<HTMLElement>('[data-section="test-panel"]')!;
  // Browser layout is covered by native-matrix.mjs. Here the actual rendered
  // border box is narrower than the remembered 720px preference.
  panel.getBoundingClientRect = () => new env.window.DOMRect(320, 36, 378, 494);
  const separator = panel.querySelector('[role="separator"]')!;
  const pointer = (target: EventTarget, type: string, x: number) => dispatchDomEvent(target,
    new env.window.MouseEvent(type, { bubbles: true, clientX: x }));
  t.after(async () => {
    await pointer(env.window, 'pointerup', 100);
    await renderer.unmount();
    if (previousStorage) Object.defineProperty(globalThis, 'localStorage', previousStorage);
    else Reflect.deleteProperty(globalThis, 'localStorage');
    env.cleanup();
  });
  return { writes, panel, render, unmount: () => renderer.unmount(),
    start: () => pointer(separator, 'pointerdown', 100),
    move: (x: number) => pointer(env.window, 'pointermove', x),
    up: (x: number) => pointer(env.window, 'pointerup', x),
    cancel: (x: number) => pointer(env.window, 'pointercancel', x), env };
}

test('dragging a fitted inline panel starts at its visible edge, then remembers the explicit size', async (t) => {
  const f = await fixture(t);
  await f.start(); await f.move(120); await f.up(120);
  assert.deepEqual(f.writes, [358], '20px inward from visible 378px must remember 358px, without a jump from 720px');
});

test('pressing a fitted resize handle without dragging preserves the larger desired width', async (t) => {
  const f = await fixture(t);
  assert.deepEqual(f.writes, [], 'mount must not persist');
  await f.start(); await f.up(100);
  assert.deepEqual(f.writes, [], 'a click must not replace the remembered desired width');
});

test('canceling a resize leaves the remembered width unchanged and restores pointer styles', async (t) => {
  const f = await fixture(t);
  await f.start(); await f.move(120); await f.cancel(120); await f.up(120);
  assert.deepEqual(f.writes, []);
  assert.equal(f.env.document.body.style.cursor, '');
  assert.equal(f.env.document.body.style.userSelect, '');
});

for (const mode of ['hidden', 'unmounted'] as const) {
  test(`${mode} panels do not persist a viewport clamp or a stale drag`, async (t) => {
    const f = await fixture(t);
    await f.start(); await f.move(120);
    if (mode === 'hidden') await f.render(false); else await f.unmount();
    await f.up(120);
    assert.deepEqual(f.writes, []);
    assert.equal(f.env.document.body.style.cursor, '');
    assert.equal(f.env.document.body.style.userSelect, '');
  });
}

test('overlay resizing retains its existing desired-width behavior', async (t) => {
  const f = await fixture(t, 'overlay');
  await f.start(); await f.move(120); await f.up(120);
  assert.deepEqual(f.writes, [700]);
});

test('rapid pointermove events coalesce into one requestAnimationFrame using the latest width', async (t) => {
  const f = await fixture(t);
  const raf = installManualRaf(f.env.window);
  t.after(() => raf.restore());

  await f.start();
  // Fire 4 rapid moves within a single frame: 378 + (100 - x).
  await f.move(110); // 368
  await f.move(120); // 358
  await f.move(130); // 348
  await f.move(140); // 338

  assert.equal(raf.requestCount, 1, 'multiple pointermove events in one frame must schedule only one rAF');
  assert.equal(raf.pendingCount, 1);
  assert.equal(
    f.panel.style.width,
    'min(720px, var(--aside-inline-max-width, 720px))',
    'panel width must not re-render synchronously before the animation frame fires',
  );

  await raf.flushNext();
  assert.equal(raf.pendingCount, 0);
  assert.equal(
    f.panel.style.width,
    'min(338px, var(--aside-inline-max-width, 338px))',
    'flushed frame must apply the latest clamped width from the coalesced moves',
  );

  await f.up(140);
  assert.deepEqual(f.writes, [338]);
});

test('pointerup cancels any pending rAF before committing the final width', async (t) => {
  const f = await fixture(t);
  const raf = installManualRaf(f.env.window);
  t.after(() => raf.restore());

  await f.start();
  await f.move(150); // schedules rAF for 328px
  assert.equal(raf.pendingCount, 1);

  // Release at 110 (368px) before the queued rAF runs.
  await f.up(110);
  assert.equal(raf.cancelledIds.length, 1, 'cleanup on pointerup must cancel the pending rAF');
  assert.equal(raf.pendingCount, 0);
  assert.deepEqual(f.writes, [368]);
  assert.equal(
    f.panel.style.width,
    'min(368px, var(--aside-inline-max-width, 368px))',
  );
});

for (const mode of ['cancel', 'hidden', 'unmounted'] as const) {
  test(`${mode} cancels a pending drag rAF so no stale width commits afterward`, async (t) => {
    const f = await fixture(t);
    const raf = installManualRaf(f.env.window);
    t.after(() => raf.restore());

    await f.start();
    await f.move(140);
    assert.equal(raf.pendingCount, 1);

    if (mode === 'cancel') await f.cancel(140);
    else if (mode === 'hidden') await f.render(false);
    else await f.unmount();

    assert.equal(raf.cancelledIds.length, 1, `${mode} must cancel pending rAF`);
    assert.equal(raf.pendingCount, 0);
    assert.deepEqual(f.writes, []);
  });
}

test('split-panel-enter animates compositor-only transform and opacity without width reflow', () => {
  const css = readFileSync(new URL('../index.css', import.meta.url), 'utf8');
  const start = css.indexOf('@keyframes split-panel-enter');
  const end = css.indexOf('/* Security-key prompts', start);
  assert.ok(start !== -1 && end > start);
  const block = css.slice(start, end);

  assert.match(block, /transform:\s*translateX\(/);
  assert.match(block, /will-change:\s*transform,\s*opacity;/);
  assert.doesNotMatch(block, /\bwidth\s*:/);
  assert.doesNotMatch(block, /\bmin-width\s*:/);
});
