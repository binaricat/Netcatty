import assert from 'node:assert/strict';
import test from 'node:test';
import { STORAGE_KEY_PLUGIN_IMPORT_TRANSACTION } from '../../infrastructure/config/storageKeys';
import {
  commitPluginImporterTransaction,
  recoverPluginImporterTransaction,
} from './pluginImporterTransaction';

const storage = (initial: Record<string, string> = {}) => {
  const values = new Map(Object.entries(initial));
  return {
    values,
    read<T>(key: string): T | null {
      const value = values.get(key);
      return value === undefined ? null : JSON.parse(value) as T;
    },
    readString: (key: string) => values.get(key) ?? null,
    write<T>(key: string, value: T) { values.set(key, JSON.stringify(value)); return true; },
    writeString(key: string, value: string) { values.set(key, value); return true; },
    remove(key: string) { values.delete(key); },
  };
};

test('plugin importer transaction commits all keys and removes its journal', () => {
  const target = storage({ hosts: JSON.stringify(['old']) });
  commitPluginImporterTransaction(target, [
    ['hosts', ['new']],
    ['keys', ['key']],
  ]);
  assert.deepEqual(target.read('hosts'), ['new']);
  assert.deepEqual(target.read('keys'), ['key']);
  assert.equal(target.readString(STORAGE_KEY_PLUGIN_IMPORT_TRANSACTION), null);
});

test('plugin importer recovery rolls back a crash during the prepared phase', () => {
  const target = storage({ hosts: JSON.stringify(['partial']), keys: JSON.stringify(['old-key']) });
  target.write(STORAGE_KEY_PLUGIN_IMPORT_TRANSACTION, {
    version: 1,
    phase: 'prepared',
    previous: [
      { key: 'hosts', value: JSON.stringify(['old-host']) },
      { key: 'keys', value: JSON.stringify(['old-key']) },
    ],
  });
  assert.equal(recoverPluginImporterTransaction(target, new Set(['hosts', 'keys'])), 'rolled-back');
  assert.deepEqual(target.read('hosts'), ['old-host']);
  assert.deepEqual(target.read('keys'), ['old-key']);
  assert.equal(target.readString(STORAGE_KEY_PLUGIN_IMPORT_TRANSACTION), null);
});

test('Vault importer recovery accepts a safe subset of transaction keys', () => {
  const target = storage({ groups: JSON.stringify(['partial']), sources: JSON.stringify(['partial-source']) });
  target.write(STORAGE_KEY_PLUGIN_IMPORT_TRANSACTION, {
    version: 1,
    phase: 'prepared',
    previous: [
      { key: 'groups', value: JSON.stringify(['old-group']) },
      { key: 'sources', value: JSON.stringify(['old-source']) },
    ],
  });

  assert.equal(
    recoverPluginImporterTransaction(target, new Set(['hosts', 'groups', 'sources'])),
    'rolled-back',
  );
  assert.deepEqual(target.read('groups'), ['old-group']);
  assert.deepEqual(target.read('sources'), ['old-source']);
});

test('Vault importer transaction rejects writes that do not actually persist', () => {
  const target = storage({ hosts: JSON.stringify(['old']) });
  const lyingStorage = {
    ...target,
    write<T>(key: string, value: T) {
      if (key === 'hosts') return true;
      return target.write(key, value);
    },
  };

  assert.throws(
    () => commitPluginImporterTransaction(lyingStorage, [['hosts', ['new']]]),
    /rejected importer transaction/,
  );
  assert.deepEqual(target.read('hosts'), ['old']);
});

test('Vault importer transaction preserves an unfinished recovery record', () => {
  const recoveryRecord = JSON.stringify({
    version: 1,
    phase: 'prepared',
    previous: [{ key: 'hosts', value: JSON.stringify(['old']) }],
  });
  const target = storage({
    hosts: JSON.stringify(['partial']),
    [STORAGE_KEY_PLUGIN_IMPORT_TRANSACTION]: recoveryRecord,
  });

  assert.throws(
    () => commitPluginImporterTransaction(target, [['hosts', ['new']]]),
    /unfinished Vault import recovery record/,
  );
  assert.equal(target.readString(STORAGE_KEY_PLUGIN_IMPORT_TRANSACTION), recoveryRecord);
  assert.deepEqual(target.read('hosts'), ['partial']);
});

test('plugin importer recovery keeps fully committed values', () => {
  const target = storage({ hosts: JSON.stringify(['new']) });
  target.write(STORAGE_KEY_PLUGIN_IMPORT_TRANSACTION, { version: 1, phase: 'committed' });
  assert.equal(recoverPluginImporterTransaction(target, new Set(['hosts'])), 'committed');
  assert.deepEqual(target.read('hosts'), ['new']);
});
