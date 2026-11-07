import assert from 'node:assert/strict';
import test from 'node:test';
import { PluginHostActionResources } from './pluginHostActionResources';
import type { Host } from '../../domain/models';

const first: Host = { id: 'synthetic-1', label: 'First', hostname: 'first.invalid', username: 'test', tags: [], os: 'linux', group: 'Synthetic', password: 'synthetic-password', startupCommand: 'synthetic-script', totp: { uri: 'synthetic-totp' } as never };

test('selected metadata projects only the allowlist and replacement invalidates revision', () => {
  const resources = new PluginHostActionResources();
  resources.observe([first]);
  const metadata = resources.metadata(first.id);
  assert.deepEqual(Object.keys(metadata), ['resourceId', 'revision', 'label', 'hostname', 'username', 'protocol', 'group', 'tags']);
  assert.equal(JSON.stringify(metadata).includes('synthetic-password'), false);
  resources.observe([first]);
  assert.equal(resources.resolve(first.id, metadata.revision), first);
  resources.observe([{ ...first }]);
  assert.throws(() => resources.resolve(first.id, metadata.revision), /changed/);
  const replaced = resources.metadata(first.id);
  resources.observe([]);
  assert.throws(() => resources.resolve(first.id, replaced.revision), /changed/);
  resources.observe([first]);
  assert.throws(() => resources.resolve(first.id, replaced.revision), /changed/);
});

test('group choices are explicit current members and never expand to later members', () => {
  const resources = new PluginHostActionResources();
  resources.observe([first]);
  const selection = [resources.metadata(first.id)];
  resources.observe([first, { ...first, id: 'synthetic-2' }]);
  assert.deepEqual(selection.map((item) => item.resourceId), [first.id]);
  assert.equal(resources.resolve(first.id, selection[0].revision), first);
});
