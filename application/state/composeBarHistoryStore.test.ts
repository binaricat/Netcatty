import assert from 'node:assert/strict';
import test from 'node:test';
import { getComposeBarHistory, pruneComposeBarHistory, recordComposeBarHistory } from './composeBarHistoryStore';

test('compose history is isolated per terminal and removed when its session closes', () => {
  pruneComposeBarHistory([]);
  recordComposeBarHistory('a', 'echo a\necho again');
  recordComposeBarHistory('b', 'echo b');
  assert.deepEqual(getComposeBarHistory('a'), ['echo a\necho again']);
  assert.deepEqual(getComposeBarHistory('b'), ['echo b']);
  pruneComposeBarHistory(['b']);
  assert.deepEqual(getComposeBarHistory('a'), []);
  assert.deepEqual(getComposeBarHistory('b'), ['echo b']);
  pruneComposeBarHistory([]);
});
