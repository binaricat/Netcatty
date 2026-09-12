import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';

test('long press opens the existing menu without running the short-click action', async () => {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    pretendToBeVisual: true,
    url: 'http://localhost',
  });
  const window = dom.window;
  const previousGlobals = new Map<string, PropertyDescriptor | undefined>();
  const installGlobal = (key: string, value: unknown) => {
    previousGlobals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, {
      configurable: true,
      writable: true,
      value,
    });
  };

  class ResizeObserverStub {
    observe() {}
    unobserve() {}
    disconnect() {}
  }

  installGlobal('window', window);
  installGlobal('document', window.document);
  installGlobal('navigator', window.navigator);
  installGlobal('HTMLElement', window.HTMLElement);
  installGlobal('HTMLInputElement', window.HTMLInputElement);
  installGlobal('HTMLTextAreaElement', window.HTMLTextAreaElement);
  installGlobal('Element', window.Element);
  installGlobal('SVGElement', window.SVGElement);
  installGlobal('Node', window.Node);
  installGlobal('NodeFilter', window.NodeFilter);
  installGlobal('MutationObserver', window.MutationObserver);
  installGlobal('CustomEvent', window.CustomEvent);
  installGlobal('DOMRect', window.DOMRect);
  installGlobal('Event', window.Event);
  installGlobal('KeyboardEvent', window.KeyboardEvent);
  installGlobal('MouseEvent', window.MouseEvent);
  installGlobal('getComputedStyle', window.getComputedStyle.bind(window));
  installGlobal('requestAnimationFrame', window.requestAnimationFrame.bind(window));
  installGlobal('cancelAnimationFrame', window.cancelAnimationFrame.bind(window));
  installGlobal('ResizeObserver', ResizeObserverStub);
  installGlobal('IS_REACT_ACT_ENVIRONMENT', true);

  const { default: React, act } = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { I18nProvider } = await import('../../application/i18n/I18nProvider.tsx');
  const { TerminalContextMenu } = await import('./TerminalContextMenu.tsx');
  const rootNode = window.document.getElementById('root');
  assert.ok(rootNode);
  const root = createRoot(rootNode);
  let pastes = 0;
  let mode = 'none';
  const fire = async (type: string) => {
    await act(async () => {
      window.document.querySelector('[data-testid="surface"]')!.dispatchEvent(new window.MouseEvent(type, {
        bubbles: true, cancelable: true, button: 2, buttons: type === 'mouseup' ? 0 : 2,
        clientX: 30, clientY: 30,
      }));
    });
  };
  try {
    await act(async () => root.render(<I18nProvider locale="en">
      <TerminalContextMenu sessionId="3153" status="connected" rightClickBehavior="paste"
        rightClickLongPressMenu getMouseTrackingMode={() => mode} onPaste={() => pastes++}>
        <div data-testid="surface">Terminal</div>
      </TerminalContextMenu>
    </I18nProvider>));
    await act(async () => {
      const surface = window.document.querySelector('[data-testid="surface"]')!;
      for (const type of ['mousedown', 'contextmenu', 'mouseup']) {
        surface.dispatchEvent(new window.MouseEvent(type, {
          bubbles: true, cancelable: true, button: 2,
        }));
      }
    });
    assert.equal(pastes, 1);
    assert.equal(window.document.querySelector('[role="menu"]'), null);
    await fire('mousedown');
    await fire('contextmenu');
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 550)); });
    assert.ok(window.document.querySelector('[role="menu"]'));
    await fire('mouseup');
    await fire('contextmenu'); // Windows release-time native event must not paste.
    assert.equal(pastes, 1);
    const pasteItem = Array.from(window.document.querySelectorAll<HTMLElement>('[role="menuitem"]'))
      .find(item => item.textContent === 'Paste');
    assert.ok(pasteItem);
    await act(async () => pasteItem.click());
    assert.equal(pastes, 2);
    assert.equal(window.document.querySelector('[role="menu"]'), null);
    mode = 'vt200';
    await fire('mousedown');
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 550)); });
    await fire('mouseup');
    assert.equal(window.document.querySelector('[role="menu"]'), null);
    assert.equal(pastes, 2);
    let reconnects = 0;
    await act(async () => root.render(<I18nProvider locale="en">
      <TerminalContextMenu sessionId="3153" status="disconnected" rightClickBehavior="paste"
        rightClickLongPressMenu isReconnectable onReconnect={() => reconnects++}
        getMouseTrackingMode={() => mode} onPaste={() => pastes++}>
        <div data-testid="surface">Terminal</div>
      </TerminalContextMenu>
    </I18nProvider>));
    await fire('mousedown');
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 550)); });
    await fire('mouseup');
    const reconnectItem = Array.from(window.document.querySelectorAll<HTMLElement>('[role="menuitem"]'))
      .find(item => item.textContent === 'Reconnect');
    assert.ok(reconnectItem);
    assert.equal(pastes, 2);
    await act(async () => reconnectItem.click());
    assert.equal(reconnects, 1);
  } finally {
    await act(async () => root.unmount());
    window.close();
    for (const [key, previous] of previousGlobals) {
      if (previous) Object.defineProperty(globalThis, key, previous);
      else delete (globalThis as Record<string, unknown>)[key];
    }
  }
});
