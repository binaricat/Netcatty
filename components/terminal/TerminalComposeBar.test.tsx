import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { JSDOM } from 'jsdom';
import { createRoot } from 'react-dom/client';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { I18nProvider } from '../../application/i18n/I18nProvider';
import { COMPOSE_SNIPPET_DRAG_MIME, TerminalComposeBar } from './TerminalComposeBar';
import { TerminalContextMenu } from './TerminalContextMenu';
import { STORAGE_KEY_COMPOSE_BAR_PINNED_SNIPPETS } from '../../infrastructure/config/storageKeys';
import { TooltipProvider } from '../ui/tooltip';
import { getComposeBarHistory, pruneComposeBarHistory, recordComposeBarHistory } from '../../application/state/composeBarHistoryStore';
import { terminalReconnectRegistry } from '../../application/state/terminalReconnectRegistry';
import { createTerminalDirectoryController } from '../../application/state/terminalDirectoryController';
import { registerTerminalDirectory, refreshObservedTerminalDirectory } from '../../application/state/terminalDirectoryRegistry';
import { terminalCwdStore } from '../../application/state/terminalCwdStore';

test('disabling Context Chips preserves the compose draft and stops extra cwd refreshes', async (t) => {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost' });
  const originals = new Map<string, PropertyDescriptor | undefined>();
  for (const name of ['window', 'document', 'localStorage']) {
    originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, value: dom.window[name as keyof Window] });
  }
  t.after(() => {
    dom.window.close();
    for (const [name, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
  });
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  let probes = 0;
  const cleanup = registerTerminalDirectory('toggle-test', createTerminalDirectoryController({
    sessionId: 'toggle-test', isCurrent: () => true, isReady: () => true,
    io: { cwd: async () => { probes++; return '/project'; }, list: async () => ({ entries: [], home: null }),
      realpath: async path => path, write() {} },
    publish: cwd => { terminalCwdStore.setCwd('toggle-test', cwd, 'backend-strict'); },
  }));
  const textarea = { value: '', selectionStart: 0, selectionEnd: 0, focus() {},
    setSelectionRange(start: number, end: number) { this.selectionStart = start; this.selectionEnd = end; } };
  const render = (enabled: boolean) => <TooltipProvider><TerminalComposeBar sessionId="toggle-test"
    contextChipsEnabled={enabled} onSend={() => true} onClose={() => {}} /></TooltipProvider>;
  let root!: ReactTestRenderer;
  await act(async () => { root = create(render(true), { createNodeMock: el => el.type === 'textarea' ? textarea : null }); });
  assert.equal(probes, 1);
  textarea.value = 'keep this draft'; textarea.selectionStart = 2; textarea.selectionEnd = 8;
  await act(async () => { root.update(render(false)); });
  assert.equal(root.root.findAllByProps({ 'aria-label': 'Context Chips' }).length, 0);
  const before = probes;
  refreshObservedTerminalDirectory('toggle-test');
  await Promise.resolve();
  assert.equal(probes, before);
  assert.equal(textarea.value, 'keep this draft');
  assert.deepEqual([textarea.selectionStart, textarea.selectionEnd], [2, 8]);
  await act(async () => { root.unmount(); });
  cleanup();
});

