import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { validateManifestValue } from './manifest.js';
import { checkPluginCompatibility } from './compatibility.js';

const manifest = JSON.parse(await readFile(new URL('../../../examples/plugins/vault-scratchpad/netcatty.plugin.json', import.meta.url), 'utf8'));
test('Vault pages require exact feature negotiation and the existing views permission', () => {
  assert.equal(validateManifestValue(manifest).valid, true);
  assert.equal(validateManifestValue({ ...manifest, features: {} }).valid, false);
  assert.equal(validateManifestValue({ ...manifest, permissions: {} }).valid, false);
  assert.equal(checkPluginCompatibility(manifest, { netcattyVersion: '1.0.0', features: [] }).compatible, false);
  assert.equal(checkPluginCompatibility(manifest, { netcattyVersion: '1.0.0', features: ['views.vault-pages'] }).compatible, true);
  const legacy = { ...manifest, features: {}, contributes: { views: [{ ...manifest.contributes.views[0], location: 'tab' }] } };
  assert.equal(validateManifestValue(legacy).valid, true, 'legacy tab packages keep their contract');
});
