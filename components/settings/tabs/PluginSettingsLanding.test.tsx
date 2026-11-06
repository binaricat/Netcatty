import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';

// Uses the real settings primitives and verifies that the host manager owns state.
test('landing rows expose real sources/status/settings and quick toggles preserve host decisions', async () => {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { pretendToBeVisual: true, url: 'http://localhost' });
  const previous = new Map<string, PropertyDescriptor | undefined>();
  const install = (key: string, value: unknown) => {
    previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  };
  for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'Element', 'Node', 'Event', 'MouseEvent']) install(key, key === 'window' ? dom.window : dom.window[key as keyof typeof dom.window]);
  install('IS_REACT_ACT_ENVIRONMENT', true);
  const { default: React, act } = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { I18nProvider } = await import('../../../application/i18n/I18nProvider');
  const { PluginSettingsLanding } = await import('./PluginSettingsLanding');
  const root = createRoot(document.getElementById('root')!);
  const plugins = [{
    id: 'com.example.alpha', enabled: true, activeVersion: '1.0.0',
    source: { id: 'official', kind: 'official', name: 'Official source', origin: 'https://plugins.example.com' },
    manifest: { manifestVersion: 1, id: 'com.example.alpha', name: 'Alpha', version: '1.0.0', publisher: 'example', engines: { netcatty: '>=0.0.0', api: '>=0.1.0-internal <0.2.0' }, main: { browser: 'index.js' }, description: 'Synthetic description', contributes: { settings: [{ id: 'com.example.alpha.value', label: 'Value', control: 'text', scope: 'application' }] } },
    runtime: { status: 'running', kind: 'browser', lastError: null, quarantinedAt: null },
  }, {
    id: 'com.example.beta', enabled: false, activeVersion: '2.0.0',
    source: { id: 'third-party:synthetic', kind: 'third-party', name: 'Synthetic source', origin: 'https://synthetic.example.com' },
    manifest: { manifestVersion: 1, id: 'com.example.beta', name: 'Beta', version: '2.0.0', publisher: 'example', engines: { netcatty: '>=0.0.0', api: '>=0.1.0-internal <0.2.0' }, main: { browser: 'index.js' } },
    runtime: { status: 'stopped', kind: null, lastError: null, quarantinedAt: null },
  }] as NetcattyInstalledPlugin[];
  const changes: Array<[string, boolean]> = [];
  const opened: Array<string | null> = [];
  let refreshes = 0;
  const manager = { plugins, available: true, statusKnown: true, busy: false, error: null as string | null, credentialStorageAvailable: true,
    async refresh() { refreshes++; }, async setEnabled(id: string, enabled: boolean) { changes.push([id, enabled]); }, async importPackage() {}, async uninstall() {} };
  Object.assign(dom.window, { netcatty: { async getPluginLogStatus() { return { saveToDisk: false, verbose: false, droppedRecords: 0, writeErrors: 0, pendingBytes: 0, maxBytes: 3145728, retentionDays: 7 }; } } });
  const render = async (value = manager, settingsAvailable = new Set(['com.example.alpha'])) => act(async () => root.render(<I18nProvider locale="en"><PluginSettingsLanding manager={value} settingsAvailable={settingsAvailable} onManage={(id) => opened.push(id)} /></I18nProvider>));
  const button = (label: string) => [...document.querySelectorAll<HTMLButtonElement>('button')].find((item) => item.textContent === label)!;
  const byLabel = (label: string) => document.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!;
  try {
    await render();
    assert.equal(document.querySelector('[role=dialog]'), null);
    assert.equal(document.querySelector('input[type=checkbox]'), null);
    assert.equal(document.querySelectorAll('[role=switch]').length, 2, 'only real plugin toggles appear on landing');
    const installedSection = () => document.querySelectorAll('section')[1];
    assert.doesNotMatch(installedSection().textContent!, /Running|Disabled|Source:/);
    const sourceRows = [...document.querySelectorAll('[data-plugin-author-row]')];
    assert.equal(sourceRows[0].querySelector('[data-plugin-source]')?.textContent, 'Official');
    const content = sourceRows[0].parentElement!;
    assert.ok(content.classList.contains('gap-1'), 'title, metadata and description have 4px vertical gaps');
    assert.ok(content.classList.contains('flex-col'));
    assert.ok(content.classList.contains('min-w-0'));
    assert.equal(content.firstElementChild?.querySelector('[title="Alpha"]')?.textContent, 'Alpha');
    assert.ok(content.firstElementChild?.classList.contains('text-sm'), 'title remains 14px');
    assert.equal(content.lastElementChild?.textContent, 'Synthetic description');
    assert.ok(content.classList.contains('text-xs'), 'metadata and description remain 12px');
    assert.ok(!content.parentElement?.classList.contains('mt-0.5'), 'shared SettingRow margin does not compress the local stack');
    const thirdParty = sourceRows[1].querySelector<HTMLElement>('[data-plugin-source]')!;
    assert.equal(thirdParty.textContent, 'Third-party');
    assert.match(thirdParty.title, /Synthetic source.*synthetic\.example\.com/);
    assert.equal(thirdParty.getAttribute('aria-label'), thirdParty.title);
    assert.doesNotMatch(document.body.textContent!, /Save host audit logs locally|trust all|safe mode|telemetry/i);
    await act(async () => button('Browse').click());
    await act(async () => byLabel('Settings for Alpha').click());
    assert.deepEqual(opened, [null, 'com.example.alpha']);
    await act(async () => byLabel('Disable Alpha').click());
    assert.deepEqual(changes, [['com.example.alpha', false]]);
    assert.equal(byLabel('Disable Alpha').getAttribute('aria-checked'), 'true', 'no optimistic flip before host approval');
    await render({ ...manager, error: 'Synthetic permission denied' });
    assert.match(document.querySelector('[role=alert]')!.textContent!, /Synthetic permission denied/);
    assert.equal(byLabel('Disable Alpha').getAttribute('aria-checked'), 'true');
    await act(async () => byLabel('Refresh installed plugins').click());
    assert.equal(refreshes, 1);
    await render({ ...manager, statusKnown: false });
    assert.equal(byLabel('Disable Alpha').disabled, true);
    await act(async () => byLabel('Disable Alpha').click());
    assert.equal(changes.length, 1);
    await render(manager, new Set());
    assert.equal(byLabel('Settings for Alpha').disabled, true, 'unavailable settings cannot open an empty destination');
    for (const [status, label] of [['starting', 'Starting'], ['stopping', 'Stopping'], ['error', 'Error'], ['quarantined', 'Quarantined'], ['unexpected', 'Status unknown']]) {
      await render({ ...manager, plugins: [{ ...plugins[0], runtime: { ...plugins[0].runtime, status } }] });
      assert.ok([...document.querySelectorAll('[role=status]')].some((item) => item.textContent === label), `${status} remains visible`);
    }
    for (const enabled of [true, false]) {
      await render({ ...manager, plugins: [{ ...plugins[0], enabled, runtime: { ...plugins[0].runtime, status: 'stopped' } }] });
      assert.equal(installedSection().querySelectorAll('[role=status]').length, 0, 'normal stopped/idle state is conveyed by the toggle');
      assert.doesNotMatch(installedSection().textContent!, /Enabled, idle|Disabled|Stopped/);
    }
    await render({ ...manager, plugins: [] });
    assert.match(document.body.textContent!, /No plugins installed/);
    await render({ ...manager, plugins: [], statusKnown: false });
    assert.match(document.body.textContent!, /Loading/);
    await render({ ...manager, plugins: [], available: false });
    assert.match(document.body.textContent!, /unavailable in this session/);
    await render({ ...manager, plugins: [{ ...plugins[0], source: undefined }] });
    assert.match(document.body.textContent!, /Source unknown/);
    assert.doesNotMatch(document.body.textContent!, /Source: Local/);
  } finally {
    await act(async () => root.unmount()); dom.window.close();
    for (const [key, descriptor] of previous) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); }
  }
});
