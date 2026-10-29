import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';

test('plugin HTML renders inside a bounded host surface and only its own input is sent', async () => {
  const dom = new JSDOM('<!doctype html><div id="root"></div><input id="host" value="private">', { url: 'http://localhost', pretendToBeVisual: true });
  const saved = new Map<string, PropertyDescriptor | undefined>();
  for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'Element', 'Node', 'Event', 'MouseEvent', 'ShadowRoot']) {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value: key === 'window' ? dom.window : dom.window[key as keyof typeof dom.window] });
  }
  Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { configurable: true, writable: true, value: true });
  let captured: ShadowRoot | undefined;
  const nativeAttach = dom.window.Element.prototype.attachShadow;
  dom.window.Element.prototype.attachShadow = function (options) { captured = nativeAttach.call(this, options) as unknown as ShadowRoot; return captured as unknown as globalThis.ShadowRoot; };
  const { default: React, act } = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { PluginRemoteSurface } = await import('./PluginRemoteSurface');
  const events: unknown[] = [];
  const tree = { children: [{ id: '1', type: 1, element: 'div', attributes: { class: 'card', style: 'display:grid;gap:8px' }, children: [
    { id: '2', type: 1, element: 'button', attributes: { type: 'button', 'data-netcatty-remote-node': 'forged' }, children: [{ id: '3', type: 3, data: '<b>Hello</b>' }] },
    { id: '4', type: 1, element: 'input', attributes: { type: 'text', value: '' }, children: [] },
  ] }] };
  const root = createRoot(document.getElementById('root')!);
  try {
    await act(async () => { root.render(<PluginRemoteSurface tree={tree} css=".card{color:red}" onEvent={(event) => events.push(event)} />); });
    assert.ok(captured); assert.equal(document.querySelector('[data-plugin-remote-surface]')?.querySelector('button'), null);
    assert.equal(captured!.querySelector('button')?.textContent, '<b>Hello</b>');
    assert.equal(captured!.querySelector('button')?.getAttribute('data-netcatty-remote-node'), '2');
    await act(async () => { captured!.querySelector('button')!.click(); });
    assert.deepEqual(events, [{ nodeId: '2', type: 'click' }]);
    const input = captured!.querySelector('input')!; input.value = 'typed';
    await act(async () => { input.dispatchEvent(new dom.window.Event('input', { bubbles: true })); });
    assert.deepEqual(events.at(-1), { nodeId: '4', type: 'input', value: 'typed' });
    await act(async () => { document.getElementById('host')!.dispatchEvent(new dom.window.Event('input', { bubbles: true })); });
    assert.equal(events.length, 2);
    await act(async () => { root.render(<PluginRemoteSurface tree={tree} css="@import 'https://bad.example/x';" onEvent={() => {}} />); });
    assert.equal(document.querySelector('[role=alert]')?.textContent, 'Unable to display plugin view.');
  } finally {
    await act(async () => { root.unmount(); });
    for (const [key, value] of saved) { if (value) Object.defineProperty(globalThis, key, value); else Reflect.deleteProperty(globalThis, key); }
    Reflect.deleteProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT'); dom.window.close();
  }
});
