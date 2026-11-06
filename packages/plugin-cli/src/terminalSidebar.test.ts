import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { validateManifestValue } from './manifest.js';
import { checkPluginCompatibility } from './compatibility.js';
const manifest = JSON.parse(await readFile(new URL('../../../examples/plugins/session-scratchpad/netcatty.plugin.json', import.meta.url), 'utf8'));
test('terminal sidebar pages require views and their exact feature without session data permissions', () => {
  assert.equal(validateManifestValue(manifest).valid, true);
  assert.equal(validateManifestValue({ ...manifest, features: {} }).valid, false);
  assert.equal(validateManifestValue({ ...manifest, permissions: {} }).valid, false);
  assert.equal(checkPluginCompatibility(manifest, { netcattyVersion: '1.0.0', features: ['views.vault-pages'] }).compatible, false);
  assert.equal(checkPluginCompatibility(manifest, { netcattyVersion: '1.0.0', features: ['views.terminal-sidebar'] }).compatible, true);
  assert.deepEqual(manifest.permissions.required, ['views']);
});
