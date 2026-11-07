import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { mkdtemp, cp, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { JSDOM } from 'jsdom';
import { sanitizeHost } from '../domain/host';
import type { ConnectionLog, Host, ManagedSource } from '../domain/models';
import { applyGroupDefaults, resolveGroupDefaults } from '../domain/groupConfig';
import type { HostInteractionEvent, HostInteractionPrompt, VaultHostSelectionResult, VaultHostActionResult, VaultHostRef } from '@netcatty/plugin-contract';

const require = createRequire(import.meta.url);

test('installed sample entrypoint uses real SDK, source authority, signed host dialogs and renderer action guards', { timeout: 45_000 }, async (t) => {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { pretendToBeVisual: true, url: 'http://localhost' });
  const previous = new Map<string, PropertyDescriptor | undefined>();
  const install = (key: string, value: unknown) => {
    previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  };
  for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'HTMLInputElement', 'HTMLButtonElement', 'Element', 'SVGElement', 'Node', 'NodeFilter', 'MutationObserver', 'CustomEvent', 'Event', 'KeyboardEvent', 'MouseEvent']) {
    install(key, key === 'window' ? dom.window : dom.window[key as keyof typeof dom.window]);
  }
  install('getComputedStyle', dom.window.getComputedStyle.bind(dom.window));
  install('requestAnimationFrame', dom.window.requestAnimationFrame.bind(dom.window));
  install('cancelAnimationFrame', dom.window.cancelAnimationFrame.bind(dom.window));
  install('IS_REACT_ACT_ENVIRONMENT', true);
  install('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  const { default: React, act } = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { I18nProvider } = await import('../application/i18n/I18nProvider');
  const { PluginHostActionHost } = await import('./plugins/PluginHostActionHost');
  const { handleConnectToHostImpl } = await import('../application/app/AppHandlers');
  const runtime = await import('../application/state/appRuntimeBridge');
  const { registerAppHandlers } = await import('../application/app/appHandlersBridge');
  const { createPluginHostService } = require('../electron/plugins/hostService.cjs');
  const { inProcessBrowserRuntime } = require('../electron/plugins/fixtures/inProcessBrowserRuntime.cjs');
  const directory = await mkdtemp(path.join(tmpdir(), 'netcatty-host-entry-'));
  const listeners = new Set<(event: unknown) => void>();
  const prompts: HostInteractionPrompt[] = [];
  const sender = Object.assign(new EventEmitter(), { id: 77, isDestroyed: () => false, send(_channel: string, event: HostInteractionEvent) { if (!('closed' in event)) prompts.push(event); for (const listener of listeners) listener(event); } });
  const owner = Object.assign(new EventEmitter(), { webContents: sender, isFocused: () => true, isVisible: () => true, isDestroyed: () => false });
  let locked = false;
  const lockListeners = new Set<(state: { locked: boolean }) => void>();
  const service = createPluginHostService({
    app: { getAppPath: () => process.cwd(), getPath: () => directory, getVersion: () => '0.0.0' }, electron: {}, env: {},
    getInteractionWindow: () => owner, isAppLocked: () => locked,
    subscribeAppLock: (callback: (state: { locked: boolean }) => void) => { lockListeners.add(callback); return () => lockListeners.delete(callback); },
    requestPermissionDecision: async (request: { requestId: string; permission: string }) => ({ requestId: request.requestId, decision: 'allow', scope: ['vault.metadata', 'vault.write', 'ui.interact'].includes(request.permission) ? 'once' : 'application' }),
  });
  let requestClock = Date.now();
  service.interactionService.clock = () => requestClock;
  service.runtimeSupervisor.runtimeFactories.browser = inProcessBrowserRuntime;
  Object.assign(dom.window, { netcatty: {
    onPluginInteraction(callback: (event: unknown) => void) { listeners.add(callback); return () => listeners.delete(callback); },
    respondPluginInteraction: (response: unknown) => service.interactionService.respond(sender, response),
  } });
  const first = sanitizeHost({ id: 'synthetic-first', label: 'Synthetic first', hostname: 'first.invalid', username: 'test', port: 22, protocol: 'ssh', os: 'linux', tags: ['synthetic'], group: 'Synthetic', password: 'synthetic-password', startupCommand: 'synthetic-script' });
  const second = sanitizeHost({ ...first, id: 'synthetic-second', label: 'Synthetic second', hostname: 'second.invalid', password: undefined, startupCommand: undefined });
  let hosts: Host[] = [first, second];
  let persisted = hosts.map((host) => structuredClone(host));
  let beforeCommit: (() => Promise<void>) | undefined;
  let saves = 0;
  const connections: Host[] = [];
  const vault = {
    hosts, customGroups: ['Synthetic'], groupConfigs: [], snippets: [], managedSources: [] as ManagedSource[], isInitialized: true,
    readCurrentHostActionState: () => ({ hosts, groupConfigs: vault.groupConfigs, snippets: vault.snippets, managedSources: vault.managedSources }),
    async readPersistedHosts() { return persisted.map((host) => structuredClone(host)); },
    async commitVaultImportTransaction(next: Host[], groups: (groups: string[]) => string[], sources: (sources: ManagedSource[]) => ManagedSource[], _configs: unknown, _expected: unknown, _lock: unknown, authorize: () => Promise<void>) {
      const nextSources = sources(vault.managedSources);
      await beforeCommit?.();
      await authorize();
      saves++; hosts = next; persisted = next.map((host) => structuredClone(host));
      return { status: 'persisted', groups: groups(vault.customGroups), sources: nextSources, groupConfigs: [] };
    },
  };
  const publish = () => {
    runtime.registerAppVaultRuntime(vault as never);
    runtime.registerAppAppLockRuntime({ initialized: true, locked } as never);
  };
  publish();
  registerAppHandlers({ handleConnectToHost: (host: Host) => { connections.push(host); return 'private-session-id'; } });
  const root = createRoot(document.getElementById('root')!);
  const settle = () => new Promise((resolve) => setTimeout(resolve, 20));
  const waitFor = async (predicate: () => boolean) => {
    for (let count = 0; count < 80; count++) { await act(async () => { await settle(); }); if (predicate()) return; }
    assert.fail(`Expected host UI state; current text: ${document.body.textContent}`);
  };
  const button = (text: string) => Array.from(document.querySelectorAll<HTMLButtonElement>('button')).find((item) => item.textContent === text)!;
  const click = async (element: HTMLElement) => { assert.ok(element); await act(async () => { element.click(); await settle(); }); };
  const begin = async (name: string) => {
    requestClock += 60_001;
    let promise!: Promise<VaultHostSelectionResult | VaultHostActionResult>;
    await act(async () => { promise = service.contributionService.executeCommand(`com.netcatty.host-actions.${name}`); void promise.catch(() => {}); await settle(); });
    await waitFor(() => document.querySelector('[role="dialog"]') !== null);
    return { promise };
  };
  const chooseGroup = async () => {
    await click(document.querySelector<HTMLElement>('[role="option"] button[aria-pressed]')!);
    await click(Array.from(document.querySelectorAll<HTMLButtonElement>('button')).find((item) => item.textContent?.startsWith('Continue ('))!);
  };
  try {
    await service.manager.initialize();
    const packageRoot = path.join(directory, 'source');
    await cp(new URL('../examples/plugins/host-actions/', import.meta.url), packageRoot, { recursive: true });
    const { buildPluginPackage } = await import('@netcatty/plugin-cli');
    const archive = path.join(directory, 'fixture.ncpkg');
    await buildPluginPackage(packageRoot, archive);
    await service.manager.install(archive, { enable: true });
    service.database.setPermissionMode('com.netcatty.host-actions', 'ui.interact', 'ask');
    service.interactionService.setReady(sender, true);
    await act(async () => root.render(<I18nProvider locale="en"><PluginHostActionHost /></I18nProvider>));

    let selectedTarget: VaultHostRef;
    await t.test('group selection shares only explicit current members and grants no connection', async () => {
      const run = await begin('select');
      await click(document.querySelector<HTMLElement>('[role="option"] button[aria-pressed]')!);
      hosts = [...hosts, sanitizeHost({ ...second, id: 'synthetic-future', hostname: 'future.invalid' })];
      persisted = hosts.map((host) => structuredClone(host));
      await click(Array.from(document.querySelectorAll<HTMLButtonElement>('button')).find((item) => item.textContent?.startsWith('Continue ('))!);
      const result = await run.promise;
      assert.ok('hosts' in result);
      assert.equal(result.hosts.length, 2); assert.equal(result.groups[0].members.length, 2);
      assert.equal(result.hosts.some((host) => host.metadata.hostname === 'future.invalid'), false);
      assert.equal(result.hosts[0].target.scope, 'metadata');
      selectedTarget = result.hosts[0].target;
      for (const text of ['synthetic-password', 'synthetic-script', 'resourceId', 'private-session-id']) assert.equal(JSON.stringify(result).includes(text), false);
      assert.equal(connections.length, 0); assert.equal(saves, 0);
    });

    await t.test('registered boundaries reject AI text, caller owners, tampered targets and stale expected revisions', async () => {
      const identity = service.runtimeSupervisor.getRuntimeIdentity('com.netcatty.host-actions');
      const routes = service.rpcRegistry.createRoutes({ ...identity, manifest: service.database.getActivePlugin(identity.pluginId).manifest });
      const transport = { signal: new AbortController().signal };
      for (const target of [
        { handle: 'text-only', version: 'v1', scope: 'host' },
        { ...selectedTarget, handle: 'synthetic-tampered-selection-handle-0000' },
      ]) await assert.rejects(routes.requestHandlers['vault.requestConnect']({ target, expectedRevision: selectedTarget.revision }, transport), /invalid|expired|changed/);
      await assert.rejects(routes.requestHandlers['vault.requestConnect']({ target: selectedTarget, expectedRevision: 'stale' }, transport), /expired|changed/);
      await assert.rejects(routes.requestHandlers['vault.requestHostDraft']({ privateOwner: 'spoof', draft: { hostname: 'synthetic.invalid' } }, transport), /invalid/);
      assert.equal(service.interactionService.pending.size, 0); assert.equal(connections.length, 0);
    });

    await t.test('cancel creates no draft or connection', async () => {
      const run = await begin('create'); await click(button('Cancel'));
      assert.deepEqual(await run.promise, { cancelled: true }); assert.equal(saves, 0); assert.equal(connections.length, 0);
    });

    await t.test('reviewed create saves only the synthetic SSH draft', async () => {
      const run = await begin('create');
      assert.match(document.body.textContent ?? '', /Changes to save/);
      await click(button('Save Host'));
      assert.deepEqual(await run.promise, { cancelled: false, status: 'saved' });
      assert.equal(saves, 1);
      const saved = hosts.find((host) => host.hostname === 'synthetic.invalid')!;
      assert.equal(saved.protocol, 'ssh'); assert.equal(saved.password, undefined); assert.equal(saved.startupCommand, undefined);
    });

    for (const change of ['remove', 'replace'] as const) await t.test(`${change} after selection prevents a stale edit`, async () => {
      hosts = [first, second]; persisted = hosts.map((host) => structuredClone(host));
      const run = await begin('edit'); await chooseGroup();
      await waitFor(() => document.body.textContent?.includes('Changes to save') === true);
      hosts = change === 'remove' ? [second] : [{ ...first }, second];
      await click(button('Save Host'));
      await assert.rejects(run.promise, /changed|cancelled|complete/);
      assert.equal(saves, 1); assert.equal(connections.length, 0);
    });

    await t.test('connection confirmation discloses saved scripts before dispatch and returns no session', async () => {
      hosts = [first, second]; persisted = hosts.map((host) => structuredClone(host));
      const run = await begin('connect'); await chooseGroup();
      await waitFor(() => document.body.textContent?.includes('Saved startup, connect or output scripts may run') === true);
      assert.equal(connections.length, 0); assert.equal(document.body.textContent?.includes('synthetic-script'), false);
      await click(button('Connect'));
      assert.deepEqual(await run.promise, { cancelled: false, status: 'requested' });
      assert.equal(connections.length, 1); assert.equal(connections[0], first);
    });

    await t.test('Vault lock cancels a pending connection', async () => {
      const run = await begin('connect'); await chooseGroup();
      await waitFor(() => button('Connect') !== undefined);
      await act(async () => { locked = true; publish(); for (const listener of lockListeners) listener({ locked: true }); await settle(); });
      await assert.rejects(run.promise, /cancelled/); assert.equal(connections.length, 1);
      locked = false; publish();
    });

    await t.test('revoke during asynchronous preparation prevents the write', async () => {
      hosts = [first, second]; persisted = hosts.map((host) => structuredClone(host));
      let release!: () => void; let preparing = false;
      beforeCommit = async () => { preparing = true; await new Promise<void>((resolve) => { release = resolve; }); };
      const run = await begin('edit'); await chooseGroup();
      await waitFor(() => button('Save Host') !== undefined); await click(button('Save Host'));
      await waitFor(() => preparing);
      await act(async () => { service.permissionEngine.setMode(service.database.getActivePlugin('com.netcatty.host-actions'), 'vault.write', 'deny'); release(); await settle(); });
      await assert.rejects(run.promise, /revoked|cancelled/); assert.equal(saves, 1); beforeCommit = undefined; service.permissionEngine.setMode(service.database.getActivePlugin('com.netcatty.host-actions'), 'vault.write', 'allow');
    });

    await t.test('source replacement during review cannot use the old action authority', async () => {
      const run = await begin('create');
      const original = service.database.getRetainedPluginSource;
      service.database.getRetainedPluginSource = () => ({ id: 'changed-source', kind: 'local', origin: null });
      try { await click(button('Save Host')); await assert.rejects(run.promise, /source binding/); }
      finally { service.database.getRetainedPluginSource = original; }
      assert.equal(saves, 1); assert.equal(connections.length, 1);
    });

    await t.test('managed A to B stays in the Vault editor and cannot acquire file-write effects', async () => {
      const candidate = sanitizeHost({ ...first, group: 'A', managedSourceId: 'synthetic-source-a' });
      hosts = [candidate]; persisted = hosts.map((host) => structuredClone(host));
      vault.managedSources = [
        { id: 'synthetic-source-a', type: 'ssh_config', filePath: '/synthetic/a.conf', groupName: 'A', lastSyncedAt: 0 },
        { id: 'synthetic-source-b', type: 'ssh_config', filePath: '/synthetic/b.conf', groupName: 'B', lastSyncedAt: 0 },
      ];
      const run = await begin('edit'); await chooseGroup();
      await waitFor(() => button('Save Host') !== undefined);
      const group = Array.from(document.querySelectorAll('label')).find((label) => label.querySelector('span')?.textContent === 'Group')?.querySelector('input');
      assert.ok(group);
      const setValue = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value')!.set!;
      await act(async () => { setValue.call(group, 'B'); group.dispatchEvent(new dom.window.Event('input', { bubbles: true })); await settle(); });
      assert.match(document.querySelector('[role="dialog"]')?.textContent ?? '', /"A"\s*\u2192\s*"B"/u);
      assert.match(document.querySelector('[role="alert"]')?.textContent ?? '', /Managed SSH config changes require the Vault host editor/);
      assert.equal(button('Save Host').disabled, true);
      await click(button('Save Host')); assert.equal(saves, 1);
      await click(button('Cancel')); assert.deepEqual(await run.promise, { cancelled: true });
      assert.equal(hosts[0].group, 'A'); assert.equal(hosts[0].managedSourceId, 'synthetic-source-a');
      vault.managedSources = [];
    });

    await t.test('creating into a managed group is explicitly unavailable in the small draft UI', async () => {
      vault.managedSources = [{ id: 'synthetic-source-b', type: 'ssh_config', filePath: '/synthetic/b.conf', groupName: 'Samples', lastSyncedAt: 0 }];
      const run = await begin('create');
      assert.match(document.querySelector('[role="alert"]')?.textContent ?? '', /Managed SSH config changes require the Vault host editor/);
      assert.equal(button('Save Host').disabled, true);
      await click(button('Cancel')); assert.deepEqual(await run.promise, { cancelled: true });
      assert.equal(saves, 1); vault.managedSources = [];
    });

    for (const transport of [
      { name: 'Mosh', expected: 'mosh', overrides: { moshEnabled: true } },
      { name: 'ET', expected: 'et', overrides: { etEnabled: true } },
      { name: 'implicit localhost shell', expected: 'local', overrides: { hostname: 'localhost' } },
    ] as const) await t.test(`${transport.name} confirmation matches the real connection handler`, async () => {
      const candidate = sanitizeHost({ ...second, id: `synthetic-${transport.expected}`, label: `Synthetic ${transport.expected}`, ...transport.overrides });
      hosts = [candidate]; persisted = hosts.map((host) => structuredClone(host));
      const dispatched: Host[] = [];
      const logs: Array<Pick<ConnectionLog, 'protocol'>> = [];
      registerAppHandlers({ handleConnectToHost: (host: Host) => handleConnectToHostImpl(() => ({
        resolveEffectiveHost: (saved: Host) => applyGroupDefaults(saved, saved.group ? resolveGroupDefaults(saved.group, vault.groupConfigs) : {}),
        discoveredShells: [], terminalSettings: {}, resolveShellSetting: () => null,
        systemInfoRef: { current: { username: 'synthetic-local-user', hostname: 'synthetic-device' } },
        keys: [], identities: [], resolveHostAuth: () => ({ username: 'synthetic-user' }),
        connectToHost: (resolved: Host) => { dispatched.push(resolved); return 'synthetic-transport-session'; },
        addConnectionLog: (entry: Pick<ConnectionLog, 'protocol'>) => logs.push(entry),
      }), host) });
      const run = await begin('connect');
      try {
        await chooseGroup(); await waitFor(() => button('Connect') !== undefined);
        const confirmation = document.querySelector('[role="dialog"]')?.textContent ?? '';
        assert.match(confirmation, new RegExp(`\\(${transport.expected}\\)`));
        assert.equal(confirmation.includes('Local execution: this opens a shell on this device.'), transport.expected === 'local');
        if (transport.expected === 'local') assert.doesNotMatch(confirmation, /test@localhost:22/u);
        assert.equal(dispatched.length, 0);
        await click(button('Connect'));
        assert.deepEqual(await run.promise, { cancelled: false, status: 'requested' });
        assert.equal(dispatched.length, 1);
        assert.equal(logs[0].protocol, transport.expected);
      } finally {
        if (button('Cancel')) await click(button('Cancel'));
        await run.promise.catch(() => {});
        registerAppHandlers({ handleConnectToHost: (host: Host) => { connections.push(host); return 'private-session-id'; } });
      }
    });

    await t.test('Allow connects through the selected target without a confirmation dialog; Deny blocks every Host action', async () => {
      const id = 'com.netcatty.host-actions';
      const plugin = service.database.getActivePlugin(id);
      const set = (permission: string, mode: string) => service.permissionEngine.setMode(plugin, permission, mode);
      set('ui.interact', 'allow');
      const allowed = await begin('connect'); await chooseGroup();
      await act(async () => { await allowed.promise; await settle(); });
      assert.equal(document.querySelector('[role="dialog"]'), null);
      assert.equal(connections.length, 2);
      for (const [permission, command] of [['vault.metadata', 'select'], ['vault.write', 'create']] as const) {
        set(permission, 'deny'); requestClock += 60_001;
        await assert.rejects(service.contributionService.executeCommand(`${id}.${command}`), /disabled/);
        assert.equal(document.querySelector('[role="dialog"]'), null);
        set(permission, 'allow');
      }
      set('ui.interact', 'deny');
      const denied = await begin('connect'); await chooseGroup();
      await assert.rejects(denied.promise, /disabled/);
      assert.equal(connections.length, 2); assert.equal(saves, 1);
      set('ui.interact', 'ask'); set('vault.write', 'ask');
      const draft = await begin('create');
      assert.equal(document.querySelectorAll('[role="dialog"]').length, 1);
      assert.ok(button('Save Host')); await click(button('Cancel'));
      assert.deepEqual(await draft.promise, { cancelled: true });
      set('vault.write', 'allow'); set('vault.metadata', 'ask');
      const selection = await begin('select'); await chooseGroup();
      assert.ok('hosts' in await selection.promise);
      assert.equal(document.querySelector('[role="dialog"]'), null);
      set('vault.metadata', 'allow');
    });

    await t.test('runtime removal rejects old signed replies', async () => {
      const run = await begin('create');
      const old = prompts.at(-1)!;
      await act(async () => { await service.manager.setEnabled('com.netcatty.host-actions', false); await settle(); });
      await assert.rejects(run.promise);
      assert.equal(await service.interactionService.respond(sender, { requestId: old.requestId, actionToken: old.actionToken, action: 'submit', draft: { hostname: 'late.invalid' } }), false);
      assert.equal(saves, 1); assert.equal(connections.length, 2);
    });
  } finally {
    await act(async () => { root.unmount(); await settle(); });
    await service.manager.shutdown();
    runtime.registerAppVaultRuntime(null); runtime.registerAppAppLockRuntime(null); registerAppHandlers(null);
    dom.window.close(); await rm(directory, { recursive: true, force: true });
    for (const [key, descriptor] of previous) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); }
  }
});
