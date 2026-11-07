import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { inspectPluginBrandIcon } from '@netcatty/plugin-contract';
import { PluginBrandIcon } from '../../plugins/PluginBrandIcon';
import { resolveCatalogBrandIcon } from '../../plugins/catalogBrandIcons';
import previews from '../../plugins/catalog-brand-icons.json';

const preview = previews[0];
const entry = { ...preview, manifest: { icon: preview.icon } } as unknown as NetcattyPluginCatalogEntry;
test('reviewed catalog brand previews bind version, source and declaration, never arbitrary URLs', () => {
  assert.ok(resolveCatalogBrandIcon(entry));
  const catalog = JSON.parse(readFileSync(new URL('../../../electron/plugins/catalog.json', import.meta.url), 'utf8')) as NetcattyPluginCatalogEntry[];
  assert.ok(resolveCatalogBrandIcon(catalog.find((item) => item.id === preview.id)!));
  for (const replacement of [{ version: '9.0.0' }, { commit: '0'.repeat(40) }, { repository: 'untrusted/plugin' }, { manifest: { icon: { kind: 'package', light: 'https://attacker.invalid/a.png' } } }]) {
    assert.equal(resolveCatalogBrandIcon({ ...entry, ...replacement } as NetcattyPluginCatalogEntry), null);
  }
  for (const theme of ['light', 'dark'] as const) {
    const bytes = Buffer.from(preview[theme].split(',')[1], 'base64');
    assert.equal(createHash('sha256').update(bytes).digest('hex'), preview[`${theme}Sha256`]);
    assert.equal(inspectPluginBrandIcon(bytes, preview.icon[theme]).width, 128);
    assert.deepEqual(bytes, readFileSync(new URL(`../../../examples/plugins/starter-netcatty/${preview.icon[theme]}`, import.meta.url)));
  }
  const html = renderToStaticMarkup(<PluginBrandIcon entry={entry} />);
  assert.match(html, /data-plugin-brand="package"/);
  assert.match(html, /dark:hidden/);
  assert.match(html, /dark:block/);
  assert.doesNotMatch(html, /src="https?:/);
  assert.match(renderToStaticMarkup(<PluginBrandIcon />), /data-plugin-brand="fallback"/);
});
test('installed brand uses metadata only, rejects stale responses, and falls back after image errors', async () => {
  const oldWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const previousAct = (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const requests: Array<(v: { light: string }) => void> = [];
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { netcatty: { getPluginBrandIcon: () => new Promise((resolve) => requests.push(resolve)) } } });
  const plugin = { id: 'com.netcatty.starter', enabled: false, activeVersion: '1.0.0', archiveSha256: 'a', runtime: {}, manifest: { icon: preview.icon } } as NetcattyInstalledPlugin;
  let renderer: ReactTestRenderer | undefined;
  try {
    await act(async () => { renderer = create(<PluginBrandIcon plugin={plugin} />); });
    assert.equal(requests.length, 1);
    await act(async () => { renderer!.update(<PluginBrandIcon plugin={{ ...plugin, archiveSha256: 'b' }} />); });
    await act(async () => requests[0]({ light: preview.light }));
    assert.equal(renderer!.root.findAllByType('img').length, 0);
    await act(async () => requests[1]({ light: preview.light }));
    assert.equal(renderer!.root.findAllByType('img').length, 1);
    await act(async () => renderer!.root.findByType('img').props.onError());
    assert.equal(renderer!.root.findAllByType('img').length, 0);
    await act(async () => { renderer!.update(<PluginBrandIcon />); });
    assert.equal(renderer!.root.findAllByType('img').length, 0);
  } finally {
    await act(async () => renderer?.unmount());
    if (oldWindow) Object.defineProperty(globalThis, 'window', oldWindow); else Reflect.deleteProperty(globalThis, 'window');
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = previousAct;
  }
});


test('disabled brand theme names cannot resolve Object prototype members', () => {
  for (const name of ['constructor', '__proto__', 'toString', 'valueOf', 'hasOwnProperty']) {
    const plugin = { id: 'com.test.theme', enabled: false, activeVersion: '1.0.0', runtime: {}, manifest: { icon: { kind: 'theme', name } } } as NetcattyInstalledPlugin;
    const html = renderToStaticMarkup(<PluginBrandIcon plugin={plugin} />);
    assert.match(html, /lucide-puzzle/);
    assert.doesNotMatch(html, /<img/);
  }
});
