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
    assert.deepEqual(events.at(-1), { nodeId: '4', type: 'input', value: 'typed', selectionStart: 5, selectionEnd: 5 });
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

test('PluginRemoteSurface forwards dblclick, contextmenu, throttled scroll, cursor popover, and host-rendered widgets', async () => {
  const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: 'http://localhost', pretendToBeVisual: true });
  const saved = new Map<string, PropertyDescriptor | undefined>();
  for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'Element', 'Node', 'Event', 'MouseEvent', 'PointerEvent', 'ShadowRoot']) {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    const val = key === 'window' ? dom.window : key === 'PointerEvent' ? dom.window.MouseEvent : dom.window[key as keyof typeof dom.window];
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value: val });
  }
  Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { configurable: true, writable: true, value: true });
  Object.assign(dom.window, {
    ResizeObserver: class {
      private cb: (entries: unknown[]) => void;
      constructor(cb: (entries: unknown[]) => void) { this.cb = cb; }
      observe(target: Element) {
        this.cb([{ target, borderBoxSize: [{ inlineSize: 800, blockSize: 600 }], contentRect: { width: 800, height: 600 } }]);
      }
      unobserve() {}
      disconnect() {}
    },
    PointerEvent: dom.window.MouseEvent,
  });
  dom.window.HTMLElement.prototype.getBoundingClientRect = () => ({
    x: 100, y: 50, width: 800, height: 600, top: 50, left: 100, right: 900, bottom: 650, toJSON() {},
  });

  const shadows: ShadowRoot[] = [];
  const nativeAttach = dom.window.Element.prototype.attachShadow;
  dom.window.Element.prototype.attachShadow = function (options) {
    const s = nativeAttach.call(this, options);
    shadows.push(s as unknown as ShadowRoot);
    return s;
  };

  const { act } = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { PluginRemoteSurface } = await import('./PluginRemoteSurface');

  const events: Array<Record<string, unknown>> = [];
  const gridProps = {
    columns: [
      { name: 'id', type: 'int4', primaryKey: true },
      { name: 'name', type: 'varchar', nullable: true },
    ],
    rows: [
      { id: 1, name: 'Alice' },
      { id: 2, name: null },
    ],
    dirtyCells: { '0:name': 'Alicia' },
    editable: true,
  };
  const erProps = {
    tables: [
      { name: 'users', columns: [{ name: 'id', type: 'int', isPk: true }] },
      { name: 'orders', columns: [{ name: 'id', type: 'int', isPk: true }, { name: 'user_id', type: 'int', isFk: true }] },
    ],
    relations: [{ fromTable: 'orders', fromColumn: 'user_id', toTable: 'users', toColumn: 'id' }],
  };
  const tree = {
    children: [
      {
        id: 'scroller',
        type: 1,
        element: 'div',
        attributes: { class: 'list' },
        children: [{ id: 'item', type: 1, element: 'button', attributes: { type: 'button' }, children: [{ id: 'it', type: 3, data: 'Row' }] }],
      },
      {
        id: 'ctx-popover',
        type: 1,
        element: 'div',
        attributes: {
          'data-plugin-popover': 'true',
          'data-plugin-anchor-x': '120',
          'data-plugin-anchor-y': '80',
          'data-plugin-popover-width': '260',
          'data-plugin-popover-max-height': '320',
          open: '',
        },
        children: [{ id: 'pop-item', type: 1, element: 'span', attributes: {}, children: [{ id: 'pt', type: 3, data: 'Menu' }] }],
      },
      {
        id: 'split',
        type: 1,
        element: 'div',
        attributes: {
          'data-plugin-widget': 'split-pane',
          'data-plugin-widget-props': JSON.stringify({ direction: 'horizontal', initialSize: 220, minSize: 120, maxSize: 400 }),
        },
        children: [
          { id: 'pane-a', type: 1, element: 'div', attributes: {}, children: [{ id: 'pa', type: 3, data: 'Left' }] },
          { id: 'pane-b', type: 1, element: 'div', attributes: {}, children: [{ id: 'pb', type: 3, data: 'Right' }] },
        ],
      },
      {
        id: 'grid',
        type: 1,
        element: 'div',
        attributes: { 'data-plugin-widget': 'data-grid', 'data-plugin-widget-props': JSON.stringify(gridProps) },
        children: [],
      },
      {
        id: 'er',
        type: 1,
        element: 'div',
        attributes: { 'data-plugin-widget': 'er-canvas', 'data-plugin-widget-props': JSON.stringify(erProps) },
        children: [],
      },
    ],
  };

  const root = createRoot(document.getElementById('root')!);
  try {
    await act(async () => {
      root.render(<PluginRemoteSurface tree={tree} css="" onEvent={(e) => events.push(e as unknown as Record<string, unknown>)} />);
    });

    const mainShadow = shadows[0];
    assert.ok(mainShadow, 'main shadow mounted');

    // 1. dblclick & contextmenu with surface-relative coordinates + preventDefault
    const btn = mainShadow.querySelector('button')!;
    const ctxEvent = new dom.window.MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 250, clientY: 170 });
    await act(async () => {
      btn.dispatchEvent(new dom.window.MouseEvent('dblclick', { bubbles: true, cancelable: true, clientX: 180, clientY: 90 }));
      btn.dispatchEvent(ctxEvent);
    });
    assert.equal(ctxEvent.defaultPrevented, true, 'contextmenu must call preventDefault');
    assert.deepEqual(events[0], { nodeId: 'item', type: 'dblclick', x: 80, y: 40 });
    assert.deepEqual(events[1], { nodeId: 'item', type: 'contextmenu', x: 150, y: 120 });

    // 2. throttled scroll
    const scroller = mainShadow.querySelector('.list') as HTMLElement;
    scroller.scrollTop = 140;
    scroller.scrollLeft = 20;
    await act(async () => {
      scroller.dispatchEvent(new dom.window.Event('scroll', { bubbles: false }));
      await new Promise((resolve) => setTimeout(resolve, 90));
    });
    const scrollEvt = events.find((e) => e.type === 'scroll');
    assert.ok(scrollEvt, 'scroll event emitted');
    assert.equal(scrollEvt!.scrollTop, 140);
    assert.equal(scrollEvt!.scrollLeft, 20);

    // 3. cursor-anchored popover positioned within surface bounds with custom width & maxHeight
    const popoverEl = document.querySelector('[data-plugin-view-popover]') as HTMLElement | null;
    assert.ok(popoverEl, 'cursor-anchored popover rendered');
    assert.equal(popoverEl!.style.width, '260px');
    assert.equal(popoverEl!.style.maxHeight, '320px');
    assert.equal(popoverEl!.style.left, '220px'); // surface.left (100) + anchorX (120)

    // 4. SplitPane rendered inside shadow root with two panes and drag handle
    const splitEl = mainShadow.querySelector('[data-plugin-widget="split-pane"]') as HTMLElement | null;
    assert.ok(splitEl, 'split-pane rendered in shadow root');
    assert.equal(splitEl!.querySelectorAll('[data-split-pane]').length, 2);
    const handle = splitEl!.querySelector('[data-split-handle]') as HTMLElement;
    await act(async () => {
      handle.dispatchEvent(new dom.window.MouseEvent('pointerdown', { bubbles: true, clientX: 220 }));
      dom.window.dispatchEvent(new dom.window.MouseEvent('pointermove', { bubbles: true, clientX: 280 }));
      dom.window.dispatchEvent(new dom.window.MouseEvent('pointerup', { bubbles: true, clientX: 280 }));
    });
    assert.deepEqual(
      events.find((e) => e.nodeId === 'split' && e.widgetEvent === 'resizeEnd'),
      { nodeId: 'split', type: 'widget', widgetEvent: 'resizeEnd', detail: { size: 280, collapsed: false } },
    );

    // 5. DataGrid slotted in Light DOM: renders dirty cell, NULL pill, inline edit & sort
    const gridHost = document.querySelector('[data-plugin-widget-host="data-grid"]') as HTMLElement | null;
    assert.ok(gridHost, 'data-grid slotted in shadow host Light DOM');
    assert.ok(gridHost!.textContent?.includes('Alicia'), 'dirty cell value rendered');
    assert.ok(gridHost!.textContent?.includes('NULL'), 'NULL pill rendered');
    const nameHeaderBtn = gridHost!.querySelector('[data-col-name="name"] button') as HTMLButtonElement;
    await act(async () => { nameHeaderBtn.click(); });
    assert.deepEqual(
      events.find((e) => e.nodeId === 'grid' && e.widgetEvent === 'sortChange'),
      { nodeId: 'grid', type: 'widget', widgetEvent: 'sortChange', detail: { column: 'name', direction: 'asc' } },
    );
    const cell = gridHost!.querySelector('[role="gridcell"][data-row-index="0"][data-col-name="name"]') as HTMLElement;
    await act(async () => {
      cell.dispatchEvent(new dom.window.MouseEvent('dblclick', { bubbles: true }));
    });
    const editorInput = cell.querySelector('input') as HTMLInputElement;
    assert.ok(editorInput, 'double-click opens inline cell editor');
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value')!.set!;
      setter.call(editorInput, 'Bob');
      editorInput.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    });
    await act(async () => {
      editorInput.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
    assert.deepEqual(
      events.find((e) => e.nodeId === 'grid' && e.widgetEvent === 'cellEdit'),
      { nodeId: 'grid', type: 'widget', widgetEvent: 'cellEdit', detail: { rowIndex: 0, colName: 'name', value: 'Bob', isNull: false } },
    );

    // 6. ER Canvas slotted in Light DOM: renders tables + FK curve + emits tableClick
    const erHost = document.querySelector('[data-plugin-widget-host="er-canvas"]') as HTMLElement | null;
    assert.ok(erHost, 'er-canvas slotted in shadow host Light DOM');
    const usersCard = erHost!.querySelector('[data-er-table="users"]') as Element | null;
    assert.ok(usersCard, 'users table card rendered');
    await act(async () => {
      usersCard!.dispatchEvent(new dom.window.MouseEvent('pointerdown', { bubbles: true, button: 0, clientX: 10, clientY: 10 }));
      dom.window.dispatchEvent(new dom.window.MouseEvent('pointerup', { bubbles: true, button: 0, clientX: 10, clientY: 10 }));
    });
    assert.deepEqual(
      events.find((e) => e.nodeId === 'er' && e.widgetEvent === 'tableClick'),
      { nodeId: 'er', type: 'widget', widgetEvent: 'tableClick', detail: { table: 'users' } },
    );
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
    for (const [key, value] of saved) { if (value) Object.defineProperty(globalThis, key, value); else Reflect.deleteProperty(globalThis, key); }
    Reflect.deleteProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT');
  }
});

