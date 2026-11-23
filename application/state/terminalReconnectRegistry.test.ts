import assert from 'node:assert/strict';
import test from 'node:test';

import { createTerminalReconnectRegistry } from './terminalReconnectRegistry';

test('recovery snapshots use the current handler and disappear on unmount', () => {
  const registry = createTerminalReconnectRegistry();
  assert.equal(registry.inspect('s'), null);
  const unregister = registry.register('s', () => {}, () => false,
    () => ({ status: 'disconnected', waitingForInput: true, reconnecting: false }));
  assert.equal(registry.inspect('s')?.waitingForInput, true);
  assert.equal(registry.inspect('s')?.reconnectAllowed, false);
  unregister();
  assert.equal(registry.inspect('s'), null);
});

test('agent reconnect never queues an unmounted terminal', () => {
  const registry = createTerminalReconnectRegistry();
  assert.equal(registry.requestIfAvailable('missing'), false);
  let calls = 0;
  registry.register('missing', () => { calls++; });
  assert.equal(calls, 0);
});

test('agent reconnect respects live eligibility and active reconnects', () => {
  const registry = createTerminalReconnectRegistry();
  let eligible = false;
  let calls = 0;
  registry.register('s', () => { calls++; registry.setActive('s', true); }, () => eligible);
  assert.equal(registry.requestIfAvailable('s'), false);
  eligible = true;
  assert.equal(registry.requestIfAvailable('s'), true);
  assert.equal(registry.requestIfAvailable('s'), false);
  assert.equal(calls, 1);
});

test('a registered terminal session can be reconnected on request', () => {
  const registry = createTerminalReconnectRegistry();
  const requestedSessionIds: string[] = [];

  registry.register('session-1', () => requestedSessionIds.push('session-1'));

  assert.equal(registry.request('session-1'), true);
  assert.deepEqual(requestedSessionIds, ['session-1']);
});

test('requesting a terminal session before its handler mounts reconnects after registration', () => {
  const registry = createTerminalReconnectRegistry();
  const requests: string[] = [];

  assert.equal(registry.request('session-1'), true);
  assert.deepEqual(requests, []);

  registry.register('session-1', () => requests.push('session-1'));

  assert.deepEqual(requests, ['session-1']);
});

test('cleanup only removes the handler that created it', () => {
  const registry = createTerminalReconnectRegistry();
  const requests: string[] = [];
  const unregisterOldHandler = registry.register('session-1', () => requests.push('old'));

  registry.register('session-1', () => requests.push('current'));
  unregisterOldHandler();

  assert.equal(registry.request('session-1'), true);
  assert.deepEqual(requests, ['current']);
});

test('active reconnect state blocks duplicate requests and notifies subscribers', () => {
  const registry = createTerminalReconnectRegistry();
  const requests: string[] = [];
  let notifications = 0;
  const unsubscribe = registry.subscribe(() => { notifications += 1; });
  registry.register('session-1', () => requests.push('session-1'));

  registry.setActive('session-1', true);
  assert.equal(registry.isActive('session-1'), true);
  assert.equal(registry.request('session-1'), false);
  assert.deepEqual(requests, []);

  registry.setActive('session-1', false);
  assert.equal(registry.request('session-1'), true);
  assert.deepEqual(requests, ['session-1']);
  assert.equal(notifications, 2);
  unsubscribe();
});

test('enter reconnect stays off until the session allows it and does not queue', () => {
  const registry = createTerminalReconnectRegistry();
  const requests: string[] = [];

  assert.equal(registry.requestEnterReconnect('session-1'), false);
  registry.register('session-1', () => requests.push('session-1'));
  assert.deepEqual(requests, []);

  registry.setEnterReconnectEnabled('session-1', true);
  assert.equal(registry.requestEnterReconnect('session-1'), true);
  assert.deepEqual(requests, ['session-1']);

  registry.setActive('session-1', true);
  assert.equal(registry.requestEnterReconnect('session-1'), false);
  assert.deepEqual(requests, ['session-1']);

  registry.setActive('session-1', false);
  registry.setEnterReconnectEnabled('session-1', false);
  assert.equal(registry.requestEnterReconnect('session-1'), false);
  assert.deepEqual(requests, ['session-1']);
});

test('unregistering the current handler clears active reconnect state', () => {
  const registry = createTerminalReconnectRegistry();
  const unregister = registry.register('session-1', () => {});
  registry.setActive('session-1', true);

  unregister();

  assert.equal(registry.isActive('session-1'), false);
});
