import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';

test('source management requires consent and Escape restores either opener inside the plugin window', async () => {
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
  // Install a synthetic preload surface on the isolated DOM window.
  Object.defineProperty(dom.window, 'netcatty', { value: { listPluginSources: async () => [] }, configurable: true });
  const { default: React, act } = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { PluginThirdPartyMarket } = await import('./PluginThirdPartyMarket');
  const { PluginManagementDialog } = await import('./PluginManagementDialog');
  const { I18nProvider } = await import('../../../application/i18n/I18nProvider');
  const root = createRoot(document.getElementById('root')!);
  const settle = () => new Promise((resolve) => setTimeout(resolve, 60));
  try {
    await act(async () => root.render(<I18nProvider locale="en"><PluginManagementDialog><PluginThirdPartyMarket installed={[]} /></PluginManagementDialog></I18nProvider>));
    await act(async () => { document.querySelector<HTMLButtonElement>('button')!.click(); await settle(); });
    for (const label of ['Manage sources', 'Add source']) {
      const opener = [...document.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent === label)!;
      assert.ok(opener);
      await act(async () => { opener.focus(); opener.click(); await settle(); });
      assert.equal(document.querySelectorAll('[role="dialog"]').length, 2);
      const dialogs = document.querySelectorAll<HTMLElement>('[role="dialog"]');
      const dialog = dialogs[dialogs.length - 1];
      assert.match(dialog.textContent ?? '', /real domain/);
      assert.equal(dialog.querySelector<HTMLInputElement>('input[type="checkbox"]')?.checked, false);
      assert.equal(dialog.querySelector<HTMLButtonElement>('button[type="submit"]')?.disabled, true);
      await act(async () => { dialog.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })); await settle(); });
      assert.equal(document.querySelectorAll('[role="dialog"]').length, 1);
      assert.equal(document.activeElement, opener);
    }
  } finally {
    // Radix schedules unmount autofocus on a timer. Drain it while the DOM's
    // Event constructor is still installed (Node 22 has a distinct global Event).
    await act(async () => { root.unmount(); await settle(); });
    dom.window.close();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
