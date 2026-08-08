import test from 'node:test';
import assert from 'node:assert/strict';

import type { PortForwardingRule } from './models/portForwarding.ts';
import {
  migratePortForwardingRulesFromStorage,
  toPersistedPortForwardingRule,
  toPersistedPortForwardingRules,
} from './portForwardingPersistence.ts';

const baseRule: PortForwardingRule = {
  id: 'rule-1',
  label: 'Tunnel',
  type: 'local',
  localPort: 8080,
  bindAddress: '127.0.0.1',
  remoteHost: '127.0.0.1',
  remotePort: 80,
  hostId: 'host-1',
  autoStart: true,
  createdAt: 1,
  status: 'active',
  error: 'stale',
  lastUsedAt: 99,
};

test('toPersistedPortForwardingRule clears runtime phase fields', () => {
  const persisted = toPersistedPortForwardingRule(baseRule);
  assert.equal(persisted.status, 'inactive');
  assert.equal(persisted.error, undefined);
  assert.equal(persisted.label, 'Tunnel');
  assert.equal(persisted.autoStart, true);
  assert.equal(persisted.lastUsedAt, 99);
});

test('toPersistedPortForwardingRules maps every rule', () => {
  const persisted = toPersistedPortForwardingRules([
    baseRule,
    { ...baseRule, id: 'rule-2', status: 'error', error: 'boom' },
  ]);
  assert.equal(persisted.length, 2);
  assert.ok(persisted.every((rule) => rule.status === 'inactive' && rule.error === undefined));
});

test('migratePortForwardingRulesFromStorage drops legacy active/connecting', () => {
  const migrated = migratePortForwardingRulesFromStorage([
    baseRule,
    { ...baseRule, id: 'rule-2', status: 'connecting' },
    { ...baseRule, id: 'rule-3', status: 'error', error: 'auth failed' },
    { ...baseRule, id: 'rule-4', status: 'inactive', error: undefined },
  ]);

  assert.equal(migrated[0]?.status, 'inactive');
  assert.equal(migrated[0]?.error, undefined);
  assert.equal(migrated[1]?.status, 'inactive');
  assert.equal(migrated[2]?.status, 'error');
  assert.equal(migrated[2]?.error, 'auth failed');
  assert.equal(migrated[3]?.status, 'inactive');
});
