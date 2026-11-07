import assert from 'node:assert/strict';
import test from 'node:test';
import { executePluginHostAction, type PluginHostAction, type PluginHostActionVault } from './pluginHostActionExecution';
import { PluginHostActionResources } from './pluginHostActionResources';
import type { Host, ManagedSource } from '../../domain/models';

const synthetic: Host = { id: 'synthetic', label: 'Synthetic', hostname: 'synthetic.invalid', username: 'test', tags: [], os: 'linux', password: 'synthetic-only', startupCommand: 'synthetic-script' };

function fixture() {
  const resources = new PluginHostActionResources();
  let active = true, authorized = 0, connections = 0, writes = 0;
  let beforeRead: (() => void) | undefined;
  let beforeCommit: (() => void) | undefined;
  let duringAuthorize: (() => void) | undefined;
  let storedSources: ManagedSource[] | undefined;
  const vault: PluginHostActionVault = {
    hosts: [synthetic], customGroups: [], groupConfigs: [], snippets: [], managedSources: [], isInitialized: true,
    async readPersistedHosts() { beforeRead?.(); return [structuredClone(synthetic)]; },
    async commitVaultImportTransaction(next, groups, sources, _configs, _expected, _lock, authorize) {
      const nextSources = sources(storedSources ?? vault.managedSources);
      beforeCommit?.();
      await authorize?.();
      writes++; vault.hosts = next;
      return { status: 'persisted', groups: groups([]), sources: nextSources, groupConfigs: [] };
    },
  };
  resources.observe(vault.hosts);
  const target = resources.metadata(synthetic.id);
  const options = {
    getVault: () => vault, resources,
    assertCurrent() { if (!active) throw new Error('Action cancelled'); },
    async authorizeCommit() { duringAuthorize?.(); if (!active) throw new Error('Action revoked'); authorized++; },
    connect(host: Host) { assert.equal(host, synthetic); connections++; return 'private-session-id'; },
  };
  return { vault, target, options, get authorized() { return authorized; }, get connections() { return connections; }, get writes() { return writes; },
    cancel() { active = false; }, beforeRead(fn: () => void) { beforeRead = fn; }, beforeCommit(fn: () => void) { beforeCommit = fn; }, duringAuthorize(fn: () => void) { duringAuthorize = fn; },
    storedSources(value: ManagedSource[]) { storedSources = value; },
  };
}

test('reviewed connection dispatches through existing handler and returns no session data', async () => {
  const f = fixture();
  assert.equal(await executePluginHostAction({ kind: 'connect', target: f.target }, f.options), 'requested');
  assert.equal(f.authorized, 1); assert.equal(f.connections, 1); assert.equal(f.writes, 0);
});

test('host edit preserves credentials and scripts and claims action authority after preparation', async () => {
  const f = fixture();
  assert.equal(await executePluginHostAction({ kind: 'edit', target: f.target, draft: { label: 'Reviewed' } }, f.options), 'saved');
  assert.equal(f.vault.hosts[0].password, synthetic.password);
  assert.equal(f.vault.hosts[0].startupCommand, synthetic.startupCommand);
  assert.equal(f.vault.hosts[0].label, 'Reviewed');
  assert.equal(f.authorized, 1); assert.equal(f.writes, 1); assert.equal(f.connections, 0);
});

for (const point of ['beforeRead', 'beforeCommit', 'duringAuthorize'] as const) test(`cancel/revoke at ${point} prevents the Vault write`, async () => {
  const f = fixture(); f[point](() => f.cancel());
  await assert.rejects(executePluginHostAction({ kind: 'edit', target: f.target, draft: { label: 'Never saved' } }, f.options), /cancelled|revoked/);
  assert.equal(f.writes, 0); assert.equal(f.connections, 0);
});

