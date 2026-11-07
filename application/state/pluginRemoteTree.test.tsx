import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';

test('React 19 changes are staged as safe data before any host rendering', async () => {
  const dom = new JSDOM('<!doctype html><div id="remote"></div>', { url: 'http://localhost', pretendToBeVisual: true });
  const saved = new Map<string, PropertyDescriptor | undefined>();
  for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'Element', 'Node', 'MutationObserver', 'Event', 'MouseEvent']) {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value: key === 'window' ? dom.window : dom.window[key as keyof typeof dom.window] });
  }
  Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { configurable: true, writable: true, value: true });
  const { default: React, act, useState } = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { RemoteMutationObserver } = await import('@remote-dom/core/elements');
  const { createPluginRemoteTree } = await import('./pluginRemoteTree');
  const staged = createPluginRemoteTree();
  const snapshots: ReturnType<typeof staged.snapshot>[] = [];
  const observer = new RemoteMutationObserver({
    mutate(records) { snapshots.push(staged.apply(JSON.parse(JSON.stringify(records)))); },
    call() { throw new Error('Host method calls are unavailable'); },
  });
  const container = document.getElementById('remote')!;
  observer.observe(container);
  const root = createRoot(container);
  function Example() {
    const [count, setCount] = useState(0);
    return <section className="card" style={{ display: 'grid', gap: '12px' }}><h1>Hello</h1><button type="button" onClick={() => setCount((value) => value + 1)}>Count {count}</button></section>;
  }
  try {
    await act(async () => { root.render(<Example />); await new Promise((resolve) => setTimeout(resolve, 10)); });
    const first = snapshots.at(-1)!;
    const section = first.children[0]; assert.equal(section.type, 1);
    if (section.type !== 1) throw new Error('Expected section');
    assert.equal(section.attributes.class, 'card');
    assert.match(section.attributes.style, /display:\s*grid/);
    await act(async () => { container.querySelector('button')!.click(); await new Promise((resolve) => setTimeout(resolve, 10)); });
    const updated = JSON.stringify(snapshots.at(-1));
    assert.match(updated, /Count /); assert.match(updated, /"data":"1"/);
    assert.equal(staged.isFailed(), false);
    assert.throws(() => staged.apply([[3, section.id, 'onclick', 'attack()']]));
    assert.deepEqual(staged.snapshot(), { children: [] });
    assert.equal(staged.isFailed(), true);
    assert.throws(() => staged.apply([]));
  } finally {
    observer.disconnect(); await act(async () => { root.unmount(); });
    for (const [key, value] of saved) { if (value) Object.defineProperty(globalThis, key, value); else Reflect.deleteProperty(globalThis, key); }
    Reflect.deleteProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT'); dom.window.close();
  }
});

test('removed attributes do not keep checkboxes, menus or old inline styles active', async () => {
  const { createPluginRemoteTree } = await import('./pluginRemoteTree');
  const tree = createPluginRemoteTree();
  tree.apply([[0, '~', { id: 'control', type: 1, element: 'input', attributes: { type: 'checkbox', checked: '', style: 'color:red' }, children: [] }, 0]]);
  const updated = tree.apply([[3, 'control', 'checked', null], [3, 'control', 'style', null]]);
  assert.deepEqual(updated.children[0], { id: 'control', type: 1, element: 'input', attributes: { type: 'checkbox' }, children: [] });
});

test('inserting a child into an existing void element fails the view', async () => {
  const { createPluginRemoteTree } = await import('./pluginRemoteTree');
  const tree = createPluginRemoteTree();
  tree.apply([[0, '~', { id: 'input', type: 1, element: 'input', attributes: {}, children: [] }, 0]]);
  assert.throws(() => tree.apply([[0, 'input', { id: 'child', type: 3, data: 'invalid' }, 0]]), /Void view elements/);
  assert.equal(tree.isFailed(), true);
  assert.deepEqual(tree.snapshot(), { children: [] });
});
