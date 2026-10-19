import { installBrowserLockFixture } from "./testSupport/browserLockFixture";
import test from 'node:test';
import assert from 'node:assert/strict';
import type { AISession } from '../infrastructure/ai/types';
import type { SyncPayload } from '../domain/sync';
import { withSyncReliabilityMeta } from '../domain/syncReliability';
import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { getAgentRuntime } from '../infrastructure/ai/harness/globalAgentRuntime';
import { useAIChatStreaming, type UseAIChatStreamingReturn } from './state/useAIChatStreaming';

installBrowserLockFixture();

const storage = new Map<string, string>();
const events = new EventTarget();
Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
  getItem: (key: string) => storage.get(key) ?? null,
  setItem: (key: string, value: string) => storage.set(key, value),
  removeItem: (key: string) => storage.delete(key),
} });
Object.defineProperty(globalThis, 'window', { configurable: true, value: events });
const keys = await import('../infrastructure/config/storageKeys');
const snapshots = await import('./state/aiStateSnapshots');
const { getAISessionsSnapshot } = await import('./state/aiSessionsStore');
const {
  buildCloudSyncPayload, buildLocalVaultPayload, collectAiSessionsForSync,
  applySyncPayload, applyLocalVaultPayload, hasMeaningfulSyncData,
  setAiSessionsSyncPreference,
  hasCloudSyncEntityData, hasMeaningfulCloudSyncData, shouldPromptCloudVaultRecovery,
} = await import('./syncPayload');

const vault = { hosts: [], keys: [], identities: [], snippets: [], customGroups: [], knownHosts: [] };
const remotePayload = (aiSessions: AISession[]): SyncPayload => ({ ...vault, aiSessions, syncedAt: 1 });
const session = (): AISession => ({
  id: 'chat', title: 'Chat', agentId: 'catty', scope: { type: 'global' }, createdAt: 1, updatedAt: 2,
  messages: [{ id: 'message', role: 'user', content: 'Inspect', timestamp: 1, attachments: [{
    filename: 'terminal.log', mediaType: 'text/plain', terminalSelection: true,
    base64Data: 'cHJpdmF0ZQ==', previewText: 'private', filePath: '/private/device/file', lineCount: 1,
  }] }],
});
function save(sessions: AISession[], enabled = true) {
  snapshots.setLatestAISessionsSnapshot(sessions);
  storage.set(keys.STORAGE_KEY_AI_SESSIONS, JSON.stringify(sessions));
  storage.set(keys.STORAGE_KEY_CLOUD_SYNC_AI_SESSIONS, JSON.stringify({ enabled }));
}
test.beforeEach(() => { storage.clear(); save([], false); });

test('actual manual upload and auto collector honor consent and explicit empty', async () => {
  save([session()], false);
  const options = { collectPluginSidecars: () => undefined };
  assert.equal((await buildCloudSyncPayload(vault, [], options)).aiSessions, undefined);
  assert.equal(collectAiSessionsForSync(), undefined);
  save([], true);
  assert.deepEqual((await buildCloudSyncPayload(vault, [], options)).aiSessions, []);
  assert.deepEqual(collectAiSessionsForSync(), []);
  save([session()], true);
  const cloud = await buildCloudSyncPayload(vault, [], options);
  assert.equal(cloud.aiSessions?.length, 1);
  assert.deepEqual(cloud.aiSessions, collectAiSessionsForSync());
  assert.equal(JSON.stringify(cloud).includes('cHJpdmF0ZQ=='), false);
  assert.equal(JSON.stringify(cloud).includes('/private/device/file'), false);
  assert.equal(JSON.stringify(cloud.aiSessions?.[0].messages[0].attachments).includes('private'), false);
});