test('compose bar preserves a draft on pane focus and records only successful async sends', async (t) => {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost' });
  const originals = new Map<string, PropertyDescriptor | undefined>();
  for (const name of ['window', 'document', 'localStorage']) {
    originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, value: dom.window[name as keyof Window] });
  }
  t.after(() => {
    dom.window.close();
    for (const [name, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
  });
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  pruneComposeBarHistory([]);
  const createTextarea = () => ({
    value: '', selectionStart: 0, selectionEnd: 0,
    focus() {},
    setSelectionRange(start: number, end: number) { this.selectionStart = start; this.selectionEnd = end; },
  });
  let textarea = createTextarea();
  let finish!: (sent: boolean) => void;
  let rejectSend!: (error: Error) => void;
  const onSend = () => new Promise<boolean>((resolve, reject) => { finish = resolve; rejectSend = reject; });
  const render = (sessionId: string) => (
    <TooltipProvider><TerminalComposeBar sessionId={sessionId} onSend={onSend} onClose={() => {}} /></TooltipProvider>
  );
  let root!: ReactTestRenderer;
  await act(async () => {
    root = create(render('a'), { createNodeMock: (el) => {
      if (el.type !== 'textarea') return null;
      textarea = createTextarea();
      return textarea;
    } });
  });
  const key = (name: string) => root.root.findByType('textarea').props.onKeyDown({
    key: name, nativeEvent: {}, currentTarget: textarea, preventDefault() {},
  });
  textarea.value = 'unsent draft';
  await act(async () => { root.update(render('b')); });
  assert.equal(textarea.value, 'unsent draft');
  await act(async () => { root.update(render('a')); });
  recordComposeBarHistory('a', 'old command from A');
  key('ArrowUp');
  assert.equal(textarea.value, 'old command from A');
  await act(async () => { root.update(render('b')); });
  assert.equal(textarea.value, 'unsent draft');
  key('Enter');
  assert.equal(textarea.value, '');
  assert.deepEqual(getComposeBarHistory('b'), []);
  await act(async () => { finish(false); });
  assert.deepEqual(getComposeBarHistory('b'), []);
  textarea.value = 'accepted command';
  key('Enter');
  textarea.value = 'next draft';
  await act(async () => { finish(true); });
  assert.deepEqual(getComposeBarHistory('b'), ['accepted command']);
  assert.equal(textarea.value, 'next draft');
  key('ArrowUp');
  assert.equal(textarea.value, 'accepted command');
  key('ArrowDown');
  assert.equal(textarea.value, 'next draft');
  textarea.value = 'first';
  key('Enter');
  const finishFirst = finish;
  textarea.value = 'second';
  key('Enter');
  const finishSecond = finish;
  await act(async () => { finishSecond(true); });
  await act(async () => { finishFirst(true); });
  assert.deepEqual(getComposeBarHistory('b'), ['accepted command', 'first', 'second']);
  key('ArrowUp');
  assert.equal(textarea.value, 'second');
  textarea.value = 'rejected';
  key('Enter');
  const finishRejected = finish;
  textarea.value = 'after rejected';
  key('Enter');
  await act(async () => { finish(true); });
  await act(async () => { finishRejected(false); });
  assert.deepEqual(getComposeBarHistory('b'), ['accepted command', 'first', 'second', 'after rejected']);
  const errorLog = t.mock.method(console, 'error', () => {});
  textarea.value = 'exception';
  key('Enter');
  const rejectFirst = rejectSend;
  textarea.value = 'after exception';
  key('Enter');
  await act(async () => { finish(true); });
  await act(async () => { rejectFirst(new Error('send failed')); });
  assert.equal(errorLog.mock.callCount(), 1);
  assert.deepEqual(getComposeBarHistory('b'), ['accepted command', 'first', 'second', 'after rejected', 'after exception']);
  await act(async () => { root.unmount(); });
  pruneComposeBarHistory([]);
});

