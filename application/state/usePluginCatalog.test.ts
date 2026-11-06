import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { usePluginCatalog } from './usePluginCatalog';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (cause: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

test('README failures clear on retry/switch and stale requests cannot replace the selected entry', async (context) => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const calls: Array<{ id: string; request: ReturnType<typeof deferred<string>> }> = [];
  Object.defineProperty(globalThis, 'window', { configurable: true, value: {
    netcatty: {
      listPluginCatalog: async () => ({ entries: [], source: "builtin", error: null }),
      getPluginCatalogReadme: (id: string) => { const request = deferred<string>(); calls.push({ id, request }); return request.promise; },
    },
  } });
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  context.after(() => {
    if (original) Object.defineProperty(globalThis, 'window', original); else Reflect.deleteProperty(globalThis, 'window');
    Reflect.deleteProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT');
  });
  let state!: ReturnType<typeof usePluginCatalog>;
  let renders = 0;
  function Probe({ id }: { id: string }) { state = usePluginCatalog(id); renders++; return null; }
  let renderer!: ReactTestRenderer;
  await act(async () => { renderer = create(React.createElement(Probe, { id: 'first' })); });
  assert.equal(state.readmeStatus, 'loading');
  await act(async () => calls[0].request.reject(new Error('temporary failure')));
  assert.equal(state.readmeStatus, 'error');
  assert.match(state.readmeError!, /temporary failure/);
  await act(async () => state.retryReadme());
  assert.equal(state.readmeStatus, 'loading'); assert.equal(state.readmeError, null);
  await act(async () => calls[1].request.resolve(''));
  assert.equal(state.readmeStatus, 'ready'); assert.equal(state.readme, ''); assert.equal(state.readmeError, null);
  await act(async () => state.retryReadme());
  await act(async () => renderer.update(React.createElement(Probe, { id: 'second' })));
  assert.equal(state.readmeError, null);
  await act(async () => calls[3].request.resolve('# Second'));
  await act(async () => calls[2].request.reject(new Error('stale failure')));
  assert.equal(state.readme, '# Second'); assert.equal(state.readmeError, null);
  await act(async () => state.retryReadme());
  await act(async () => renderer.unmount());
  const unmountedRenders = renders;
  await act(async () => calls[4].request.resolve('late content'));
  assert.equal(renders, unmountedRenders);
});

test('offline snapshot stays browsable, retry clears warning, and operations bind the selected token', async (context) => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const entry = { id: 'com.test.registry', selectionToken: 'first' } as NetcattyPluginCatalogEntry;
  let offline = true;
  const reads: unknown[][] = []; const installs: unknown[][] = [];
  Object.defineProperty(globalThis, 'window', { configurable: true, value: {
    dispatchEvent() {}, netcatty: {
      listPluginCatalog: async () => ({ entries: [{ ...entry, selectionToken: offline ? 'first' : 'second' }], source: offline ? 'cached' : 'registry', error: offline ? 'offline' : null }),
      getPluginCatalogReadme: async (...args: unknown[]) => { reads.push(args); return '# Pinned'; },
      installCatalogPlugin: async (...args: unknown[]) => { installs.push(args); },
    },
  } });
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  context.after(() => {
    if (original) Object.defineProperty(globalThis, 'window', original); else Reflect.deleteProperty(globalThis, 'window');
    Reflect.deleteProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT');
  });
  let state!: ReturnType<typeof usePluginCatalog>;
  function Probe() { state = usePluginCatalog(entry.id); return null; }
  let renderer!: ReactTestRenderer;
  await act(async () => { renderer = create(React.createElement(Probe)); });
  assert.equal(state.entries.length, 1); assert.equal(state.listStatus, 'ready'); assert.equal(state.listError, 'offline');
  assert.equal(state.source, 'cached');
  offline = false;
  await act(async () => state.retryList());
  assert.equal(state.listError, null); assert.equal(state.source, 'registry');
  assert.deepEqual(reads.at(-1), [entry.id, 'second', 'official']);
  await act(async () => state.install(entry.id));
  assert.deepEqual(installs, [[entry.id, 'second', 'official', undefined]]);
  await act(async () => renderer.unmount());
});
