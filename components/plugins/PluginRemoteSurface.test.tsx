import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';

test('plugin surface forwards its own input and contains malformed updates and render errors', async () => {
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
    let clicks = 0;
    const renderView = async (nextTree: unknown) => act(async () => root.render(<>
      <PluginRemoteSurface key="view" tree={nextTree} css="" onEvent={() => {}} />
      <button id="canary" onClick={() => clicks++}>Host canary</button>
      <PluginRemoteSurface key="sibling" tree={tree} css="" onEvent={() => {}} />
    </>));
    await renderView(tree);
    await renderView({ children: [{ id: 'bad', type: 1, element: 'input', attributes: {}, children: [{ id: 'text', type: 3, data: 'invalid' }] }] });
    assert.equal(document.querySelectorAll('[data-plugin-remote-surface]').length, 1);
    assert.ok(document.querySelector('[role=alert]'));
    await act(async () => document.getElementById('canary')!.click());
    assert.equal(clicks, 1);
    // Validated data can still hit a React rendering constraint. Contain that
    // descendant throw too, independently of the policy rejection above.
    const originalError = console.error;
    try {
      console.error = () => {};
      await renderView({ children: [{ id: 'bad', type: 1, element: 'textarea', attributes: {}, children: [
        { id: 'a', type: 3, data: 'one' }, { id: 'b', type: 3, data: 'two' },
      ] }] });
    } finally { console.error = originalError; }
    assert.equal(document.querySelectorAll('[data-plugin-remote-surface]').length, 1);
    assert.ok(document.querySelector('[role=alert]'));
    await act(async () => document.getElementById('canary')!.click());
    assert.equal(clicks, 2);
  } finally {
    await act(async () => { root.unmount(); });
    for (const [key, value] of saved) { if (value) Object.defineProperty(globalThis, key, value); else Reflect.deleteProperty(globalThis, key); }
    Reflect.deleteProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT'); dom.window.close();
  }
});

test('closed-shadow editing keeps app close shortcuts in Vault, sidebar, tabs and popovers', async () => {
  const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: 'http://localhost', pretendToBeVisual: true });
  const saved = new Map<string, PropertyDescriptor | undefined>();
  for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document, navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement, Element: dom.window.Element, Node: dom.window.Node, IS_REACT_ACT_ENVIRONMENT: true })) {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  dom.window.HTMLElement.prototype.getBoundingClientRect = () => ({ x: 20, y: 20, width: 240, height: 30, top: 20, left: 20, right: 260, bottom: 50, toJSON() {} });
  Object.assign(dom.window, { ResizeObserver: class { observe() {} disconnect() {} } });
  const shadows: ShadowRoot[] = [];
  const nativeAttach = dom.window.Element.prototype.attachShadow;
  dom.window.Element.prototype.attachShadow = function (options) {
    const shadow = nativeAttach.call(this, options); shadows.push(shadow as unknown as ShadowRoot); return shadow;
  };
  const { act } = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { PluginRemoteSurface } = await import('./PluginRemoteSurface');
  const { handleGlobalHotkeyKeyDownImpl } = await import('../../application/app/AppHandlers');
  const { isPluginViewEditingTarget, isPluginShortcutEditableEvent } = await import('../../application/state/pluginKeybindings');
  const { matchesKeyBinding } = await import('../../domain/models');
  const { DEFAULT_KEY_BINDINGS } = await import('../../domain/models/keyBindings');
  const actions: string[] = [];
  const capture = (event: KeyboardEvent) => handleGlobalHotkeyKeyDownImpl(() => ({
    HOTKEY_DEBUG: false, closeTabKeyStr: 'Ctrl + W', hotkeyScheme: 'pc', keyBindings: DEFAULT_KEY_BINDINGS, matchesKeyBinding,
    executeHotkeyAction: (action: string) => actions.push(action),
  }), event);
  dom.window.addEventListener('keydown', capture as unknown as EventListener, true);
  const control = (id: string, element: string, attributes = {}) => ({ id, type: 1, element, attributes, children: [] });
  const tree = { children: [control('input', 'input'), control('textarea', 'textarea'), control('anchor', 'button', { id: 'anchor' }),
    { ...control('popover', 'div', { 'data-plugin-popover': 'true', 'data-plugin-anchor': 'anchor', open: '' }), children: [control('pop-input', 'input'), control('pop-textarea', 'textarea')] },
  ] };
  const root = createRoot(document.getElementById('root')!);
  try {
    for (const slot of ['vault-page', 'terminal-sidebar', 'plugin-tab']) {
      shadows.length = 0;
      await act(async () => root.render(<div key={slot} data-plugin-view-slot={slot}><PluginRemoteSurface tree={tree} css="" onEvent={() => {}} /></div>));
      assert.equal(shadows.length, 2, 'includes the portaled popover surface');
      for (const shadow of shadows) {
        for (const element of shadow.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>('input,textarea')) {
          await act(async () => element.focus());
          // Native menu IPC sees this same retargeted document.activeElement.
          assert.equal(isPluginViewEditingTarget(document.activeElement), true, `${slot}: ${element.tagName}`);
          let editable = false;
          const observe = (event: Event) => { editable = isPluginShortcutEditableEvent(event); assert.equal(event.target, shadow.host); };
          dom.window.addEventListener('keydown', observe, { once: true });
          await act(async () => element.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'w', code: 'KeyW', ctrlKey: true, bubbles: true, composed: true, cancelable: true })));
          assert.equal(editable, true);
          assert.deepEqual(actions, []);
        }
      }
      await act(async () => (shadows[0].querySelector('button') as HTMLButtonElement).focus());
      assert.equal(isPluginViewEditingTarget(document.activeElement), false, 'focus marker clears when editing ends');
    }
  } finally {
    dom.window.removeEventListener('keydown', capture as unknown as EventListener, true);
    await act(async () => root.unmount()); dom.window.close();
    for (const [key, value] of saved) { if (value) Object.defineProperty(globalThis, key, value); else Reflect.deleteProperty(globalThis, key); }
  }
});
