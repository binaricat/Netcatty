import assert from 'node:assert/strict';
import test from 'node:test';
import { TraceStore } from './traceStore';
import type { AgentEvent, CompactionTrace } from './types';

function makeDeltaEvent(sessionId: string, seq: number): AgentEvent {
  return {
    id: `evt-${sessionId}-${seq}`,
    type: 'model_delta',
    sessionId,
    backend: 'catty',
    turnId: 'turn-1',
    timestamp: seq,
    text: `tok-${seq}`,
  };
}

function makeCompactionEvent(sessionId: string, seq: number): AgentEvent {
  const trace: CompactionTrace = {
    trigger: 'pre-turn',
    estimatedTokensBefore: 1000 + seq,
    estimatedTokensAfter: 500 + seq,
    messagesBefore: 20 + seq,
    messagesAfter: 10,
    compressedMessageCount: seq,
    retainedTailCount: 10,
    didTypedCompression: true,
    didLlmSummarize: false,
    did413Fallback: false,
  };
  return {
    id: `cmp-${sessionId}-${seq}`,
    type: 'compaction',
    sessionId,
    backend: 'catty',
    turnId: 'turn-1',
    timestamp: seq,
    trace,
  };
}

test('TraceStore ring buffer preserves chronological order across wrap-around without splice', () => {
  const store = new TraceStore(4, 2);

  // Under capacity
  store.append(makeDeltaEvent('s1', 1));
  store.append(makeDeltaEvent('s1', 2));
  assert.deepEqual(
    store.getEvents('s1').map((event) => event.timestamp),
    [1, 2],
  );

  // Exact capacity + multiple wrap-arounds
  for (let i = 3; i <= 11; i += 1) {
    store.append(makeDeltaEvent('s1', i));
  }
  assert.deepEqual(
    store.getEvents('s1').map((event) => event.timestamp),
    [8, 9, 10, 11],
  );

  // One more wrap to hit head === 0 again
  store.append(makeDeltaEvent('s1', 12));
  assert.deepEqual(
    store.getEvents('s1').map((event) => event.timestamp),
    [9, 10, 11, 12],
  );

  // Compactions ring buffer overflows independently in chronological order
  for (let i = 1; i <= 5; i += 1) {
    store.append(makeCompactionEvent('s1', i));
  }
  assert.deepEqual(
    store.getCompactions('s1').map((trace) => trace.compressedMessageCount),
    [4, 5],
  );

  const exported = store.exportTrace('s1');
  assert.equal(exported.sessionId, 's1');
  assert.deepEqual(
    exported.events.map((event) => event.timestamp),
    [2, 3, 4, 5],
  );
  assert.deepEqual(
    exported.compactions.map((trace) => trace.compressedMessageCount),
    [4, 5],
  );
  assert.equal(typeof exported.exportedAt, 'number');

  // Capacity of 1 edge case
  const single = new TraceStore(1, 1);
  single.append(makeDeltaEvent('s1', 1));
  single.append(makeDeltaEvent('s1', 2));
  assert.deepEqual(single.getEvents('s1').map((event) => event.timestamp), [2]);
});

test('TraceStore evicts least-recently-used sessions once maxSessions is exceeded', () => {
  const store = new TraceStore(10, 5, 3);

  store.append(makeDeltaEvent('s1', 1));
  store.append(makeCompactionEvent('s1', 1));
  store.append(makeDeltaEvent('s2', 2));
  store.append(makeDeltaEvent('s3', 3));

  // Touch s1 via read so s2 becomes the LRU session
  assert.equal(store.getEvents('s1').length, 2);

  // Adding s4 must evict s2 while keeping s1, s3, s4
  store.append(makeDeltaEvent('s4', 4));
  assert.deepEqual(store.getEvents('s2'), []);
  assert.deepEqual(store.getCompactions('s2'), []);
  assert.equal(store.getEvents('s1').length, 2);
  assert.equal(store.getCompactions('s1').length, 1);
  assert.equal(store.getEvents('s3').length, 1);
  assert.equal(store.getEvents('s4').length, 1);

  // clear() removes both events and compactions for a session
  store.clear('s1');
  assert.deepEqual(store.getEvents('s1'), []);
  assert.deepEqual(store.getCompactions('s1'), []);
});

test('TraceStore handles large streaming bursts in O(1) per append without array shifting', () => {
  const store = new TraceStore(2_000, 500, 16);
  for (let i = 1; i <= 10_000; i += 1) {
    store.append(makeDeltaEvent('stream-1', i));
  }
  const events = store.getEvents('stream-1');
  assert.equal(events.length, 2_000);
  assert.equal(events[0].timestamp, 8_001);
  assert.equal(events[events.length - 1].timestamp, 10_000);
});
