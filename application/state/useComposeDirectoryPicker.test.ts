import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { useComposeDirectoryPicker } from './useComposeDirectoryPicker';
import { createTerminalDirectoryController } from './terminalDirectoryController';
import { refreshObservedTerminalDirectory, registerTerminalDirectory } from './terminalDirectoryRegistry';
import { terminalCwdStore } from './terminalCwdStore';
import { DirectoryPickerError, directoryChangeCommand } from '../../domain/directoryPicker';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

for (const outcome of ['complete', 'close', 'switch', 'repeated-reports'] as const) {
  test(`unchanged OSC 7 during directory loading retries within the active menu (${outcome})`, async t => {
    const id = 'hook-list-revision-' + outcome;
    const cwd = '/base';
    terminalCwdStore.setCwd(id, cwd, 'osc7');
    const pending: Array<(value: { entries: { name: string; path: string; hidden: boolean }[]; home: null }) => void> = [];
    let reads = 0;
    const controller = createTerminalDirectoryController({
      sessionId: id, isCurrent: () => true, isReady: () => true, publish() {},
      io: { cwd: async () => cwd, realpath: async value => value, write() {},
        list: () => { reads++; return new Promise(resolve => pending.push(resolve)); } },
    });
    const unregister = registerTerminalDirectory(id, controller);
    let model!: ReturnType<typeof useComposeDirectoryPicker>;
    function Harness({ session }: { session: string }) { model = useComposeDirectoryPicker(session); return null; }
    let root!: ReactTestRenderer;
    await act(async () => { root = create(React.createElement(Harness, { session: id })); });
    t.after(async () => { await act(async () => { root.unmount(); }); unregister(); });
    await act(async () => { model.setOpen(true); });
    const version = terminalCwdStore.getVersion();
    await act(async () => {
      terminalCwdStore.setCwd(id, cwd, 'osc7');
      pending.shift()!({ entries: [{ name: 'old', path: '/base/old', hidden: false }], home: null });
    });
    assert.equal(terminalCwdStore.getVersion(), version, 'unchanged reports keep the render version stable');
    assert.equal(reads, 2, 'an invalidated result triggers a fresh read');
    assert.equal(model.loading, true);
    assert.deepEqual(model.entries, []);
    if (outcome === 'close') await act(async () => { model.setOpen(false); });
    if (outcome === 'switch') await act(async () => { root.update(React.createElement(Harness, { session: id + '-other' })); });
    if (outcome === 'repeated-reports') {
      for (let attempt = 0; attempt < 2; attempt++) {
        await act(async () => {
          terminalCwdStore.setCwd(id, cwd, 'osc7');
          pending.shift()!({ entries: [], home: null });
        });
      }
      assert.equal(reads, 3, 'retries are bounded during continuous reports');
      assert.equal(model.error, 'readFailed');
      assert.equal(model.loading, false);
      return;
    }
    await act(async () => {
      pending.shift()!({ entries: [{ name: 'fresh', path: '/base/fresh', hidden: false }], home: null });
    });
    assert.equal(reads, 2);
    if (outcome === 'complete') {
      assert.deepEqual(model.entries.map(entry => entry.name), ['fresh']);
      assert.equal(model.error, null);
      assert.equal(model.loading, false);
    } else {
      assert.deepEqual(model.entries, [], 'cancelled results preserve menu/session isolation');
      assert.equal(model.open, false);
    }
  });
}

test('PowerShell non-filesystem reports clear an open menu and recover after returning to FileSystem', async t => {
  const id = 'hook-powershell-provider';
  let filesystem = true;
  const controller = createTerminalDirectoryController({
    sessionId: id, target: { authority: 'local:ps', pathFlavor: 'win32' },
    buildChangeCommand: path => directoryChangeCommand(path, 'powershell', 'win32'),
    isCurrent: () => true, isReady: () => true,
    io: { cwd: async () => { if (!filesystem) throw new DirectoryPickerError('nonFilesystem'); return 'C:\\base'; },
      home: async () => 'C:\\base', realpath: async value => value, write() {},
      list: async () => ({ home: 'C:\\base', entries: [{ name: 'child', path: 'C:\\base\\child', hidden: false }] }) },
    publish: cwd => terminalCwdStore.setCwd(id, cwd, 'backend-strict'),
  });
  const unregister = registerTerminalDirectory(id, controller);
  let model!: ReturnType<typeof useComposeDirectoryPicker>;
  function Harness() { model = useComposeDirectoryPicker(id); return null; }
  let root!: ReactTestRenderer;
  await act(async () => { root = create(React.createElement(Harness)); });
  t.after(async () => { await act(async () => { root.unmount(); }); unregister(); });
  await act(async () => { model.setOpen(true); });
  assert.equal(model.pathFlavor, 'win32');
  assert.equal(model.parent, 'C:\\');
  assert.equal(model.entries.length, 1);
  await act(async () => { filesystem = false; await controller.refresh().catch(() => {}); });
  assert.equal(model.cwd, null);
  assert.equal(model.home, null);
  assert.equal(model.error, 'nonFilesystem');
  assert.deepEqual(model.entries, []);
  await act(async () => { filesystem = true; await controller.refresh(); });
  assert.equal(model.cwd, 'C:\\base');
  assert.equal(model.error, null);
  assert.equal(model.entries.length, 1);
});

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
