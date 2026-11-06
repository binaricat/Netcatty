import assert from 'node:assert/strict';
import test from 'node:test';
import { checkPluginUpdates } from './pluginUpdateCheck';

const official: NetcattyPluginSource = { id: 'official', kind: 'official', name: 'Official source', origin: 'https://plugins.example.com', enabled: true };
const third: NetcattyPluginSource = { id: 'third-party:synthetic', kind: 'third-party', name: 'Synthetic source', origin: 'https://synthetic.example.com', enabled: true };
const local: NetcattyPluginSource = { id: 'local', kind: 'local', name: 'Local import', origin: null };
const plugin = (id: string, version: string, source?: NetcattyPluginSource): NetcattyInstalledPlugin => ({ id, activeVersion: version, source, archiveSha256: 'a'.repeat(64), enabled: false, manifest: null, runtime: { status: 'stopped', kind: null, lastError: null, quarantinedAt: null } });
const entry = (id: string, version: string) => ({ id, version, artifact: { url: 'https://plugins.example.com/synthetic.ncpkg', sha256: 'b'.repeat(64) } }) as NetcattyPluginCatalogEntry;
const catalog = (entries: NetcattyPluginCatalogEntry[]): NetcattyPluginCatalogSnapshot => ({ source: 'registry', error: null, entries });

test('update checks compare semantic versions within each host-bound source and never mutate or fetch directly', async () => {
  const installed = [plugin('com.example.alpha', '1.9.0', official), plugin('com.example.beta', '2.0.0-beta.1', third), plugin('com.example.local', '1.0.0', local), plugin('com.example.unknown', '1.0.0')];
  const requested: string[] = [];
  let mutations = 0;
  const bridge = {
    async listPlugins() { return installed; }, async listPluginSources() { return [official, third]; },
    async listPluginCatalog(sourceId?: string) {
      requested.push(sourceId!);
      return sourceId === official.id ? catalog([entry(installed[0].id, '1.10.0'), entry(installed[1].id, '99.0.0')]) : catalog([entry(installed[1].id, '2.0.0')]);
    },
    async installCatalogPlugin() { mutations++; }, async setPluginEnabled() { mutations++; }, async checkForUpdates() { mutations++; },
  };
  const previous = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('Direct fetching is forbidden'); };
  try {
    const result = await checkPluginUpdates(bridge);
    assert.deepEqual(requested, [official.id, third.id]);
    assert.equal(result.checked, 2);
    assert.equal(result.skipped, 2);
    assert.equal(result.failedSources, 0);
    assert.deepEqual(result.updates, [
      { pluginId: installed[0].id, sourceId: official.id, installedVersion: '1.9.0', availableVersion: '1.10.0' },
      { pluginId: installed[1].id, sourceId: third.id, installedVersion: '2.0.0-beta.1', availableVersion: '2.0.0' },
    ]);
    assert.equal(mutations, 0);
  } finally { globalThis.fetch = previous; }
});

test('cached, failed, disabled and unpublished sources do not claim an update check succeeded', async () => {
  const disabled = { ...third, enabled: false };
  const installed = [plugin('com.example.alpha', '1.0.0', official), plugin('com.example.beta', '1.0.0', disabled)];
  const calls: string[] = [];
  const result = await checkPluginUpdates({ async listPlugins() { return installed; }, async listPluginSources() { return [official, disabled]; },
    async listPluginCatalog(sourceId) { calls.push(sourceId!); return { source: 'cached', error: 'synthetic offline', entries: [entry(installed[0].id, '2.0.0')] }; } });
  assert.deepEqual(calls, [official.id]);
  assert.equal(result.checked, 0); assert.equal(result.skipped, 2); assert.equal(result.failedSources, 1); assert.deepEqual(result.updates, []);
  const unpublished = await checkPluginUpdates({ async listPlugins() { return [installed[0]]; }, async listPluginSources() { return [official]; }, async listPluginCatalog() { return catalog([{ ...entry(installed[0].id, '2.0.0'), artifact: undefined }]); } });
  assert.equal(unpublished.checked, 0); assert.equal(unpublished.skipped, 1);
});

test('source or installed package replacement during an asynchronous catalog read invalidates results', async () => {
  for (const change of ['source', 'hash', 'disabled']) {
    const before = plugin('com.example.alpha', '1.0.0', official);
    let installed = [before]; let sources = [official];
    const result = await checkPluginUpdates({ async listPlugins() { return installed; }, async listPluginSources() { return sources; }, async listPluginCatalog() {
      if (change === 'source') { installed = [{ ...before, source: third }]; sources = [third]; }
      if (change === 'hash') installed = [{ ...before, archiveSha256: 'c'.repeat(64) }];
      if (change === 'disabled') sources = [{ ...official, enabled: false }];
      return catalog([entry(before.id, '2.0.0')]);
    } });
    assert.deepEqual(result.updates, [], change); assert.equal(result.checked, 0, change); assert.equal(result.skipped, 1, change);
  }
});

test('a failing source leaves other fresh source results intact and missing APIs fail explicitly', async () => {
  const installed = [plugin('com.example.alpha', '1.0.0', official), plugin('com.example.beta', '1.0.0', third)];
  const result = await checkPluginUpdates({ async listPlugins() { return installed; }, async listPluginSources() { return [official, third]; }, async listPluginCatalog(id) { if (id === third.id) throw new Error('synthetic source unavailable'); return catalog([entry(installed[0].id, '1.1.0')]); } });
  assert.equal(result.failedSources, 1); assert.equal(result.checked, 1); assert.equal(result.skipped, 1); assert.equal(result.updates[0].sourceId, official.id);
  await assert.rejects(checkPluginUpdates({}), /unavailable/);
});
