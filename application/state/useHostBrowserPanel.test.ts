import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { act, create } from 'react-test-renderer';
import { installDomEnvironment } from '../../components/test-support/renderReactDom';
import { netcattyBridge } from '../../infrastructure/services/netcattyBridge';
import type { TerminalSettings } from '../../domain/models';
import { useHostBrowserPanel } from './useHostBrowserPanel';

type Layout = Parameters<NonNullable<NetcattyBridge['setHostBrowserPanelLayout']>>[0];
type Result = Awaited<ReturnType<NonNullable<NetcattyBridge['setHostBrowserPanelLayout']>>>;
const layers = [{ image: 'data:image/png;base64,fixture', bounds: { x: 0, y: 0, width: 500, height: 600 } }];

async function fixture(t: test.TestContext) {
  const env = installDomEnvironment();
  const frames = new Map<number, FrameRequestCallback>();
  let frameId = 0;
  const originals = new Map(['requestAnimationFrame', 'cancelAnimationFrame', 'getComputedStyle']
    .map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  Object.defineProperty(globalThis, 'requestAnimationFrame', { configurable: true,
    value: (callback: FrameRequestCallback) => { frames.set(++frameId, callback); return frameId; } });
  Object.defineProperty(globalThis, 'cancelAnimationFrame', { configurable: true,
    value: (id: number) => frames.delete(id) });
  const resizeObservers = new Map<ResizeObserver, Set<Element>>();
  const resizeCallbacks = new Map<ResizeObserver, ResizeObserverCallback>();
  class LayoutResizeObserver implements ResizeObserver {
    constructor(callback: ResizeObserverCallback) { resizeCallbacks.set(this, callback); resizeObservers.set(this, new Set()); }
    observe(target: Element) { resizeObservers.get(this)?.add(target); }
    unobserve(target: Element) { resizeObservers.get(this)?.delete(target); }
    disconnect() { resizeObservers.delete(this); resizeCallbacks.delete(this); }
  }
  Object.defineProperty(env.window, 'ResizeObserver', { configurable: true, value: LayoutResizeObserver });
  const fonts = Object.assign(new env.window.EventTarget(), { status: 'loaded' });
  Object.defineProperty(env.document, 'fonts', { configurable: true, value: fonts });
  const style = env.document.createElement('div').style;
  style.colorScheme = 'dark';
  globalThis.getComputedStyle = () => style;
  const layouts: Layout[] = [];
  let respond: (layout: Layout) => Promise<Result> = async (layout) => layout.occluded ? { layers } : true;
  t.mock.method(netcattyBridge, 'get', () => ({
    setHostBrowserPanelLayout: async (layout: Layout) => { layouts.push(layout); return respond(layout); },
    openHostBrowser: async () => {},
    startPortForward: async () => assert.fail('a local browser needs no SSH transport'),
    closeHostBrowserPanel: async () => {},
  }));
  let panel: ReturnType<typeof useHostBrowserPanel>;
  function Panel({ visible = true, browserId = 'local:overlay-test' }) {
    panel = useHostBrowserPanel({ browserId,
      host: { id: 'local', protocol: 'local', label: 'Local terminal', hostname: '', username: '', tags: [], os: 'macos' },
      hosts: [], keys: [], identities: [], knownHosts: [], terminalSettings: {} as TerminalSettings,
      isVisible: visible });
    return React.createElement('div', { ref: panel.elementRef });
  }
  const element = env.document.createElement('div');
  env.document.body.append(element);
  let bounds = new env.window.DOMRect(200, 100, 500, 600);
  let reads = 0;
  element.getBoundingClientRect = () => { reads += 1; return bounds; };
  let renderer: ReturnType<typeof create>;
  t.after(async () => {
    if (renderer) await act(async () => renderer.unmount());
    for (const [name, previous] of originals) {
      if (previous) Object.defineProperty(globalThis, name, previous);
      else Reflect.deleteProperty(globalThis, name);
    }
    env.cleanup();
  });
  await act(async () => { renderer = create(React.createElement(Panel), { createNodeMock: () => element }); });
  const overlay = (html: string, x = 220, y = 110) => {
    env.document.body.insertAdjacentHTML('beforeend', html);
    const node = env.document.body.lastElementChild!;
    for (const target of [node, ...node.children]) {
      target.getBoundingClientRect = () => new env.window.DOMRect(x, y, 150, 40);
    }
    return node;
  };
  const tick = async () => {
    await act(async () => {
      await Promise.resolve();
      const pending = [...frames.values()]; frames.clear();
      for (const callback of pending) callback(0);
    });
  };
  return { layouts, overlay, tick, panel: () => panel, pendingFrames: () => frames.size,
    env, element, style, fonts, reads: () => reads, setBounds: (next: DOMRect) => { bounds = next; },
    observerCount: () => resizeObservers.size,
    resize: () => { for (const [observer, callback] of resizeCallbacks) callback([], observer); },
    respond: (callback: typeof respond) => { respond = callback; },
    hide: async () => { await act(async () => renderer.update(React.createElement(Panel, { visible: false }))); } };
}

const tooltip = '<div data-radix-popper-content-wrapper><div data-state="delayed-open"><span role="tooltip">Split vertically</span></div></div>';

test('a split-button tooltip keeps the browser picture, then restores its live view', async (t) => {
  const f = await fixture(t);
  assert.equal(f.layouts.at(-1)?.visible, true);
  const hint = f.overlay(tooltip);
  await f.tick();
  assert.equal(f.layouts.at(-1)?.visible, true, 'the owning panel remains open');
  assert.equal(f.layouts.at(-1)?.occluded, true);
  assert.deepEqual(f.panel().snapshot, layers, 'the native page is replaced by its picture, not a blank pane');
  const count = f.layouts.length;
  await f.tick();
  assert.equal(f.layouts.length, count, 'a stationary tooltip captures only once');
  hint.remove(); await f.tick();
  assert.equal(f.layouts.at(-1)?.occluded, false);
  assert.deepEqual(f.panel().snapshot, []);
});

test('unrelated and closed poppers leave the browser live', async (t) => {
  const f = await fixture(t);
  f.overlay(tooltip, 10, 10);
  f.overlay('<div data-radix-popper-content-wrapper><div role="menu" data-state="closed"></div></div>');
  await f.tick();
  assert.equal(f.layouts.length, 1);
  assert.equal(f.layouts.at(-1)?.occluded, false);
});

test('overlapping nonmodal menus yield with a picture; modal dialogs yield even beside the pane', async (t) => {
  const f = await fixture(t);
  const menu = f.overlay('<div data-radix-popper-content-wrapper><div role="dialog" data-state="open"></div></div>');
  await f.tick(); assert.equal(f.layouts.at(-1)?.occluded, true);
  menu.remove(); await f.tick();
  f.overlay('<div role="dialog" aria-modal="true"></div>', 0, 0);
  await f.tick(); assert.equal(f.layouts.at(-1)?.occluded, true);
});

test('closing a menu while capture is pending cannot restore stale pictures', async (t) => {
  const f = await fixture(t);
  let complete: (result: Result) => void = () => assert.fail('capture was not started');
  f.respond((layout) => layout.occluded ? new Promise((resolve) => { complete = resolve; }) : Promise.resolve(true));
  const menu = f.overlay(tooltip); await f.tick();
  menu.remove(); await f.tick();
  await act(async () => complete({ layers }));
  assert.deepEqual(f.panel().snapshot, []);
});

test('hiding or locking the pane clears pictures without taking another capture', async (t) => {
  const f = await fixture(t);
  f.overlay(tooltip); await f.tick();
  assert.deepEqual(f.panel().snapshot, layers);
  f.overlay('<div data-app-lock-overlay role="dialog"></div>'); await f.tick();
  assert.equal(f.layouts.at(-1)?.visible, false);
  assert.equal(f.layouts.at(-1)?.occluded, false);
  assert.deepEqual(f.panel().snapshot, []);
  await f.hide();
  assert.deepEqual(f.panel().snapshot, []);
});


test('a stationary visible browser leaves no repeating layout work', async (t) => {
  const f = await fixture(t);
  for (let index = 0; index < 600; index += 1) await f.tick();
  assert.equal(f.layouts.length, 1);
  assert.equal(f.pendingFrames(), 0, 'idle browser must stop scheduling document/style/geometry scans');
});


test('layout, scroll, font, stylesheet and theme changes coalesce without resuming idle scans', async (t) => {
  const f = await fixture(t);
  const reads = f.reads();
  f.setBounds(new f.env.window.DOMRect(100, 50, 400, 500));
  for (let index = 0; index < 20; index += 1) {
    f.resize();
    f.env.window.dispatchEvent(new f.env.window.Event('resize'));
    f.element.dispatchEvent(new f.env.window.Event('scroll', { bubbles: true }));
  }
  f.fonts.dispatchEvent(new f.env.window.Event('loadingdone'));
  f.env.document.dispatchEvent(new f.env.window.Event('load'));
  f.style.colorScheme = 'light';
  f.env.document.documentElement.classList.add('light');
  assert.equal(f.reads(), reads, 'bursts do not synchronously force repeated layout reads');
  await f.tick();
  assert.equal(f.reads(), reads + 1);
  assert.deepEqual(f.layouts.at(-1)?.bounds, { x: 100, y: 50, width: 400, height: 500 });
  assert.equal(f.layouts.at(-1)?.theme, 'light');
  assert.equal(f.pendingFrames(), 0);
  f.env.document.body.setAttribute('inert', ''); await f.tick();
  assert.equal(f.layouts.at(-1)?.visible, false);
  f.env.document.body.removeAttribute('inert'); await f.tick();
  assert.equal(f.layouts.at(-1)?.visible, true);
});

test('resize observation follows a moving overlay and is released while hidden', async (t) => {
  const f = await fixture(t);
  const popper = f.overlay(tooltip, 10, 10); await f.tick();
  assert.equal(f.layouts.at(-1)?.occluded, false);
  popper.firstElementChild!.getBoundingClientRect = () => new f.env.window.DOMRect(220, 110, 150, 40);
  f.resize(); await f.tick();
  assert.equal(f.layouts.at(-1)?.occluded, true);
  await f.hide();
  assert.equal(f.observerCount(), 0);
  const reads = f.reads();
  f.overlay('<div role="dialog" aria-modal="true"></div>');
  f.env.window.dispatchEvent(new f.env.window.Event('resize'));
  f.fonts.dispatchEvent(new f.env.window.Event('loadingdone'));
  await f.tick();
  assert.equal(f.pendingFrames(), 0);
  assert.equal(f.reads(), reads);
});

test('only pane/ancestor and overlay motion follows frames, then stops at settlement', async (t) => {
  const f = await fixture(t);
  const animation = { pending: false, playState: 'running' };
  f.element.getAnimations = () => [animation as unknown as Animation];
  f.element.dispatchEvent(new f.env.window.Event('transitionrun', { bubbles: true }));
  const reads = f.reads();
  for (let index = 0; index < 5; index += 1) {
    f.setBounds(new f.env.window.DOMRect(200 + index * 10, 100, 500, 600));
    await f.tick();
  }
  assert.equal(f.reads(), reads + 5);
  assert.equal(f.layouts.at(-1)?.bounds?.x, 240);
  animation.playState = 'finished'; await f.tick();
  assert.equal(f.pendingFrames(), 0);

  const spinner = f.env.document.createElement('div'); f.env.document.body.append(spinner); await f.tick();
  spinner.getAnimations = () => [animation as unknown as Animation];
  const settledReads = f.reads();
  spinner.dispatchEvent(new f.env.window.Event('animationstart', { bubbles: true }));
  await f.tick();
  assert.equal(f.reads(), settledReads, 'unrelated cursor/spinner animation does not wake the browser');
});

test('removing an animating overlay cannot leave an endless layout loop', async (t) => {
  const f = await fixture(t);
  const popper = f.overlay(tooltip);
  popper.firstElementChild!.getAnimations = () => [{ pending: false, playState: 'running' } as Animation];
  await f.tick();
  assert.equal(f.pendingFrames(), 1);
  popper.remove(); await f.tick();
  assert.equal(f.pendingFrames(), 0);
  assert.equal(f.layouts.at(-1)?.occluded, false);
});

test('an old capture stays obsolete when an identical overlay is opened again', async (t) => {
  const f = await fixture(t);
  const captures: ((result: Result) => void)[] = [];
  f.respond((layout) => layout.occluded ? new Promise((resolve) => { captures.push(resolve); }) : Promise.resolve(true));
  const first = f.overlay(tooltip); await f.tick();
  first.remove(); await f.tick();
  f.overlay(tooltip); await f.tick();
  assert.equal(captures.length, 2);
  await act(async () => captures[0]({ layers }));
  assert.deepEqual(f.panel().snapshot, [], 'the first A capture must not become valid after A -> B -> A');
  await act(async () => captures[1]({ layers }));
  assert.deepEqual(f.panel().snapshot, layers);
});
