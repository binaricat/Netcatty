import assert from 'node:assert/strict';
import test from 'node:test';

import {
  getAppHandlers,
  registerAppHandlers,
  stabilizeAppHandlers,
  subscribeAppHandlers,
  type StableAppHandlerCache,
} from './appHandlersBridge';

test('stabilized handlers keep their identity and call the latest implementation', () => {
  const cache: StableAppHandlerCache = new Map();
  const ref = { current: 1 };
  const calls: string[] = [];
  const first = stabilizeAppHandlers(cache, {
    closeTabsBatch: (id: string) => calls.push(`v1:${id}`),
    toggleSidePanelRef: ref,
  });
  const second = stabilizeAppHandlers(cache, {
    closeTabsBatch: (id: string) => calls.push(`v2:${id}`),
    toggleSidePanelRef: ref,
  });
  assert.equal(second.closeTabsBatch, first.closeTabsBatch);
  assert.equal(second.toggleSidePanelRef, ref, 'non-function values pass through');
  (first.closeTabsBatch as (id: string) => void)('a');
  assert.deepEqual(calls, ['v2:a']);
});

test('the bridge does not notify Hosts when only handler implementations change', () => {
  const cache: StableAppHandlerCache = new Map();
  let notified = 0;
  const unsubscribe = subscribeAppHandlers(() => { notified += 1; });
  try {
    registerAppHandlers(stabilizeAppHandlers(cache, { handleDeleteHost: () => 'v1' }));
    const afterFirst = notified;
    // A session status change recreated the callback (it closes over hosts).
    registerAppHandlers(stabilizeAppHandlers(cache, { handleDeleteHost: () => 'v2' }));
    assert.equal(notified, afterFirst);
    assert.equal((getAppHandlers()!.handleDeleteHost as () => string)(), 'v2');
  } finally {
    unsubscribe();
    registerAppHandlers(null);
  }
});
