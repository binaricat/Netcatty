import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';

test('permission panel refreshes real grants, revokes once, and keeps stale reads from replacing new results', async () => {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { pretendToBeVisual: true, url: 'http://localhost' });
  const previous = new Map<string, PropertyDescriptor | undefined>();
  const install = (key: string, value: unknown) => {
    previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  };
  for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'Element', 'Node', 'Event', 'MouseEvent']) {
    install(key, key === 'window' ? dom.window : dom.window[key as keyof typeof dom.window]);
  }
  install('IS_REACT_ACT_ENVIRONMENT', true);
  const { default: React, act } = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { I18nProvider } = await import('../../../application/i18n/I18nProvider');
  const { PluginPermissionPanel } = await import('./PluginPermissionPanel');
  const root = createRoot(document.getElementById('root')!);
  const initial = {
    grants: [{ permission: 'network', resource: 'https://synthetic.invalid/<text>', resourceKind: 'exact', scope: 'always' as const, sessionId: null, grantedAt: 1, matchesCurrentActivation: false }],
    audit: [{ event: 'permission.used', createdAt: 2, permission: 'network' }],
  };
  let reads = 0;
  let revokes = 0;
  let changed = 0;
  let staleRead: (value: typeof initial) => void = () => {};
  let releaseRevoke: () => void = () => {};
  const revokePending = new Promise<void>((resolve) => { releaseRevoke = resolve; });
  Object.assign(dom.window, { netcatty: {
    async getPluginPermissions(id: string) {
      assert.equal(id, 'com.example.synthetic');
      reads++;
      if (reads === 2) return new Promise<typeof initial>((resolve) => { staleRead = resolve; });
      return reads > 2 ? { grants: [], audit: [] } : initial;
    },
    async revokePluginPermissions(id: string) { assert.equal(id, 'com.example.synthetic'); revokes++; await revokePending; },
  } });
  const button = (text: string) => Array.from(document.querySelectorAll<HTMLButtonElement>('button')).find((item) => item.textContent === text)!;
  try {
    await act(async () => root.render(<I18nProvider locale="en"><PluginPermissionPanel pluginId="com.example.synthetic" onChanged={async () => { changed++; }} /></I18nProvider>));
    assert.match(document.body.textContent!, /synthetic.invalid/);
    assert.equal(document.querySelector('text'), null, 'resource is rendered as plain text');
    assert.match(document.body.textContent!, /Until revoked/);
    assert.match(document.body.textContent!, /Inactive for the current activation/);
    await act(async () => { button('Refresh').click(); });
    await act(async () => {
      button('Disable and revoke all grants').click();
      button('Disable and revoke all grants').click();
    });
    assert.equal(revokes, 1);
    assert.equal(button('Refresh').disabled, true);
    await act(async () => { releaseRevoke(); });
    assert.equal(changed, 1);
    assert.match(document.body.textContent!, /No saved grants/);
    await act(async () => { staleRead(initial); });
    assert.doesNotMatch(document.body.textContent!, /synthetic.invalid/);
    Object.assign(dom.window, { netcatty: { async getPluginPermissions() { throw new Error('synthetic read failed'); } } });
    await act(async () => { button('Refresh').click(); });
    assert.match(document.querySelector('[role="alert"]')?.textContent ?? '', /synthetic read failed/);
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});

