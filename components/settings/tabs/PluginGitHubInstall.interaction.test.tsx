import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';

for (const locale of ['en', 'es', 'ru', 'zh-CN', 'zh-TW']) test(`real dialog (${locale}) reviews permissions and requires fresh trust after failed installation for same-package retries and different repositories`, async () => {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { pretendToBeVisual: true, url: 'http://localhost' });
  const previous = new Map<string, PropertyDescriptor | undefined>();
  const install = (key: string, value: unknown) => {
    previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  };
  for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'HTMLInputElement', 'Element', 'Node', 'NodeFilter', 'MutationObserver', 'CustomEvent', 'Event', 'KeyboardEvent', 'MouseEvent']) install(key, key === 'window' ? dom.window : dom.window[key as keyof typeof dom.window]);
  install('getComputedStyle', dom.window.getComputedStyle.bind(dom.window));
  install('requestAnimationFrame', dom.window.requestAnimationFrame.bind(dom.window));
  install('cancelAnimationFrame', dom.window.cancelAnimationFrame.bind(dom.window));
  install('IS_REACT_ACT_ENVIRONMENT', true);
  const { default: React, act } = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { I18nProvider } = await import('../../../application/i18n/I18nProvider');
  const { loadLocaleMessages, getLoadedLocaleMessages } = await import('../../../application/i18n/messages');
  await loadLocaleMessages(locale);
  const messages = getLoadedLocaleMessages(locale)!;
  const t = (key: string) => messages[key]!;
  const { PluginGitHubInstall } = await import('./PluginGitHubInstall');
  const root = createRoot(document.getElementById('root')!);
  const requests: string[] = [];
  const installed: string[] = [];
  const discarded: string[] = [];
  let refreshed = 0;
  let resolveDownload: ((value: NetcattyGitHubPluginPreview) => void) | undefined;
  Object.defineProperty(window, 'netcatty', { configurable: true, value: {
    prepareGitHubPlugin: async (input: string) => { requests.push(input); if (requests.length === 1) throw new Error('GitHub API rate limit reached. Try again later'); return new Promise<NetcattyGitHubPluginPreview>(resolve => { resolveDownload = resolve; }); },
    installGitHubPlugin: async (token: string) => { installed.push(token); if (installed.length <= 2) throw new Error('GitHub package preview expired. Download and review it again'); return {} as NetcattyInstalledPlugin; },
    discardGitHubPlugin: async (token: string) => { discarded.push(token); },
  } as NetcattyBridge });
  const settle = () => new Promise(resolve => setTimeout(resolve, 20));
  const button = (text: string) => [...document.querySelectorAll<HTMLButtonElement>('button')].find(el => el.textContent === text)!;
  const click = async (el: HTMLElement) => { assert.ok(el); await act(async () => { el.click(); await settle(); }); };
  const type = async (text: string) => {
    await act(async () => {
      const input = document.querySelector<HTMLInputElement>('input:not([type=checkbox])')!;
      Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value')!.set!.call(input, text);
      input.dispatchEvent(new Event('input', { bubbles: true }));
      await settle();
    });
  };
  const preview = { token: 'reviewed-token', source: { id: 'github:fixture', kind: 'github', name: 'owner/repo', origin: 'https://github.com/owner/repo', tag: 'v1.0.0', commit: 'a'.repeat(40) }, assetName: 'plugin.ncpkg', size: 400,
    archiveSha256: 'b'.repeat(64), manifest: { manifestVersion: 1, id: 'com.example.fixture', name: 'fixture', publisher: 'example', version: '1.0.0', engines: { netcatty: '*', api: '*' }, main: { browser: 'index.js' }, permissions: { required: [{ permission: 'network', resources: ['https://example.com'], reason: 'Read only fixture' }] } } } as NetcattyGitHubPluginPreview;
  try {
    await act(async () => root.render(<I18nProvider locale={locale}><PluginGitHubInstall disabled={false} onInstalled={async () => { refreshed++; }} /></I18nProvider>));
    const trigger = button(t('settings.plugins.github.install'));
    await click(trigger);
    assert.equal(document.activeElement?.tagName, 'INPUT');
    assert.ok(button(t('settings.plugins.github.download')).disabled);
    await type('https://evil.com/owner/repo');
    await click(button(t('settings.plugins.github.download')));
    assert.equal(document.querySelector('[role=alert] p')!.textContent, t('settings.plugins.github.error.invalidRepository'));
    assert.equal(requests.length, 0);
    if (locale !== 'en') {
      // The existing error follows provider state without repeating the host call.
      await act(async () => root.render(<I18nProvider locale="en"><PluginGitHubInstall disabled={false} onInstalled={async () => { refreshed++; }} /></I18nProvider>));
      assert.match(document.querySelector('[role=alert]')!.textContent!, /repository only/);
      await act(async () => root.render(<I18nProvider locale={locale}><PluginGitHubInstall disabled={false} onInstalled={async () => { refreshed++; }} /></I18nProvider>));
      assert.equal(document.querySelector('[role=alert] p')!.textContent, t('settings.plugins.github.error.invalidRepository'));
      assert.equal(requests.length, 0);
    }
    await type('github.com/Owner/Repo.git/');
    await click(button(t('settings.plugins.github.download')));
    assert.equal(document.querySelector('[role=alert] p')!.textContent, t('settings.plugins.github.error.rateLimit'));
    assert.deepEqual(requests, ['https://github.com/owner/repo']);
    await click(button(t('settings.plugins.github.download')));
    assert.ok(button(t('settings.plugins.github.download')).disabled);
    assert.equal(document.querySelector('form')?.getAttribute('aria-busy'), 'true');
    assert.equal(document.querySelector<HTMLInputElement>('input')?.disabled, true);
    await act(async () => { resolveDownload!(preview); await settle(); });
    const review = document.querySelector('[data-plugin-github-preview]')!;
    assert.match(review.textContent!, /https:\/\/github.com\/owner\/repo/);
    assert.match(review.textContent!, /v1\.0\.0.*aaaaaaaa/);
    assert.match(review.textContent!, /https:\/\/example.com/);
    assert.ok(button(t('settings.plugins.github.confirm')).disabled);
    await click(document.querySelector('input[type=checkbox]')!);
    assert.equal(button(t('settings.plugins.github.confirm')).disabled, false);
    await click(button(t('settings.plugins.github.confirm')));
    assert.deepEqual(installed, ['reviewed-token']);
    assert.equal(document.querySelector('[role=alert] p')!.textContent, t('settings.plugins.github.error.expired'));
    assert.equal(document.querySelector('[data-plugin-github-preview]'), null);
    assert.equal(refreshed, 0);
    // A retry of the very same archive/repository is a fresh preview too.
    await click(button(t('settings.plugins.github.download')));
    await act(async () => { resolveDownload!({ ...preview, token: 'retry-token' }); await settle(); });
    assert.equal(document.querySelector<HTMLInputElement>('input[type=checkbox]')!.checked, false);
    assert.ok(button(t('settings.plugins.github.confirm')).disabled);
    await click(button(t('settings.plugins.github.confirm')));
    assert.deepEqual(installed, ['reviewed-token']);
    await click(document.querySelector('input[type=checkbox]')!);
    assert.equal(button(t('settings.plugins.github.confirm')).disabled, false);
    await click(button(t('settings.plugins.github.confirm')));
    assert.equal(document.querySelector('[role=alert] p')!.textContent, t('settings.plugins.github.error.expired'));
    await type('another/plugin');
    await click(button(t('settings.plugins.github.download')));
    await act(async () => { resolveDownload!({ ...preview, token: 'different-token', source: { ...preview.source, origin: 'https://github.com/another/plugin', name: 'another/plugin' } }); await settle(); });
    assert.equal(requests.at(-1), 'https://github.com/another/plugin');
    assert.match(document.querySelector('[data-plugin-github-preview]')!.textContent!, /https:\/\/github.com\/another\/plugin/);
    assert.equal(document.querySelector<HTMLInputElement>('input[type=checkbox]')!.checked, false);
    assert.ok(button(t('settings.plugins.github.confirm')).disabled);
    await click(button(t('settings.plugins.github.confirm')));
    assert.deepEqual(installed, ['reviewed-token', 'retry-token']);
    await click(document.querySelector('input[type=checkbox]')!);
    await click(document.querySelector('input[type=checkbox]')!);
    assert.ok(button(t('settings.plugins.github.confirm')).disabled);
    await click(document.querySelector('input[type=checkbox]')!);
    await click(button(t('settings.plugins.github.confirm')));
    assert.deepEqual(installed, ['reviewed-token', 'retry-token', 'different-token']);
    assert.equal(refreshed, 1);
    assert.equal(document.querySelector('[role=dialog]'), null);
    await click(trigger);
    assert.equal(document.querySelector('[data-plugin-github-preview]'), null);
    assert.equal(document.querySelector<HTMLInputElement>('input')?.value, '');
    await type('owner/repo');
    await click(button(t('settings.plugins.github.download')));
    await act(async () => { resolveDownload!({ ...preview, token: 'cancel-token' }); await settle(); });
    await click(button(t('common.back')));
    assert.deepEqual(discarded, ['cancel-token']);
    await act(async () => { document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); await settle(); });
    assert.equal(document.querySelector('[role=dialog]'), null);
    assert.equal(document.activeElement, trigger);
  } finally {
    await act(async () => root.unmount());
    for (const [key, descriptor] of previous) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); }
    dom.window.close();
  }
});
