import assert from 'node:assert/strict';
import test from 'node:test';
import { applyPluginHostEdit, normalizePluginHostDraft, pluginHostFieldDiff, pluginHostRunsSavedScripts } from './pluginHostActions';
import type { Host, Snippet } from './models';

const host: Host = { id: 'synthetic-host', label: 'Synthetic', hostname: 'host.invalid', username: 'test', os: 'linux', tags: [], password: 'synthetic-secret', startupCommand: 'synthetic-script' };

test('host action drafts reuse importer normalization and discard credential/executable fields', () => {
  const created = normalizePluginHostDraft({ ...host, password: 'untrusted', protocol: 'local' } as never, 'host-owned-id');
  assert.equal(created.id, 'host-owned-id');
  assert.equal(created.protocol, 'ssh');
  assert.equal(created.password, undefined);
  assert.equal(created.startupCommand, undefined);
  assert.throws(() => normalizePluginHostDraft({ hostname: 'host.invalid', port: 0 }, 'id'));
  assert.throws(() => normalizePluginHostDraft({ hostname: 'host.invalid\ninvalid' }, 'id'));
  assert.throws(() => normalizePluginHostDraft({ hostname: 'host.invalid other.invalid' }, 'id'));
});

test('edit draft preserves saved connection and credentials and diff includes only approved metadata', () => {
  const edited = applyPluginHostEdit(host, { label: ' Renamed ', tags: ['new'], hostname: 'attacker.invalid', password: 'untrusted' } as never);
  assert.equal(edited.password, host.password);
  assert.equal(edited.hostname, host.hostname);
  assert.equal(edited.startupCommand, host.startupCommand);
  assert.throws(() => applyPluginHostEdit(host, { label: ' ' }), /required/);
  assert.deepEqual(pluginHostFieldDiff(host, edited), [
    { field: 'label', before: 'Synthetic', after: 'Renamed' },
    { field: 'tags', before: [], after: ['new'] },
  ]);
  assert.equal(JSON.stringify(pluginHostFieldDiff(undefined, normalizePluginHostDraft(host, 'id'))).includes('synthetic-secret'), false);
});

test('connection warning covers host, inherited, global and output automation without returning script content', () => {
  const clean = { ...host, startupCommand: undefined };
  assert.equal(pluginHostRunsSavedScripts(clean, [], []), false);
  assert.equal(pluginHostRunsSavedScripts(host, [], []), true);
  assert.equal(pluginHostRunsSavedScripts({ ...clean, group: 'Synthetic' }, [{ path: 'Synthetic', startupCommand: 'synthetic-group-script' }], []), true);
  assert.equal(pluginHostRunsSavedScripts(clean, [], [{ id: 'global', label: 'Global', command: 'synthetic', kind: 'script', trigger: 'onConnect', targetsAllHosts: true } as Snippet]), true);
  assert.equal(pluginHostRunsSavedScripts(clean, [], [{ id: 'output', label: 'Output', command: 'synthetic', kind: 'script', trigger: 'onOutput', triggerPattern: 'ready' } as Snippet]), true);
  assert.equal(pluginHostRunsSavedScripts({ ...clean, outputTriggers: [{ id: 't', pattern: 'ready', scriptId: 'synthetic' }] }, [], []), true);
});
