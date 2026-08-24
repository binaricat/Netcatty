import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';

test('split menu keeps custom shortcuts aligned with the matching split actions', async () => {
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

  const openMenu = async () => {
    const surface = window.document.querySelector<HTMLElement>('[data-testid="terminal-surface"]');
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

  try {
    await act(async () => {
      root.render(
        <I18nProvider locale="zh-CN">
          <TerminalContextMenu
            sessionId="issue-3082"
            status="connected"
            hotkeyScheme="mac"
            keyBindings={[
              {
                id: 'split-horizontal',
                action: 'splitHorizontal',
                label: 'Split Horizontal',
                mac: '⌘ + H',
                pc: 'Ctrl + H',
                category: 'navigation',
              },
              {
                id: 'split-vertical',
                action: 'splitVertical',
                label: 'Split Vertical',
                mac: '⌘ + V',
                pc: 'Ctrl + V',
                category: 'navigation',
              },
            ]}
            onSplitHorizontal={() => actions.push('horizontal')}
            onSplitVertical={() => actions.push('vertical')}
          >
            <div data-testid="terminal-surface">Terminal</div>
          </TerminalContextMenu>
        </I18nProvider>,
      );
    });

    await openMenu();
    const horizontalItem = findMenuItem('水平分屏');
    assert.match(horizontalItem.textContent ?? '', /水平分屏\s*⌘ H/);
    const horizontalDivider = horizontalItem.querySelector('svg line');
    assert.ok(horizontalDivider);
    assert.equal(horizontalDivider.getAttribute('y1'), horizontalDivider.getAttribute('y2'));
    assert.notEqual(horizontalDivider.getAttribute('x1'), horizontalDivider.getAttribute('x2'));
    await act(async () => horizontalItem.click());

    await openMenu();
    const verticalItem = findMenuItem('垂直分屏');
    assert.match(verticalItem.textContent ?? '', /垂直分屏\s*⌘ V/);
    const verticalDivider = verticalItem.querySelector('svg line');
    assert.ok(verticalDivider);
    assert.equal(verticalDivider.getAttribute('x1'), verticalDivider.getAttribute('x2'));
    assert.notEqual(verticalDivider.getAttribute('y1'), verticalDivider.getAttribute('y2'));
    await act(async () => verticalItem.click());

    assert.deepEqual(actions, ['horizontal', 'vertical']);
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
