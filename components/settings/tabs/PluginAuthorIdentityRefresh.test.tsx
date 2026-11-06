import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { JSDOM } from 'jsdom';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { usePluginAuthorIdentity } from '../../../application/state/usePluginAuthorIdentity';
import { checkPluginUpdates } from '../../../infrastructure/services/pluginUpdateCheck';

const require = createRequire(import.meta.url);
const { PluginDatabase } = require('../../../electron/plugins/database.cjs');
const { MarketSourcesService } = require('../../../electron/plugins/marketSourcesService.cjs');
const { OFFICIAL_SOURCE } = require('../../../electron/plugins/sourceIdentity.cjs');
const { registerPluginBridge, CHANNELS } = require('../../../electron/plugins/pluginBridge.cjs');
const { createPreloadApi } = require('../../../electron/preload/api.cjs');
const { catalog, delivery, makeFiles, read, digest } = require('../../../electron/plugins/fixtures/staticDistributionFixture.cjs');

test('mounted installed authors follow actual catalog/update/source entrypoints without changing package identity', async () => {
  const rootPath = mkdtempSync(join(tmpdir(), 'netcatty-author-refresh-'));
  const database = new PluginDatabase(join(rootPath, 'plugins.sqlite'));
  const dom = new JSDOM('<!doctype html><div id="root"></div>', { pretendToBeVisual: true });
  const previous = new Map<string, PropertyDescriptor | undefined>();
  for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document,
    navigator: dom.window.navigator, HTMLElement: dom.window.HTMLElement, Element: dom.window.Element,
    Node: dom.window.Node, IntersectionObserver: undefined, IS_REACT_ACT_ENVIRONMENT: true })) {
    previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  const entry = structuredClone(catalog[0]);
  entry.artifact = { sha256: 'a'.repeat(64), url: `${OFFICIAL_SOURCE.origin}/assets/${'a'.repeat(64)}.ncpkg` };
  const bytes = read(delivery.plugins[0].iconLight.path.slice(1));
  const avatar = { path: `/assets/${digest(bytes)}.png`, sha256: digest(bytes), size: bytes.length };
  const filesFor = (entries = [entry], image = true) => {
    const files = makeFiles(entries, (index: { plugins: Array<{ id: string; versions: Array<{ distribution: string }> }> }, sidecar: { schemaVersion: number; plugins: Array<{ id: string; avatar: typeof avatar | null; artifact: { path: string; sha256: string; size: number } }> }) => {
      sidecar.schemaVersion = 2;
      for (const item of sidecar.plugins) {
        item.avatar = image ? avatar : null;
        item.artifact = { path: `/assets/${entry.artifact.sha256}.ncpkg`, sha256: entry.artifact.sha256, size: 1 };
        index.plugins.find((plugin) => plugin.id === item.id).versions[0].distribution = 'release';
      }
    });
    files.set(avatar.path, bytes); return files;
  };
  let files = filesFor();
  database.installVersion({ pluginId: entry.id, version: entry.version, runtimeKind: "browser", apiVersion: "0.1.0-internal.1", manifest: entry.manifest, archiveSha256: entry.artifact.sha256,
    packageRelativePath: 'packages/synthetic', source: OFFICIAL_SOURCE }, { enable: true });
  const manager = { initialize: async () => {}, list: async () => database.listPlugins(),
    changeMarketSource: async (change: () => unknown) => change() };
  let avatarReads = 0;
  const service = new MarketSourcesService({ database, manager,
    fetch: async (url: string) => { assert.equal(new URL(url).origin, OFFICIAL_SOURCE.origin); assert.ok(!new URL(url).pathname.endsWith('.ncpkg'), 'rejected selection never downloads a package'); return new Response(files.get(new URL(url).pathname)); },
    createSourceFetch: (origin: string) => async (url: string) => { assert.equal(new URL(url).origin, origin); return new Response(files.get(new URL(url).pathname)); },
    resolveAvatar: async () => { avatarReads++; return 'data:image/png;base64,eA=='; } });
  const ipcMain = { handlers: new Map(), handle(channel: string, handler: unknown) { this.handlers.set(channel, handler); }, on() {} };
  const events = new EventEmitter();
  registerPluginBridge(ipcMain, { manager, catalogService: service, isTrustedSender: () => true,
    broadcast: (channel: string, payload: unknown) => events.emit(channel, {}, payload) });
  const api = createPreloadApi({ ipcRenderer: { on: events.on.bind(events), removeListener: events.removeListener.bind(events),
    invoke: (channel: string, payload: unknown) => ipcMain.handlers.get(channel)({}, payload) } });
  let authorCalls = 0;
  const original = api.getPluginAuthorPresentation;
  api.getPluginAuthorPresentation = (request: NetcattyPluginAuthorRequest) => { authorCalls++; return original(request); };
  Object.assign(window, { netcatty: api });
  let plugin = database.getActivePlugin(entry.id) as NetcattyInstalledPlugin;
  function Row() {
    const { ref, identity } = usePluginAuthorIdentity({ plugin });
    return <div ref={ref} data-author={identity?.author} data-avatar={identity?.avatar} data-official={identity?.officialMaintained ?? false} />;
  }
  const { act } = await import('react');
  const { createRoot } = await import('react-dom/client');
  const root = createRoot(document.getElementById('root')!);
  const row = () => document.querySelector<HTMLElement>('[data-official]')!;
  try {
    await act(async () => root.render(<><Row /><Row /></>));
    assert.equal(row().dataset.author, entry.manifest.publisher); assert.equal(row().dataset.official, 'false');
    assert.equal(avatarReads, 0, 'opening installed rows never fetches a catalog/avatar');
    await act(async () => { await checkPluginUpdates(api); });
    assert.equal(row().dataset.author, entry.author); assert.equal(row().dataset.official, 'true');
    assert.match(row().dataset.avatar!, /^data:image\/png/);
    assert.equal(events.listenerCount(CHANNELS.catalogChanged), 1, 'rows share one preload subscription');
    const count = authorCalls;
    await act(async () => { await api.listPluginCatalog('official'); root.render(<><Row /><Row /></>); });
    assert.equal(authorCalls, count, 'equivalent catalog and installation retain request dedupe');
    files = filesFor([{ ...entry, author: 'Updated project name' }], false);
    await act(async () => { await api.listPluginCatalog('official'); });
    assert.equal(row().dataset.author, 'Updated project name'); assert.equal(row().dataset.avatar, undefined);
    const beforeWithdrawal = (await api.listPluginCatalog('official')).entries[0];
    files = filesFor([]);
    await act(async () => {
      await assert.rejects(api.installCatalogPlugin(entry.id, beforeWithdrawal.selectionToken, 'official'), /not in the curated catalog|changed/);
    });
    assert.equal(row().dataset.author, entry.manifest.publisher); assert.equal(row().dataset.official, 'false');
    assert.equal(row().dataset.avatar, undefined, 'rejected install refresh removes withdrawn enrichment without another list or remount');

    const source = await api.addPluginSource({ name: 'Community', address: 'https://community.example.com' });
    const community = structuredClone(entry);
    community.id = community.manifest.id = 'com.community.identity';
    community.artifact.url = `${source.origin}/assets/${community.artifact.sha256}.ncpkg`;
    files = filesFor([community]);
    database.installVersion({ pluginId: community.id, version: community.version, manifest: community.manifest,
      archiveSha256: community.artifact.sha256, packageRelativePath: 'packages/community', source }, { enable: true });
    await act(async () => { await api.listPluginCatalog(source.id); });
    assert.equal(authorCalls, count + 4, 'unrelated source changes do not reload official rows');
    plugin = database.getActivePlugin(community.id);
    await act(async () => root.render(<><Row /><Row /></>));
    assert.equal(row().dataset.author, community.author); assert.match(row().dataset.avatar!, /^data:image\/png/);
    assert.equal(row().dataset.official, 'false', 'copied catalog never gains official maintenance authority');
    await act(async () => { await api.updatePluginSource({ id: source.id, name: 'Renamed', enabled: false }); });
    assert.equal(row().dataset.author, community.manifest.publisher); assert.equal(row().dataset.avatar, undefined);
    await act(async () => { await api.updatePluginSource({ id: source.id, name: 'Renamed', enabled: true }); });
    assert.equal(row().dataset.author, community.author);
    await act(async () => { await api.removePluginSource(source.id, false); });
    assert.equal(row().dataset.author, community.manifest.publisher); assert.equal(row().dataset.avatar, undefined);
    await act(async () => root.unmount());
    assert.equal(events.listenerCount(CHANNELS.catalogChanged), 0, 'last row releases the shared IPC listener');
  } finally {
    database.close(); dom.window.close(); rmSync(rootPath, { recursive: true, force: true });
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key);
    }
  }
});
