import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { validateManifestValue } from './manifest.js';
const manifest = JSON.parse(await readFile(new URL('../../../examples/plugins/terminal-selection-draft/netcatty.plugin.json', import.meta.url), 'utf8'));
test('selection and draft declarations are additive, optional-only, and feature negotiated', () => {
  assert.equal(validateManifestValue(manifest).valid, true);
  for (const [permission, feature] of [['terminal.selection.read', 'terminal.selection-sharing'], ['terminal.input.propose', 'terminal.input-drafts']]) {
    const required = structuredClone(manifest);
    required.permissions.required.push(permission);
    required.permissions.optional = required.permissions.optional.filter((p: string) => p !== permission);
    assert.equal(validateManifestValue(required).valid, false);
    const missing = structuredClone(manifest);
    missing.features.required = missing.features.required.filter((f: string) => f !== feature);
    assert.equal(validateManifestValue(missing).valid, false);
    const optional = structuredClone(manifest);
    optional.features.required = optional.features.required.filter((f: string) => f !== feature);
    optional.features.optional = [feature];
    assert.equal(validateManifestValue(optional).valid, true);
  }
});
