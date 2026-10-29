import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';

// Exercise the real Radix portal/focus lifecycle, rather than a mocked Dialog.
test('plugin manager is single-instance, closes with Escape, restores focus and remounts on reopen', async () => {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { pretendToBeVisual: true, url: 'http://localhost' });
  const previous = new Map<string, PropertyDescriptor | undefined>();
  const install = (key: string, value: unknown) => {
    previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  };
  for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'HTMLInputElement', 'Element', 'Node', 'NodeFilter', 'MutationObserver', 'CustomEvent', 'Event', 'KeyboardEvent', 'MouseEvent']) {
    install(key, key === 'window' ? dom.window : dom.window[key as keyof typeof dom.window]);
  }
  install('getComputedStyle', dom.window.getComputedStyle.bind(dom.window));
  install('requestAnimationFrame', dom.window.requestAnimationFrame.bind(dom.window));
  install('cancelAnimationFrame', dom.window.cancelAnimationFrame.bind(dom.window));
  install('IS_REACT_ACT_ENVIRONMENT', true);
  const { default: React, act, useEffect, useRef, useState } = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { I18nProvider } = await import('../../../application/i18n/I18nProvider');
  const { PluginManagementDialog } = await import('./PluginManagementDialog');
  const root = createRoot(document.getElementById('root')!);
  let mounts = 0;
  let unmounts = 0;
  function Content() {
    useEffect(() => { mounts++; return () => { unmounts++; }; }, []);
    return <input aria-label="Plugin search" defaultValue="" />;
  }
  const settle = () => new Promise((resolve) => setTimeout(resolve, 20));
  const click = async (element: HTMLElement) => { await act(async () => { element.click(); await settle(); }); };
  try {
    await act(async () => { root.render(<I18nProvider locale="en"><PluginManagementDialog><Content /></PluginManagementDialog></I18nProvider>); });
    const trigger = document.querySelector<HTMLButtonElement>('button')!;
    assert.equal(document.querySelector('[role="dialog"]'), null);
    assert.equal(mounts, 0, 'closed settings entry does not mount manager subscriptions');
    trigger.focus();
    await click(trigger);
    assert.equal(document.querySelectorAll('[role="dialog"]').length, 1);
    // JSDOM cannot emulate Electron's native drag hit testing. Protect the
    // no-drag boundary that keeps the portaled manager above the titlebar clickable.
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!;
    assert.equal(dialog.classList.contains('app-no-drag'), true, 'plugin manager must exclude its content from native window dragging');
    const visibleClose = dialog.querySelector<HTMLButtonElement>('button[data-dialog-close]:not([aria-hidden])')!;
    assert.equal(visibleClose.closest('.app-no-drag'), dialog, 'the visible X must be inside the no-drag boundary');
    assert.equal(mounts, 1);
    assert.equal(document.activeElement?.getAttribute('aria-label'), 'Plugin search');
    assert.equal(document.querySelector('[role="dialog"]')?.contains(document.querySelector('[data-settings-scroll-pane]')), true);
    await act(async () => { root.render(<I18nProvider locale="en"><PluginManagementDialog><Content /></PluginManagementDialog></I18nProvider>); });
    assert.equal(document.querySelectorAll('[role="dialog"]').length, 1);
    assert.equal(mounts, 1, 'rerender does not spawn another manager');
    const closeButton = document.querySelector<HTMLButtonElement>('[role="dialog"] button[data-dialog-close]:not([aria-hidden])')!;
    await act(async () => {
      closeButton.focus();
      closeButton.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }));
    });
    assert.equal(document.activeElement?.getAttribute('aria-label'), 'Plugin search', 'Tab wraps inside the modal');
    await act(async () => { document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); await settle(); });
    assert.equal(document.querySelector('[role="dialog"]'), null);
    assert.equal(document.activeElement, trigger);
    assert.equal(unmounts, 1);
    await click(trigger);
    assert.equal(mounts, 2);
    await click(document.querySelector<HTMLButtonElement>('[role="dialog"] button[data-dialog-close]:not([aria-hidden])')!);
    assert.equal(document.querySelector('[role="dialog"]'), null);
    assert.equal(document.activeElement, trigger);
    assert.equal(unmounts, 2);
    function ControlledEntry() {
      const [open, setOpen] = useState(false);
      const browse = useRef<HTMLButtonElement | null>(null);
      const opener = useRef<HTMLElement | null>(null);
      return <>
        <button ref={browse}>Fallback browse</button>
        <button onClick={(event) => { opener.current = event.currentTarget; setOpen(true); }}>External plugin settings</button>
        <PluginManagementDialog open={open} onOpenChange={setOpen} trigger={null} restoreFocusTo={opener} fallbackFocusTo={browse}><input aria-label="Controlled search" /></PluginManagementDialog>
      </>;
    }
    await act(async () => root.render(<I18nProvider locale="en"><ControlledEntry /></I18nProvider>));
    const external = [...document.querySelectorAll<HTMLButtonElement>('button')].find((item) => item.textContent === 'External plugin settings')!;
    external.focus();
    await click(external);
    assert.equal(document.querySelectorAll('[role=dialog]').length, 1);
    await act(async () => { document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); await settle(); });
    assert.equal(document.activeElement, external, 'controlled entry restores the actual row opener');
    await click(external);
    external.disabled = true;
    await act(async () => { document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); await settle(); });
    assert.equal(document.activeElement?.textContent, 'Fallback browse', 'a disabled or removed opener uses the stable browse action');

  } finally {
    await act(async () => root.unmount());
    // Let Radix finish deferred focus cleanup before restoring the DOM globals.
    await settle();
    dom.window.close();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
