import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { Host } from '../../domain/models';
import { handleAssetActionOp } from './assetActionBridgeClient';

const host: Host = {
  id: 'host-1',
  label: 'prod',
  hostname: 'prod.example.com',
  username: 'root',
  password: 'secret',
  tags: [],
  os: 'linux',
  protocol: 'ssh',
};

function createDeps(overrides: Partial<Parameters<typeof handleAssetActionOp>[2]> = {}) {
  return {
    getHosts: () => [host],
    getSessions: () => [],
    resolveEffectiveHost: (entry: Host) => entry,
    openHost: () => {},
    connectHost: () => 'unused',
    closeSession: () => true,
    focusSession: () => {},
    ...overrides,
  };
}

describe('handleAssetActionOp', () => {
  it('opens a host in Vault without leaking credentials', async () => {
    const opened: string[] = [];
    const result = await handleAssetActionOp('asset.open', { hostId: 'host-1' }, createDeps({
      openHost: (hostId) => { opened.push(hostId); },
    }));

    assert.equal(result.ok, true);
    assert.deepEqual(opened, ['host-1']);
    assert.doesNotMatch(JSON.stringify(result), /secret/);
  });

  it('connects an SSH asset and returns a redacted session summary', async () => {
    const connected: string[] = [];
    const result = await handleAssetActionOp('asset.connect', { hostId: 'host-1' }, createDeps({
      connectHost: (entry) => {
        connected.push(entry.id);
        return 'session-1';
      },
    }));

    assert.equal(result.ok, true);
    assert.equal(result.sessionId, 'session-1');
    assert.deepEqual(connected, ['host-1']);
    assert.doesNotMatch(JSON.stringify(result), /secret/);
  });

  it('requires sessionId when disconnect by host is ambiguous', async () => {
    const result = await handleAssetActionOp('asset.disconnect', { hostId: 'host-1' }, createDeps({
      getSessions: () => [
        { id: 's1', hostId: 'host-1', status: 'connected' },
        { id: 's2', hostId: 'host-1', status: 'connected' },
      ],
    }));

    assert.equal(result.ok, false);
    assert.match(String(result.error), /sessionId/);
    assert.doesNotMatch(JSON.stringify(result), /secret/);
  });

  it('rejects disconnect when sessionId does not belong to the requested host', async () => {
    const closed: string[] = [];
    const result = await handleAssetActionOp('asset.disconnect', {
      sessionId: 's1',
      hostId: 'other-host',
    }, createDeps({
      getSessions: () => [{ id: 's1', hostId: 'host-1', status: 'connected' }],
      closeSession: (sessionId) => {
        closed.push(sessionId);
        return true;
      },
    }));

    assert.equal(result.ok, false);
    assert.match(String(result.error), /does not belong/i);
    assert.deepEqual(closed, []);
    assert.doesNotMatch(JSON.stringify(result), /secret/);
  });

  it('reconnects an existing session by closing it and opening a replacement', async () => {
    const closed: string[] = [];
    const connected: string[] = [];
    const result = await handleAssetActionOp('asset.reconnect', { sessionId: 's1' }, createDeps({
      getSessions: () => [{ id: 's1', hostId: 'host-1', status: 'connected' }],
      closeSession: (sessionId) => {
        closed.push(sessionId);
        return true;
      },
      connectHost: (entry) => {
        connected.push(entry.id);
        return 'session-2';
      },
    }));

    assert.equal(result.ok, true);
    assert.equal(result.sessionId, 'session-2');
    assert.deepEqual(closed, ['s1']);
    assert.deepEqual(connected, ['host-1']);
    assert.doesNotMatch(JSON.stringify(result), /secret/);
  });

  it('rejects reconnect when sessionId does not belong to the requested host', async () => {
    const closed: string[] = [];
    const connected: string[] = [];
    const result = await handleAssetActionOp('asset.reconnect', {
      sessionId: 's1',
      hostId: 'other-host',
    }, createDeps({
      getSessions: () => [{ id: 's1', hostId: 'host-1', status: 'connected' }],
      closeSession: (sessionId) => {
        closed.push(sessionId);
        return true;
      },
      connectHost: (entry) => {
        connected.push(entry.id);
        return 'session-2';
      },
    }));

    assert.equal(result.ok, false);
    assert.match(String(result.error), /does not belong/i);
    assert.deepEqual(closed, []);
    assert.deepEqual(connected, []);
    assert.doesNotMatch(JSON.stringify(result), /secret/);
  });
});
