import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { AsidePanel } from './ui/aside-panel';
import { createDomRenderer, dispatchDomEvent, installDomEnvironment } from './test-support/renderReactDom';

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
  return { writes, render, unmount: () => renderer.unmount(),
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
