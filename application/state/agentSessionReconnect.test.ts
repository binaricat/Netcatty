import assert from 'node:assert/strict';
import test from 'node:test';
import { requestAgentSessionReconnect } from './agentSessionReconnect';

test('reconnect preserves identity and only dispatches disconnected eligible sessions', () => {
  let calls = 0;
  const registry = { isActive: () => false, requestIfAvailable: () => { calls++; return true; } };
  assert.equal(requestAgentSessionReconnect('s', undefined, registry).ok, false);
  assert.equal(requestAgentSessionReconnect('s', 'connected', registry).status, 'connected');
  assert.equal(requestAgentSessionReconnect('s', 'connecting', registry).started, false);
  const result = requestAgentSessionReconnect('s', 'disconnected', registry);
  assert.deepEqual(result, { ok: true, started: true, sessionId: 's', status: 'reconnecting', shellReady: false });
  assert.equal(calls, 1);
});

test('auto/manual reconnect and unavailable terminal cannot queue another recovery', () => {
  const registry = { isActive: () => true, requestIfAvailable: () => { throw Error('must not dispatch'); } };
  assert.equal(requestAgentSessionReconnect('s', 'disconnected', registry).started, false);
  assert.equal(requestAgentSessionReconnect('s', 'disconnected', { isActive: () => false, requestIfAvailable: () => false }).code, 'RECONNECT_UNAVAILABLE');
});