test('empty compose draft Enter reconnects; a typed draft still sends', async (t) => {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost' });
  const originals = new Map<string, PropertyDescriptor | undefined>();
  for (const name of ['window', 'document', 'localStorage']) {
    originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, value: dom.window[name as keyof Window] });
  }
  const sessionId = 'compose-enter-reconnect';
  const reconnects: string[] = [];
  const unregister = terminalReconnectRegistry.register(sessionId, () => {
    reconnects.push(sessionId);
  });
  t.after(() => {
    unregister();
    terminalReconnectRegistry.setEnterReconnectEnabled(sessionId, false);
    dom.window.close();
    for (const [name, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
  });
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const createTextarea = () => ({
    value: '', selectionStart: 0, selectionEnd: 0,
    focus() {},
    setSelectionRange() {},
  });
  let textarea = createTextarea();
  const sent: string[] = [];
  let root!: ReactTestRenderer;
  await act(async () => {
    root = create(
      <TooltipProvider>
        <TerminalComposeBar sessionId={sessionId} onSend={(text) => { sent.push(text); return true; }} onClose={() => {}} />
      </TooltipProvider>,
      { createNodeMock: (el) => {
        if (el.type !== 'textarea') return null;
        textarea = createTextarea();
        return textarea;
      } },
    );
  });
  const key = (name: string, extra: Record<string, unknown> = {}) => {
    let prevented = false;
    root.root.findByType('textarea').props.onKeyDown({
      key: name,
      shiftKey: false,
      altKey: false,
      ctrlKey: false,
      metaKey: false,
      nativeEvent: {},
      currentTarget: textarea,
      preventDefault() { prevented = true; },
      ...extra,
    });
    return prevented;
  };

  terminalReconnectRegistry.setEnterReconnectEnabled(sessionId, true);
  assert.equal(key('Enter'), true);
  assert.deepEqual(reconnects, [sessionId]);
  assert.deepEqual(sent, []);
  assert.equal(textarea.value, '');

  textarea.value = 'echo hi';
  assert.equal(key('Enter'), true);
  assert.deepEqual(reconnects, [sessionId]);
  assert.deepEqual(sent, ['echo hi']);
  assert.equal(textarea.value, '');

  textarea.value = 'keep me';
  assert.equal(key('Enter', { shiftKey: true }), false);
  assert.equal(textarea.value, 'keep me');
  assert.deepEqual(sent, ['echo hi']);
  assert.deepEqual(reconnects, [sessionId]);

  textarea.value = '';
  assert.equal(key('Enter', { ctrlKey: true }), true);
  assert.deepEqual(sent, ['echo hi']);
  assert.deepEqual(reconnects, [sessionId]);

  assert.equal(key('Enter', { nativeEvent: { isComposing: true, keyCode: 229 } }), false);
  assert.deepEqual(reconnects, [sessionId]);

  terminalReconnectRegistry.setEnterReconnectEnabled(sessionId, false);
  assert.equal(key('Enter'), true);
  assert.deepEqual(reconnects, [sessionId]);
  assert.deepEqual(sent, ['echo hi']);

  await act(async () => { root.unmount(); });
});

test('compose send target toggle shows all vs active without looking like broadcast when active', async (t) => {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost' });
  const originals = new Map<string, PropertyDescriptor | undefined>();
  for (const name of ['window', 'document', 'localStorage']) {
    originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, value: dom.window[name as keyof Window] });
  }
  t.after(() => {
    dom.window.close();
    for (const [name, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
  });
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const toggles: string[] = [];
  const render = (composeSendToAll: boolean) => (
    <I18nProvider locale="en">
      <TooltipProvider>
        <TerminalComposeBar
          sessionId="compose-target"
          onSend={() => true}
          onClose={() => {}}
          isBroadcastEnabled
          composeSendToAll={composeSendToAll}
          onToggleComposeSendTarget={() => { toggles.push('toggle'); }}
        />
      </TooltipProvider>
    </I18nProvider>
  );
  let root!: ReactTestRenderer;
  await act(async () => {
    root = create(render(true), { createNodeMock: (el) => (el.type === 'textarea' ? { focus() {} } : null) });
  });
  const button = root.root.findAll(
    (node) => node.props?.['data-compose-send-target'] === 'all' || node.props?.['data-compose-send-target'] === 'active',
  )[0];
  assert.ok(button);
  assert.equal(button.props['data-compose-send-target'], 'all');
  assert.equal(button.props['aria-pressed'], true);
  assert.match(String(button.props['aria-label']), /all sessions/i);
  const pulsing = root.root.findAll((node) => typeof node.props?.className === 'string' && node.props.className.includes('animate-pulse'));
  assert.ok(pulsing.length > 0);
  await act(async () => {
    button.props.onClick({
      preventDefault() {},
      stopPropagation() {},
      defaultPrevented: false,
      nativeEvent: { defaultPrevented: false },
    });
  });
  assert.deepEqual(toggles, ['toggle']);
  await act(async () => { root.update(render(false)); });
  const active = root.root.findAll((node) => node.props?.['data-compose-send-target'] === 'active')[0];
  assert.ok(active);
  assert.equal(active.props['aria-pressed'], false);
  assert.match(String(active.props['aria-label']), /active session/i);
  const stillPulsing = root.root.findAll((node) => typeof node.props?.className === 'string' && node.props.className.includes('animate-pulse'));
  assert.equal(stillPulsing.length, 0);
  await act(async () => { root.unmount(); });
});


