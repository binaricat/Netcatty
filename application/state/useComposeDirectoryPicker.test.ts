import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { useComposeDirectoryPicker } from './useComposeDirectoryPicker';
import { createTerminalDirectoryController } from './terminalDirectoryController';
import { refreshObservedTerminalDirectory, registerTerminalDirectory } from './terminalDirectoryRegistry';
import { terminalCwdStore } from './terminalCwdStore';

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
