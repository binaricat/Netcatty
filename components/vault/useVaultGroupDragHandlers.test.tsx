import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import type { Host, ManagedSource } from '../../types';
import { useVaultGroupDragHandlers } from './useVaultGroupDragHandlers';

const host = (id: string, extra: Partial<Host> = {}): Host => ({
  id, label: `Host ${id}`, hostname: `${id}.example`, username: 'user', port: 22,
  tags: ['keep'], group: 'Old', ...extra,
});

test('bulk group move publishes all selected hosts together and preserves unselected hosts', async () => {
  const original = [host('a'), host('b', { protocol: 'telnet' }), host('c')];
  const writes: Host[][] = [];
  await withActions(original, [], actions => {
    act(() => actions.moveHostsToGroup(new Set(['a', 'b']), 'New/Nested'));
    assert.equal(writes.length, 1);
    assert.deepEqual(writes[0].map(h => h.group), ['New/Nested', 'New/Nested', 'Old']);
    assert.equal(writes[0][2], original[2]);
    assert.deepEqual(writes[0][0].tags, ['keep']);
    assert.equal(writes[0][0].hostname, original[0].hostname);
  }, writes);
});

test('mixed protocols entering and leaving managed groups retain single-host move rules', async () => {
  const original = [host('ssh'), host('telnet', { protocol: 'telnet' }), host('local', { protocol: 'local' })];
  const sources = [{ id: 'parent', groupName: 'Managed' }, { id: 'child', groupName: 'Managed/Nested' }] as ManagedSource[];
  const writes: Host[][] = [];
  await withActions(original, sources, actions => {
    act(() => actions.moveHostsToGroup(new Set(original.map(h => h.id)), 'Managed/Nested'));
    assert.equal(writes.length, 1);
    assert.equal(writes[0][0].managedSourceId, 'child');
    assert.equal(writes[0][0].label, 'Hostssh');
    assert.equal(writes[0][1].managedSourceId, undefined);
    assert.equal(writes[0][1].label, 'Host telnet');
    assert.equal(writes[0][2].managedSourceId, undefined);
    assert.equal(writes[0][2].label, 'Host local');
  }, writes);
  await withActions(writes[0], sources, actions => {
    act(() => actions.moveHostsToGroup(new Set(original.map(h => h.id)), null));
    assert.deepEqual(writes[1].map(h => h.group), ['', '', '']);
    assert.ok(writes[1].every(h => h.managedSourceId === undefined));
  }, writes);
});

test('same-group, missing and empty selections do not publish changes', async () => {
  const writes: Host[][] = [];
  await withActions([host('a')], [], actions => {
    act(() => actions.moveHostsToGroup(new Set(['a']), 'Old'));
    act(() => actions.moveHostsToGroup(new Set(['missing']), 'New'));
    act(() => actions.moveHostsToGroup(new Set(), 'New'));
    assert.equal(writes.length, 0);
    act(() => actions.moveHostToGroup('a', 'New'));
    assert.equal(writes.length, 1);
    assert.equal(writes[0][0].group, 'New');
  }, writes);
});

async function withActions(
  hosts: Host[], managedSources: ManagedSource[],
  run: (actions: ReturnType<typeof useVaultGroupDragHandlers>) => void,
  writes: Host[][],
) {
  const previousWindow = globalThis.window;
  const actEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
  const previousAct = actEnvironment.IS_REACT_ACT_ENVIRONMENT;
  actEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
  globalThis.window = { setTimeout: () => 1, clearTimeout: () => {} } as unknown as Window & typeof globalThis;
  let renderer: ReactTestRenderer | undefined;
  let actions: ReturnType<typeof useVaultGroupDragHandlers>;
  function Probe() {
    actions = useVaultGroupDragHandlers({ hosts, managedSources,
      onUpdateHosts: next => writes.push(next), onUpdateManagedSources: () => {}, t: key => key });
    return null;
  }
  try {
    await act(async () => { renderer = create(<Probe />); });
    run(actions!);
  } finally {
    await act(async () => renderer?.unmount());
    globalThis.window = previousWindow;
    actEnvironment.IS_REACT_ACT_ENVIRONMENT = previousAct;
  }
}