test('compose right-click never pastes into the terminal behind it', async (t) => {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: 'http://localhost' });
  const globals = ['window', 'document', 'localStorage', 'Element', 'HTMLElement', 'Node'] as const;
  const originals = globals.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const);
  for (const name of globals) {
    Object.defineProperty(globalThis, name, { configurable: true, value: dom.window[name] });
  }
  const rootElement = dom.window.document.querySelector('#root')!;
  const root = createRoot(rootElement);
  t.after(async () => {
    await act(async () => root.unmount());
    dom.window.close();
    for (const [name, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
  });
  let pasteCount = 0;
  const render = (broadcast: boolean) => (
    <I18nProvider locale="en"><TooltipProvider>
      <TerminalContextMenu sessionId="right-click-test" status="connected" rightClickBehavior="paste" onPaste={() => { pasteCount++; }}>
        <div>
          <div data-terminal-cell />
          <TerminalComposeBar sessionId="right-click-test" isBroadcastEnabled={broadcast} onSend={() => true} onClose={() => {}} />
        </div>
      </TerminalContextMenu>
    </TooltipProvider></I18nProvider>
  );
  const rightClick = async (target: string) => {
    const element = rootElement.querySelector(target);
    assert.ok(element, target);
    await act(async () => {
      element.dispatchEvent(new dom.window.MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2 }));
    });
  };

  await act(async () => root.render(render(false)));
  const textareaEvent = new dom.window.MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2 });
  await act(async () => {
    rootElement.querySelector('textarea')!.dispatchEvent(textareaEvent);
  });
  assert.equal(pasteCount, 0, 'the solo composer must not paste into the PTY');
  assert.equal(textareaEvent.defaultPrevented, false, 'textarea keeps native edit context menu');
  await rightClick('[data-terminal-cell]');
  assert.equal(pasteCount, 1, 'ordinary terminal right-click paste still works');

  await act(async () => root.render(render(true)));
  await rightClick('textarea');
  assert.equal(pasteCount, 1, 'broadcast compose opens only its own menu');
  assert.ok(rootElement.querySelector('[data-compose-broadcast-menu]'));
  await rightClick('[data-compose-broadcast-menu]');
  assert.equal(pasteCount, 1, 'right-click on the compose menu must not paste into the PTY');
});

