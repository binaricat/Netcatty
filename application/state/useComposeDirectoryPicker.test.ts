import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { useComposeDirectoryPicker } from './useComposeDirectoryPicker';
import { createTerminalDirectoryController } from './terminalDirectoryController';
import { refreshObservedTerminalDirectory, registerTerminalDirectory } from './terminalDirectoryRegistry';
import { terminalCwdStore } from './terminalCwdStore';
import { DirectoryPickerError } from '../../domain/directoryPicker';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

test('opening loads children once; search is local; unmount stops chip refresh demand', async () => {
  let reads = 0; let probes = 0;
  const id = 'hook-directory';
  const controller = createTerminalDirectoryController({ sessionId: id,
    io: { cwd: async () => { probes++; return '/base'; }, realpath: async path => path, write() {},
      list: async () => { reads++; return { home: '/base', entries: [{ name: 'child', path: '/base/child', hidden: false }] }; } },
    isCurrent: () => true, isReady: () => true,
    publish: cwd => { terminalCwdStore.setCwd(id, cwd, 'backend-strict'); },
  });
  const cleanup = registerTerminalDirectory(id, controller);
  let model!: ReturnType<typeof useComposeDirectoryPicker>;
  function Harness() { model = useComposeDirectoryPicker(id); return null; }
  let root!: ReactTestRenderer;
  await act(async () => { root = create(React.createElement(Harness)); });
  assert.equal(model.cwd, '/base');
  await act(async () => { model.setOpen(true); });
  assert.equal(reads, 1);
  await act(async () => { model.setQuery('CH'); });
  assert.equal(model.entries.length, 1);
  assert.equal(reads, 1);
  await act(async () => { root.unmount(); });
  const before = probes;
  refreshObservedTerminalDirectory(id);
  await Promise.resolve();
  assert.equal(probes, before);
  cleanup();
});

test('switching terminal cancels an old directory read and closes its popover', async () => {
  let finish!: (value: { entries: { name: string; path: string; hidden: boolean }[]; home: null }) => void;
  const cleanups = ['hook-a', 'hook-b'].map(id => registerTerminalDirectory(id, createTerminalDirectoryController({
    sessionId: id, isCurrent: () => true, isReady: () => true,
    io: { cwd: async () => '/' + id, realpath: async path => path, write() {},
      list: () => new Promise(resolve => { finish = resolve; }) },
    publish: cwd => { terminalCwdStore.setCwd(id, cwd, 'backend-strict'); },
  })));
  let model!: ReturnType<typeof useComposeDirectoryPicker>;
  function Harness({ id }: { id: string }) { model = useComposeDirectoryPicker(id); return null; }
  let root!: ReactTestRenderer;
  await act(async () => { root = create(React.createElement(Harness, { id: 'hook-a' })); });
  await act(async () => { model.setOpen(true); });
  await act(async () => { root.update(React.createElement(Harness, { id: 'hook-b' })); });
  await act(async () => { finish({ entries: [{ name: 'old', path: '/hook-a/old', hidden: false }], home: null }); });
  assert.equal(model.open, false);
  assert.equal(model.cwd, '/hook-b');
  assert.deepEqual(model.entries, []);
  await act(async () => { root.unmount(); });
  cleanups.forEach(cleanup => cleanup());
});

test('reconnect after an aborted listing allows manual recovery from a failed cwd probe', async t => {
  const id = 'hook-directory-reconnect';
  let finishOld!: (value: { entries: { name: string; path: string; hidden: boolean }[]; home: null }) => void;
  const oldController = createTerminalDirectoryController({
    sessionId: id, isCurrent: () => true, isReady: () => true,
    io: { cwd: async () => '/old', realpath: async value => value, write() {},
      list: () => new Promise(resolve => { finishOld = resolve; }) },
    publish: cwd => { terminalCwdStore.setCwd(id, cwd, 'backend-strict'); },
  });
  const unregisterOld = registerTerminalDirectory(id, oldController);
  let model!: ReturnType<typeof useComposeDirectoryPicker>;
  function Harness() { model = useComposeDirectoryPicker(id); return null; }
  let root!: ReactTestRenderer;
  let unregisterNew = () => {};
  t.after(async () => {
    await act(async () => { root.unmount(); });
    unregisterOld(); unregisterNew();
  });
  await act(async () => { root = create(React.createElement(Harness)); });
  await act(async () => { model.setOpen(true); });
  assert.equal(model.loading, true);
  // Close while the request is pending, so the read is already aborted when
  // the disconnect disposes its controller and settles the old promise.
  await act(async () => { model.setOpen(false); });
  await act(async () => { unregisterOld(); terminalCwdStore.setCwd(id, null); });
  let failProbe = true;
  const nextController = createTerminalDirectoryController({
    sessionId: id, isCurrent: () => true, isReady: () => true,
    io: { cwd: async () => { if (failProbe) throw new DirectoryPickerError('unknown'); return '/recovered'; },
      realpath: async value => value, write() {},
      list: async () => ({ entries: [{ name: 'new', path: '/recovered/new', hidden: false }], home: null }) },
    publish: cwd => { terminalCwdStore.setCwd(id, cwd, 'backend-strict'); },
  });
  await act(async () => { unregisterNew = registerTerminalDirectory(id, nextController); });
  assert.equal(model.cwd, null);
  assert.equal(model.error, 'unknown');
  assert.equal(model.loading, false, 'cancelled reads must not leave the manual Refresh action disabled');
  await act(async () => { failProbe = false; await model.refresh(); model.setOpen(true); });
  assert.equal(model.cwd, '/recovered');
  assert.equal(model.loading, false);
  assert.deepEqual(model.entries.map(entry => entry.name), ['new']);
  await act(async () => { finishOld({ entries: [{ name: 'stale', path: '/old/stale', hidden: false }], home: null }); });
  assert.deepEqual(model.entries.map(entry => entry.name), ['new']);
});
