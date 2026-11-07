import assert from 'node:assert/strict';
import test from 'node:test';
import { filterPluginCatalog } from './PluginMarketplace';
test('catalog search matches name, author and description without case sensitivity', () => {
  const entries = [{ id: 'a', name: 'Starter', author: 'Netcatty', description: 'Local greeting' }] as NetcattyPluginCatalogEntry[];
  for (const query of ['starter', 'NETCATTY', ' greeting ']) assert.equal(filterPluginCatalog(entries, query).length, 1);
  assert.equal(filterPluginCatalog(entries, 'unrelated').length, 0);
  assert.equal(filterPluginCatalog(entries, '').length, 1);
});
