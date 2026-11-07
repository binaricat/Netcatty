import assert from 'node:assert/strict';
import test, { before, after } from 'node:test';
import { JSDOM } from 'jsdom';
import React, { useState } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import { I18nProvider } from '../../../application/i18n/I18nProvider';
import { PluginMarketplaceContent } from './PluginMarketplace';
import type { usePluginCatalog } from '../../../application/state/usePluginCatalog';

const infoDom = new JSDOM('<!doctype html><html><body></body></html>');
const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
const previousDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
before(() => {
  Object.defineProperty(globalThis, 'window', { configurable: true, value: infoDom.window });
  Object.defineProperty(globalThis, 'document', { configurable: true, value: infoDom.window.document });
});
after(() => {
  infoDom.window.close();
  if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow); else Reflect.deleteProperty(globalThis, 'window');
  if (previousDocument) Object.defineProperty(globalThis, 'document', previousDocument); else Reflect.deleteProperty(globalThis, 'document');
});

const entries = ['Alpha', 'Beta'].map((name) => ({
  id: `com.example.${name.toLowerCase()}`, name, author: 'Example', version: '1.0.0', license: 'MIT',
  description: `${name} local utility`, repository: 'example/plugins', commit: 'a'.repeat(40),
  manifest: { manifestVersion: 1, id: `com.example.${name.toLowerCase()}`, name, version: '1.0.0', publisher: 'Example', engines: { netcatty: '>=1.0.0', api: '0.1.0-internal' }, main: { browser: 'index.js' }, permissions: { required: ['settings.read'] } },
})) as NetcattyPluginCatalogEntry[];
const catalog = {
  entries, source: 'registry', sourceBinding: null, listStatus: 'ready', listError: null, readmeImages: {}, readme: '# Author documentation', readmeStatus: 'ready', readmeError: null,
  error: null, busy: false, retryList() {}, retryReadme() {}, async install() {},
} as ReturnType<typeof usePluginCatalog>;

test('catalog keeps search during selection/back, switches detail, and displays real installed state', async () => {
  const previousRaf = globalThis.requestAnimationFrame;
  globalThis.requestAnimationFrame = (callback) => { callback(0); return 0; };
  const actGlobal = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
  const previousActEnvironment = actGlobal.IS_REACT_ACT_ENVIRONMENT;
  actGlobal.IS_REACT_ACT_ENVIRONMENT = true;
  let renderer: ReactTestRenderer;
  function Harness() {
    const [selected, setSelected] = useState<string | null>(null);
    return <I18nProvider locale="en"><PluginMarketplaceContent catalog={catalog} selected={selected} onSelect={setSelected}
      installed={[{ id: entries[0].id, activeVersion: '0.9.0', enabled: false, source: { id: 'official', kind: 'official', name: 'Official', origin: 'https://plugins.netcatty.app' }, runtime: { lastError: 'Incompatible with this host' } } as NetcattyInstalledPlugin]} /></I18nProvider>;
  }
  try {
    await act(async () => { renderer = create(<Harness />); });
    const cards = () => renderer.root.findAll((node) => node.type === 'button' && Boolean(node.props['data-plugin-id']));
    const input = () => renderer.root.findByType('input');
    assert.equal(cards().length, 2);
    await act(async () => input().props.onChange({ target: { value: 'Alpha' } }));
    assert.equal(cards().length, 1);
    await act(async () => cards()[0].props.onClick());
    assert.equal(renderer.root.findByType('article').props['aria-label'], 'Alpha');
    assert.equal(cards().length, 0, 'detail replaces the entire grid at every width');
    assert.equal(renderer.root.findAllByType('input').length, 0);
    const detailText = JSON.stringify(renderer.toJSON());
    assert.match(detailText, /0.9.0/);
    assert.match(detailText, /Disabled/);
    assert.match(detailText, /Incompatible with this host/);
    assert.match(detailText, /Last recorded error/);
    assert.equal(renderer.root.findAllByType('details').length, 0, 'permissions are not hidden in a disclosure');
    assert.equal(renderer.root.findAll((node) => node.type === 'button' && node.children.includes('Install this version (disabled)')).length, 0, 'source-only cards have no install action');
    const back = () => renderer.root.findAllByType('button').find((node) => node.children.includes('All plugins'))!;
    await act(async () => back().props.onClick());
    assert.equal(renderer.root.findAllByType('article').length, 0);
    assert.equal(input().props.value, 'Alpha');
    await act(async () => input().props.onChange({ target: { value: '' } }));
    await act(async () => cards()[1].props.onClick());
    assert.equal(renderer.root.findByType('article').props['aria-label'], 'Beta');
    assert.equal(cards().length, 0);
    await act(async () => back().props.onClick());
    await act(async () => input().props.onChange({ target: { value: 'no match' } }));
    assert.equal(cards().length, 0);
    assert.equal(input().props.value, 'no match');
    await act(async () => renderer.unmount());
  } finally {
    globalThis.requestAnimationFrame = previousRaf;
    actGlobal.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
  }
});


