import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createSyncedJsonStateTracker,
  finalizeSyncedJsonStateBroadcast,
  recordIncomingSyncedJsonStateChange,
  recordLocalSyncedJsonStateChange,
} from './syncedJsonState.ts';

test('local changes still broadcast normally', () => {
  let tracker = createSyncedJsonStateTracker();

  tracker = recordLocalSyncedJsonStateChange(tracker, '{"k":"old"}', '{"k":"new"}');
  const result = finalizeSyncedJsonStateBroadcast(tracker, '{"k":"new"}');

  assert.equal(result.shouldBroadcast, true);
  assert.equal(result.nextTracker.localVersion, 1);
  assert.equal(result.nextTracker.broadcastedLocalVersion, 1);
  assert.equal(result.nextTracker.incomingSignature, null);
});

test('incoming changes do not get echoed back out', () => {
  let tracker = createSyncedJsonStateTracker();

  tracker = recordIncomingSyncedJsonStateChange(tracker, '{"k":"old"}', '{"k":"disabled"}');
  const result = finalizeSyncedJsonStateBroadcast(tracker, '{"k":"disabled"}');

  assert.equal(result.shouldBroadcast, false);
  assert.equal(result.nextTracker.localVersion, 0);
  assert.equal(result.nextTracker.broadcastedLocalVersion, 0);
  assert.equal(result.nextTracker.incomingSignature, null);
});

test('rapid incoming updates each stay one-way without starting an echo loop', () => {
  let tracker = createSyncedJsonStateTracker();

  tracker = recordIncomingSyncedJsonStateChange(tracker, '{"open":"Ctrl+K"}', '{"open":"disabled"}');
  let result = finalizeSyncedJsonStateBroadcast(tracker, '{"open":"disabled"}');
  assert.equal(result.shouldBroadcast, false);

  tracker = recordIncomingSyncedJsonStateChange(
    result.nextTracker,
    '{"open":"disabled"}',
    '{"open":"Ctrl+K"}',
  );
  result = finalizeSyncedJsonStateBroadcast(tracker, '{"open":"Ctrl+K"}');
  assert.equal(result.shouldBroadcast, false);
});