test('right-clicking a compose snippet chip does not trigger terminal paste even with long-press menu enabled', async (t) => {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: 'http://localhost' });
  const globals = ['window', 'document', 'localStorage', 'Element', 'HTMLElement', 'Node', 'CustomEvent'] as const;
  const originals = globals.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const);
  for (const name of globals) {
    Object.defineProperty(globalThis, name, { configurable: true, value: dom.window[name] });
  }
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  dom.window.localStorage.setItem(
    STORAGE_KEY_COMPOSE_BAR_PINNED_SNIPPETS,
    JSON.stringify(['snip-1', 'snip-2']),
  );
  const rootElement = dom.window.document.querySelector('#root')!;
  const root = createRoot(rootElement);
  t.after(async () => {
    await act(async () => root.unmount());
    dom.window.close();
    for (const [name, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
  });

  let pasteCount = 0;
  const snippets = [
    { id: 'snip-1', label: 'First', command: 'echo 1' },
    { id: 'snip-2', label: 'Second', command: 'echo 2' },
  ];

  await act(async () => {
    root.render(
      <I18nProvider locale="en">
        <TooltipProvider>
          <TerminalContextMenu
            sessionId="chip-right-click-test"
            status="connected"
            rightClickBehavior="paste"
            rightClickLongPressMenu
            onPaste={() => { pasteCount++; }}
          >
            <div>
              <div data-terminal-cell />
              <TerminalComposeBar
                sessionId="chip-right-click-test"
                snippets={snippets}
                onSend={() => true}
                onClose={() => {}}
              />
            </div>
          </TerminalContextMenu>
        </TooltipProvider>
      </I18nProvider>,
    );
  });

  const chipButton = rootElement.querySelector('[data-compose-snippet-id="snip-1"] button');
  assert.ok(chipButton);
  const chipContextMenu = new dom.window.MouseEvent('contextmenu', {
    bubbles: true,
    cancelable: true,
    button: 2,
  });
  await act(async () => {
    chipButton.dispatchEvent(new dom.window.MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 2, buttons: 2 }));
    chipButton.dispatchEvent(chipContextMenu);
    chipButton.dispatchEvent(new dom.window.MouseEvent('mouseup', { bubbles: true, cancelable: true, button: 2, buttons: 0 }));
  });
  assert.equal(pasteCount, 0);
  assert.equal(chipContextMenu.defaultPrevented, true, 'non-editable chip suppresses stray browser menu');
});

