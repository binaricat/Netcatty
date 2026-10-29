import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';

test('uninstall requires a visible confirmation, reports failures, and removes the installed card after success', async () => {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { pretendToBeVisual: true, url: 'http://localhost' });
  const previous = new Map<string, PropertyDescriptor | undefined>();
  const install = (key: string, value: unknown) => {
    previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  };
  for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'HTMLInputElement', 'Element', 'Node', 'NodeFilter', 'Event', 'MouseEvent', 'KeyboardEvent', 'MutationObserver', 'DocumentFragment', 'CustomEvent']) {
    install(key, key === 'window' ? dom.window : dom.window[key as keyof typeof dom.window]);
  }
  install('getComputedStyle', dom.window.getComputedStyle.bind(dom.window));
  install('requestAnimationFrame', dom.window.requestAnimationFrame.bind(dom.window));
  install('cancelAnimationFrame', dom.window.cancelAnimationFrame.bind(dom.window));
  install('IS_REACT_ACT_ENVIRONMENT', true);
  const { default: React, act } = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { I18nProvider } = await import('../../../application/i18n/I18nProvider');
  const { usePluginManager } = await import('../../../application/state/usePluginManager');
  const { PluginManagementDialog } = await import('./PluginManagementDialog');
  const { PluginPackageManager } = await import('./PluginPackageManager');
  const plugin = {
    id: 'com.example.disposable', enabled: false, activeVersion: '1.0.0',
    manifest: { manifestVersion: 1, id: 'com.example.disposable', name: 'Disposable', version: '1.0.0', publisher: 'Example', engines: { netcatty: '*', api: '*' }, main: { browser: 'index.js' } },
    runtime: { status: 'stopped', kind: null, lastError: null, quarantinedAt: null },
  } as NetcattyInstalledPlugin;
  let installed = [plugin];
  const removed: string[] = [];
  let finish!: () => void;
  let fail!: (error: Error) => void;
  Object.assign(dom.window, { netcatty: {
    async getPluginRuntimeStatus() { return { available: true }; },
    async listPlugins() { return installed; },
    async getPluginPermissions() { return { policies: [], grants: [], audit: [] }; },
    async uninstallPlugin(id: string) {
      removed.push(id);
      await new Promise<void>((resolve, reject) => { finish = resolve; fail = reject; });
      installed = installed.filter((entry) => entry.id !== id);
    },
  } });
  function Fixture() {
    const manager = usePluginManager();
    return <PluginManagementDialog open trigger={null}><PluginPackageManager manager={manager} initialSelectedId={plugin.id} /></PluginManagementDialog>;
  }
  const root = createRoot(document.getElementById('root')!);
  const settle = () => new Promise((resolve) => setTimeout(resolve, 30));
  const confirmation = () => document.querySelector<HTMLElement>('[data-plugin-uninstall-confirm]');
  const button = (label: string, within: ParentNode = document) => [...within.querySelectorAll<HTMLButtonElement>('button')].find((item) => item.textContent === label)!;
  try {
    await act(async () => { root.render(<I18nProvider locale="en"><Fixture /></I18nProvider>); await settle(); });
    const trigger = button('Uninstall');
    await act(async () => { trigger.click(); await settle(); });
    assert.ok(confirmation(), 'confirmation is a separate dialog, not below the scroll fold');
    assert.equal(document.querySelectorAll('[role="dialog"]').length, 2);
    assert.deepEqual(removed, [], 'opening the confirmation never deletes the plugin');
    const checkbox = confirmation()!.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
    assert.equal(checkbox.checked, false);
    await act(async () => { checkbox.click(); button('Cancel', confirmation()!).click(); await settle(); });
    assert.equal(confirmation(), null);
    assert.deepEqual(removed, []);
    assert.equal(document.activeElement, trigger);
    await act(async () => { trigger.click(); await settle(); });
    assert.equal(confirmation()!.querySelector<HTMLInputElement>('input')!.checked, false, 'private data clearing is reset for a new confirmation');
    await act(async () => { button('Uninstall', confirmation()!).click(); await settle(); });
    assert.deepEqual(removed, [plugin.id]);
    assert.equal(button('Uninstall', confirmation()!).disabled, true);
    await act(async () => { fail(new Error('Synthetic removal failed')); await settle(); });
    assert.match(confirmation()!.querySelector('[role="alert"]')!.textContent!, /Synthetic removal failed/);
    assert.equal(installed.length, 1);
    await act(async () => { button('Uninstall', confirmation()!).click(); await settle(); });
    await act(async () => { finish(); await settle(); });
    assert.equal(confirmation(), null);
    assert.equal(installed.length, 0);
    assert.equal(document.querySelector('article'), null, 'the removed plugin no longer has an installed card or detail');
    assert.equal(document.querySelectorAll('[role="dialog"]').length, 1, 'the plugin manager remains open');
  } finally {
    await act(async () => { root.unmount(); await settle(); });
    dom.window.close();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key);
    }
  }
});