test('sync persistence survives restart beyond the local-only history limits', () => {
  const many = Array.from({ length: 51 }, (_, index) => ({ ...session(), id: `chat-${index}`, updatedAt: index,
    messages: Array.from({ length: 201 }, (_, turn) => ({ id: `m-${turn}`, role: 'user' as const, content: 'History', timestamp: turn })) }));
  save(many);
  assert.equal(snapshots.writeSessionsForStorage(many), true);
  assert.equal(collectAiSessionsForSync()?.length, 51);
  snapshots.setLatestAISessionsSnapshot(null as unknown as AISession[]);
  const afterRestart = collectAiSessionsForSync()!;
  assert.equal(afterRestart.length, 51);
  assert.equal(afterRestart[0].messages.length, 201);
  save(many, false);
  assert.equal(snapshots.writeSessionsForStorage(many), true);
  const localOnly = JSON.parse(storage.get(keys.STORAGE_KEY_AI_SESSIONS)!);
  assert.equal(localOnly.length, 50);
  assert.equal(localOnly[0].messages.length, 200);
});

test('failed history persistence refuses upload without pruning the cloud representation', async () => {
  save([session()]);
  const original = globalThis.localStorage.setItem;
  globalThis.localStorage.setItem = (key, value) => {
    if (key === keys.STORAGE_KEY_AI_SESSIONS) throw new DOMException('Full', 'QuotaExceededError');
    original(key, value);
  };
  snapshots.setLatestAISessionsSnapshot([{ ...session(), title: 'Unsaved change' }]);
  try {
    await assert.rejects(buildCloudSyncPayload(vault, [], { collectPluginSidecars: () => undefined }), /persist|save/i);
    assert.equal(JSON.parse(storage.get(keys.STORAGE_KEY_AI_SESSIONS)!)[0].title, 'Chat');
    const backup = buildLocalVaultPayload(vault);
    assert.equal(backup.aiSessions?.[0].title, 'Unsaved change');
    assert.equal(backup.aiSessions?.[0].messages[0].attachments?.[0].base64Data, 'cHJpdmF0ZQ==');
  } finally { globalThis.localStorage.setItem = original; }
});

test('failed opt-in preference commit leaves local chats and native threads untouched', async () => {
  const local = { ...session(), externalSessionId: 'native-thread' };
  save([local], false);
  const original = globalThis.localStorage.setItem;
  const cleanups: string[] = [];
  Object.assign(window, { netcatty: { aiSdkAgentCleanup: async (id: string) => { cleanups.push(id); return { ok: true }; } } });
  globalThis.localStorage.setItem = (key, value) => {
    if (key === keys.STORAGE_KEY_CLOUD_SYNC_AI_SESSIONS) throw new DOMException('Full', 'QuotaExceededError');
    original(key, value);
  };
  const incoming = { ...session(), updatedAt: 3, messages: [...session().messages,
    { id: 'remote', role: 'assistant' as const, content: 'Remote turn', timestamp: 3 }] };
  try {
    await assert.rejects(setAiSessionsSyncPreference(true, async () => [remotePayload([incoming])]), /preference|enable/i);
    assert.deepEqual(snapshots.latestAISessionsSnapshot, [local]);
    assert.deepEqual(JSON.parse(storage.get(keys.STORAGE_KEY_AI_SESSIONS)!), [local]);
    assert.deepEqual(cleanups, []);
    assert.equal(JSON.parse(storage.get(keys.STORAGE_KEY_CLOUD_SYNC_AI_SESSIONS)!).enabled, false);
  } finally { globalThis.localStorage.setItem = original; delete (window as unknown as { netcatty?: unknown }).netcatty; }
});

test('local backup retains chat and attachment bytes with cloud consent off', async () => {
  const local = session();
  save([local], false);
  const backup = buildLocalVaultPayload(vault);
  assert.deepEqual(backup.aiSessions, [local]);
  assert.equal(hasMeaningfulSyncData({ ...vault, aiSessions: [local], syncedAt: 1 }), true);
  save([], false);
  await applyLocalVaultPayload(backup, { importVaultData: () => undefined }, {
    prepareConvergentRestore: async () => async () => {},
  });
  assert.equal(getAISessionsSnapshot().sessions[0].messages[0].attachments?.[0].base64Data, 'cHJpdmF0ZQ==');
});