test('README failure leaves the permissions and source visible, before the failure message', () => {
  const html = renderToStaticMarkup(<I18nProvider locale="en"><PluginMarketplaceContent
    catalog={{ ...catalog, readmeStatus: 'error', readme: null, readmeError: 'Network unavailable' }}
    selected={entries[0].id} onSelect={() => {}} installed={[]} /></I18nProvider>);
  assert.match(html, /Compatibility and permissions/);
  assert.match(html, /settings.read/);
  assert.match(html, /Declared supported capabilities default to Allow/);
  assert.match(html, /Ask or Deny/);
  assert.match(html, /Host validation and resource scope always apply/);
  assert.match(html, /Host validation and the selected permission mode still apply/);
  assert.doesNotMatch(html, /Check the actual scope in the permission prompt/);
  assert.match(html, /Source example/);
  assert.ok(html.indexOf('settings.read') < html.indexOf('Network unavailable'));
  assert.match(html, /Retry/);
  assert.doesNotMatch(html, /<details/);
});

test('cards use subtle shadows and details have no breakpoint-specific columns or nested scroller', () => {
  const css = readFileSync(new URL('./plugin-marketplace.css', import.meta.url), 'utf8');
  assert.match(css, /box-shadow: 0 1px 4px/);
  assert.match(css, /\.dark \.plugin-card/);
  assert.doesNotMatch(css, /@container|248px|max-height|overflow-y/);
});

test('full-page detail starts at the top and back restores the settings scroll and card focus', async () => {
  const previousRaf = globalThis.requestAnimationFrame;
  const frames: FrameRequestCallback[] = [];
  globalThis.requestAnimationFrame = (callback) => { frames.push(callback); return frames.length; };
  const actGlobal = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
  const previousActEnvironment = actGlobal.IS_REACT_ACT_ENVIRONMENT;
  actGlobal.IS_REACT_ACT_ENVIRONMENT = true;
  const pane = { scrollTop: 450 };
  let focused = false;
  const list = { scrollTop: 0, closest: (selector: string) => selector === '.plugin-marketplace' ? { clientWidth: 1100 } : pane,
    querySelectorAll: () => [{ dataset: { pluginId: entries[0].id }, focus: () => { focused = true; } }] };
  let renderer!: ReactTestRenderer;
  function Harness() {
    const [selected, setSelected] = useState<string | null>(null);
    return <I18nProvider locale="en"><PluginMarketplaceContent catalog={catalog} selected={selected} onSelect={setSelected} installed={[]} /></I18nProvider>;
  }
  try {
    await act(async () => { renderer = create(<Harness />, { createNodeMock: (element) => element.type === 'div' && (element.props as { className?: string }).className?.includes('plugin-marketplace-catalog') ? list : null }); });
    const card = renderer.root.findAll((node) => node.type === 'button' && node.props['data-plugin-id'] === entries[0].id)[0];
    await act(async () => card.props.onClick());
    frames.splice(0).forEach((frame) => frame(0));
    assert.equal(pane.scrollTop, 0);
    const back = renderer.root.findAllByType('button').find((node) => node.children.includes('All plugins'))!;
    await act(async () => back.props.onClick());
    frames.splice(0).forEach((frame) => frame(0));
    assert.equal(pane.scrollTop, 450);
    assert.equal(focused, true);
    await act(async () => renderer.unmount());
  } finally {
    globalThis.requestAnimationFrame = previousRaf;
    actGlobal.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
  }
});