test('PluginDataGrid FK jump, hiddenColumns, keyboard shortcuts, and PluginErCanvas double-click + SVG export', async () => {
  const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: 'http://localhost', pretendToBeVisual: true });
  const saved = new Map<string, PropertyDescriptor | undefined>();
  for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'Element', 'Node', 'Event', 'MouseEvent', 'KeyboardEvent', 'PointerEvent', 'ShadowRoot']) {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    const val = key === 'window' ? dom.window : key === 'PointerEvent' ? dom.window.MouseEvent : dom.window[key as keyof typeof dom.window];
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value: val });
  }
  Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { configurable: true, writable: true, value: true });
  Object.assign(dom.window, {
    ResizeObserver: class {
      private cb: (entries: unknown[]) => void;
      constructor(cb: (entries: unknown[]) => void) { this.cb = cb; }
      observe(target: Element) {
        this.cb([{ target, borderBoxSize: [{ inlineSize: 800, blockSize: 600 }], contentRect: { width: 800, height: 600 } }]);
      }
      unobserve() {}
      disconnect() {}
    },
    PointerEvent: dom.window.MouseEvent,
  });
  dom.window.HTMLElement.prototype.getBoundingClientRect = () => ({
    x: 0, y: 0, width: 800, height: 600, top: 0, left: 0, right: 800, bottom: 600, toJSON() {},
  });

  const shadows: ShadowRoot[] = [];
  const nativeAttach = dom.window.Element.prototype.attachShadow;
  dom.window.Element.prototype.attachShadow = function (options) {
    const s = nativeAttach.call(this, options);
    shadows.push(s as unknown as ShadowRoot);
    return s;
  };

  const { act } = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { PluginRemoteSurface } = await import('./PluginRemoteSurface');

  const events: Array<Record<string, unknown>> = [];
  const gridProps = {
    columns: [
      { name: 'id', type: 'int4', primaryKey: true },
      { name: 'customer_id', type: 'int4', foreignKey: { table: 'customers', column: 'id', schema: 'public' } },
      { name: 'secret_col', type: 'text' },
    ],
    hiddenColumns: ['secret_col'],
    rows: [[10, 42, 'hidden-val']],
    editable: true,
  };
  const roGridProps = {
    columns: [{ name: 'id', type: 'int4' }],
    rows: [{ id: 99 }],
    editable: false,
  };
  const erProps = {
    tables: [
      { name: 'customers', schema: 'public', columns: [{ name: 'id', type: 'integer', isPk: true }, { name: 'created_at', type: 'timestamp with time zone' }] },
      { name: 'orders', schema: 'public', columns: [{ name: 'id', type: 'integer', isPk: true }, { name: 'customer_id', type: 'integer', isFk: true }] },
    ],
    relations: [{ fromTable: 'public.orders', fromColumn: 'customer_id', toTable: 'public.customers', toColumn: 'id', onDelete: 'CASCADE' }],
  };
  const tree = {
    children: [
      { id: 'surface-btn', type: 1, element: 'button', attributes: { type: 'button' }, children: [{ id: 'sbt', type: 3, data: 'Btn' }] },
      { id: 'grid', type: 1, element: 'div', attributes: { 'data-plugin-widget': 'data-grid', 'data-plugin-widget-props': JSON.stringify(gridProps) }, children: [] },
      { id: 'ro-grid', type: 1, element: 'div', attributes: { 'data-plugin-widget': 'data-grid', 'data-plugin-widget-props': JSON.stringify(roGridProps) }, children: [] },
      { id: 'er', type: 1, element: 'div', attributes: { 'data-plugin-widget': 'er-canvas', 'data-plugin-widget-props': JSON.stringify(erProps) }, children: [] },
    ],
  };

  const root = createRoot(document.getElementById('root')!);
  try {
    await act(async () => {
      root.render(<PluginRemoteSurface tree={tree} css="" onEvent={(e) => events.push(e as unknown as Record<string, unknown>)} />);
    });

    // Shadow surface prevents default on Cmd+K / Cmd+S
    const btn = shadows[0].querySelector('button')!;
    const modK = new dom.window.KeyboardEvent('keydown', { key: 'k', metaKey: true, bubbles: true, cancelable: true });
    await act(async () => { btn.dispatchEvent(modK); });
    assert.equal(modK.defaultPrevented, true, 'Cmd+K inside shadow surface must preventDefault');

    // DataGrid: hiddenColumns excludes secret_col while preserving values
    const gridHost = document.querySelector('[data-plugin-widget-node="grid"]') as HTMLElement;
    assert.equal(gridHost.querySelector('[data-col-name="secret_col"]'), null, 'hidden column must not render');
    const fkCell = gridHost.querySelector('[role="gridcell"][data-row-index="0"][data-col-name="customer_id"]') as HTMLElement;
    assert.ok(fkCell, 'customer_id FK cell rendered');
    const jumpBtn = fkCell.querySelector('[data-fk-jump]') as HTMLButtonElement;
    assert.ok(jumpBtn, 'FK jump button rendered');
    await act(async () => { jumpBtn.click(); });
    assert.deepEqual(
      events.find((e) => e.nodeId === 'grid' && e.widgetEvent === 'fkJump'),
      { nodeId: 'grid', type: 'widget', widgetEvent: 'fkJump', detail: { rowIndex: 0, colName: 'customer_id', value: 42, targetTable: 'customers', targetColumn: 'id', targetSchema: 'public' } },
    );

    // Select FK cell then press Cmd+C -> cellCopy, Delete -> cellEdit NULL, Cmd+Z -> shortcut mod+z
    await act(async () => { fkCell.click(); });
    const gridRoot = gridHost.querySelector('[data-plugin-data-grid]') as HTMLElement;
    await act(async () => {
      gridRoot.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'c', metaKey: true, bubbles: true, cancelable: true }));
      gridRoot.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Delete', bubbles: true, cancelable: true }));
      gridRoot.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'z', metaKey: true, bubbles: true, cancelable: true }));
    });
    assert.deepEqual(
      events.find((e) => e.nodeId === 'grid' && e.widgetEvent === 'cellCopy'),
      { nodeId: 'grid', type: 'widget', widgetEvent: 'cellCopy', detail: { text: '42', rowIndex: 0, colName: 'customer_id', rowIndices: [0] } },
    );
    assert.deepEqual(
      events.find((e) => e.nodeId === 'grid' && e.widgetEvent === 'cellEdit'),
      { nodeId: 'grid', type: 'widget', widgetEvent: 'cellEdit', detail: { rowIndex: 0, colName: 'customer_id', value: null, isNull: true } },
    );
    assert.deepEqual(
      events.find((e) => e.nodeId === 'grid' && e.widgetEvent === 'shortcut'),
      { nodeId: 'grid', type: 'widget', widgetEvent: 'shortcut', detail: { shortcut: 'mod+z' } },
    );

    // Non-editable grid double-click emits cellDoubleClick
    const roHost = document.querySelector('[data-plugin-widget-node="ro-grid"]') as HTMLElement;
    const roCell = roHost.querySelector('[role="gridcell"][data-row-index="0"][data-col-name="id"]') as HTMLElement;
    await act(async () => { roCell.dispatchEvent(new dom.window.MouseEvent('dblclick', { bubbles: true })); });
    assert.deepEqual(
      events.find((e) => e.nodeId === 'ro-grid' && e.widgetEvent === 'cellDoubleClick'),
      { nodeId: 'ro-grid', type: 'widget', widgetEvent: 'cellDoubleClick', detail: { rowIndex: 0, colName: 'id', value: 99 } },
    );

    // ER Canvas: abbreviated type, tableDoubleClick, Export SVG
    const erHost = document.querySelector('[data-plugin-widget-node="er"]') as HTMLElement;
    assert.ok(erHost.textContent?.includes('timestamptz'), 'verbose PG timestamp abbreviated to timestamptz');
    const ordersCard = erHost.querySelector('[data-er-table="orders"]') as Element;
    await act(async () => { ordersCard.dispatchEvent(new dom.window.MouseEvent('dblclick', { bubbles: true })); });
    assert.deepEqual(
      events.find((e) => e.nodeId === 'er' && e.widgetEvent === 'tableDoubleClick'),
      { nodeId: 'er', type: 'widget', widgetEvent: 'tableDoubleClick', detail: { table: 'orders', schema: 'public' } },
    );
    const exportBtn = erHost.querySelector('[data-er-export-svg]') as HTMLButtonElement;
    await act(async () => { exportBtn.click(); });
    const exportEvt = events.find((e) => e.nodeId === 'er' && e.widgetEvent === 'exportSvg');
    assert.ok(exportEvt, 'exportSvg event emitted');
    assert.match(String((exportEvt!.detail as { svg: string }).svg), /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);

    // Host global hotkey handler yields Cmd+K (commandPalette) to active plugin surface while keeping Cmd+J (quickSwitch)
    const { handleGlobalHotkeyKeyDownImpl } = await import('../../application/app/AppHandlers');
    const { matchesKeyBinding } = await import('../../domain/models');
    const { DEFAULT_KEY_BINDINGS } = await import('../../domain/models/keyBindings');
    const hostActions: string[] = [];
    const onGlobalKey = (event: KeyboardEvent) => handleGlobalHotkeyKeyDownImpl(() => ({
      HOTKEY_DEBUG: false,
      closeTabKeyStr: '⌘ + W',
      hotkeyScheme: 'mac',
      keyBindings: DEFAULT_KEY_BINDINGS,
      matchesKeyBinding,
      executeHotkeyAction: (action: string) => hostActions.push(action),
    }), event);
    dom.window.addEventListener('keydown', onGlobalKey as unknown as EventListener, true);
    try {
      await act(async () => {
        gridRoot.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'k', code: 'KeyK', metaKey: true, bubbles: true, cancelable: true }));
      });
      assert.deepEqual(hostActions, [], 'host commandPalette must not hijack Cmd+K inside plugin surface');
      assert.ok(
        events.some((e) => e.nodeId === 'grid' && e.widgetEvent === 'shortcut' && (e.detail as { shortcut?: string })?.shortcut === 'mod+k'),
        'Cmd+K reaches plugin DataGrid as mod+k shortcut',
      );
      await act(async () => {
        gridRoot.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'j', code: 'KeyJ', metaKey: true, bubbles: true, cancelable: true }));
      });
      assert.deepEqual(hostActions, ['quickSwitch'], 'Cmd+J still opens Netcatty Quick Switcher');
    } finally {
      dom.window.removeEventListener('keydown', onGlobalKey as unknown as EventListener, true);
    }
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
    for (const [key, value] of saved) { if (value) Object.defineProperty(globalThis, key, value); else Reflect.deleteProperty(globalThis, key); }
    Reflect.deleteProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT');
  }
});

