import assert from 'node:assert/strict';
import test from 'node:test';
import { getComposeBarHistory, pruneComposeBarHistory, recordComposeBarHistory, clearComposeBarHistory, subscribeComposeBarHistoryCleared } from './composeBarHistoryStore';

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

test('late send completion cannot restore a closed session or overwrite another send', async () => {
  const { createComposeBarHistoryRecorder } = await import('./composeBarHistoryStore');
  pruneComposeBarHistory([]);
  const first = createComposeBarHistoryRecorder('a');
  const second = createComposeBarHistoryRecorder('a');
  second('second');
  first('first');
  assert.deepEqual(getComposeBarHistory('a'), ['first', 'second']);
  const late = createComposeBarHistoryRecorder('a');
  pruneComposeBarHistory([]);
  late('late');
  assert.deepEqual(getComposeBarHistory('a'), []);
});


test('failed submissions unblock later successes in submission order', async () => {
  const { createComposeBarHistoryRecorder } = await import('./composeBarHistoryStore');
  pruneComposeBarHistory([]);
  const failed = createComposeBarHistoryRecorder('a');
  const accepted = createComposeBarHistoryRecorder('a');
  accepted('accepted');
  assert.deepEqual(getComposeBarHistory('a'), []);
  failed();
  assert.deepEqual(getComposeBarHistory('a'), ['accepted']);
  pruneComposeBarHistory([]);
});

test('clearComposeBarHistory drops every session and notifies live compose bars', () => {
  pruneComposeBarHistory([]);
  recordComposeBarHistory('a', 'echo a');
  recordComposeBarHistory('b', 'echo b');

  let notified = 0;
  const unsubscribe = subscribeComposeBarHistoryCleared(() => {
    notified += 1;
  });

  clearComposeBarHistory();

  assert.deepEqual(getComposeBarHistory('a'), []);
  assert.deepEqual(getComposeBarHistory('b'), []);
  assert.equal(notified, 1);

  unsubscribe();
  clearComposeBarHistory();
  assert.equal(notified, 1);
});
