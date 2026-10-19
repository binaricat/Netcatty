import test from 'node:test';
import assert from 'node:assert/strict';
import { cloudSyncPayloadsEqual, inheritOmittedLegacySyncFields } from './legacy';
import type { SyncPayload } from '../sync';

const payload = (overrides: Partial<SyncPayload> = {}): SyncPayload => ({
  hosts: [], keys: [], snippets: [], customGroups: [], syncedAt: 0, ...overrides,
});
const sessions = [{ id: 'chat-1', updatedAt: 1, messages: [{ id: 'm1', content: 'hello' }] }] as SyncPayload['aiSessions'];

test('chat-only changes participate in cloud payload equality', () => {
  const base = payload({ aiSessions: sessions });
  assert.equal(cloudSyncPayloadsEqual(base, payload({ aiSessions: sessions, syncedAt: 123 })), true);
  assert.equal(cloudSyncPayloadsEqual(base, payload({ aiSessions: [] })), false);
  const changed = structuredClone(base);
  changed.aiSessions![0].messages[0].content = 'complete';
  assert.equal(cloudSyncPayloadsEqual(base, changed), false);
});

test('unsupported omitted chat fields inherit baseline, while explicit empty remains a reset', () => {
  const base = payload({ aiSessions: sessions });
  assert.equal(cloudSyncPayloadsEqual(base, inheritOmittedLegacySyncFields(base, payload())), true);
  assert.equal(cloudSyncPayloadsEqual(base, inheritOmittedLegacySyncFields(base, payload({ aiSessions: [] }))), false);
});
