import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

import type { Host } from '../../domain/models';
import type { VaultGroupMutationState } from '../../domain/vaultGroupMutation';
import { useVaultHostDeletion } from './useVaultHostDeletion';
import { commitVaultGroupMutationPersistence } from './vaultGroupMutationPersistence';
import {
  STORAGE_KEY_GROUP_CONFIGS,
  STORAGE_KEY_HOSTS,
} from '../../infrastructure/config/storageKeys';

const host = (id: string, hostIds?: string[]): Host => ({
  id, label: id, hostname: `${id}.test`, username: 'root', tags: [], os: 'linux',
  ...(hostIds ? { hostChain: { hostIds } } : {}),
});

async function withDeletion(
  commit: Parameters<typeof useVaultHostDeletion>[0],
  run: (remove: ReturnType<typeof useVaultHostDeletion>) => Promise<void>,
) {
  const environment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
  const previous = environment.IS_REACT_ACT_ENVIRONMENT;
  environment.IS_REACT_ACT_ENVIRONMENT = true;
  let remove!: ReturnType<typeof useVaultHostDeletion>;
  let renderer: ReactTestRenderer | undefined;
  function Probe() {
    remove = useVaultHostDeletion(commit);
    return null;
  }
  try {
    await act(async () => { renderer = create(React.createElement(Probe)); });
    await run(remove);
  } finally {
    await act(async () => { renderer?.unmount(); });
    environment.IS_REACT_ACT_ENVIRONMENT = previous;
  }
}

for (const removed of [['jump'], ['jump', 'extra']]) {
  test(`host deletion cleans latest host and group references together: ${removed.join(',')}`, async () => {
    const latest: VaultGroupMutationState = {
      hosts: [host('jump'), host('extra'), host('kept'), host('target', ['jump', 'kept'])],
      configs: [{ path: 'prod', username: 'latest-user', hostChain: { hostIds: ['jump'] } }],
      groups: ['prod'], managedSources: [], snippets: [],
    };
    let committed: VaultGroupMutationState | undefined;
    await withDeletion(async (mutate) => {
      const result = mutate(latest);
      if (result.ok) committed = result.state;
      return result;
    }, async (remove) => { await act(async () => { await remove(removed); }); });
    assert.ok(committed);
    assert.deepEqual(committed.hosts.map((item) => item.id),
      removed.length === 1 ? ['extra', 'kept', 'target'] : ['kept', 'target']);
    assert.deepEqual(committed.hosts.at(-1)?.hostChain, { hostIds: ['kept'] });
    assert.deepEqual(committed.configs[0], {
      path: 'prod', username: 'latest-user', hostChain: { hostIds: [] },
    });
    assert.equal(committed.snippets, latest.snippets);
    assert.deepEqual(latest.hosts.at(-1)?.hostChain, { hostIds: ['jump', 'kept'] });
  });
}

test('a failed group-config write rolls host deletion back and reports failure', async () => {
  const original = {
    [STORAGE_KEY_HOSTS]: [host('jump'), host('target', ['jump'])],
    [STORAGE_KEY_GROUP_CONFIGS]: [{ path: 'prod', hostChain: { hostIds: ['jump'] } }],
  };
  const values = new Map(Object.entries(original).map(([key, value]) => [key, JSON.stringify(value)]));
  const storage = {
    read: <T,>(key: string): T | null => JSON.parse(values.get(key) ?? 'null'),
    readString: (key: string) => values.get(key) ?? null,
    write: <T,>(key: string, value: T) => {
      if (key === STORAGE_KEY_GROUP_CONFIGS) return false;
      values.set(key, JSON.stringify(value));
      return true;
    },
    writeString: (key: string, value: string) => { values.set(key, value); return true; },
    remove: (key: string) => { values.delete(key); },
  };
  const identity = async <T,>(value: T) => value;
  await withDeletion((mutate) => commitVaultGroupMutationPersistence({
    storage, mutate, prepareState: (value) => value,
    decryptHosts: identity, decryptConfigs: identity,
    encryptHosts: identity, encryptConfigs: identity, isCurrent: () => true,
  }), async (remove) => {
    await assert.rejects(remove(['jump']), /rejected importer transaction/);
  });
  for (const [key, value] of Object.entries(original)) {
    assert.deepEqual(storage.read(key), value);
  }
});

test('host deletion reports a rejected or superseded transaction', async () => {
  for (const failure of [{ ok: false, error: 'unavailable' }, { ok: false, superseded: true }] as const) {
    await withDeletion(async () => failure, async (remove) => {
      await assert.rejects(remove(['jump']), /unavailable|superseded/);
    });
  }
});