test('chat-only data is syncable but does not suppress empty-vault recovery', () => {
  const local = { ...vault, aiSessions: [session()], syncedAt: 1 };
  assert.equal(hasMeaningfulCloudSyncData(local), true);
  assert.equal(hasCloudSyncEntityData(local), false);
  const host = { id: 'remote', label: 'Remote', hostname: 'remote.example', username: 'test', port: 22, protocol: 'ssh' as const, tags: [], os: 'linux' as const };
  for (const hosts of [[host], [host, { ...host, id: 'second' }]]) {
    assert.equal(shouldPromptCloudVaultRecovery(local, { ...vault, hosts, syncedAt: 2 }), true);
  }
  assert.equal(shouldPromptCloudVaultRecovery({ ...vault, syncedAt: 1 }, local), false);
});

test('download publishes immediately and keeps local attachment bytes on a newer message', async () => {
  save([session()]);
  const incoming = session();
  incoming.updatedAt = 3;
  incoming.messages[0].content = 'Updated';
  incoming.messages[0].attachments = [{ base64Data: '', mediaType: 'text/plain', filename: 'terminal.log', terminalSelection: true, contentUnavailable: true }];
  const payload: SyncPayload = { ...vault, aiSessions: [incoming], syncedAt: 2 };
  await applySyncPayload(payload, { importVaultData: () => undefined });
  const current = getAISessionsSnapshot().sessions[0];
  assert.equal(current.messages[0].content, 'Updated');
  assert.equal(current.messages[0].attachments?.[0].base64Data, 'cHJpdmF0ZQ==');
  assert.equal(snapshots.latestAISessionsSnapshot?.[0], current);
  assert.equal(JSON.parse(storage.get(keys.STORAGE_KEY_AI_SESSIONS)!)[0].messages[0].content, 'Updated');
});

test('restoring an old backup without chat leaves current chats alone', async () => {
  const local = session();
  save([local], false);
  await applyLocalVaultPayload({ ...vault, syncedAt: 1 }, { importVaultData: () => undefined }, {
    prepareConvergentRestore: async () => async () => {},
  });
  assert.deepEqual(snapshots.latestAISessionsSnapshot, [local]);
  assert.deepEqual(JSON.parse(storage.get(keys.STORAGE_KEY_AI_SESSIONS)!), [local]);
});

test('authoritative cloud session removal stays removed in the next upload', async () => {
  save([session()]);
  await applySyncPayload({ ...vault, aiSessions: [], syncedAt: 3 }, { importVaultData: () => undefined });
  assert.deepEqual(getAISessionsSnapshot().sessions, []);
  assert.deepEqual(collectAiSessionsForSync(), []);
  assert.deepEqual((await buildCloudSyncPayload(vault, [], { collectPluginSidecars: () => undefined })).aiSessions, []);
});

test('replacement stops active turns and waits for finalizers before persisting history', async (context) => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  let hook: UseAIChatStreamingReturn;
  function Harness() {
    hook = useAIChatStreaming({ maxIterations: 1, addMessageToSession: () => {}, updateLastMessage: () => {}, updateMessageById: () => {} });
    return null;
  }
  let renderer: ReactTestRenderer;
  await act(async () => { renderer = create(React.createElement(Harness)); });
  const original = globalThis.localStorage.setItem;
  try {
    for (const remove of [false, true]) {
      const order: string[] = [];
      const controller = new AbortController();
      const local = { ...session(), messages: [...session().messages,
        { id: 'reply', role: 'assistant' as const, content: 'Partial', timestamp: 2, executionStatus: 'running' as const }] };
      save([local]);
      hook!.abortControllersRef.current.set('chat', controller);
      await act(async () => { hook!.setStreamingForScope('chat', true); });
      Object.assign(window, { netcatty: {
        aiCattyCancelExec: async () => { order.push('cancel'); },
        aiSdkAgentCancel: async () => ({ ok: true }),
        aiSdkAgentCleanup: async () => { order.push('cleanup'); return { ok: true }; },
      } });
      const wait = context.mock.method(getAgentRuntime(), 'waitForActiveTurn', async () => {
        assert.equal(controller.signal.aborted, true);
        await new Promise(resolve => setTimeout(resolve, 0));
        snapshots.setLatestAISessionsSnapshot([{ ...local, messages: [local.messages[0],
          { ...local.messages[1], content: 'Settled', executionStatus: 'cancelled' }] }]);
        order.push('settled');
      });
      globalThis.localStorage.setItem = (key, value) => { if (key === keys.STORAGE_KEY_AI_SESSIONS) order.push('persist'); original(key, value); };
      const incoming = { ...session(), updatedAt: 3, messages: [...session().messages,
        { id: 'remote', role: 'user' as const, content: 'Remote', timestamp: 3 }] };
      await applySyncPayload(remotePayload(remove ? [] : [incoming]), { importVaultData: () => undefined });
      assert.ok(order.indexOf('cancel') < order.indexOf('settled'));
      assert.ok(order.indexOf('settled') < order.indexOf('persist'));
      assert.ok(order.indexOf('persist') < order.indexOf('cleanup'));
      assert.equal(hook!.abortControllersRef.current.has('chat'), false);
      if (remove) assert.deepEqual(getAISessionsSnapshot().sessions, []);
      else assert.ok(getAISessionsSnapshot().sessions[0].messages.some(message => message.content === 'Settled'));
      wait.mock.restore();
      globalThis.localStorage.setItem = original;
      await act(async () => { hook!.setStreamingForScope('chat', false); });
    }
  } finally {
    context.mock.restoreAll(); globalThis.localStorage.setItem = original;
    delete (window as unknown as { netcatty?: unknown }).netcatty;
    await act(async () => { renderer!.unmount(); });
  }
});