test('offline catalog warning keeps details visible and disables market installation', () => {
  const downloadable = { ...entries[0], artifact: { url: 'https://github.com/example/plugin/releases/download/v1/plugin.ncpkg', sha256: 'a'.repeat(64) } };
  const html = renderToStaticMarkup(<I18nProvider locale="en"><PluginMarketplaceContent
    catalog={{ ...catalog, entries: [downloadable], listError: 'Registry offline', source: 'cached' }}
    selected={downloadable.id} onSelect={() => {}} installed={[]} /></I18nProvider>);
  assert.match(html, /Offline catalog · installation unavailable/);
  assert.match(html, /Compatibility and permissions/);
  assert.match(html, /<button[^>]*disabled=""[^>]*>Install this version/);
  assert.match(html, /Notices: 1/);
});

test('manual refresh remains available after success and is disabled while loading', () => {
  const ready = renderToStaticMarkup(<I18nProvider locale="en"><PluginMarketplaceContent catalog={catalog} selected={null} onSelect={() => {}} installed={[]} /></I18nProvider>);
  assert.match(ready, />Refresh<\/button>/);
  const loading = renderToStaticMarkup(<I18nProvider locale="en"><PluginMarketplaceContent catalog={{ ...catalog, listStatus: 'loading' }} selected={null} onSelect={() => {}} installed={[]} /></I18nProvider>);
  assert.match(loading, /<button[^>]*disabled=""[^>]*>Refresh<\/button>/);
});

test('replacing an installed plugin discloses that its running version will stop beside the install action', () => {
  const downloadable = { ...entries[0], artifact: { url: 'https://github.com/example/plugin/releases/download/v1/plugin.ncpkg', sha256: 'a'.repeat(64) } };
  const html = renderToStaticMarkup(<I18nProvider locale="en"><PluginMarketplaceContent
    catalog={{ ...catalog, entries: [downloadable] }} selected={downloadable.id} onSelect={() => {}}
    installed={[{ id: downloadable.id, activeVersion: '0.9.0', enabled: true, source: { id: 'official', kind: 'official', name: 'Official', origin: 'https://plugins.netcatty.app' } } as NetcattyInstalledPlugin]} /></I18nProvider>);
  assert.match(html, /<p[^>]*>This replaces and stops the installed version\./);
  assert.ok(html.indexOf('This replaces and stops') < html.indexOf('Install this version (disabled)'));
});

test('a mirror cannot claim another source installation or offer cross-source replacement', () => {
  const mirror = { id: 'third-party:mirror', kind: 'third-party' as const, name: 'Netcatty', origin: 'https://mirror.example.com' };
  const existing = { id: entries[0].id, activeVersion: '1.0.0', enabled: true, source: { id: 'official', kind: 'official', name: 'Official', origin: 'https://plugins.netcatty.app' } } as NetcattyInstalledPlugin;
  const list = renderToStaticMarkup(<I18nProvider locale="en"><PluginMarketplaceContent catalog={catalog}
    marketSource={mirror} selected={null} onSelect={() => {}} installed={[existing]} /></I18nProvider>);
  assert.doesNotMatch(list, />Installed</);
  const downloadable = { ...entries[0], artifact: { url: `${mirror.origin}/assets/${'a'.repeat(64)}.ncpkg`, sha256: 'a'.repeat(64) } };
  const detail = renderToStaticMarkup(<I18nProvider locale="en"><PluginMarketplaceContent catalog={{ ...catalog, entries: [downloadable] }}
    marketSource={mirror} selected={downloadable.id} onSelect={() => {}} installed={[existing]} /></I18nProvider>);
  assert.match(detail, /installed from another source/);
  assert.match(detail, /https:\/\/plugins.netcatty.app/);
  assert.match(detail, /disabled=""[^>]*>Install this version/);
});
