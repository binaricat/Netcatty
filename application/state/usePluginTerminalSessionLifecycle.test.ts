import assert from 'node:assert/strict';
import test from 'node:test';

import {
  beginPluginTerminalSessionMountLifecycle,
  normalizePluginTerminalProtocol,
  ownsPluginTerminalBackendLifecycle,
  shouldPublishPluginTerminalSessionMountLifecycle,
  shouldPublishPluginTerminalEvent,
  transitionPluginTerminalConnectionState,
} from './usePluginTerminalSessionLifecycle.ts';

test('an attached renderer does not claim creation or disposal of the reused backend session', () => {
  assert.equal(ownsPluginTerminalBackendLifecycle(undefined), true);
  assert.equal(ownsPluginTerminalBackendLifecycle(true), true);
  assert.equal(ownsPluginTerminalBackendLifecycle(false), false);
  for (const type of ['created', 'connected', 'reconnected', 'disconnected', 'disposed'] as const) {
    assert.equal(shouldPublishPluginTerminalEvent(type, false), false);
  }
  assert.equal(shouldPublishPluginTerminalEvent('resized', false), true);
});

const connectedState = {
  cwd: '/srv/old',
  title: 'old backend',
  cols: 120,
  rows: 40,
  alternateScreen: true,
};

test('disconnect clears connection-scoped terminal Provider metadata before publishing', () => {
  assert.deepEqual(
    transitionPluginTerminalConnectionState(connectedState, 'disconnected', true, 137),
    {
      snapshotState: { cols: 120, rows: 40 },
      everConnected: true,
      eventType: 'disconnected',
      eventDetails: { exitCode: 137 },
    },
  );
});

test('disconnect omits an exit code when the backend did not provide one', () => {
  assert.deepEqual(
    transitionPluginTerminalConnectionState(connectedState, 'disconnected', true),
    {
      snapshotState: { cols: 120, rows: 40 },
      everConnected: true,
      eventType: 'disconnected',
    },
  );
});

test('reconnect clears stale backend metadata while retaining viewport dimensions', () => {
  assert.deepEqual(
    transitionPluginTerminalConnectionState(connectedState, 'connected', true),
    {
      snapshotState: { cols: 120, rows: 40 },
      everConnected: true,
      eventType: 'reconnected',
    },
  );
});

test('the initial connection preserves its initial cwd snapshot', () => {
  assert.deepEqual(
    transitionPluginTerminalConnectionState({ cwd: '/srv/initial' }, 'connected', false),
    {
      snapshotState: { cwd: '/srv/initial' },
      everConnected: true,
      eventType: 'connected',
    },
  );
});

test('a reconnecting transition clears stale metadata before any later disposal', () => {
  assert.deepEqual(
    transitionPluginTerminalConnectionState(connectedState, 'connecting', true),
    {
      snapshotState: { cols: 120, rows: 40 },
      everConnected: true,
    },
  );
});

test('transition snapshots remain writable for later cwd and title updates', () => {
  const transition = transitionPluginTerminalConnectionState(connectedState, 'connected', true);
  transition.snapshotState.cwd = '/srv/new';
  transition.snapshotState.title = 'new backend';

  assert.deepEqual(transition.snapshotState, {
    cols: 120,
    rows: 40,
    cwd: '/srv/new',
    title: 'new backend',
  });
});

test('terminal lifecycle snapshots preserve dynamic protocol identifiers', () => {
  assert.equal(
    normalizePluginTerminalProtocol('com.example.transport'),
    'com.example.transport',
  );
  assert.equal(normalizePluginTerminalProtocol('mosh'), 'mosh');
  assert.equal(normalizePluginTerminalProtocol(undefined), 'ssh');
});

test('an attach popup does not publish backend session mount or disposal lifecycle', () => {
  assert.equal(shouldPublishPluginTerminalSessionMountLifecycle(true), false);
  assert.equal(shouldPublishPluginTerminalSessionMountLifecycle(false), true);

  const events: string[] = [];
  const cleanup = beginPluginTerminalSessionMountLifecycle(
    shouldPublishPluginTerminalSessionMountLifecycle(true),
    () => events.push('created'),
    () => events.push('disposed'),
  );
  cleanup?.();
  assert.deepEqual(events, []);

  const ownerCleanup = beginPluginTerminalSessionMountLifecycle(
    shouldPublishPluginTerminalSessionMountLifecycle(false),
    () => events.push('created'),
    () => events.push('disposed'),
  );
  ownerCleanup?.();
  assert.deepEqual(events, ['created', 'disposed']);
});