test('local restore replaces later sessions and later turns with the backup snapshot', async () => {
  const backedUp = session();
  const later = { ...session(), updatedAt: 3, messages: [...session().messages,
    { id: 'later', role: 'assistant' as const, content: 'After backup', timestamp: 3 }] };
  save([later, { ...session(), id: 'created-after-backup' }]);
  await applyLocalVaultPayload({ ...vault, aiSessions: [backedUp], syncedAt: 1 }, { importVaultData: () => undefined }, {
    prepareConvergentRestore: async () => async () => {},
  });
  assert.deepEqual(getAISessionsSnapshot().sessions, [backedUp]);
  await applyLocalVaultPayload({ ...vault, aiSessions: [], syncedAt: 1 }, { importVaultData: () => undefined }, {
    prepareConvergentRestore: async () => async () => {},
  });
  assert.deepEqual(getAISessionsSnapshot().sessions, []);
});

test('cloud downloads respect local chat opt-in while still applying vault data', async () => {
  save([], false);
  let vaultImports = 0;
  const downloaded = { ...vault, aiSessions: [session()], syncedAt: 2 };
  await applySyncPayload(downloaded, { importVaultData: () => { vaultImports++; } });
  assert.equal(vaultImports, 1);
  assert.deepEqual(snapshots.latestAISessionsSnapshot, []);
  assert.deepEqual(JSON.parse(storage.get(keys.STORAGE_KEY_AI_SESSIONS)!), []);
  save([], true);
  await applySyncPayload(downloaded, { importVaultData: () => { vaultImports++; } });
  assert.equal(vaultImports, 2);
  assert.equal(snapshots.latestAISessionsSnapshot?.[0].id, 'chat');
});

test('enabling sync imports existing cloud chats before an empty local list can be uploaded', async () => {
  save([], false);
  let loads = 0;
  await setAiSessionsSyncPreference(true, async () => {
    loads++;
    assert.equal(collectAiSessionsForSync(), undefined);
    return [remotePayload([session()])];
  });
  assert.equal(loads, 1);
  assert.equal(collectAiSessionsForSync()?.[0].id, 'chat');
  assert.equal(getAISessionsSnapshot().sessions[0].id, 'chat');
  await setAiSessionsSyncPreference(false, async () => { throw new Error('Disable must not load'); });
  assert.equal(collectAiSessionsForSync(), undefined);
});

test('an unsuccessful initial cloud read leaves chat sync disabled and local history unchanged', async () => {
  save([], false);
  await assert.rejects(setAiSessionsSyncPreference(true, async () => { throw new Error('offline'); }), /offline/);
  assert.equal(collectAiSessionsForSync(), undefined);
  assert.deepEqual(snapshots.latestAISessionsSnapshot, []);
});

