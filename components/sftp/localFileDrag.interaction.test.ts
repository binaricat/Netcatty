import assert from 'node:assert/strict';
import test from 'node:test';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { JSDOM } from 'jsdom';
import { useSftpPaneDragAndSelect } from './hooks/useSftpPaneDragAndSelect';
import { clearLocalFileDrag } from '../../application/state/sftp/localFileDrag';
import type { SftpFileEntry } from '../../types';

test('list hook preserves local copy/move routing, remote HTML drag, selection and connection cleanup', async () => {
  const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: 'http://localhost' });
  const previous = new Map<string, PropertyDescriptor | undefined>();
  for (const [name, value] of Object.entries({ window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true })) {
    previous.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, value });
  }
  const starts: { paths: string[] }[] = [];
  Object.defineProperty(dom.window, 'netcatty', { value: {
    startLocalFileDrag: async (payload: { paths: string[] }) => { starts.push(payload); return { started: true }; },
    cancelLocalFileDrag() {},
    getPathForFile: (file: { path: string }) => file.path,
  }});
  const entries: SftpFileEntry[] = [
    { name: 'a.txt', type: 'file' }, { name: 'b.txt', type: 'file' }, { name: 'folder', type: 'directory' },
  ].map(entry => ({ ...entry, size: 0, sizeFormatted: '', lastModified: 0, lastModifiedFormatted: '' })) as SftpFileEntry[];
  const actions: { kind: string; args: unknown[] }[] = [];
  const record = (kind: string) => (...args: unknown[]) => { actions.push({ kind, args }); };
  let left!: ReturnType<typeof useSftpPaneDragAndSelect>;
  let right!: ReturnType<typeof useSftpPaneDragAndSelect>;
  let remoteDrag: Parameters<typeof useSftpPaneDragAndSelect>[0]['draggedFiles'] = null;
  function Harness({ local = true, connectionId = 'left' }) {
    const usePane = (side: 'left' | 'right') => useSftpPaneDragAndSelect({
      side, pane: { id: side, selectedFiles: new Set(['a.txt', 'folder']),
        connection: { id: side === 'left' ? connectionId : 'right', currentPath: '/files', isLocal: side === 'right' || local } },
      sortedDisplayFiles: entries, draggedFiles: remoteDrag,
      onDragStart: (files, origin) => { remoteDrag = files.map(file => ({ ...file, side: origin })); record('remote')(files); },
      onReceiveFromOtherPane: record('copy'), onMoveEntriesToPath: async (...args) => record('move')(...args),
      onUploadExternalFiles: async () => record('external')(), onOpenEntry() {}, onRangeSelect() {}, onToggleSelection() {},
    });
    left = usePane('left'); right = usePane('right');
    return null;
  }
  const event = (paths: string[] = []) => ({
    preventDefault() {}, stopPropagation() {},
    dataTransfer: { types: paths.length ? ['Files'] : [], files: paths.map(path => ({ path })), items: paths.map(() => ({})),
      effectAllowed: '', dropEffect: '', setData: record('text') },
  }) as unknown as React.DragEvent;
  const root = createRoot(dom.window.document.getElementById('root')!);
  try {
    await act(async () => root.render(React.createElement(Harness)));
    await act(async () => left.handleFileDragStart(entries[0], event()));
    assert.deepEqual(starts.at(-1)?.paths, ['/files/a.txt', '/files/folder']);
    await act(async () => right.handlePaneDrop(event(starts.at(-1)!.paths)));
    assert.deepEqual(actions.map(a => a.kind), ['copy']);
    assert.equal((actions[0].args[0] as unknown[]).length, 2);

    actions.length = 0;
    await act(async () => left.handleFileDragStart(entries[1], event()));
    assert.deepEqual(starts.at(-1)?.paths, ['/files/b.txt'], 'dragging an unselected row excludes the old selection');
    await act(async () => left.handleEntryDrop(entries[2], event(starts.at(-1)!.paths)));
    assert.deepEqual(actions, [{ kind: 'move', args: [['/files/b.txt'], '/files/folder'] }]);

    actions.length = 0;
    await act(async () => left.handleFileDragStart(entries[1], event()));
    await act(async () => root.render(React.createElement(Harness, { connectionId: 'replacement' })));
    await act(async () => right.handlePaneDrop(event(['/files/b.txt'])));
    assert.deepEqual(actions.map(a => a.kind), ['external'], 'connection replacement invalidates internal native identity');

    actions.length = 0;
    await act(async () => root.render(React.createElement(Harness, { local: false })));
    const before = starts.length;
    await act(async () => left.handleFileDragStart(entries[1], event()));
    assert.equal(starts.length, before, 'remote path never reaches native bridge');
    assert.deepEqual(actions.map(a => a.kind), ['text', 'remote']);
    await act(async () => root.render(React.createElement(Harness, { local: false })));
    await act(async () => right.handlePaneDrop(event()));
    assert.equal(actions.at(-1)?.kind, 'copy');
  } finally {
    await act(async () => root.unmount());
    clearLocalFileDrag();
    dom.window.close();
    for (const [name, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
  }
});