test('dragging pinned snippet chips reorders them, persists order, and stays isolated from terminal file drops', async (t) => {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: 'http://localhost' });
  const globals = ['window', 'document', 'localStorage', 'Element', 'HTMLElement', 'Node', 'CustomEvent'] as const;
  const originals = globals.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const);
  for (const name of globals) {
    Object.defineProperty(globalThis, name, { configurable: true, value: dom.window[name] });
  }
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  dom.window.localStorage.setItem(
    STORAGE_KEY_COMPOSE_BAR_PINNED_SNIPPETS,
    JSON.stringify(['s1', 's2', 's3']),
  );
  const rootElement = dom.window.document.querySelector('#root')!;
  const root = createRoot(rootElement);
  t.after(async () => {
    await act(async () => root.unmount());
    dom.window.close();
    for (const [name, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
  });

  const snippets = [
    { id: 's1', label: 'Alpha', command: 'echo alpha' },
    { id: 's2', label: 'Beta', command: 'echo beta' },
    { id: 's3', label: 'Gamma', command: 'echo gamma' },
  ];
  let parentDragEvents = 0;

  await act(async () => {
    root.render(
      <I18nProvider locale="en">
        <TooltipProvider>
          <div
            onDragEnter={() => { parentDragEvents++; }}
            onDragOver={() => { parentDragEvents++; }}
            onDragLeave={() => { parentDragEvents++; }}
            onDrop={() => { parentDragEvents++; }}
          >
            <TerminalComposeBar
              sessionId="reorder-test"
              snippets={snippets}
              onSend={() => true}
              onClose={() => {}}
            />
          </div>
        </TooltipProvider>
      </I18nProvider>,
    );
  });

  const getChipIds = () => (
    Array.from(rootElement.querySelectorAll('[data-compose-snippet-id]'))
      .map((el) => (el as HTMLElement).dataset.composeSnippetId)
  );
  assert.deepEqual(getChipIds(), ['s1', 's2', 's3']);

  const createDataTransfer = () => {
    const store = new Map<string, string>();
    return {
      effectAllowed: 'none',
      dropEffect: 'none',
      get types() { return Array.from(store.keys()); },
      setData(type: string, value: string) { store.set(type, value); },
      getData(type: string) { return store.get(type) ?? ''; },
    };
  };

  const dispatchDrag = async (
    target: Element,
    type: 'dragstart' | 'dragover' | 'drop' | 'dragend',
    dataTransfer: ReturnType<typeof createDataTransfer>,
    clientX = 0,
  ) => {
    const event = new dom.window.Event(type, { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'dataTransfer', { value: dataTransfer });
    Object.defineProperty(event, 'clientX', { value: clientX });
    await act(async () => {
      target.dispatchEvent(event);
    });
    return event;
  };

  const setChipRect = (id: string, left: number, width: number) => {
    const el = rootElement.querySelector<HTMLElement>(`[data-compose-snippet-id="${id}"]`)!;
    el.getBoundingClientRect = () => ({
      left,
      right: left + width,
      top: 0,
      bottom: 24,
      width,
      height: 24,
      x: left,
      y: 0,
      toJSON() { return {}; },
    });
    return el;
  };

  // Dragging from the unpin button must not start a reorder drag.
  const unpinButton = rootElement.querySelector('[data-compose-snippet-id="s3"] [data-compose-snippet-unpin]')!;
  const blockedTransfer = createDataTransfer();
  const blockedStart = await dispatchDrag(unpinButton, 'dragstart', blockedTransfer);
  assert.equal(blockedStart.defaultPrevented, true);
  assert.equal(blockedTransfer.getData(COMPOSE_SNIPPET_DRAG_MIME), '');

  // Drag s3 onto the left half of s1 -> moves s3 to the front.
  const chip1 = setChipRect('s1', 0, 80);
  setChipRect('s2', 84, 80);
  const chip3 = setChipRect('s3', 168, 80);
  const transferToFront = createDataTransfer();
  await dispatchDrag(chip3, 'dragstart', transferToFront);
  assert.equal(transferToFront.getData(COMPOSE_SNIPPET_DRAG_MIME), 's3');
  assert.equal(transferToFront.getData('text/plain'), '', 'must not expose plain text that could drop into textarea');

  await dispatchDrag(chip1, 'dragover', transferToFront, 10);
  assert.equal(
    rootElement.querySelector('[data-compose-snippet-id="s1"] [data-compose-snippet-drop-indicator]')?.getAttribute('data-compose-snippet-drop-indicator'),
    'before',
  );
  await dispatchDrag(chip1, 'drop', transferToFront, 10);
  await dispatchDrag(chip3, 'dragend', transferToFront);

  assert.deepEqual(getChipIds(), ['s3', 's1', 's2']);
  assert.deepEqual(
    JSON.parse(dom.window.localStorage.getItem(STORAGE_KEY_COMPOSE_BAR_PINNED_SNIPPETS) ?? '[]'),
    ['s3', 's1', 's2'],
  );
  assert.equal(parentDragEvents, 0, 'snippet drag events must not bubble to parent terminal drop handlers');

  // Drag s3 onto the trailing empty area of the strip -> moves s3 to the end.
  const updatedChip3 = setChipRect('s3', 0, 80);
  setChipRect('s1', 84, 80);
  setChipRect('s2', 168, 80);
  const strip = rootElement.querySelector<HTMLElement>('[data-compose-snippet-strip]')!;
  const transferToEnd = createDataTransfer();
  await dispatchDrag(updatedChip3, 'dragstart', transferToEnd);
  await dispatchDrag(strip, 'dragover', transferToEnd, 320);
  assert.equal(
    rootElement.querySelector('[data-compose-snippet-id="s2"] [data-compose-snippet-drop-indicator]')?.getAttribute('data-compose-snippet-drop-indicator'),
    'after',
  );
  await dispatchDrag(strip, 'drop', transferToEnd, 320);
  await dispatchDrag(updatedChip3, 'dragend', transferToEnd);

  assert.deepEqual(getChipIds(), ['s1', 's2', 's3']);
  assert.deepEqual(
    JSON.parse(dom.window.localStorage.getItem(STORAGE_KEY_COMPOSE_BAR_PINNED_SNIPPETS) ?? '[]'),
    ['s1', 's2', 's3'],
  );
  assert.equal(parentDragEvents, 0);
});
