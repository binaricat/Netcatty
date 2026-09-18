import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';

test('multiline paste dialog returns decisions and restores terminal focus after closing', async () => {
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
  const { MultilinePasteConfirmHost } = await import('./MultilinePasteConfirmDialog.tsx');
  const { requestMultilinePasteConfirm } = await import('../../application/state/multilinePasteConfirmStore.ts');
  const terminalInput = window.document.createElement('textarea');
  window.document.body.appendChild(terminalInput);
  const root = createRoot(window.document.getElementById('root')!);
  try {
    await act(async () => root.render(<I18nProvider locale="en"><MultilinePasteConfirmHost /></I18nProvider>));
    for (const [label, action] of [['Send', 'send'], ['Send line by line', 'line-by-line'], ['Cancel', 'cancel']]) {
      terminalInput.focus();
      let decision!: ReturnType<typeof requestMultilinePasteConfirm>;
      await act(async () => {
        decision = requestMultilinePasteConfirm({
          text: 'show run\nshow version', lineCount: 2, charCount: 21,
          onClose: () => terminalInput.focus(),
        });
      });
      assert.ok(window.document.querySelector('[role="dialog"]'));
      const button = Array.from(window.document.querySelectorAll('button')).find(item => item.textContent === label);
      assert.ok(button);
      await act(async () => button.click());
      await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)); });
      assert.deepEqual(await decision, { action, text: 'show run\nshow version' });
      assert.equal(window.document.querySelector('[role="dialog"]'), null);
      assert.equal(window.document.activeElement, terminalInput, `${label} should restore focus`);
    }
  } finally {
    await act(async () => root.unmount());
    window.close();
    for (const [key, descriptor] of previousGlobals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
