import assert from 'node:assert/strict';
import test from 'node:test';
import React, { useLayoutEffect } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { useSftpPaneVirtualList } from './hooks/useSftpPaneVirtualList';
import { useSftpPaneTreeRows } from './useSftpPaneTreeRows';
import type { SftpFileEntry } from '../../types';
import { installDomEnvironment } from '../test-support/renderReactDom';

const files: SftpFileEntry[] = Array.from({ length: 5000 }, (_, i) => ({
  name: `file-${i}.txt`, type: 'file', size: 1, lastModified: 0,
  sizeFormatted: '1 B', lastModifiedFormatted: '--',
}));

test('file windows stay bounded on the first commit, hidden tabs and measured scrolling', async (t) => {
  const dom = installDomEnvironment();
  const previousObserver = globalThis.ResizeObserver;
  let resize = () => {};
  globalThis.ResizeObserver = class implements ResizeObserver {
    constructor(callback: ResizeObserverCallback) { resize = () => callback([], this); }
    observe() {} unobserve() {} disconnect() {}
  };
  let nextFrame = 0;
  const frames = new Map<number, FrameRequestCallback>();
  dom.window.requestAnimationFrame = callback => { frames.set(++nextFrame, callback); return nextFrame; };
  dom.window.cancelAnimationFrame = id => { frames.delete(id); };
  const flushFrames = async () => {
    const batch = [...frames.values()]; frames.clear();
    await act(async () => { batch.forEach(callback => callback(0)); });
  };
  const node = { clientHeight: 600, scrollTop: 0, querySelector: () => ({ getBoundingClientRect: () => ({ height: measuredHeight }) }) };
  let measuredHeight = 44;
  let result!: ReturnType<typeof useSftpPaneVirtualList>;
  const commits: number[] = [];
  function Fixture({ active, entries = files, density = 'comfortable' }: { active: boolean; entries?: SftpFileEntry[]; density?: string }) {
    result = useSftpPaneVirtualList({ isActive: active, sortedDisplayFiles: entries, layoutKey: density });
    useLayoutEffect(() => { commits.push(result.visibleRows.length); });
    return React.createElement('div', { ref: result.fileListRef });
  }
  let renderer!: ReactTestRenderer;
  t.after(async () => {
    await act(async () => { renderer?.unmount(); });
    globalThis.ResizeObserver = previousObserver;
    dom.cleanup();
  });
  await act(async () => { renderer = create(React.createElement(Fixture, { active: true }), { createNodeMock: () => node }); });
  assert.ok(commits.every(count => count < 100), `initial commits must be bounded: ${commits}`);
  await flushFrames();
  node.scrollTop = 4999 * result.rowHeight;
  await act(async () => { result.handleFileListScroll({ currentTarget: node } as unknown as React.UIEvent<HTMLDivElement>); });
  await flushFrames();
  assert.equal(result.visibleRows.at(-1)?.entry, files.at(-1), 'the final file remains reachable');
  await act(async () => { renderer.update(React.createElement(Fixture, { active: false })); });
  assert.ok(result.shouldVirtualize && result.visibleRows.length < 100, 'hiding must retain the file window');
  assert.equal(result.visibleRows.at(-1)?.entry, files.at(-1));
  node.clientHeight = 0;
  await act(async () => { resize(); });
  await act(async () => { renderer.update(React.createElement(Fixture, { active: true })); });
  assert.ok(result.visibleRows.length < 100, 'a zero-size viewport must not mount every file');
  assert.equal(result.visibleRows.at(-1)?.entry, files.at(-1), 'restoring retains the last-file window');
  const fewerFiles = files.slice(0, 100);
  node.clientHeight = 600;
  node.scrollTop = fewerFiles.length * result.rowHeight - node.clientHeight;
  await act(async () => { renderer.update(React.createElement(Fixture, { active: false, entries: fewerFiles })); });
  assert.ok(result.visibleRows.length > 0, 'an inactive listing shrink must not leave an empty window');
  await act(async () => { renderer.update(React.createElement(Fixture, { active: true, entries: fewerFiles })); });
  assert.equal(result.visibleRows.at(-1)?.entry, fewerFiles.at(-1));
  assert.ok(result.visibleRows[0].top <= node.scrollTop, 'restoring reads the browser-clamped scroll position');
  assert.ok(result.visibleRows.at(-1)!.top + result.rowHeight >= node.scrollTop + node.clientHeight);
  measuredHeight = 24;
  await act(async () => { renderer.update(React.createElement(Fixture, { active: true, density: 'compact' })); resize(); });
  await flushFrames();
  assert.equal(result.rowHeight, 24, 'density is still measured from real rows');
  node.scrollTop = 0;
  await act(async () => { result.handleFileListScroll({ currentTarget: node } as unknown as React.UIEvent<HTMLDivElement>); });
  await flushFrames();
  assert.equal(result.visibleRows[0]?.entry, files[0]);
  await act(async () => { renderer.update(React.createElement(Fixture, { active: true, entries: files.slice(0, 10) })); });
  assert.equal(result.shouldVirtualize, false);
  assert.equal(result.visibleRows.length, 10);
});

test('tree windows stay bounded before measurement and when the viewport becomes hidden', async (t) => {
  const dom = installDomEnvironment();
  let result!: ReturnType<typeof useSftpPaneTreeRows>;
  const descriptors = files.map(entry => ({ type: 'node', entry, entryPath: `/fixture/${entry.name}`, depth: 0 }));
  function Fixture({ height, top = 0, count = files.length }: { height: number; top?: number; count?: number }) {
    result = useSftpPaneTreeRows({ nodeDescriptors: descriptors.slice(0, count), viewportHeight: height, scrollTop: top, selectedPaths: new Set(), tRef: { current: (key: string) => key } });
    return null;
  }
  let renderer!: ReactTestRenderer;
  t.after(async () => { await act(async () => { renderer?.unmount(); }); dom.cleanup(); });
  await act(async () => { renderer = create(React.createElement(Fixture, { height: 0 })); });
  assert.ok(result.visibleRange.virtualized && result.treeRows.length < 100, 'initial tree commit must be bounded');
  await act(async () => { renderer.update(React.createElement(Fixture, { height: 600, top: 4999 * 28 })); });
  assert.equal(result.visibleRange.end, 4999);
  await act(async () => { renderer.update(React.createElement(Fixture, { height: 0, top: 4999 * 28 })); });
  assert.ok(result.treeRows.length < 100, 'zero height must not mount every tree row');
  assert.equal(result.visibleRange.end, 4999);
  await act(async () => { renderer.update(React.createElement(Fixture, { height: 0, top: 4999 * 28, count: 100 })); });
  assert.ok(result.treeRows.length > 0, 'a hidden tree refresh must retain rows after the listing shrinks');
  assert.equal(result.visibleRange.end, 99);
  await act(async () => { renderer.update(React.createElement(Fixture, { height: 600, top: 4999 * 28, count: 100 })); });
  assert.ok(result.treeRows.length > 0);
  assert.equal(result.visibleRange.end, 99);
});
