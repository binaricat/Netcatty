import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { JSDOM } from 'jsdom';
import { PluginAuthorRow } from '../../plugins/PluginAuthorRow';
import { I18nProvider } from '../../../application/i18n/I18nProvider';

const entry = { id: 'com.netcatty.starter', name: 'Starter', author: 'Netcatty', version: '0.1.2',
  repository: 'binaricat/Netcatty', commit: 'a'.repeat(40), selectionToken: 'b'.repeat(64),
  manifest: { publisher: 'netcatty' } } as NetcattyPluginCatalogEntry;
const identity = { author: 'Netcatty', avatar: 'data:image/png;base64,eA==', officialMaintained: true,
  sourceId: 'official', version: entry.version, archiveSha256: null };

test('untrusted entry strings and absent imagery show only the author without decoration or an official badge', () => {
  const claimed = { ...entry, author: '<img src="https://avatars.githubusercontent.com/u/1">',
    officialMaintained: true, avatar: 'https://avatars.githubusercontent.com/u/1' };
  const html = renderToStaticMarkup(<I18nProvider locale="en"><PluginAuthorRow entry={claimed} /></I18nProvider>);
  assert.doesNotMatch(html, /<img|<svg|data-plugin-author-placeholder|bg-muted|rounded-full|data-plugin-official-maintainer/);
  assert.match(html, /&lt;img/);
});

test('installed authors share a compact row with localized sources and full accessible provenance', () => {
  const plugin = { id: entry.id, manifest: { publisher: 'An extremely long publisher name' },
    source: { id: 'third-party:example', kind: 'third-party', name: 'Community packages', origin: 'https://packages.example.org/catalog' },
  } as NetcattyInstalledPlugin;
  for (const [locale, label] of [['en', 'Third-party'], ['zh-CN', '第三方']]) {
    const dom = new JSDOM(renderToStaticMarkup(<I18nProvider locale={locale}><PluginAuthorRow plugin={plugin} showSource /></I18nProvider>));
    const row = dom.window.document.querySelector('[data-plugin-author-row]')!;
    const source = row.querySelector<HTMLElement>('[data-plugin-source]')!;
    assert.ok(source, 'source belongs to the author row');
    assert.equal(source.textContent, label);
    assert.match(source.title, /Community packages.*packages\.example\.org/);
    assert.equal(source.getAttribute('aria-label'), source.title);
    assert.ok(source.classList.contains('shrink-0'));
    assert.ok(row.classList.contains('min-w-0'));
    assert.ok(row.classList.contains('gap-3'), 'author and source are separated by 12px');
    assert.ok(row.classList.contains('overflow-hidden'), 'metadata is bounded even at extremely narrow widths');
    const authorGroup = row.querySelector('[data-plugin-author]')!;
    assert.equal(authorGroup.parentElement, row);
    assert.equal(source.parentElement, row);
    assert.ok(authorGroup.classList.contains('min-w-0'));
    assert.ok(authorGroup.classList.contains('gap-1.5'), 'avatar and author have a 6px gap');
    assert.ok(source.classList.contains('gap-1'), 'source icon and text have a 4px gap');
    assert.ok(row.querySelector('[title="An extremely long publisher name"]')?.classList.contains('truncate'));
    assert.ok(source.querySelector('svg[aria-hidden="true"]'));
    assert.equal(row.querySelector('[data-plugin-official-maintainer]'), null);
    dom.window.close();
  }
});

test('missing authors and unknown sources do not leave an empty author group or expose translation keys', () => {
  for (const source of [undefined, { kind: 'unexpected' }]) {
    const plugin = { id: entry.id, manifest: {}, source } as NetcattyInstalledPlugin;
    const dom = new JSDOM(renderToStaticMarkup(<I18nProvider locale="en"><PluginAuthorRow plugin={plugin} showSource /></I18nProvider>));
    const row = dom.window.document.querySelector('[data-plugin-author-row]')!;
    assert.equal(row.querySelector('[data-plugin-author]'), null);
    assert.equal(row.textContent, 'Source unknown');
    assert.equal(row.querySelectorAll('svg').length, 1, 'only the source outline icon remains');
    dom.window.close();
  }
});

