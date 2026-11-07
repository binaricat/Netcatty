import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';

test('local logging controls default off, disclose verbose risk, and call host-only management actions', async () => {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { pretendToBeVisual: true, url: 'http://localhost' });
  const previous = new Map<string, PropertyDescriptor | undefined>();
  const install = (key: string, value: unknown) => {
    previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  };
  for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'HTMLInputElement', 'Element', 'Node', 'Event', 'MouseEvent', 'KeyboardEvent', 'MutationObserver', 'NodeFilter', 'DocumentFragment', 'CustomEvent', 'getComputedStyle']) {
    install(key, key === 'window' ? dom.window : dom.window[key as keyof typeof dom.window]);
  }
  install('IS_REACT_ACT_ENVIRONMENT', true);
  const { default: React, act } = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { I18nProvider } = await import('../../../application/i18n/I18nProvider');
  const { PluginLogSettings } = await import('./PluginLogSettings');
  const root = createRoot(document.getElementById('root')!);
  let status = { saveToDisk: false, verbose: false, droppedRecords: 2, writeErrors: 0, pendingBytes: 0, maxBytes: 3145728, retentionDays: 7 };
  const settings: Array<{ saveToDisk: boolean; verbose: boolean }> = [];
  const actions: string[] = [];
  let failConfigure = false;
  Object.assign(dom.window, { netcatty: {
    async getPluginLogStatus() { return status; },
    async configurePluginLogs(value: { saveToDisk: boolean; verbose: boolean }) { settings.push(value); status = { ...status, ...value }; if (failConfigure) throw new Error('synthetic preferences write failed'); return status; },
    async openPluginLogFolder() { actions.push('open'); return status; },
    async exportPluginLogs() { actions.push('export'); return status; },
    async clearPluginLogs() { actions.push('clear-confirmed-by-native-host'); return status; },
  } });
  const button = (label: string) => [...document.querySelectorAll<HTMLButtonElement>('button')].find((item) => item.textContent === label)!;
  const switches = () => [...document.querySelectorAll<HTMLButtonElement>('[role="switch"]')];
  try {
    await act(async () => root.render(<React.StrictMode><I18nProvider locale="en"><PluginLogSettings /></I18nProvider></React.StrictMode>));
    assert.equal(document.querySelector('[role=dialog]'), null);
    assert.equal(document.querySelector('input[type=checkbox]'), null);
    const configure = button('Configure');
    configure.focus();
    await act(async () => configure.click());
    assert.equal(document.querySelectorAll('[role=dialog]').length, 1);
    assert.equal(switches()[0].getAttribute('aria-checked'), 'false');
    assert.equal(switches()[0].disabled, false, 'StrictMode initialization completes');
    assert.equal(switches()[1].disabled, true);
    assert.match(document.body.textContent!, /no upload or sync/);
    assert.match(document.body.textContent!, /Dropped: 2/);
    await act(async () => switches()[0].click());
    assert.deepEqual(settings, [{ saveToDisk: true, verbose: false }]);
    await act(async () => switches()[1].click());
    assert.equal(settings.length, 1, 'opening disclosure does not enable verbose logs');
    assert.match(document.body.textContent!, /cannot make arbitrary text safe/);
    await act(async () => button('Cancel').click());
    assert.equal(settings.length, 1, 'cancelling risk consent leaves verbose off');
    await act(async () => switches()[1].click());
    await act(async () => button('Enable temporarily').click());
    assert.deepEqual(settings[1], { saveToDisk: true, verbose: true });
    await act(async () => button('Open folder').click());
    await act(async () => button('Export').click());
    await act(async () => button('Clear logs…').click());
    assert.deepEqual(actions, ['open', 'export', 'clear-confirmed-by-native-host']);
    failConfigure = true;
    await act(async () => switches()[0].click());
    assert.deepEqual(settings.at(-1), { saveToDisk: false, verbose: false });
    assert.equal(switches()[0].getAttribute('aria-checked'), 'false', 'failed configuration refreshes actual OFF host state');
    assert.equal(switches()[1].getAttribute('aria-checked'), 'false');
    assert.match(document.querySelector('[role=alert]')!.textContent!, /synthetic preferences write failed/);
    await act(async () => button('Close').click());
    assert.equal(document.querySelector('[role=dialog]'), null);
    assert.equal(document.activeElement, configure);
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
