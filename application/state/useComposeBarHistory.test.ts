import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { useComposeBarHistory } from './useComposeBarHistory';
import { pruneComposeBarHistory, recordComposeBarHistory } from './composeBarHistoryStore';

test('changing workspace focus resets navigation without replacing the draft', async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  pruneComposeBarHistory([]);
  recordComposeBarHistory('a', 'a1');
  recordComposeBarHistory('a', 'a2');
  recordComposeBarHistory('b', 'b1');
  let history!: ReturnType<typeof useComposeBarHistory>;
  function Harness({ sessionId }: { sessionId: string }) {
    history = useComposeBarHistory(sessionId);
    return null;
  }
  let root!: ReactTestRenderer;
  await act(async () => { root = create(React.createElement(Harness, { sessionId: 'a' })); });
  assert.equal(history.navigate('unsent draft', 'up'), 'a2');
  await act(async () => { root.update(React.createElement(Harness, { sessionId: 'b' })); });
  assert.equal(history.navigate('unsent draft', 'down'), undefined);
  assert.equal(history.navigate('unsent draft', 'up'), 'b1');
  assert.equal(history.navigate('b1', 'down'), 'unsent draft');
  recordComposeBarHistory('b', 'later completion');
  assert.equal(history.navigate('unsent draft', 'up'), 'later completion');
  await act(async () => { root.unmount(); });
  pruneComposeBarHistory([]);
});

test('an in-progress history walk stays stable when a late send evicts the oldest entry', async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  pruneComposeBarHistory([]);
  for (let index = 0; index < 100; index += 1) recordComposeBarHistory('a', `h${index}`);
  let history!: ReturnType<typeof useComposeBarHistory>;
  function Harness() { history = useComposeBarHistory('a'); return null; }
  let root!: ReactTestRenderer;
  await act(async () => { root = create(React.createElement(Harness)); });
  const finish = history.prepareRecord();
  assert.equal(history.navigate('draft', 'up'), 'h99');
  finish('h100');
  assert.equal(history.navigate('h99', 'up'), 'h98');
  assert.equal(history.navigate('h98', 'down'), 'h99');
  assert.equal(history.navigate('h99', 'down'), 'draft');
  assert.equal(history.navigate('draft', 'up'), 'h100');
  await act(async () => { root.unmount(); });
  pruneComposeBarHistory([]);
});
