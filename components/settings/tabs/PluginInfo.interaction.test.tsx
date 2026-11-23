import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';

test('information previews on hover/focus, pins on click and Escape returns focus without closing the manager', async () => {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { pretendToBeVisual: true, url: 'http://localhost' });
  const previous = new Map<string, PropertyDescriptor | undefined>();
  const install = (key: string, value: unknown) => {
    previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  };
  for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'HTMLInputElement', 'Element', 'Node', 'NodeFilter', 'MutationObserver', 'CustomEvent', 'Event', 'KeyboardEvent', 'MouseEvent']) {
    install(key, key === 'window' ? dom.window : dom.window[key as keyof typeof dom.window]);
  }
  install('getComputedStyle', dom.window.getComputedStyle.bind(dom.window));
  install('requestAnimationFrame', dom.window.requestAnimationFrame.bind(dom.window));
  install('cancelAnimationFrame', dom.window.cancelAnimationFrame.bind(dom.window));
  install('IS_REACT_ACT_ENVIRONMENT', true);
  const { default: React, act, useState } = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { PluginInfo } = await import('./PluginInfo');
  const { PluginManagementDialog } = await import('./PluginManagementDialog');
  const { I18nProvider } = await import('../../../application/i18n/I18nProvider');
  const root = createRoot(document.getElementById('root')!);
  const settle = (ms = 60) => new Promise((resolve) => setTimeout(resolve, ms));
  try {
    await act(async () => root.render(<I18nProvider locale="en"><PluginManagementDialog><PluginInfo label="Plugin help">Packages remain disabled until reviewed.</PluginInfo><button data-other>Other control</button></PluginManagementDialog></I18nProvider>));
    await act(async () => { document.querySelector<HTMLButtonElement>('button')!.click(); await settle(); });
    const trigger = document.querySelector<HTMLButtonElement>('button[aria-label="Plugin help"]')!;
    const other = document.querySelector<HTMLButtonElement>('[data-other]')!;
    assert.ok(trigger); assert.equal(trigger.getAttribute('title'), null, 'not a native title-only hint');
    await act(async () => { other.focus(); await settle(); });
    const hover = new MouseEvent('pointermove', { bubbles: true });
    Object.defineProperty(hover, 'pointerType', { value: 'mouse' });
    await act(async () => { trigger.dispatchEvent(hover); await settle(260); });
    assert.match(document.querySelector('[role="tooltip"]')?.textContent ?? '', /Packages remain disabled/);
    await act(async () => { trigger.focus(); await settle(); });
    assert.ok(document.querySelector('[role="tooltip"]'));
    await act(async () => { trigger.click(); await settle(); });
    const pinned = document.querySelector<HTMLElement>('[role="dialog"][aria-label="Plugin help"]');
    assert.ok(pinned, 'click exposes a persistent readable popover');
    assert.equal(document.querySelector('[role="tooltip"]'), null);
    await act(async () => { pinned.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })); await settle(); });
    assert.equal(document.querySelector('[role="dialog"][aria-label="Plugin help"]'), null);
    assert.equal(document.querySelectorAll('[role="dialog"]').length, 1, 'Escape closes only the information layer');
    assert.equal(document.activeElement, trigger);
    assert.equal(Boolean(document.querySelector('[role="tooltip"]')), false, 'Escape does not immediately reopen the focus preview');
    await act(async () => { other.focus(); trigger.focus(); await settle(); });
    assert.ok(document.querySelector('[role="tooltip"]'), 'a subsequent deliberate focus still previews help');

    const { PluginMarketplaceContent } = await import('./PluginMarketplace');
    const entry = { id: 'com.example.guide', name: 'Guide', author: 'Example', version: '1.0.0', license: 'MIT', repository: 'example/plugin', commit: 'a'.repeat(40), description: 'Synthetic metadata',
      manifest: { id: 'com.example.guide', name: 'Guide', publisher: 'Example', main: { browser: 'index.js' }, engines: { netcatty: '*', api: '0.1.0-internal' } },
    } as NetcattyPluginCatalogEntry;
    const catalog = { entries: [entry], source: 'registry', sourceBinding: null, listStatus: 'ready', listError: null, readmeImages: {}, readme: '# Guide', readmeStatus: 'ready', readmeError: null, error: null, busy: false, retryList() {}, retryReadme() {}, async install() {} } as ReturnType<typeof import('../../../application/state/usePluginCatalog').usePluginCatalog>;
    function Browser() {
      const [selected, setSelected] = useState<string | null>(null);
      const [toolbar, setToolbar] = useState<HTMLDivElement | null>(null);
      return <I18nProvider locale="en"><div data-toolbar ref={setToolbar} /><div data-settings-scroll-pane><PluginMarketplaceContent catalog={catalog} installed={[]} selected={selected} onSelect={setSelected} toolbarContainer={toolbar} /></div></I18nProvider>;
    }
    await act(async () => { root.render(<Browser />); await settle(); });
    const pane = document.querySelector<HTMLElement>('[data-settings-scroll-pane]')!;
    assert.match(document.querySelector('[data-toolbar]')?.textContent ?? '', /Refresh/);
    pane.scrollTop = 450;
    await act(async () => { document.querySelector<HTMLButtonElement>('[data-plugin-id]')!.click(); await settle(); });
    assert.equal(document.querySelector('.plugin-marketplace-catalog'), null, 'detail replaces the candidate list');
    assert.doesNotMatch(document.querySelector('[data-toolbar]')?.textContent ?? '', /Refresh/, 'list refresh stays out of detail');
    assert.equal(pane.scrollTop, 0);
    assert.equal(document.activeElement?.tagName, 'H4');
    assert.equal(document.activeElement?.textContent, 'Guide');
    const back = Array.from(document.querySelectorAll('button')).find((button) => button.textContent?.includes('All plugins'))!;
    await act(async () => { back.click(); await settle(); });
    assert.equal(pane.scrollTop, 450);
    assert.equal(document.activeElement?.getAttribute('data-plugin-id'), entry.id);
    assert.match(document.querySelector('[data-toolbar]')?.textContent ?? '', /Refresh/);

    const { PluginStatus } = await import('./PluginStatus');
    function StatusHarness() {
      const [offline, setOffline] = useState(true);
      const [noVault, setNoVault] = useState(true);
      return <I18nProvider locale="en"><PluginStatus noVault={noVault} offlineError={offline ? 'Network unavailable' : null} retry={() => setOffline(false)} /><button onClick={() => setNoVault(false)}>Restore vault</button></I18nProvider>;
    }
    await act(async () => { root.render(<StatusHarness />); await settle(); });
    const status = document.querySelector<HTMLButtonElement>('button[aria-label$="Notices: 2"]')!;
    await act(async () => { status.focus(); await settle(); });
    assert.match(document.querySelector('[role="tooltip"]')?.textContent ?? '', /Network unavailable/);
    assert.equal(document.querySelector('[role="tooltip"] button'), null, 'hover preview never contains an interactive Retry');
    await act(async () => { status.click(); await settle(); });
    const retry = document.querySelector<HTMLButtonElement>('[role="dialog"] button')!;
    assert.equal(retry.textContent, 'Retry');
    assert.equal(status.textContent, '2', 'only the number badge is visible, not a second text label');
    assert.equal(document.querySelectorAll('button[aria-label*="Notices:"]').length, 1);
    assert.match(document.querySelector('[role="dialog"]')?.textContent ?? '', /Updates are manual/);
    assert.ok(document.querySelector('[role="dialog"] hr'));
    await act(async () => { retry.click(); await settle(); });
    assert.ok(document.querySelector('button[aria-label$="Notices: 1"]'));
    assert.doesNotMatch(document.querySelector('[role="dialog"]')?.textContent ?? '', /Network unavailable/);
    await act(async () => { document.querySelector('[role="dialog"]')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })); await settle(); });
    assert.match(document.activeElement?.getAttribute('aria-label') ?? '', /Notices: 1$/);
    await act(async () => { Array.from(document.querySelectorAll('button')).find((button) => button.textContent === 'Restore vault')!.click(); await settle(); });
    const healthy = document.querySelector<HTMLButtonElement>('button[aria-label="Plugin information"]')!;
    assert.ok(healthy, 'one information control remains when healthy');
    assert.equal(healthy.querySelector('span[aria-hidden="true"]'), null, 'healthy control has no count badge');
    await act(async () => { healthy.click(); await settle(); });
    assert.match(document.querySelector('[role="dialog"]')?.textContent ?? '', /Updates are manual/);
    await act(async () => { document.querySelector('[role="dialog"]')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })); await settle(); });
    const thirdParty: NetcattyPluginSource = { id: 'third-party:synthetic', kind: 'third-party', name: 'Independent source', origin: 'https://example.com' };
    await act(async () => { root.render(<I18nProvider locale="en"><PluginMarketplaceContent marketSource={thirdParty} catalog={{ ...catalog, entries: [], listError: 'ECONNREFUSED', source: 'cached' }} installed={[]} selected={null} onSelect={() => {}} /></I18nProvider>); await settle(); });
    const thirdStatus = document.querySelector<HTMLButtonElement>('button[aria-label$="Notices: 1"]')!;
    await act(async () => { thirdStatus.focus(); await settle(); });
    const thirdPreview = document.querySelector('[role="tooltip"]')?.textContent ?? '';
    assert.match(thirdPreview, /provided by the selected third party/);
    assert.match(thirdPreview, /If a previously validated catalog exists for this source/);
    assert.doesNotMatch(thirdPreview, /bundled examples|Curated open-source|First-party/);
    assert.equal(document.querySelector('[role="tooltip"] button'), null);
    await act(async () => { thirdStatus.click(); await settle(); });
    assert.match(document.querySelector('[role="dialog"]')?.textContent ?? '', /ECONNREFUSED/);
    assert.match(document.querySelector('[role="dialog"]')?.textContent ?? '', /Retry/);
    assert.doesNotMatch(document.querySelector('[role="dialog"]')?.textContent ?? '', /bundled examples|Curated open-source/);
    await act(async () => { document.querySelector('[role="dialog"]')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })); await settle(); });
    await act(async () => { root.render(<I18nProvider locale="en"><PluginMarketplaceContent marketSource={thirdParty} catalog={catalog} installed={[]} selected={entry.id} onSelect={() => {}} /></I18nProvider>); await settle(); });
    const sourceInfo = document.querySelector<HTMLButtonElement>('button[aria-label="Source example"]')!;
    await act(async () => { sourceInfo.click(); await settle(); });
    assert.match(document.querySelector('[role="dialog"]')?.textContent ?? '', /Source-only entry from this provider/);
    assert.doesNotMatch(document.querySelector('[role="dialog"]')?.textContent ?? '', /First-party/);
    await act(async () => { document.querySelector('[role="dialog"]')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })); await settle(); });
  } finally {
    await act(async () => { root.unmount(); await settle(); });
    dom.window.close();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key);
    }
  }
});
