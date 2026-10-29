import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { JSDOM } from 'jsdom';
const require = createRequire(import.meta.url);

test('real Settings logging and Ask dialogs open, nest and dismiss correctly', async () => {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { pretendToBeVisual: true, url: 'http://localhost' });
  const previous = new Map<string, PropertyDescriptor | undefined>();
  const install = (key: string, value: unknown) => {
    previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  };
  for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'HTMLInputElement', 'Element', 'Node', 'NodeFilter', 'Event', 'MouseEvent', 'KeyboardEvent', 'MutationObserver', 'DocumentFragment', 'CustomEvent']) install(key, key === 'window' ? dom.window : dom.window[key as keyof typeof dom.window]);
  install('getComputedStyle', dom.window.getComputedStyle.bind(dom.window));
  install('requestAnimationFrame', dom.window.requestAnimationFrame.bind(dom.window));
  install('cancelAnimationFrame', dom.window.cancelAnimationFrame.bind(dom.window));
  install('IS_REACT_ACT_ENVIRONMENT', true);
  const { default: React, act } = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { I18nProvider } = await import('../../../application/i18n/I18nProvider');
  const { PluginSettingsLanding } = await import('./PluginSettingsLanding');
  const { PluginPermissionHost } = await import('../../plugins/PluginPermissionHost');
  const { PluginPermissionDecisionHost } = require('../../../electron/plugins/permissionDecisionHost.cjs');
  type Prompt = NetcattyPluginPermissionPrompt | { requestId: string; closed: true };
  const listeners = new Set<(event: Prompt) => void>();
  const sender = Object.assign(new EventEmitter(), { isDestroyed: () => false, send: (_channel: string, event: Prompt) => { for (const listener of listeners) listener(event); } });
  const owner = Object.assign(new EventEmitter(), { webContents: sender, isFocused: () => true, isVisible: () => true, isDestroyed: () => false });
  const host = new PluginPermissionDecisionHost({ getWindows: () => [owner], isLocked: () => false });
  let logStatus = { saveToDisk: false, verbose: false, droppedRecords: 0, writeErrors: 0, pendingBytes: 0, maxBytes: 3145728, retentionDays: 7 };
  Object.assign(dom.window, { netcatty: {
    async getPluginLogStatus() { return logStatus; },
    async configurePluginLogs(value: { saveToDisk: boolean; verbose: boolean }) { logStatus = { ...logStatus, ...value }; return logStatus; },
    onPluginPermission(listener: (event: Prompt) => void) { listeners.add(listener); return () => listeners.delete(listener); },
    setPluginPermissionReady: async (ready: boolean) => host.setReady(sender, ready),
    respondPluginPermission: async (response: unknown) => host.respond(sender, response),
  } });
  const manager = { plugins: [], available: true, statusKnown: true, busy: false, error: null, credentialStorageAvailable: true,
    async refresh() {}, async setEnabled() {}, async importPackage() {}, async uninstall() {} };
  const root = createRoot(document.getElementById('root')!);
  const button = (label: string) => [...document.querySelectorAll<HTMLButtonElement>('button')].find((element) => element.textContent === label)!;
  const flushVisibility = () => new Promise<void>((resolve) => dom.window.queueMicrotask(resolve));
  try {
    await act(async () => root.render(<I18nProvider locale="en"><PluginSettingsLanding manager={manager} settingsAvailable={new Set()} onManage={() => {}} /><PluginPermissionHost /></I18nProvider>));
    await flushVisibility();
    assert.equal(document.querySelector('[role="dialog"]'), null);
    assert.ok(button('Configure'), 'real idle logging row is present');
    await act(async () => button('Configure').click());
    await flushVisibility();
    assert.ok(document.querySelector('[role="dialog"][data-host-security-surface]'));
    await act(async () => document.querySelectorAll<HTMLButtonElement>('[role="switch"]')[0].click());
    await act(async () => document.querySelectorAll<HTMLButtonElement>('[role="switch"]')[1].click());
    await flushVisibility();
    assert.equal(document.querySelectorAll('[role="dialog"]').length, 2);
    await act(async () => button('Cancel').click());
    await flushVisibility();
    assert.equal(document.querySelectorAll('[role="dialog"]').length, 1);
    await act(async () => button('Close').click());
    await flushVisibility();
    assert.equal(document.querySelector('[role="dialog"]'), null);
    let pending!: Promise<{ decision: string }>;
    await act(async () => {
      pending = host.request({ requestId: 'settings-visibility-ask', pluginId: 'com.example.settings-visibility', pluginName: 'Settings visibility fixture', pluginVersion: '1.0.0',
        permission: 'settings.read', resources: ['*'], reason: 'Read own synthetic setting' });
    });
    await flushVisibility();
    assert.ok(document.querySelector('[role="dialog"][data-host-security-surface]'));
    await act(async () => { button('Deny').click(); await pending; });
    await flushVisibility();
    assert.equal((await pending).decision, 'deny');
    assert.equal(document.querySelector('[role="dialog"]'), null);
  } finally {
    await act(async () => root.unmount()); host.shutdown(); dom.window.close();
    for (const [key, descriptor] of previous) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); }
  }
});
