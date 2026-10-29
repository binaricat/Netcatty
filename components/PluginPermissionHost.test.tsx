import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import { JSDOM } from 'jsdom';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

// Test-only observer preserves the security-surface visibility assertions.
function observePluginHostSecurityVisibility(mount: HTMLElement, publish: (visible: boolean) => void): () => void {
  const document = mount.ownerDocument;
  let visible = true;
  const update = () => {
    const blocked = [...document.querySelectorAll('[data-host-security-surface]')].some((surface) => {
      const style = document.defaultView!.getComputedStyle(surface);
      return style.display !== 'none' && style.visibility !== 'hidden'
        && !surface.closest('[hidden], [inert], [aria-hidden="true"]');
    });
    if (visible === !blocked) return;
    visible = !blocked;
    publish(visible);
  };
  const observer = new document.defaultView!.MutationObserver(update);
  observer.observe(document.body, { childList: true, subtree: true, attributes: true,
    attributeFilter: ['class', 'style', 'hidden', 'inert', 'aria-hidden', 'data-host-security-surface'] });
  update();
  return () => observer.disconnect();
}

test('registered Ask uses one in-app dialog; policy controls apply Allow and Deny with no hidden prompt', async () => {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { pretendToBeVisual: true, url: 'http://localhost' });
  const previous = new Map<string, PropertyDescriptor | undefined>();
  const install = (key: string, value: unknown) => {
    previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  };
  for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'HTMLInputElement', 'Element', 'Node', 'NodeFilter', 'MutationObserver', 'CustomEvent', 'Event', 'KeyboardEvent', 'MouseEvent', 'DocumentFragment']) {
    install(key, key === 'window' ? dom.window : dom.window[key as keyof typeof dom.window]);
  }
  install('getComputedStyle', dom.window.getComputedStyle.bind(dom.window));
  install('requestAnimationFrame', dom.window.requestAnimationFrame.bind(dom.window));
  install('cancelAnimationFrame', dom.window.cancelAnimationFrame.bind(dom.window));
  install('IS_REACT_ACT_ENVIRONMENT', true);
  dom.window.HTMLElement.prototype.scrollIntoView = () => {};
  const { default: React, act } = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { I18nProvider } = await import('../application/i18n/I18nProvider');
  const { PluginPermissionHost } = await import('./plugins/PluginPermissionHost');
  const { PluginPermissionPanel } = await import('./settings/tabs/PluginPermissionPanel');
  const { PluginPermissionDecisionHost } = require('../electron/plugins/permissionDecisionHost.cjs');
  const { PluginPermissionEngine } = require('../electron/plugins/permissionEngine.cjs');
  const { PluginHostRpcRegistry } = require('../electron/plugins/hostRpcRegistry.cjs');
  const listeners = new Set<(event: unknown) => void>();
  const sender = Object.assign(new EventEmitter(), { isDestroyed: () => false, send: (_channel: string, event: unknown) => { for (const listener of listeners) listener(event); } });
  const owner = Object.assign(new EventEmitter(), { webContents: sender, isDestroyed: () => false, isFocused: () => true, isVisible: () => true });
  const host = new PluginPermissionDecisionHost({ getWindow: () => owner, isLocked: () => false });
  let mode = 'allow', effects = 0;
  const plugin = { id: 'com.example.permission-ui', activeVersion: '1.0.0', manifest: { id: 'com.example.permission-ui', publisher: 'example', permissions: { optional: [{ permission: 'network', resources: ['https://example.com'] }] } } };
  const engine = new PluginPermissionEngine({ database: { getPermissionMode: () => mode, privateOwner: () => 'synthetic-source-owner',
    setPermissionMode: (_id: string, _permission: string, value: string) => { mode = value; }, recordSecurityAudit() {}, deleteAllPermissionGrants() {}, listPermissionGrants: () => [] },
    requestDecision: (...args: unknown[]) => host.request(...args) });
  const registry = new PluginHostRpcRegistry(); registry.use(engine.createMiddleware());
  registry.registerRequest('network.fixture', async () => { effects++; return 'synthetic result'; }, { authorization: { permission: 'network', resources: ['https://example.com'] } });
  const route = registry.createRoutes({ pluginId: plugin.id, pluginVersion: '1.0.0', runtimeId: 'runtime-ui', runtimeKind: 'browser', manifest: plugin.manifest }).requestHandlers['network.fixture'];
  Object.assign(dom.window, { netcatty: {
    onPluginPermission(callback: (event: unknown) => void) { listeners.add(callback); return () => listeners.delete(callback); },
    setPluginPermissionReady: async (ready: boolean) => host.setReady(sender, ready),
    respondPluginPermission: async (response: unknown) => host.respond(sender, response),
    getPluginPermissions: async () => ({ grants: [], audit: [], policies: engine.describePolicies(plugin), policyRevision: engine.getPolicyRevision(plugin) }),
    setPluginPermissionMode: async (_id: string, permission: string, value: string, revision: string) => {
      assert.equal(revision, engine.getPolicyRevision(plugin)); engine.setMode(plugin, permission, value); return true;
    },
  } });
  const root = createRoot(document.getElementById('root')!);
  const nativeMount = document.createElement('div'); document.body.append(nativeMount);
  const nativeVisibility: boolean[] = [];
  const stopVisibility = observePluginHostSecurityVisibility(nativeMount, (visible) => nativeVisibility.push(visible));
  const settle = () => new Promise((resolve) => setTimeout(resolve, 20));
  const button = (text: string) => Array.from(document.querySelectorAll<HTMLButtonElement>('button')).find((element) => element.textContent === text)!;
  const choose = async (text: string) => {
    await act(async () => { document.querySelector('[role="combobox"]')!.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })); await settle(); });
    const option = Array.from(document.querySelectorAll<HTMLElement>('[role="option"]')).find((element) => element.textContent === text)!;
    assert.ok(option);
    await act(async () => { option.click(); await settle(); });
  };
  try {
    await act(async () => root.render(<I18nProvider locale="en"><PluginPermissionPanel pluginId={plugin.id} onChanged={async () => {}} /><PluginPermissionHost /></I18nProvider>));
    await route({}, {}); assert.equal(effects, 1); assert.equal(document.querySelector('[role="dialog"]'), null);
    await choose('Ask'); assert.equal(mode, 'ask');
    let operation!: Promise<string>;
    await act(async () => { operation = route({}, {}); await settle(); });
    assert.equal(document.querySelectorAll('[role="dialog"]').length, 1);
    assert.ok(document.querySelector('[role="dialog"][data-host-security-surface]'));
    assert.equal(nativeVisibility.at(-1), false, 'the existing native-view lifecycle must yield to the trusted Ask');
    assert.match(document.querySelector('[role="dialog"]')!.textContent!, /https:\/\/example.com/);
    assert.equal(effects, 1);
    await act(async () => { button('Allow this operation').click(); await operation; await settle(); });
    assert.equal(effects, 2); assert.equal(document.querySelector('[role="dialog"]'), null);
    await new Promise<void>((resolve) => dom.window.queueMicrotask(resolve));
    assert.equal(nativeVisibility.at(-1), false, 'visible permission settings remain a security surface after Ask closes');
    await choose('Deny'); assert.equal(mode, 'deny');
    await assert.rejects(route({}, {}), /disabled/); assert.equal(effects, 2); assert.equal(document.querySelector('[role="dialog"]'), null);
    await choose('Allow'); assert.equal(mode, 'allow');
    await route({}, {}); assert.equal(effects, 3); assert.equal(document.querySelector('[role="dialog"]'), null);
    // Model the settings editor closing before interacting with a native view.
    document.querySelector('section[data-host-security-surface]')!.setAttribute('hidden', '');
    await new Promise<void>((resolve) => dom.window.queueMicrotask(resolve));
    assert.equal(nativeVisibility.at(-1), true);
    let displayed!: Promise<unknown>;
    const opaque = 'selected:0cfc16d6-3448-4333-82ef-dd4ffbddfdab:v1';
    await act(async () => {
      displayed = host.request({ requestId: 'host-display-fixture', pluginId: plugin.id, permission: 'ai.invoke', resources: ['*'], reason: 'Host model invocation',
        relatedPermissions: [{ permission: 'context.selected.read', resources: [opaque] }],
        displayContext: { modelLabel: 'QA fixture · deterministic-fixture', selections: [{ title: 'Synthetic retry plan', scope: 'note', version: 'bf304994-039a-4884-a707-3a1a40a5d3a9' }] },
      }); await settle();
    });
    const text = document.querySelector('[role="dialog"]')!.textContent!;
    assert.equal(nativeVisibility.at(-1), false, 'Ask alone must hide the attached plugin view');
    assert.match(text, /QA fixture · deterministic-fixture/); assert.match(text, /Synthetic retry plan/);
    assert.doesNotMatch(text, /selected:|0cfc16d6|bf304994/);
    await act(async () => { button('Deny').click(); await displayed; await settle(); });
    await new Promise<void>((resolve) => dom.window.queueMicrotask(resolve));
    assert.equal(nativeVisibility.at(-1), true, 'dismissing Ask restores the existing view without closing it');
    for (const selections of [[], [{ title: 'Synthetic terminal B', scope: 'session', version: 'opaque-worker-revision' }]]) {
      await act(async () => {
        displayed = host.request({ requestId: 'agent-empty-args', pluginId: plugin.id, permission: 'ai.agent.actions', resources: ['*'],
          displayContext: { modelLabel: 'Synthetic configured Catty', action: { capabilityId: 'session.environment', text: '{}', label: 'PLUGIN_SUPPLIED_OPERATION_NAME' }, selections },
        }); await settle();
      });
      const dialog = document.querySelector('[role="dialog"]')!;
      assert.match(dialog.textContent!, /Operation:.*get_environment/);
      assert.match(dialog.textContent!, /session\.environment/);
      assert.equal(dialog.querySelector('pre')!.textContent, '{}');
      if (selections.length) assert.match(dialog.textContent!, /Targets:.*Synthetic terminal B/);
      else assert.match(dialog.textContent!, /Targets:.*No targets selected/);
      assert.doesNotMatch(dialog.textContent!, /opaque-worker-revision|PLUGIN_SUPPLIED_OPERATION_NAME/);
      await act(async () => { button('Deny').click(); await displayed; await settle(); });
    }
  } finally {
    await act(async () => root.unmount()); stopVisibility(); host.shutdown(); engine.shutdown(); dom.window.close();
    for (const [key, descriptor] of previous) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); }
  }
});
