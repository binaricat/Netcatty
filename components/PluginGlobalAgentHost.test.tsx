import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import { createRequire } from 'node:module';
import { EventEmitter, once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
test('installed global Chat UI reuses actual Catty runtime, configured HTTP transport and selected worker dispatch', { timeout: 30_000 }, async () => {
  // This Node/JSDOM harness proves installed app wiring, not a native sandbox or
  // real model/Claude acceptance. No real shell, remote host or credentials.
  const rootPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'netcatty-global-agent-ui-'));
  const oldTmp = process.env.TMPDIR; process.env.TMPDIR = directory;
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { pretendToBeVisual: true, url: 'http://localhost' });
  const previous = new Map<string, PropertyDescriptor | undefined>();
  const install = (key: string, value: unknown) => { previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key)); Object.defineProperty(globalThis, key, { configurable: true, writable: true, value }); };
  for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'HTMLInputElement', 'HTMLSelectElement', 'Element', 'Node', 'NodeFilter', 'MutationObserver', 'CustomEvent', 'Event', 'KeyboardEvent', 'MouseEvent', 'DocumentFragment']) install(key, key === 'window' ? dom.window : dom.window[key as keyof typeof dom.window]);
  install('localStorage', dom.window.localStorage); install('getComputedStyle', dom.window.getComputedStyle.bind(dom.window));
  install('requestAnimationFrame', dom.window.requestAnimationFrame.bind(dom.window)); install('cancelAnimationFrame', dom.window.cancelAnimationFrame.bind(dom.window)); install('IS_REACT_ACT_ENVIRONMENT', true);
  const { default: React, act } = await import('react'); const { createRoot } = await import('react-dom/client');
  const { PluginAgentHost } = await import('./plugins/PluginAgentHost');
  const { I18nProvider } = await import('../application/i18n/I18nProvider');
  const { registerAppAppLockRuntime, getAppAppLockRuntime } = await import('../application/state/appRuntimeBridge');
  const keys = await import('../infrastructure/config/storageKeys');
  const { createGlobalAgentProviderFixture } = await import('../scripts/plugin-global-agent-provider-fixture.mjs');
  const { createPluginHostService } = require('../electron/plugins/hostService.cjs');
  const { inProcessBrowserRuntime } = require('../electron/plugins/fixtures/inProcessBrowserRuntime.cjs');
  const { createPreloadApi } = require('../electron/preload/api.cjs');
  const { registerProviderHandlers } = require('../electron/bridges/aiBridge/providerHandlers.cjs');
  const { registerCattyExecHandlers } = require('../electron/bridges/aiBridge/cattyExecHandlers.cjs');
  const { registerAgentProcessHandlers } = require('../electron/bridges/aiBridge/agentProcessHandlers.cjs');
  const { registerPrivacyHandlers } = require('../electron/bridges/aiBridge/privacyHandlers.cjs');
  const aiBridge = require('../electron/bridges/aiBridge.cjs'); const mcp = require('../electron/bridges/mcpServerBridge.cjs');
  const privacy = require('../electron/shared/aiPrivacyService.cjs');
  const { server, counts } = createGlobalAgentProviderFixture({ delayMs: 30 });
  const oldLock = getAppAppLockRuntime(); const root = createRoot(document.getElementById('root')!);
  let service: ReturnType<typeof createPluginHostService> | undefined; let panel: JSDOM | undefined;
  const errors: string[] = []; const originalError = console.error;
  let phase = 'setup';
  // Flush the known Node sqlite import warning before observing safe categories.
  await new Promise<void>((resolve) => setImmediate(resolve));
  console.error = (value: unknown) => { errors.push(`${phase}:${typeof value === 'string' && value === '[Plugin Agent] Turn unavailable' ? 'DELEGATED_TURN_UNAVAILABLE' : typeof value === 'string' && /not wrapped in act/.test(value) ? 'REACT_ACT_WARNING' : 'SDK_OR_RENDERER_ERROR'}`); };
  try {
    privacy.configure({ enabled: false }); server.listen(0, '127.0.0.1'); await once(server, 'listening');
    const address = server.address(); assert.ok(address && typeof address !== 'string'); const endpoint = `http://127.0.0.1:${address.port}/v1`;
    const handlers = new Map<string, (...args: unknown[]) => unknown>();
    const ipcMain = { handle: (name: string, handler: (...args: unknown[]) => unknown) => handlers.set(name, handler), removeHandler: (name: string) => handlers.delete(name) };
    const ipcRenderer = new EventEmitter() as EventEmitter & { invoke: (channel: string, payload: unknown) => Promise<unknown> };
    const trustedReplies: unknown[] = []; const pluginReplies: unknown[] = []; const workerCalls: string[] = [];
    const sender = Object.assign(new EventEmitter(), { id: 7, isDestroyed: () => false, send: (channel: string, payload: unknown) => ipcRenderer.emit(channel, {}, structuredClone(payload)) });
    const mainWindow = Object.assign(new EventEmitter(), { webContents: sender, isDestroyed: () => false, isVisible: () => true, isFocused: () => true });
    const owner = (id: string) => id === 'synthetic-a' ? 7 : id === 'synthetic-b' ? 8 : null;
    const worker = { getSessionOwnerWebContentsId: owner, getPluginSessionBinding: (id: string, actual: number) => actual === owner(id) ? { epoch: 'fixture-worker', generation: id === 'synthetic-a' ? 1 : 2 } : null,
      send: () => {}, request: async (method: string, payload: { sessionId: string }, options?: { beforeExecute?: () => void }) => {
        options?.beforeExecute?.(); if (method === 'netcatty:ai:exec') { workerCalls.push(payload.sessionId); return { ok: true, stdout: 'Synthetic worker output', stderr: '', exitCode: 0 }; } return [];
      } };
    mcp.init({ sessions: new Map(), terminalWorkerManager: worker, cliDiscoveryFilePath: path.join(directory, 'discovery.json') }); mcp.setPermissionMode('observer');
    const common = { ipcMain, validateSender: (event: { sender: unknown }) => event.sender === sender,
      validateSenderOrSettings: (event: { sender: unknown }) => event.sender === sender, mcpServerBridge: mcp, aiPrivacyService: privacy };
    const providerContext = { ...common, require: createRequire(path.join(rootPath, 'electron/bridges/aiBridge.cjs')),
      providerConfigs: [] as Array<{ id: string; baseURL?: string; apiKey?: string }>, webSearchApiHost: null,
      injectApiKeyIntoRequest: (url: string, headers: Record<string, string>, providerId: string) => {
        const provider = providerContext.providerConfigs.find((entry) => entry.id === providerId);
        return { url, headers: Object.fromEntries(Object.entries(headers).map(([key, value]) => [key, value.replace('__IPC_SECURED__', provider?.apiKey ?? '')])) };
      }, shouldSkipTLSVerify: () => false, streamRequest: aiBridge._streamRequestForTests,
      // The production stream function owns this map. Turn release below uses
      // its actual main lease; direct SDK abort still calls the ordinary route.
      activeStreams: new Map() };
    registerProviderHandlers(providerContext); registerCattyExecHandlers(common); registerAgentProcessHandlers(common); registerPrivacyHandlers(common);
    ipcRenderer.invoke = async (channel, payload) => {
      if (channel === 'netcatty:ai:chat:stream') {
        const request = payload as { requestId: string; url: string }; assert.equal(new URL(request.url).origin, new URL(endpoint).origin);
        assert.match(request.requestId, /^agent-model_/);
      }
      const handler = handlers.get(channel); assert.ok(handler, `Unexpected trusted IPC: ${channel}`);
      const result = await handler({ sender }, structuredClone(payload));
      if (channel === 'netcatty:plugins:agent-host-response') trustedReplies.push(payload);
      return result;
    };
    const api = createPreloadApi({ ipcRenderer, webUtils: {} }); Object.defineProperty(dom.window, 'netcatty', { value: api });
    registerAppAppLockRuntime({ locked: false } as NonNullable<ReturnType<typeof getAppAppLockRuntime>>);
    dom.window.localStorage.setItem(keys.STORAGE_KEY_AI_PROVIDERS, JSON.stringify([{ id: 'fixture-provider', name: 'Synthetic fixture', providerId: 'custom', enabled: true,
      baseURL: endpoint, defaultModel: 'global-agent-fixture', apiKey: 'FIXTURE_ONLY_API_MARKER' }]));
    dom.window.localStorage.setItem(keys.STORAGE_KEY_AI_ACTIVE_PROVIDER, 'fixture-provider');
    service = createPluginHostService({ app: { getAppPath: () => rootPath, getPath: () => directory, getVersion: () => '0.0.0' }, env: {},
      electron: { ipcMain }, getInteractionWindow: () => mainWindow, isAppLocked: () => false, getTerminalWorkerManager: () => worker });
    service.runtimeSupervisor.runtimeFactories.browser = inProcessBrowserRuntime; await service.manager.initialize();
    const sample = path.join(rootPath, 'examples/plugins/global-agent'); const staging = path.join(directory, 'package'); fs.mkdirSync(path.join(staging, 'dist'), { recursive: true });
    for (const file of ['netcatty.plugin.json', 'README.md']) fs.copyFileSync(path.join(sample, file), path.join(staging, file));
    fs.copyFileSync(path.join(sample, 'dist/host.js'), path.join(staging, 'dist/host.js'));
    const { buildPluginPackage } = await import('@netcatty/plugin-cli'); const archive = path.join(directory, 'global-agent.ncpkg'); await buildPluginPackage(staging, archive);
    await service.manager.install(archive, { enable: true });
    await act(async () => root.render(<I18nProvider locale="en"><PluginAgentHost sessions={[
      { id: 'synthetic-a', hostId: 'host-a', hostLabel: 'Workspace A fixture', hostname: 'a.invalid', username: 'fixture', status: 'connected' },
      { id: 'synthetic-b', hostId: 'host-b', hostLabel: 'Workspace B fixture', hostname: 'b.invalid', username: 'fixture', status: 'connected' },
    ]} /></I18nProvider>));
    const waitFor = async (condition: () => boolean) => { const until = Date.now() + 8_000; while (!condition()) {
      if (Date.now() >= until) throw Error(`Global Agent UI fixture timed out; accepted=${counts.requests}, rejected=${counts.rejected}, effects=${workerCalls.length}, status=${panel?.window.document.getElementById('status')?.textContent}`);
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 5)); });
    } };
    let viewOpen = true;
    const mountPanel = async () => {
      panel = new JSDOM(fs.readFileSync(path.join(sample, 'view.html'), 'utf8'), { runScripts: 'outside-only' });
      Object.defineProperty(panel.window, 'pluginContext', { value: { commands: { executeCommand: async (name: string, params: unknown) => {
        // PluginViewHost.close removes sender authority before WebContents
        // closes. A pagehide RPC cannot be relied on to reach this relay.
        if (!viewOpen) throw Error('Untrusted plugin view sender');
        const result = structuredClone(await service!.contributionService.executeCommand(name, structuredClone(params))); pluginReplies.push(result); return result;
      } }, views: { onDidReceiveMessage: () => ({ dispose() {} }) } } });
      await act(async () => panel!.window.eval(fs.readFileSync(path.join(sample, 'panel.js'), 'utf8').replace('export function mount', 'function mount') + '\nwindow.disposePanel = mount(document.body, window.pluginContext, "test", "test");'));
    };
    await mountPanel();
    const element = (id: string) => panel!.window.document.getElementById(id)!;
    await waitFor(() => element('status').textContent!.startsWith('Choose terminals'));
    await act(async () => element('targets').click()); await waitFor(() => document.querySelectorAll('input[type="checkbox"]').length === 2);
    await act(async () => { for (const checkbox of document.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')) checkbox.click(); });
    await act(async () => { [...document.querySelectorAll('button')].find((button) => button.textContent === 'Use selected terminals')!.click(); });
    await waitFor(() => element('status').textContent!.startsWith('Targets selected'));
    await act(async () => element('open').click()); await waitFor(() => element('status').textContent!.startsWith('Ready'));
    let prompt = element('prompt') as HTMLTextAreaElement; prompt.value = 'Synthetic selected-target task';
    const send = () => element('compose').dispatchEvent(new panel!.window.Event('submit', { cancelable: true }));
    phase = 'complete'; await act(async () => { send(); }); await waitFor(() => element('status').textContent === 'Complete');
    assert.deepEqual(workerCalls, ['synthetic-b']); assert.match(element('transcript').textContent!, /Synthetic global Agent result/);
    assert.equal(mcp.getPermissionMode(), 'observer'); assert.equal(counts.requests, 2); assert.equal(counts.rejected, 0);
    assert.match(element('usage').textContent!, /input tokens/);
    phase = 'stop'; prompt.value = 'fixture:wait'; await act(async () => { send(); });
    await waitFor(() => element('transcript').textContent!.includes('Synthetic waiting output'));
    await act(async () => element('stop').click()); await waitFor(() => element('status').textContent === 'Stopped' && counts.aborted === 1);
    const stopped = element('transcript').textContent; await new Promise((resolve) => setTimeout(resolve, 75)); assert.equal(element('transcript').textContent, stopped);
    phase = 'modal-reopen-history';
    const reference = pluginReplies.find((value) => value && typeof value === 'object' && 'conversationRef' in value && 'chatHandle' in value) as { conversationRef: string };
    const beforeReopen = counts.requests;
    viewOpen = false;
    panel!.window.disposePanel(); panel!.window.close();
    viewOpen = true; await mountPanel();
    await waitFor(() => element('status').textContent!.startsWith('Choose terminals'));
    (element('conversation') as HTMLSelectElement).value = reference.conversationRef;
    await act(async () => element('conversation').dispatchEvent(new panel!.window.Event('change')));
    await act(async () => element('targets').click()); await waitFor(() => document.querySelectorAll('input[type="checkbox"]').length === 2);
    await act(async () => { [...document.querySelectorAll('button')].find((button) => button.textContent === 'Use selected terminals')!.click(); });
    await waitFor(() => element('status').textContent!.startsWith('Targets selected'));
    await act(async () => element('open').click());
    await waitFor(() => /^(Ready|Conversation unavailable)/.test(element('status').textContent!));
    assert.match(element('status').textContent!, /^Ready/, 'ordinary modal reopen must release the prior exact chat even if pagehide cleanup never reaches the plugin');
    assert.match(element('transcript').textContent!, /Synthetic global Agent result/);
    assert.equal(service.agentService.chats.size, 1); assert.equal(counts.requests, beforeReopen, 'history reopen does not invoke a model');
    prompt = element('prompt') as HTMLTextAreaElement; prompt.value = 'Synthetic continuation';
    phase = 'deny'; const before = counts.requests; const plugin = service.database.getActivePlugin('com.netcatty.globalagent');
    service.permissionEngine.setMode(plugin, 'ai.agent.actions', 'deny', service.permissionEngine.getPolicyRevision(plugin));
    await act(async () => { send(); }); await waitFor(() => element('status').textContent!.startsWith('Request ended'));
    assert.equal(counts.requests, before); assert.deepEqual(workerCalls, ['synthetic-b']);
    phase = 'restart-history';
    await service.manager.setEnabled('com.netcatty.globalagent', false);
    await service.manager.setEnabled('com.netcatty.globalagent', true);
    await act(async () => element('refresh').click()); await waitFor(() => element('status').textContent!.startsWith('Choose terminals'));
    const conversation = element('conversation') as HTMLSelectElement; conversation.value = reference.conversationRef;
    await act(async () => conversation.dispatchEvent(new panel!.window.Event('change')));
    await act(async () => element('targets').click()); await waitFor(() => document.querySelectorAll('input[type="checkbox"]').length === 2);
    await act(async () => { [...document.querySelectorAll('button')].find((button) => button.textContent === 'Use selected terminals')!.click(); });
    await waitFor(() => element('status').textContent!.startsWith('Targets selected'));
    await act(async () => element('open').click()); await waitFor(() => element('status').textContent!.startsWith('Ready'));
    assert.match(element('transcript').textContent!, /Synthetic global Agent result/, 'owned core history survives runtime restart');
    prompt.value = 'Synthetic model-only continuation'; await act(async () => { send(); });
    await waitFor(() => element('status').textContent === 'Complete');
    assert.equal(counts.requests, before + 1, 'Actions Deny allows a tool-free configured model turn after reopening');
    assert.deepEqual(workerCalls, ['synthetic-b']);
    phase = 'backend-revision';
    const latestChat = [...pluginReplies].reverse().find((value) => value && typeof value === 'object' && 'chatHandle' in value) as { chatHandle: string };
    const generation = service.agentService.host.generation; const requestsBeforeChange = counts.requests;
    const { LOCAL_STORAGE_ADAPTER_CHANGED_EVENT } = await import('../infrastructure/persistence/localStorageAdapter');
    dom.window.localStorage.setItem(keys.STORAGE_KEY_AI_ACTIVE_MODEL, 'changed-synthetic-model');
    await act(async () => window.dispatchEvent(new CustomEvent(LOCAL_STORAGE_ADAPTER_CHANGED_EVENT, { detail: { key: keys.STORAGE_KEY_AI_ACTIVE_MODEL } })));
    await waitFor(() => service!.agentService.host.generation > generation && service!.agentService.chats.size === 0);
    await assert.rejects(service.contributionService.executeCommand('com.netcatty.globalagent.history', { chatHandle: latestChat.chatHandle }));
    assert.equal(counts.requests, requestsBeforeChange, 'configuration invalidation never retries model inference');
    assert.doesNotMatch(JSON.stringify(pluginReplies), /FIXTURE_ONLY_API_MARKER|apiKey|externalSessionId|plugin-agent:|opaque-owner|mcpServers|permissionMode/);
    assert.doesNotMatch(JSON.stringify(trustedReplies), /FIXTURE_ONLY_API_MARKER|apiKey/);
    assert.deepEqual(errors, []);
  } finally {
    console.error = originalError;
    if (panel) { panel.window.disposePanel(); panel.window.close(); }
    await act(async () => root.unmount()); await service?.manager.shutdown();
    mcp.setPermissionMode('confirm'); mcp.cleanup(); aiBridge.cleanup(); privacy.configure({ enabled: false }); registerAppAppLockRuntime(oldLock);
    server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); dom.window.close();
    for (const [key, descriptor] of previous) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); }
    if (oldTmp === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = oldTmp;
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
