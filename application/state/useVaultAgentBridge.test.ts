import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  applyAgentNotesUpdate,
  haveSameVaultAgentSnapshot,
  resolveVaultAgentEffectiveHost,
  resolveVaultAgentNotes,
} from './useVaultAgentBridge';
import type { Host } from '../../domain/models';
import { publishNotesSnapshot } from './notesStore';

type Snapshot = Parameters<typeof haveSameVaultAgentSnapshot>[0];

describe('haveSameVaultAgentSnapshot', () => {
  it('compares every snapshot field by reference', () => {
    const snapshot: Snapshot = {
      hosts: [], keys: [], notes: [], snippets: [], customGroups: [], groupConfigs: [],
      portForwardingRules: [], managedSources: [],
    };
    assert.equal(haveSameVaultAgentSnapshot(snapshot, { ...snapshot }), true);
    for (const key of Object.keys(snapshot) as Array<keyof Snapshot>) {
      assert.equal(
        haveSameVaultAgentSnapshot(snapshot, { ...snapshot, [key]: [] }),
        false,
        key,
      );
    }
  });
});

describe('applyAgentNotesUpdate', () => {
  it('rolls back an unsaved agent note before a later successful write', () => {
    const oldNotes = [{ id: 'old', title: 'Old', content: 'old', createdAt: 1, updatedAt: 1 }];
    const noteA = { id: 'a', title: 'A', content: 'a', createdAt: 2, updatedAt: 2 };
    const noteB = { id: 'b', title: 'B', content: 'b', createdAt: 3, updatedAt: 3 };
    let inMemory = oldNotes;
    let persisted = oldNotes;
    let failNext = true;
    const updateNotes = (notes: typeof oldNotes) => {
      inMemory = notes;
      if (failNext) {
        failNext = false;
        return false;
      }
      persisted = notes;
      return true;
    };

    assert.equal(applyAgentNotesUpdate([...oldNotes, noteA], oldNotes, updateNotes), false);
    assert.deepEqual(inMemory, oldNotes);
    assert.deepEqual(persisted, oldNotes);

    assert.equal(applyAgentNotesUpdate([...inMemory, noteB], inMemory, updateNotes), true);
    assert.deepEqual(persisted.map((note) => note.id), ['old', 'b']);
  });
});

describe('resolveVaultAgentEffectiveHost', () => {
  it('uses the latest snapshotted group defaults', () => {
    const host: Host = {
      id: 'host-1', label: 'Host', hostname: 'host.test', username: 'root',
      group: 'production', tags: [], os: 'linux',
    };

    assert.equal(
      resolveVaultAgentEffectiveHost(host, [{ path: 'production', protocol: 'telnet' }], []).protocol,
      'telnet',
    );
  });
});

describe('resolveVaultAgentNotes', () => {
  it('prefers the live notes store when App omitted the notes prop', () => {
    const stale: Snapshot['notes'] = [];
    const live = [{ id: 'n1', title: 'Live', content: 'x', updatedAt: 1 }] as Snapshot['notes'];
    publishNotesSnapshot({ notes: live, noteGroups: [] });
    assert.equal(resolveVaultAgentNotes(undefined, stale as never), live);
    assert.equal(resolveVaultAgentNotes(stale as never, stale as never), stale);
  });
});