test('partial revocation failure refreshes actual manager and engine state without clearing the original error', async () => {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { pretendToBeVisual: true, url: 'http://localhost' });
  const previous = new Map<string, PropertyDescriptor | undefined>();
  for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'Element', 'Node', 'Event', 'MouseEvent', 'IS_REACT_ACT_ENVIRONMENT']) {
    previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value: key === 'window' ? dom.window : key === 'IS_REACT_ACT_ENVIRONMENT' ? true : dom.window[key as keyof typeof dom.window] });
  }
  const { act } = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { I18nProvider } = await import('../../../application/i18n/I18nProvider');
  const { PluginPermissionPanel } = await import('./PluginPermissionPanel');
  const { PluginManager } = await import('../../../electron/plugins/pluginManager.cjs');
  const { PluginPermissionEngine } = await import('../../../electron/plugins/permissionEngine.cjs');
  const { defaultSecurityPrincipal, normalizePermissionDeclarations, permissionDeclarationHash } = await import('../../../electron/plugins/permissionResources.cjs');
  const manifest = { id: 'com.example.synthetic', publisher: 'example', permissions: { optional: ['storage'] } };
  const principal = defaultSecurityPrincipal(manifest);
  const grant = { pluginId: manifest.id, permission: 'storage', resource: '*', resourceKind: 'exact', grantedAt: 1,
    declarationHash: permissionDeclarationHash(normalizePermissionDeclarations(manifest).get('storage'), principal) };
  let enabled = true, running = true, stopped = false, readFails = false;
  let grants = [grant];
  let reads = 0, changed = 0;
  const database = {
    getActivePlugin: () => ({ id: manifest.id, enabled, manifest }),
    listPlugins: () => [{ id: manifest.id, enabled, manifest }],
    setEnabled(_id: string, value: boolean) { enabled = value; },
    listPermissionGrants: () => grants,
    deleteAllPermissionGrants() { grants = []; },
    recordSecurityAudit() { throw new Error('synthetic audit write failed'); },
  };
  const engine = new PluginPermissionEngine({ database });
  const manager = new PluginManager({ database, permissionEngine: engine,
    packageStore: { async initialize() {} },
    contributionService: { async initialize() {}, onPluginDisabled() {} },
    runtimeSupervisor: { async stop() { running = false; stopped = true; } },
  });
  Object.assign(dom.window, { netcatty: {
    async getPluginPermissions() {
      reads++;
      if (readFails) throw new Error('synthetic grants refresh failed');
      const groups = engine.describeGrants(manifest.id, running ? { pluginId: manifest.id, manifest, securityPrincipal: principal } : null);
      return { grants: groups.always, audit: [] };
    },
    async revokePluginPermissions(id: string) { return manager.revokePermissions(id); },
  } });
  const root = createRoot(document.getElementById('root')!);
  const refreshManager = async () => { changed++; assert.equal((await manager.list())[0].enabled, false); };
  const revoke = () => Array.from(document.querySelectorAll<HTMLButtonElement>('button')).find((item) => item.textContent === 'Disable and revoke all grants')!;
  try {
    await act(async () => root.render(<I18nProvider locale="en"><PluginPermissionPanel key="first" pluginId={manifest.id} onChanged={refreshManager} /></I18nProvider>));
    assert.match(document.body.textContent!, /Matches the current activation/);
    await act(async () => { revoke().click(); });
    assert.equal(enabled, false); assert.equal(stopped, true);
    assert.equal(changed, 1); assert.equal(reads, 2);
    assert.match(document.querySelector('[role="alert"]')?.textContent ?? '', /synthetic audit write failed/);
    assert.match(document.body.textContent!, /No saved grants/);
    assert.doesNotMatch(document.body.textContent!, /Matches the current activation/);
    // A failed state read must also remove the old grant snapshot while
    // retaining the mutation error and reporting the refresh failure.
    enabled = true; running = true; stopped = false; grants = [grant];
    await act(async () => root.render(<I18nProvider locale="en"><PluginPermissionPanel key="second" pluginId={manifest.id} onChanged={async () => { await refreshManager(); readFails = true; throw new Error('synthetic manager refresh failed'); }} /></I18nProvider>));
    assert.match(document.body.textContent!, /Matches the current activation/);
    await act(async () => { revoke().click(); });
    assert.equal(enabled, false); assert.equal(stopped, true);
    assert.equal(changed, 2); assert.equal(reads, 4);
    const error = document.querySelector('[role="alert"]')?.textContent ?? '';
    assert.match(error, /synthetic audit write failed/);
    assert.match(error, /synthetic manager refresh failed/);
    assert.match(error, /synthetic grants refresh failed/);
    assert.doesNotMatch(document.body.textContent!, /Matches the current activation/);
  } finally {
    await act(async () => root.unmount()); engine.shutdown(); dom.window.close();
    for (const [key, descriptor] of previous) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); }
  }
});
