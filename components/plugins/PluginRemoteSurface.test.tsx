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
  const { act } = await import('react');
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
    const optionA = { id: 'a', type: 1, element: 'option', attributes: { selected: '' }, children: [{ id: 'at', type: 3, data: '  First\n option  ' }] };
    const optionB = { id: 'b', type: 1, element: 'option', attributes: {}, children: [{ id: 'bt', type: 3, data: 'Second' }] };
    const controls = { children: [
      { id: 'select', type: 1, element: 'select', attributes: { multiple: '' }, children: [optionA, optionB] },
      { id: 'textarea', type: 1, element: 'textarea', attributes: {}, children: [{ id: 'ta', type: 3, data: 'Hello' }, { id: 'tb', type: 3, data: ' world' }] },
    ] };
    const renderControls = async () => act(async () => root.render(<PluginRemoteSurface tree={{ ...controls }} css="" onEvent={(event) => events.push(event)} />));
    await renderControls();
    const select = captured!.querySelector('select')!;
    assert.deepEqual([...select.selectedOptions].map((option) => option.value), ['First option']);
    assert.equal(captured!.querySelector('textarea')!.value, 'Hello world');
    await act(async () => {
      select.options[0].selected = false; select.options[1].selected = true;
      select.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
    });
    assert.deepEqual(events.at(-1), { nodeId: 'select', type: 'change', value: 'Second', values: ['Second'] });
    optionA.attributes = {} as typeof optionA.attributes;
    optionB.attributes = { selected: '' };
    await renderControls();
    assert.deepEqual([...select.selectedOptions].map((option) => option.value), ['Second'], 'acknowledgement keeps native option text values selected');

    let clicks = 0;
    const renderView = async (nextTree: unknown, viewKey = 'view') => act(async () => root.render(<>
      <PluginRemoteSurface key={viewKey} tree={nextTree} css="" onEvent={() => {}} />
      <button id="canary" onClick={() => clicks++}>Host canary</button>
      <PluginRemoteSurface key="sibling" tree={tree} css="" onEvent={() => {}} />
    </>));
    await renderView(tree);
    await renderView({ children: [{ id: 'bad', type: 1, element: 'input', attributes: {}, children: [{ id: 'text', type: 3, data: 'invalid' }] }] });
    assert.equal(document.querySelectorAll('[data-plugin-remote-surface]').length, 1);
    assert.ok(document.querySelector('[role=alert]'));
    await act(async () => document.getElementById('canary')!.click());
    assert.equal(clicks, 1);
    // Unexpected rendering failures stay within this plugin, including layout effects.
    const originalError = console.error;
    const prevAttach = dom.window.Element.prototype.attachShadow;
    try {
      console.error = () => {};
      dom.window.Element.prototype.attachShadow = () => { throw new Error('Synthetic surface failure'); };
      await renderView(tree, 'broken-surface');
    } finally {
      dom.window.Element.prototype.attachShadow = prevAttach;
      console.error = originalError;
    }
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

test('PluginRemoteSurface avoids JSON/form hook work on text and plain elements and preserves unchanged subtrees', async () => {
  const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: 'http://localhost', pretendToBeVisual: true });
  const saved = new Map<string, PropertyDescriptor | undefined>();
  for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'Element', 'Node', 'Event', 'MouseEvent', 'ShadowRoot']) {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value: key === 'window' ? dom.window : dom.window[key as keyof typeof dom.window] });
  }
  Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { configurable: true, writable: true, value: true });

  let captured: ShadowRoot | undefined;
  const nativeAttach = dom.window.Element.prototype.attachShadow;
  dom.window.Element.prototype.attachShadow = function (options) {
    captured = nativeAttach.call(this, options) as unknown as ShadowRoot;
    return captured as unknown as globalThis.ShadowRoot;
  };

  const { act } = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { PluginRemoteSurface } = await import('./PluginRemoteSurface');

  const stableSubtree = {
    id: 'stable-list',
    type: 1,
    element: 'div',
    attributes: { class: 'list' },
    children: Array.from({ length: 40 }, (_, i) => ({
      id: `row-${i}`,
      type: 1,
      element: 'span',
      attributes: {},
      children: [{ id: `text-${i}`, type: 3, data: `Item ${i}` }],
    })),
  };
  const onEvent = () => {};
  const root = createRoot(document.getElementById('root')!);

  const origStringify = JSON.stringify;
  const origParse = JSON.parse;
  let stringifyCalls = 0;
  let parseCalls = 0;
  JSON.stringify = ((...args: Parameters<typeof JSON.stringify>) => {
    stringifyCalls++;
    return origStringify(...args);
  }) as typeof JSON.stringify;
  JSON.parse = ((...args: Parameters<typeof JSON.parse>) => {
    parseCalls++;
    return origParse(...args);
  }) as typeof JSON.parse;

  try {
    await act(async () => {
      root.render(
        <PluginRemoteSurface
          tree={{
            children: [
              stableSubtree,
              { id: 'comment-1', type: 8, data: 'ignored' },
              { id: 'counter', type: 1, element: 'p', attributes: {}, children: [{ id: 'c-text', type: 3, data: 'Count 0' }] },
              { id: 'input-1', type: 1, element: 'input', attributes: { type: 'text', value: 'hello' }, children: [] },
            ],
          }}
          css=".list{display:grid}"
          onEvent={onEvent}
        />,
      );
    });
    assert.equal(stringifyCalls, 0, 'initial mount of text, plain, and input elements must not invoke JSON.stringify');
    assert.equal(parseCalls, 0, 'initial mount of text, plain, and input elements must not invoke JSON.parse');
    const firstListNode = captured!.querySelector('.list');
    assert.ok(firstListNode);
    assert.equal(captured!.querySelector('p')?.textContent, 'Count 0');
    assert.equal(captured!.querySelector('input')?.value, 'hello');

    await act(async () => {
      root.render(
        <PluginRemoteSurface
          tree={{
            children: [
              stableSubtree,
              { id: 'comment-1', type: 8, data: 'ignored' },
              { id: 'counter', type: 1, element: 'p', attributes: {}, children: [{ id: 'c-text', type: 3, data: 'Count 1' }] },
              { id: 'input-1', type: 1, element: 'input', attributes: { type: 'text', value: 'world' }, children: [] },
            ],
          }}
          css=".list{display:grid}"
          onEvent={onEvent}
        />,
      );
    });
    assert.equal(parseCalls, 0, 're-rendering text, plain, and input elements must invoke zero JSON.parse calls');
    assert.equal(captured!.querySelector('.list'), firstListNode, 'unchanged plain subtree preserves DOM identity');
    assert.equal(captured!.querySelector('p')?.textContent, 'Count 1');
    assert.equal(captured!.querySelector('input')?.value, 'world');
  } finally {
    JSON.stringify = origStringify;
    JSON.parse = origParse;
    await act(async () => root.unmount());
    dom.window.close();
    for (const [key, value] of saved) { if (value) Object.defineProperty(globalThis, key, value); else Reflect.deleteProperty(globalThis, key); }
    Reflect.deleteProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT');
  }
});
