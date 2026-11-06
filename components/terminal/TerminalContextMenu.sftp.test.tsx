import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import { loadLocaleMessages } from '../../application/i18n/messages.ts';

test('SFTP menu opens the clicked pane without a selection and is absent without a handler', async () => {
  await loadLocaleMessages('zh-CN');
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
  const actions: string[] = [];

  const openMenu = async (hostId: string) => {
    const surface = window.document.querySelector<HTMLElement>(`[data-testid="${hostId}"]`);
    assert.ok(surface);
    await act(async () => {
      surface.dispatchEvent(new window.MouseEvent('contextmenu', {
        bubbles: true,
        button: 2,
        clientX: 20,
        clientY: 20,
      }));
    });
  };

  const findMenuItem = (label: string): HTMLElement => {
    const item = Array.from(window.document.querySelectorAll<HTMLElement>('[role="menuitem"]'))
      .find((candidate) => candidate.textContent?.includes(label));
    assert.ok(item, `${label} menu item should be visible`);
    return item;
  };

  const renderPanes = async (enabled = true) => {
    await act(async () => {
      root.render(
        <I18nProvider locale="zh-CN">
          {['host-a', 'host-b'].map((hostId) => (
            <TerminalContextMenu
              key={hostId}
              sessionId={hostId}
              hostId={hostId}
              status="connected"
              hasSelection={false}
              onOpenSftp={enabled ? () => actions.push(hostId) : undefined}
            >
              <div data-testid={hostId}>Terminal</div>
            </TerminalContextMenu>
          ))}
        </I18nProvider>,
      );
    });
  };

  try {
    await renderPanes();
    for (const hostId of ['host-b', 'host-a', 'host-b']) {
      await openMenu(hostId);
      const item = findMenuItem('打开 SFTP');
      assert.notEqual(item.getAttribute('aria-disabled'), 'true');
      assert.equal(findMenuItem('复制').getAttribute('aria-disabled'), 'true');
      await act(async () => item.click());
      assert.equal(window.document.querySelector('[role="menu"]'), null);
    }
    assert.deepEqual(actions, ['host-b', 'host-a', 'host-b']);

    await renderPanes(false);
    await openMenu('host-a');
    assert.equal(window.document.body.textContent?.includes('打开 SFTP'), false);
  } finally {
    await act(async () => root.unmount());
    await new Promise((resolve) => setTimeout(resolve, 0));
    dom.window.close();
    for (const [key, descriptor] of previousGlobals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete (globalThis as Record<string, unknown>)[key];
    }
  }
});
