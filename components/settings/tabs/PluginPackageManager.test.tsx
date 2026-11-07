import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { I18nProvider } from '../../../application/i18n/I18nProvider';
import { PluginPackageDetails, PluginPackageManager } from './PluginPackageManager';
import { JSDOM } from 'jsdom';
import type { usePluginManager } from '../../../application/state/usePluginManager';

test('installed cards and selected details keep author before compact source metadata', () => {
  const plugin = { id: 'com.example.synthetic', enabled: false, activeVersion: '1.0.0',
    source: { id: 'local', kind: 'local', name: 'Imported package', origin: null },
    manifest: { manifestVersion: 1, id: 'com.example.synthetic', name: 'Synthetic', publisher: 'Publisher', version: '1.0.0', engines: { netcatty: '*', api: '*' }, main: { browser: 'index.js' } },
    runtime: { status: 'stopped', kind: null, lastError: 'Diagnostic remains visible', quarantinedAt: null },
  } as NetcattyInstalledPlugin;
  const manager = { plugins: [plugin], available: true, statusKnown: true, busy: false } as ReturnType<typeof usePluginManager>;
  for (const initialSelectedId of [null, plugin.id]) {
    const dom = new JSDOM(renderToStaticMarkup(<I18nProvider locale="en"><PluginPackageManager manager={manager} initialSelectedId={initialSelectedId} /></I18nProvider>));
    const article = dom.window.document.querySelector('article')!;
    const row = article.querySelector('[data-plugin-author-row]')!;
    assert.equal(row.querySelector('[data-plugin-source]')?.textContent, 'Local');
    assert.match(row.textContent!, /PublisherLocal/);
    assert.doesNotMatch(article.textContent!, /Source:/);
    assert.doesNotMatch(article.textContent!, /Diagnostic remains visible/);
    assert.ok(article.querySelector('button[aria-haspopup="dialog"][aria-label$="Synthetic"]'), 'recorded errors are available from the name-adjacent icon');
    dom.window.close();
  }
});

test('package detail renders manifest resources as text and explains advanced authority', () => {
  const plugin = {
    id: 'com.example.synthetic', enabled: false, activeVersion: '1.0.0',
    archiveSha256: 'a'.repeat(64),
    manifest: {
      manifestVersion: 1, id: 'com.example.synthetic', name: 'synthetic', version: '1.0.0', publisher: 'example',
      engines: { netcatty: '>=1.0.0 <2.0.0', api: '0.1.0-internal' },
      main: { node: 'index.js' },
      permissions: { required: [{ permission: 'network', resources: ['https://example.com'], reason: '<script>attack()</script>' }] },
    },
    runtime: { status: 'stopped', kind: null, lastError: null, quarantinedAt: null },
  } as NetcattyInstalledPlugin;
  const html = renderToStaticMarkup(<I18nProvider locale="en"><PluginPackageDetails plugin={plugin} /></I18nProvider>);
  assert.match(html, /full Node filesystem and network authority/);
  assert.match(html, /Broker permissions cannot restrict this access/);
  assert.match(html, /Development preview only/);
  assert.match(html, /https:\/\/example.com/);
  assert.match(html, /&lt;script&gt;/);
  assert.doesNotMatch(html, /<script>/);
  assert.match(html, /Declared supported capabilities default to Allow/);
  assert.match(html, /Ask or Deny/);
  assert.match(html, /Host validation and resource scope always apply/);
  assert.match(html, /this capability may expose private data/);
  assert.match(html, /mode can be changed in permission settings/);
  assert.doesNotMatch(html, /before granting/);
  assert.match(html, /aaaaaaaaaaaaaaaa/);
});