test('mounted author rows load only when visible, retain fallbacks, cancel stale results and show a borderless themed maintainer pill', async () => {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { pretendToBeVisual: true });
  const previous = new Map<string, PropertyDescriptor | undefined>();
  const install = (key: string, value: unknown) => {
    previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  };
  const observers: Array<{ target: Element | null; callback: IntersectionObserverCallback }> = [];
  class VisibilityObserver {
    record: typeof observers[number];
    constructor(callback: IntersectionObserverCallback) { this.record = { callback, target: null }; observers.push(this.record); }
    observe(target: Element) { this.record.target = target; }
    disconnect() { this.record.target = null; }
  }
  for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'Element', 'Node', 'Event']) {
    install(key, key === 'window' ? dom.window : dom.window[key as keyof typeof dom.window]);
  }
  install('IntersectionObserver', VisibilityObserver);
  install('IS_REACT_ACT_ENVIRONMENT', true);
  const { act } = await import('react');
  const { createRoot } = await import('react-dom/client');
  const root = createRoot(document.getElementById('root')!);
  const calls: NetcattyPluginAuthorRequest[] = [];
  const pending: Array<(value: NetcattyPluginAuthorPresentation | null) => void> = [];
  Object.assign(window, { netcatty: { getPluginAuthorPresentation: (request: NetcattyPluginAuthorRequest) => {
    calls.push(request); return new Promise((resolve) => pending.push(resolve));
  } } });
  const render = async (value = entry, sourceId = 'official') => {
    await act(async () => root.render(<I18nProvider locale="en"><PluginAuthorRow entry={value} sourceId={sourceId} /></I18nProvider>));
  };
  const visible = async () => {
    await act(async () => {
      for (const observer of [...observers]) if (observer.target) observer.callback([{ target: observer.target, isIntersecting: true } as IntersectionObserverEntry], {} as IntersectionObserver);
    });
  };
  try {
    await render(); assert.equal(calls.length, 0); assert.equal(document.querySelector('[data-plugin-author-placeholder]'), null);
    await visible(); assert.deepEqual(calls[0], { kind: 'catalog', pluginId: entry.id, selectionToken: entry.selectionToken, sourceId: 'official' });
    assert.equal(document.querySelector('img'), null, 'loading does not reserve an empty avatar');
    assert.equal(document.querySelector('[data-plugin-author]')?.textContent, 'Netcatty');
    await act(async () => pending.shift()!(identity));
    const image = document.querySelector('img')!;
    assert.equal(image.getAttribute('src'), identity.avatar); assert.equal(image.width, 16); assert.equal(image.height, 16);
    const badge = document.querySelector<HTMLElement>('[data-plugin-official-maintainer]')!;
    assert.equal(badge.textContent, 'Official maintainer'); assert.match(badge.title, /not a safety certification/);
    assert.ok(badge.classList.contains('border-0'));
    assert.ok(badge.classList.contains('bg-amber-500/15')); assert.ok(badge.classList.contains('dark:bg-amber-400/15'));
    assert.ok(badge.classList.contains('text-amber-800')); assert.ok(badge.classList.contains('dark:text-amber-300'));
    document.documentElement.classList.add('dark');
    assert.ok(document.querySelector('[data-plugin-author-row]')?.classList.contains('items-center'));
    await act(async () => image.dispatchEvent(new Event('error')));
    assert.equal(document.querySelector('img'), null); assert.equal(document.querySelector('[data-plugin-author-placeholder]'), null);
    assert.ok(document.querySelector('[data-plugin-official-maintainer]'), 'image failure does not alter maintenance identity');

    const next = { ...entry, selectionToken: 'c'.repeat(64) };
    await render(next); assert.equal(document.querySelector('[data-plugin-official-maintainer]'), null);
    await visible(); const stale = pending.shift()!;
    const copied = { ...entry, author: 'Community author', selectionToken: 'd'.repeat(64) };
    await render(copied, 'third-party:copy'); await visible();
    await act(async () => stale(identity));
    assert.equal(document.querySelector('[data-plugin-official-maintainer]'), null);
    assert.match(document.querySelector('[data-plugin-author-row]')!.textContent!, /Community author/);
    await act(async () => pending.shift()!({ ...identity, author: copied.author, sourceId: 'third-party:copy', officialMaintained: false, avatar: 'https://avatars.githubusercontent.com/u/1' }));
    assert.equal(document.querySelector('img'), null, 'renderer never uses a remote avatar URL');
    assert.equal(document.querySelector('[data-plugin-official-maintainer]'), null);

    await render({ ...entry, selectionToken: 'f'.repeat(64) }); await visible();
    await act(async () => pending.shift()!({ ...identity, avatar: null, officialMaintained: false }));
    assert.equal(document.querySelector('[data-plugin-author-placeholder]'), null);
    const installed = { id: entry.id, activeVersion: entry.version, archiveSha256: 'a'.repeat(64),
      source: { id: 'official', kind: 'official', origin: 'https://plugins.netcatty.app', name: 'Official' },
      manifest: entry.manifest, runtime: {} } as NetcattyInstalledPlugin;
    await act(async () => root.render(<I18nProvider locale="en"><PluginAuthorRow plugin={installed} /></I18nProvider>));
    await visible(); assert.deepEqual(calls.at(-1), { kind: 'installed', pluginId: installed.id });
    await act(async () => pending.shift()!({ ...identity, version: '9.0.0', archiveSha256: installed.archiveSha256! }));
    assert.equal(document.querySelector('[data-plugin-official-maintainer]'), null, 'a stale installed version cannot gain a badge');
    const count = calls.length;
    await act(async () => root.render(<I18nProvider locale="en"><PluginAuthorRow plugin={{ ...installed }} /></I18nProvider>));
    await visible(); assert.equal(calls.length, count, 'unchanged installed identity does not reload on a new object reference');

    await render({ ...entry, selectionToken: 'e'.repeat(64) }); await visible();
    const late = pending.shift()!;
    await act(async () => root.unmount());
    await act(async () => late(identity));
    assert.equal(document.querySelector('[data-plugin-author-row]'), null);
    assert.ok(observers.every((observer) => observer.target === null));
  } finally {
    dom.window.close();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key);
    }
  }
});
