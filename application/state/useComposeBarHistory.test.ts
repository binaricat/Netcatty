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
  await act(async () => { root.unmount(); });
  pruneComposeBarHistory([]);
});
