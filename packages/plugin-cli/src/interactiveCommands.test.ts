import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { validateManifestValue } from './manifest.js';
import { checkPluginCompatibility } from './compatibility.js';

const manifest = JSON.parse(await readFile(new URL('../../../examples/plugins/host-interactions/netcatty.plugin.json', import.meta.url), 'utf8'));
test('interactive command budget requires feature negotiation without changing ordinary command admission', () => {
  assert.equal(validateManifestValue(manifest).valid, true);
  assert.equal(validateManifestValue({ ...manifest, features: { required: ['host.interactions'] } }).valid, false);
  assert.equal(checkPluginCompatibility(manifest, { netcattyVersion: '1.0.0', features: ['host.interactions'] }).compatible, false);
  assert.equal(checkPluginCompatibility(manifest, { netcattyVersion: '1.0.0', features: ['host.interactions', 'commands.interactive'] }).compatible, true);
  const legacy = structuredClone(manifest); delete legacy.contributes.commands[0].interactive; legacy.features.required = ['host.interactions'];
  assert.equal(validateManifestValue(legacy).valid, true);
});
