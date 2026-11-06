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

test('cold plugin host reaches the local fixture through the actual main provider allowlist without the AI sidebar', { timeout: 20_000 }, async (t) => {
  // JSDOM + the in-process runtime prove app wiring; they are not native sandbox
  // evidence. All state is synthetic, with no real provider, key, Note or host.
  const rootPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'netcatty-ai-ui-'));
  const oldTmp = process.env.TMPDIR; process.env.TMPDIR = fixtureRoot;
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { pretendToBeVisual: true, url: 'http://localhost' });
  const previous = new Map<string, PropertyDescriptor | undefined>();
  const install = (key: string, value: unknown) => {
    previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  };
  for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'HTMLInputElement', 'HTMLSelectElement', 'Element', 'Node', 'NodeFilter', 'MutationObserver', 'CustomEvent', 'Event', 'KeyboardEvent', 'MouseEvent', 'DocumentFragment']) {
    install(key, key === 'window' ? dom.window : dom.window[key as keyof typeof dom.window]);
  }
  install('localStorage', dom.window.localStorage);
  install('getComputedStyle', dom.window.getComputedStyle.bind(dom.window));
  install('requestAnimationFrame', dom.window.requestAnimationFrame.bind(dom.window));
  install('cancelAnimationFrame', dom.window.cancelAnimationFrame.bind(dom.window));
  install('IS_REACT_ACT_ENVIRONMENT', true);
  const { default: React, act } = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { PluginAIContextHost } = await import('./plugins/PluginAIContextHost');
  const { I18nProvider } = await import('../application/i18n/I18nProvider');
  const { publishNotesSnapshot, getNotesSnapshot } = await import('../application/state/notesStore');
  const { registerAppAppLockRuntime, getAppAppLockRuntime } = await import('../application/state/appRuntimeBridge');
  const { STORAGE_KEY_AI_PROVIDERS, STORAGE_KEY_AI_ACTIVE_PROVIDER, STORAGE_KEY_AI_ACTIVE_MODEL } = await import('../infrastructure/config/storageKeys');
  const { createAssistantProviderFixture } = await import('../scripts/plugin-assistant-provider-fixture.mjs');
  const { createPluginHostService } = require('../electron/plugins/hostService.cjs');
  const { inProcessBrowserRuntime } = require('../electron/plugins/fixtures/inProcessBrowserRuntime.cjs');
  const { createPreloadApi } = require('../electron/preload/api.cjs');
  const aiBridge = require('../electron/bridges/aiBridge.cjs');
  const { registerProviderHandlers } = require('../electron/bridges/aiBridge/providerHandlers.cjs');
  const { server, counts } = createAssistantProviderFixture({ delayMs: 25 });
  const oldNotes = getNotesSnapshot(); const oldLock = getAppAppLockRuntime();
  let service: ReturnType<typeof createPluginHostService> | undefined;
  let panel: JSDOM | undefined;
  const root = createRoot(document.getElementById('root')!);
  let locked = false; let contentAllowed = false;
  const lockListeners = new Set<(state: { locked: boolean }) => void>();
  const reviews: Array<Record<string, unknown>> = [];
  const trustedPayloads: unknown[] = [];
  const streamResults: Array<{ ok: boolean; statusCode?: number; allowlistRejected: boolean }> = [];
  const providerSyncs: Array<{ count: number; selectedPresent: boolean }> = [];
  const sdkErrorNames: string[] = [];
  let diagnosticPhase = 'setup';
  const originalConsoleError = console.error;
  // node:sqlite was imported above. Node 22 delivers its ExperimentalWarning
  // asynchronously through console.error. Let module warnings reach normal
  // stderr before observing SDK/renderer errors; do not suppress that warning.
  await new Promise<void>((resolve) => setImmediate(resolve));
  // The expected pre-fix SDK error contains request details. Keep diagnostics
  // categorical even on the failing-before path; never print payloads/headers.
  console.error = (value: unknown) => {
    let category = 'unknown';
    if (typeof value === 'string' && /not wrapped in act/.test(value)) category = 'react-act-warning';
    else if (typeof value === 'string' && /act.*environment|environment.*act/.test(value)) category = 'react-act-environment';
    else if (typeof value === 'string' && /ExperimentalWarning: SQLite is an experimental feature/.test(value)) category = 'node-sqlite-experimental';
    else if (typeof value === 'string') category = 'other-string';
    else if (value && typeof value === 'object') {
      const name = (value as { name?: unknown }).name;
      if (typeof name === 'string' && ['AbortError', 'AI_APICallError', 'AI_LoadAPIKeyError', 'TypeError', 'Error'].includes(name)) category = name;
    }
    sdkErrorNames.push(`${diagnosticPhase}:${category}`);
  };
  t.after(() => { console.error = originalConsoleError; });
  try {
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    const address = server.address(); assert.ok(address && typeof address !== 'string');
    const endpoint = `http://127.0.0.1:${address.port}/v1`;
    const ipcHandlers = new Map<string, (...args: unknown[]) => unknown>();
    const ipcRenderer = new EventEmitter() as EventEmitter & { invoke: (channel: string, payload: unknown) => Promise<unknown> };
    const sender = Object.assign(new EventEmitter(), { id: 1, isDestroyed: () => false, send: (channel: string, payload: unknown) => {
      if (channel === 'netcatty:plugins:ai-host-request') trustedPayloads.push(structuredClone(payload));
      ipcRenderer.emit(channel, {}, structuredClone(payload));
    } });
    const mainWindow = Object.assign(new EventEmitter(), { webContents: sender, isDestroyed: () => false, isVisible: () => true, isFocused: () => true });
    const providerContext = {
      ipcMain: { handle: (channel: string, handler: (...args: unknown[]) => unknown) => ipcHandlers.set(channel, handler) },
      providerConfigs: [] as Array<{ id: string; baseURL?: string; apiKey?: string }>, webSearchApiHost: null,
      validateSender: (event: { sender: unknown }) => event.sender === sender,
      validateSenderOrSettings: (event: { sender: unknown }) => event.sender === sender,
      // Only credential injection is synthetic. Admission, sync and the HTTP
      // transport are the production implementations, not a direct-fetch seam.
      injectApiKeyIntoRequest: (url: string, headers: Record<string, string>, providerId: string) => {
        const config = providerContext.providerConfigs.find((item) => item.id === providerId);
        return { url, headers: Object.fromEntries(Object.entries(headers).map(([key, value]) =>
          [key, config?.apiKey ? value.replace('__IPC_SECURED__', config.apiKey) : value])) };
      },
      shouldSkipTLSVerify: () => false,
      streamRequest: aiBridge._streamRequestForTests,
    };
    registerProviderHandlers(providerContext);
    assert.equal(providerContext.providerConfigs.length, 0);
    ipcRenderer.invoke = async (channel, payload) => {
      if (channel === 'netcatty:ai:chat:stream') {
        const request = payload as { url: string; headers: Record<string, string>; body: string; requestId: string };
        assert.equal(new URL(request.url).origin, new URL(endpoint).origin);
        assert.doesNotMatch(JSON.stringify(request), /fixture-only/);
      }
      if (channel === 'netcatty:ai:chat:cancel') return aiBridge.cancelPluginAIStreamsForSender(sender) > 0;
      const handler = ipcHandlers.get(channel);
      assert.ok(handler, `Unexpected trusted IPC: ${channel}`);
      const result = await handler({ sender }, structuredClone(payload));
      if (channel === 'netcatty:ai:sync-providers') providerSyncs.push({ count: providerContext.providerConfigs.length,
        selectedPresent: providerContext.providerConfigs.some((item) => item.id === 'qa-provider') });
      if (channel === 'netcatty:ai:chat:stream') {
        const status = result as { ok: boolean; statusCode?: number; error?: string };
        streamResults.push({ ok: status.ok, statusCode: status.statusCode, allowlistRejected: status.error === 'URL host is not in the allowed list' });
      }
      return result;
    };
    const api = createPreloadApi({ ipcRenderer, webUtils: {} });
    Object.defineProperty(dom.window, 'netcatty', { value: api });
    const syntheticNote = { id: 'synthetic-note', title: 'Synthetic retry plan', content: 'Synthetic retry plan: add a retry button.', createdAt: 1, updatedAt: 1 };
    publishNotesSnapshot({ notes: [syntheticNote], noteGroups: [] });
    registerAppAppLockRuntime({ locked: false } as NonNullable<ReturnType<typeof getAppAppLockRuntime>>);
    dom.window.localStorage.setItem(STORAGE_KEY_AI_PROVIDERS, JSON.stringify([
      { id: 'qa-provider', name: 'QA fixture', providerId: 'custom', enabled: true, baseURL: endpoint, defaultModel: 'deterministic-fixture', apiKey: 'fixture-only' },
      { id: 'qa-secondary', name: 'Synthetic secondary', providerId: 'custom', enabled: true, baseURL: 'https://secondary.invalid/v1', defaultModel: 'synthetic', apiKey: 'secondary-fixture-marker' },
    ]));
    dom.window.localStorage.setItem(STORAGE_KEY_AI_ACTIVE_PROVIDER, 'qa-provider');
    dom.window.localStorage.setItem(STORAGE_KEY_AI_ACTIVE_MODEL, 'deterministic-fixture');
    service = createPluginHostService({
      app: { getAppPath: () => rootPath, getPath: () => fixtureRoot, getVersion: () => '0.0.0' }, env: {},
      getInteractionWindow: () => mainWindow, isAppLocked: () => locked,
      subscribeAppLock: (listener: (state: { locked: boolean }) => void) => { lockListeners.add(listener); return () => lockListeners.delete(listener); },
      electron: { ipcMain: { handle: (name: string, handler: (...args: unknown[]) => unknown) => ipcHandlers.set(name, handler), removeHandler: (name: string) => ipcHandlers.delete(name) },
        dialog: { showMessageBox: async (_window: unknown, options: Record<string, unknown>) => { reviews.push(options); return { response: 1 }; } } },
      requestPermissionDecision: async (request: { requestId: string; permission: string; relatedPermissions?: Array<{ permission: string }> }) => (request.permission === 'context.selected.read' || request.relatedPermissions?.some((item) => item.permission === 'context.selected.read')) && !contentAllowed
        ? { requestId: request.requestId, decision: 'deny' }
        : { requestId: request.requestId, decision: 'allow', scope: request.permission === 'context.selected.read' ? 'once' : 'application' },
    });
    service.runtimeSupervisor.runtimeFactories.browser = inProcessBrowserRuntime;
    await service.manager.initialize();
    const staging = path.join(fixtureRoot, 'package'); fs.mkdirSync(path.join(staging, 'dist'), { recursive: true });
    const sample = path.join(rootPath, 'examples/plugins/assistant');
    for (const file of ['netcatty.plugin.json', 'README.md']) fs.copyFileSync(path.join(sample, file), path.join(staging, file));
    fs.copyFileSync(path.join(sample, 'dist/host.js'), path.join(staging, 'dist/host.js'));
    const { buildPluginPackage } = await import('@netcatty/plugin-cli');
    const archive = path.join(fixtureRoot, 'assistant.ncpkg'); await buildPluginPackage(staging, archive);
    service.database.setPermissionMode('com.netcatty.assistant', 'context.selected.read', 'ask');
    await service.manager.install(archive, { enable: true });
    await act(async () => root.render(<I18nProvider locale="en"><PluginAIContextHost sessions={[]} workspaces={[]} /></I18nProvider>));
    const waitFor = async (condition: () => boolean) => {
      const deadline = Date.now() + 5000;
      while (!condition()) {
        if (Date.now() >= deadline) throw Error('Connected host UI state timed out');
        await act(async () => { await new Promise((resolve) => setTimeout(resolve, 5)); });
      }
    };
    panel = new JSDOM(fs.readFileSync(path.join(sample, 'view.html'), 'utf8'), { runScripts: 'outside-only' });
    Object.defineProperty(panel.window, 'pluginContext', { value: { commands: {
      executeCommand: async (command: string, args: unknown) => structuredClone(await service!.contributionService.executeCommand(command, structuredClone(args))),
      }, views: { onDidReceiveMessage: () => ({ dispose() {} }) }
    } });
    diagnosticPhase = 'initial-selection';
    await act(async () => panel!.window.eval(fs.readFileSync(path.join(sample, 'panel.js'), 'utf8').replace('export function mount', 'function mount') + '\nwindow.disposePanel = mount(document.body, window.pluginContext, "test", "test");'));
    await waitFor(() => document.getElementById('plugin-ai-note') !== null);
    const noteChoice = document.getElementById('plugin-ai-note') as HTMLSelectElement;
    assert.equal(noteChoice.options.length, 2);
    await act(async () => { noteChoice.value = syntheticNote.id; noteChoice.dispatchEvent(new Event('change', { bubbles: true })); });
    await act(async () => { Array.from(document.querySelectorAll('button')).find((button) => button.textContent === 'Share selected summaries')!.click(); });
    const element = (id: string) => panel!.window.document.getElementById(id)!;
    await waitFor(() => element('status').textContent === 'Ready');
    assert.match(element('model').textContent!, /QA fixture/);
    const reference = element('context') as HTMLSelectElement;
    assert.equal(reference.value, ''); assert.equal(reference.options.length, 2);
    assert.notEqual(reference.options[1].value, syntheticNote.id); reference.value = reference.options[1].value;
    const send = () => element('compose').dispatchEvent(new panel!.window.Event('submit', { cancelable: true }));
    diagnosticPhase = 'deny-content';
    send(); await waitFor(() => element('status').textContent!.startsWith('Request ended'));
    assert.equal(counts.requests, 0); assert.equal(reviews.length, 0);
    contentAllowed = true;
    diagnosticPhase = 'complete-stream';
    send(); await waitFor(() => counts.completed === 1 || streamResults.some((result) => !result.ok));
    assert.deepEqual(streamResults.at(-1), { ok: true, statusCode: 200, allowlistRejected: false },
      'Cold plugin startup must synchronize host providers before the main allowlist admits transport');
    assert.ok(providerSyncs.some((sync) => sync.selectedPresent && sync.count === 2), 'Preserve other host-configured providers in the shared registry');
    await waitFor(() => element('status').textContent === 'Complete');
    assert.equal(reviews.length, 0, 'content policy must not open a second native sharing review');
    assert.equal(counts.completed, 1); assert.match(element('response').textContent!, /Synthetic plan/); assert.match(element('usage').textContent!, /12 input tokens/);
    diagnosticPhase = 'stop-stream';
    send(); await waitFor(() => element('response').textContent!.startsWith('Synthetic plan: '));
    element('stop').dispatchEvent(new panel.window.Event('click'));
    await waitFor(() => element('status').textContent === 'Stopped' && counts.aborted === 1);
    const stoppedText = element('response').textContent; await new Promise((resolve) => setTimeout(resolve, 50)); assert.equal(element('response').textContent, stoppedText);
    diagnosticPhase = 'lock-stream';
    send(); await waitFor(() => element('response').textContent!.startsWith('Synthetic plan: '));
    locked = true; registerAppAppLockRuntime({ locked: true } as NonNullable<ReturnType<typeof getAppAppLockRuntime>>);
    for (const listener of lockListeners) listener({ locked: true });
    await waitFor(() => counts.aborted === 2 && service!.aiContextService.broker.turns.size === 0);
    assert.equal(aiBridge._getActiveStreamCountForTests(), 0);
    assert.doesNotMatch(JSON.stringify(trustedPayloads), /fixture-only|secondary-fixture-marker|apiKey|privateOwner|permissionMode|mcp/);
    assert.deepEqual(sdkErrorNames, []);
  } finally {
    console.error = originalConsoleError;
    // JSDOM.close does not deliver the browser pagehide lifecycle. Invalidate
    // the sample's pending callbacks before teardown closes its document.
    if (panel) { panel.window.disposePanel(); panel.window.close(); }
    await act(async () => root.unmount());
    await service?.manager.shutdown(); aiBridge.cleanup();
    publishNotesSnapshot(oldNotes); registerAppAppLockRuntime(oldLock);
    server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve()));
    dom.window.close();
    for (const [key, value] of previous) { if (value) Object.defineProperty(globalThis, key, value); else Reflect.deleteProperty(globalThis, key); }
    if (oldTmp === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = oldTmp;
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  }
});