for (const change of ['remove', 'replace', 'scripts', 'locked'] as const) test(`${change} during awaited connection preparation prevents dispatch`, async () => {
  const f = fixture();
  f.beforeRead(() => {
    if (change === 'remove') f.vault.hosts = [];
    if (change === 'replace') f.vault.hosts = [{ ...synthetic }];
    if (change === 'scripts') f.vault.snippets = [];
    if (change === 'locked') f.cancel();
  });
  await assert.rejects(executePluginHostAction({ kind: 'connect', target: f.target }, f.options));
  assert.equal(f.authorized, 0); assert.equal(f.connections, 0);
});

test('create produces a saved SSH draft without executable or credential injection', async () => {
  const f = fixture();
  const action: PluginHostAction = { kind: 'create', draft: { hostname: 'new.invalid', label: 'New', group: 'Synthetic', password: 'untrusted', startupCommand: 'untrusted' } as never };
  assert.equal(await executePluginHostAction(action, f.options), 'saved');
  const created = f.vault.hosts[1];
  assert.notEqual(created.id, synthetic.id);
  assert.equal(created.password, undefined); assert.equal(created.startupCommand, undefined);
});

const managedSources: ManagedSource[] = [
  { id: 'synthetic-source-a', type: 'ssh_config', filePath: '/synthetic/a.conf', groupName: 'A', lastSyncedAt: 0 },
  { id: 'synthetic-source-b', type: 'ssh_config', filePath: '/synthetic/b.conf', groupName: 'B', lastSyncedAt: 0 },
];

for (const destination of ['B', 'Unmanaged', ''] as const) test(`managed A to ${destination || 'no group'} is refused before action authority or persistence`, async () => {
  const f = fixture();
  const host = { ...synthetic, group: 'A', managedSourceId: managedSources[0].id };
  f.vault.hosts = [host]; f.vault.managedSources = managedSources;
  f.vault.readPersistedHosts = async () => [structuredClone(host)];
  f.options.resources.observe(f.vault.hosts);
  const target = f.options.resources.metadata(host.id);
  await assert.rejects(executePluginHostAction({ kind: 'edit', target, draft: { group: destination } }, f.options), /Managed.*Vault/);
  assert.equal(f.writes, 0); assert.equal(f.authorized, 0);
  assert.equal(f.vault.hosts[0].managedSourceId, managedSources[0].id);
});

for (const kind of ['create', 'edit'] as const) test(`${kind} into a managed destination is refused`, async () => {
  const f = fixture(); f.vault.managedSources = managedSources;
  const action: PluginHostAction = kind === 'create'
    ? { kind, draft: { hostname: 'new.invalid', group: 'B/Child' } }
    : { kind, target: f.target, draft: { group: 'B/Child' } };
  await assert.rejects(executePluginHostAction(action, f.options), /Managed.*Vault/);
  assert.equal(f.writes, 0); assert.equal(f.authorized, 0);
});

test('ordinary unmanaged moves preserve the managed-source catalog without taking ownership', async () => {
  const f = fixture(); f.vault.managedSources = managedSources;
  assert.equal(await executePluginHostAction({ kind: 'edit', target: f.target, draft: { group: 'Unmanaged' } }, f.options), 'saved');
  assert.equal(f.vault.hosts[0].managedSourceId, undefined);
  assert.equal(f.vault.hosts[0].group, 'Unmanaged');
  assert.equal(f.vault.managedSources, managedSources);
});

test('a managed-source catalog replacement during preparation prevents the write', async () => {
  const f = fixture();
  f.beforeCommit(() => { f.vault.managedSources = managedSources; });
  await assert.rejects(executePluginHostAction({ kind: 'create', draft: { hostname: 'new.invalid', group: 'B' } }, f.options), /Managed sources changed/);
  assert.equal(f.writes, 0); assert.equal(f.authorized, 0);
});

test('a newer persisted managed-source catalog rejects a stale unmanaged preview before the claim', async () => {
  const f = fixture(); f.storedSources(managedSources);
  await assert.rejects(executePluginHostAction({ kind: 'create', draft: { hostname: 'new.invalid', group: 'B' } }, f.options), /Managed sources changed/);
  assert.equal(f.writes, 0); assert.equal(f.authorized, 0);
});
