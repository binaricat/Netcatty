import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { JSDOM } from 'jsdom';
import { createRoot } from 'react-dom/client';
import { act } from 'react-test-renderer';
import { STORAGE_KEY_COMPOSE_BAR_PINNED_SNIPPETS } from '../../infrastructure/config/storageKeys';
import { useComposeBarPinnedSnippets } from './useComposeBarPinnedSnippets';

function setupDom(t: test.TestContext) {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    url: 'http://localhost',
  });
  const globals = ['window', 'document', 'localStorage', 'CustomEvent', 'Event', 'StorageEvent'] as const;
  const originals = globals.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const);
  for (const name of globals) {
    Object.defineProperty(globalThis, name, { configurable: true, value: dom.window[name] });
  }
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const rootElement = dom.window.document.querySelector('#root')!;
  const root = createRoot(rootElement);
  t.after(async () => {
    await act(async () => root.unmount());
    dom.window.close();
    for (const [name, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
  });
  return { dom, root };
}

test('useComposeBarPinnedSnippets persists reordered pins, ignores unknown IDs, and syncs sibling instances', async (t) => {
  const { dom, root } = setupDom(t);
  dom.window.localStorage.setItem(
    STORAGE_KEY_COMPOSE_BAR_PINNED_SNIPPETS,
    JSON.stringify(['s1', 's2', 's3']),
  );

  type HookResult = ReturnType<typeof useComposeBarPinnedSnippets>;
  let firstHook!: HookResult;
  let secondHook!: HookResult;

  function Harness({ snippetIdKey }: { snippetIdKey: string }) {
    firstHook = useComposeBarPinnedSnippets(snippetIdKey);
    return null;
  }

  function SiblingHarness({ snippetIdKey }: { snippetIdKey: string }) {
    secondHook = useComposeBarPinnedSnippets(snippetIdKey);
    return null;
  }

  await act(async () => {
    root.render(
      <>
        <Harness snippetIdKey={'s1\0s2\0s3'} />
        <SiblingHarness snippetIdKey={'s1\0s2\0s3'} />
      </>,
    );
  });

  assert.deepEqual(firstHook.pinnedIds, ['s1', 's2', 's3']);
  assert.deepEqual(secondHook.pinnedIds, ['s1', 's2', 's3']);

  await act(async () => {
    firstHook.reorder('s3', 's1', 'before');
  });

  assert.deepEqual(firstHook.pinnedIds, ['s3', 's1', 's2']);
  assert.deepEqual(secondHook.pinnedIds, ['s3', 's1', 's2']);
  assert.deepEqual(
    JSON.parse(dom.window.localStorage.getItem(STORAGE_KEY_COMPOSE_BAR_PINNED_SNIPPETS) ?? '[]'),
    ['s3', 's1', 's2'],
  );

  // Unknown/deleted drag IDs are ignored without corrupting persisted order.
  await act(async () => {
    firstHook.reorder('deleted-snippet', 's1', 'before');
    firstHook.reorder('s2', 'missing-target', 'after');
  });
  assert.deepEqual(firstHook.pinnedIds, ['s3', 's1', 's2']);

  // Deleting a snippet prunes it while keeping the customized order of remaining pins.
  await act(async () => {
    root.render(
      <>
        <Harness snippetIdKey={'s3\0s2'} />
        <SiblingHarness snippetIdKey={'s3\0s2'} />
      </>,
    );
  });
  assert.deepEqual(firstHook.pinnedIds, ['s3', 's2']);
  assert.deepEqual(secondHook.pinnedIds, ['s3', 's2']);
  assert.deepEqual(
    JSON.parse(dom.window.localStorage.getItem(STORAGE_KEY_COMPOSE_BAR_PINNED_SNIPPETS) ?? '[]'),
    ['s3', 's2'],
  );
});

test('useComposeBarPinnedSnippets still seeds defaults on first run when vault snippets are present', async (t) => {
  const { dom, root } = setupDom(t);
  type HookResult = ReturnType<typeof useComposeBarPinnedSnippets>;
  let hook!: HookResult;

  function Harness() {
    hook = useComposeBarPinnedSnippets('a\0b', ['a', 'b']);
    return null;
  }

  await act(async () => {
    root.render(<Harness />);
  });

  assert.deepEqual(hook.pinnedIds, ['a', 'b']);
  assert.deepEqual(
    JSON.parse(dom.window.localStorage.getItem(STORAGE_KEY_COMPOSE_BAR_PINNED_SNIPPETS) ?? '[]'),
    ['a', 'b'],
  );
});
