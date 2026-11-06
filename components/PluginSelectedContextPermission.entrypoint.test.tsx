import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { JSDOM } from 'jsdom';
const require = createRequire(import.meta.url);

test('registered selected-summary Ask is one host chooser; Allow still selects and Deny releases nothing', { timeout: 45_000 }, async () => {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { pretendToBeVisual: true, url: 'http://localhost' });
  const previous = new Map<string, PropertyDescriptor | undefined>();
  const install = (key: string, value: unknown) => {
    previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  };
  for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'HTMLInputElement', 'HTMLSelectElement', 'Element', 'Node', 'NodeFilter', 'MutationObserver', 'CustomEvent', 'Event', 'KeyboardEvent', 'MouseEvent']) install(key, key === 'window' ? dom.window : dom.window[key as keyof typeof dom.window]);
  install('getComputedStyle', dom.window.getComputedStyle.bind(dom.window));
  install('requestAnimationFrame', dom.window.requestAnimationFrame.bind(dom.window));
  install('cancelAnimationFrame', dom.window.cancelAnimationFrame.bind(dom.window));
  install('IS_REACT_ACT_ENVIRONMENT', true);
  const { default: React, act } = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { I18nProvider } = await import('../application/i18n/I18nProvider');
  const { PluginAIContextHost } = await import('./plugins/PluginAIContextHost');
  const { PluginPermissionHost } = await import('./plugins/PluginPermissionHost');
  const { publishNotesSnapshot, getNotesSnapshot } = await import('../application/state/notesStore');
  const { registerAppAppLockRuntime, getAppAppLockRuntime } = await import('../application/state/appRuntimeBridge');
  const { createPluginHostService } = require('../electron/plugins/hostService.cjs');
  const { inProcessBrowserRuntime } = require('../electron/plugins/fixtures/inProcessBrowserRuntime.cjs');
  const { registerPluginBridge } = require('../electron/plugins/pluginBridge.cjs');
  const { createPreloadApi } = require('../electron/preload/api.cjs');
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'netcatty-selected-policy-'));
  const oldNotes = getNotesSnapshot(); const oldLock = getAppAppLockRuntime();
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  const ipcMain = Object.assign(new EventEmitter(), { handle: (channel: string, handler: (...args: unknown[]) => unknown) => handlers.set(channel, handler), removeHandler: (channel: string) => handlers.delete(channel) });
  const ipcRenderer = Object.assign(new EventEmitter(), { invoke: async (channel: string, payload: unknown) => {
    const handler = handlers.get(channel); assert.ok(handler, channel); return handler({ sender }, structuredClone(payload));
  } });
  const prompts: Array<{ channel: string; kind?: string; closed?: boolean }> = [];
  const sender = Object.assign(new EventEmitter(), { id: 42, isDestroyed: () => false, send: (channel: string, payload: { kind?: string; closed?: boolean }) => {
    prompts.push({ channel, kind: payload.kind, closed: payload.closed }); ipcRenderer.emit(channel, {}, structuredClone(payload));
  } });
  const owner = Object.assign(new EventEmitter(), { webContents: sender, isFocused: () => true, isVisible: () => true, isDestroyed: () => false });
  const service = createPluginHostService({ app: { getAppPath: () => process.cwd(), getPath: () => fixtureRoot, getVersion: () => '0.0.0' },
    electron: { ipcMain }, env: {}, getInteractionWindow: () => owner, isAppLocked: () => false });
  service.runtimeSupervisor.runtimeFactories.browser = inProcessBrowserRuntime;
  registerPluginBridge(ipcMain, { ...service, isTrustedSender: (event: { sender: unknown }) => event.sender === sender });
  Object.assign(dom.window, { netcatty: createPreloadApi({ ipcRenderer, webUtils: {} }) });
  const note = { id: 'synthetic-selected-note', title: 'Synthetic selection', content: 'BODY MUST NOT BE SHARED', createdAt: 1, updatedAt: 1 };
  publishNotesSnapshot({ notes: [note], noteGroups: [] }); registerAppAppLockRuntime({ locked: false } as never);
  const root = createRoot(document.getElementById('root')!);
  const settle = () => new Promise((resolve) => setTimeout(resolve, 20));
  const waitForDialog = async () => {
    const deadline = Date.now() + 5_000;
    while (!document.querySelector('[role="dialog"]')) {
      assert.ok(Date.now() < deadline, 'registered route did not present a host interaction');
      await act(async () => { await settle(); });
    }
  };
  const button = (label: string) => Array.from(document.querySelectorAll<HTMLButtonElement>('button')).find((element) => element.textContent === label)!;
  const begin = () => {
    const result = service.contributionService.executeCommand('com.netcatty.assistant.contexts') as Promise<Array<{ handle: string; version: string; title: string }>>;
    void result.catch(() => {});
    return result;
  };
  try {
    await service.manager.initialize();
    const stage = path.join(fixtureRoot, 'package'); fs.mkdirSync(path.join(stage, 'dist'), { recursive: true });
    const sample = path.resolve('examples/plugins/assistant');
    for (const file of ['netcatty.plugin.json', 'README.md']) fs.copyFileSync(path.join(sample, file), path.join(stage, file));
    fs.copyFileSync(path.join(sample, 'dist/host.js'), path.join(stage, 'dist/host.js'));
    const { buildPluginPackage } = await import('@netcatty/plugin-cli');
    const archive = path.join(fixtureRoot, 'assistant.ncpkg'); await buildPluginPackage(stage, archive); await service.manager.install(archive, { enable: true });
    await act(async () => root.render(<I18nProvider locale="en"><PluginPermissionHost /><PluginAIContextHost sessions={[]} workspaces={[]} /></I18nProvider>));
    const plugin = service.database.getActivePlugin('com.netcatty.assistant');
    for (const mode of ['ask', 'allow']) {
      service.permissionEngine.setMode(plugin, 'context.selected.list', mode);
      let result!: ReturnType<typeof begin>;
      await act(async () => { result = begin(); await settle(); });
      await waitForDialog();
      assert.ok(document.getElementById('plugin-ai-note'), 'the first interaction must be the real host chooser');
      assert.equal(document.querySelectorAll('[role="dialog"]').length, 1);
      assert.equal(prompts.filter((prompt) => prompt.channel === 'netcatty:plugins:permission-prompt' && !prompt.closed).length, 0, 'no capability dialog before the chooser');
      await act(async () => {
        const select = document.getElementById('plugin-ai-note') as HTMLSelectElement; select.value = note.id; select.dispatchEvent(new dom.window.Event('change', { bubbles: true })); await settle();
      });
      await act(async () => { button('Share selected summaries').click(); await settle(); });
      const summaries = await result;
      assert.ok(summaries.some((item) => item.title === note.title));
      assert.doesNotMatch(JSON.stringify(summaries), /BODY MUST NOT BE SHARED/);
      assert.equal(document.querySelector('[role="dialog"]'), null);
    }
    service.permissionEngine.setMode(plugin, 'context.selected.list', 'deny');
    const count = prompts.filter((prompt) => prompt.kind === 'context.select').length;
    await assert.rejects(service.contributionService.executeCommand('com.netcatty.assistant.contexts'), /disabled/);
    assert.equal(prompts.filter((prompt) => prompt.kind === 'context.select').length, count); assert.equal(document.querySelector('[role="dialog"]'), null);
    service.permissionEngine.setMode(plugin, 'context.selected.list', 'ask');
    let cancelled!: ReturnType<typeof begin>;
    await act(async () => { cancelled = begin(); await settle(); });
    await waitForDialog();
    await act(async () => { button('Cancel').click(); await settle(); });
    await assert.rejects(cancelled); assert.equal(service.aiContextService.selected.handles.size, 0);
    let revoked!: ReturnType<typeof begin>;
    await act(async () => { revoked = begin(); await settle(); });
    await waitForDialog();
    await act(async () => { service.permissionEngine.setMode(plugin, 'context.selected.list', 'deny'); await settle(); });
    await assert.rejects(revoked); assert.equal(document.querySelector('[role="dialog"]'), null); assert.equal(service.aiContextService.selected.handles.size, 0);
  } finally {
    await act(async () => root.unmount()); await service.manager.shutdown();
    publishNotesSnapshot(oldNotes); registerAppAppLockRuntime(oldLock); dom.window.close(); fs.rmSync(fixtureRoot, { recursive: true, force: true });
    for (const [key, descriptor] of previous) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); }
  }
});