test('enabling from multiple mirrored providers retains the newer turns from either copy', async () => {
  save([], false);
  const newer = session();
  newer.updatedAt = 3;
  newer.messages.push({ id: 'new-turn', role: 'assistant', content: 'Newer provider turn', timestamp: 3 });
  await setAiSessionsSyncPreference(true, async () => [remotePayload([newer]), remotePayload([session()])]);
  assert.deepEqual(collectAiSessionsForSync()?.[0].messages.map((message) => message.id), ['message', 'new-turn']);
});

test('initial enable retains local-only chats but respects remote deletions and preservation', async () => {
  const localOnly = { ...session(), id: 'local-only' };
  save([localOnly], false);
  await setAiSessionsSyncPreference(true, async () => [remotePayload([session()])]);
  assert.deepEqual(collectAiSessionsForSync()?.map(item => item.id).sort(), ['chat', 'local-only']);
  const removed = withSyncReliabilityMeta(remotePayload([]), remotePayload([session()]), { now: 3 });
  for (const preserve of [false, true]) {
    save([session(), localOnly], false);
    await setAiSessionsSyncPreference(true, async () => [removed, remotePayload([session()])], preserve);
    assert.deepEqual(collectAiSessionsForSync()?.map(item => item.id).sort(), preserve ? ['chat', 'local-only'] : ['local-only']);
  }
});

test('backup rollback resets the native thread that still contains later turns', async () => {
  const cleanups: string[] = [];
  Object.assign(window, { netcatty: { aiSdkAgentCleanup: async (id: string) => { cleanups.push(id); return { ok: true }; } } });
  const backedUp = { ...session(), agentId: 'codex', externalSessionId: 'native-thread' };
  save([{ ...backedUp, updatedAt: 4, messages: [...backedUp.messages,
    { id: 'later', role: 'assistant', content: 'After backup', timestamp: 4 }] }]);
  await applyLocalVaultPayload(remotePayload([backedUp]), { importVaultData: () => undefined }, {
    prepareConvergentRestore: async () => async () => {},
  });
  const restored = getAISessionsSnapshot().sessions[0];
  assert.equal(restored.externalSessionId, undefined);
  assert.deepEqual(restored.messages, backedUp.messages);
  assert.deepEqual(cleanups, ['chat']);
  delete (window as unknown as { netcatty?: unknown }).netcatty;
});

test('cloud restore never resumes a source device SDK thread, and preserves matching local threads', async () => {
  const local = { ...session(), externalSessionId: 'local-native-thread' };
  save([local]);
  const incoming = { ...session(), updatedAt: 3, externalSessionId: 'remote-native-thread' };
  const fresh = { ...incoming, id: 'new-chat' };
  await applySyncPayload({ ...vault, aiSessions: [incoming, fresh], syncedAt: 2 }, { importVaultData: () => undefined });
  const current = getAISessionsSnapshot().sessions;
  assert.equal(current.find((s) => s.id === 'chat')?.externalSessionId, 'local-native-thread');
  assert.equal(current.find((s) => s.id === 'new-chat')?.externalSessionId, undefined);
});

test('changed remote transcript resets the local native SDK thread before continuing', async () => {
  const cleanups: string[] = [];
  Object.assign(window, { netcatty: { aiSdkAgentCleanup: async (id: string) => { cleanups.push(id); return { ok: true }; } } });
  save([{ ...session(), agentId: 'codex', externalSessionId: 'local-native-thread' }]);
  const incoming = { ...session(), agentId: 'codex', updatedAt: 3, externalSessionId: 'remote-native-thread' };
  incoming.messages.push({ id: 'remote-turn', role: 'user', content: 'Added on another device', timestamp: 3 });
  await applySyncPayload({ ...vault, aiSessions: [incoming], syncedAt: 2 }, { importVaultData: () => undefined });
  assert.deepEqual(cleanups, ['chat']);
  assert.equal(getAISessionsSnapshot().sessions[0].externalSessionId, undefined);
  assert.equal(getAISessionsSnapshot().sessions[0].messages.at(-1)?.content, 'Added on another device');
  delete (window as unknown as { netcatty?: unknown }).netcatty;
});