test('RemoteImageElement renders a transparent placeholder while loading and never shows a broken img', async () => {
  const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: 'http://localhost', pretendToBeVisual: true });
  const saved = new Map<string, PropertyDescriptor | undefined>();
  for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'Element', 'Node', 'Event', 'ShadowRoot']) {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value: key === 'window' ? dom.window : dom.window[key as keyof typeof dom.window] });
  }
  Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { configurable: true, writable: true, value: true });

  const shadows: ShadowRoot[] = [];
  const nativeAttach = dom.window.Element.prototype.attachShadow;
  dom.window.Element.prototype.attachShadow = function (options) {
    const s = nativeAttach.call(this, options);
    shadows.push(s as unknown as ShadowRoot);
    return s;
  };

  const { act } = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { PluginRemoteSurface } = await import('./PluginRemoteSurface');

  let resolveImage!: (url: string) => void;
  const loadImage = () => new Promise<string>((resolve) => { resolveImage = resolve; });
  const root = createRoot(document.getElementById('root')!);
  try {
    await act(async () => {
      root.render(
        <PluginRemoteSurface
          tree={{ children: [{ id: 'img1', type: 1, element: 'img', attributes: { src: 'asset:assets/icons/pg.png', alt: 'PostgreSQL' }, children: [] }] }}
          css=""
          loadImage={loadImage}
          onEvent={() => {}}
        />,
      );
    });
    const img = shadows[0]?.querySelector('img');
    assert.ok(img, 'img element rendered');
    assert.equal(img!.getAttribute('data-plugin-image-loading'), 'true');
    assert.match(img!.getAttribute('src') ?? '', /^data:image\/gif;base64,/);
    assert.equal(img!.getAttribute('alt'), '', 'alt text hidden while placeholder loads');

    const resolvedUrl = 'data:image/png;base64,iVBORw0KGgo=';
    await act(async () => {
      resolveImage(resolvedUrl);
      await Promise.resolve();
    });
    assert.equal(img!.getAttribute('data-plugin-image-loading'), null);
    assert.equal(img!.getAttribute('src'), resolvedUrl);
    assert.equal(img!.getAttribute('alt'), 'PostgreSQL');
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
    for (const [key, value] of saved) { if (value) Object.defineProperty(globalThis, key, value); else Reflect.deleteProperty(globalThis, key); }
    Reflect.deleteProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT');
  }
});
