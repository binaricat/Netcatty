import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import type { ConnectionLog } from '../../domain/models';
import { STORAGE_KEY_CONNECTION_LOGS } from '../../infrastructure/config/storageKeys';
import {
  publishConnectionLogsSnapshot,
  registerConnectionLogsActions,
} from './connectionLogsStore';
import {
  clearAllRemoteDesktopRecordingsAndSyncLogs,
  collectProtectedRemoteDesktopMediaIds,
} from './remoteDesktopLogActions';
import { withVaultImportLock } from './vaultManagedImportLock';

function installDomEnv() {
  const dom = new JSDOM('', { url: 'http://localhost' });
  const keys = ['window', 'document', 'localStorage'] as const;
  const previous = new Map<string, PropertyDescriptor | undefined>(
    keys.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]),
  );
  Object.defineProperties(globalThis, {
    window: { value: dom.window, configurable: true },
    document: { value: dom.window.document, configurable: true },
    localStorage: { value: dom.window.localStorage, configurable: true },
  });
  return {
    restore: () => {
      dom.window.close();
      for (const key of keys) {
        const desc = previous.get(key);
        if (desc) Object.defineProperty(globalThis, key, desc);
        else Reflect.deleteProperty(globalThis, key);
      }
    },
  };
}

test('clearAllRemoteDesktopRecordingsAndSyncLogs protects saved logs and clears unsaved metadata even in detached Settings window', async () => {
  const env = installDomEnv();
  const savedClipId = '11111111-1111-4111-8111-111111111111';
  const unsavedClipId = '22222222-2222-4222-8222-222222222222';
  const unsavedThumbId = '33333333-3333-4333-8333-333333333333';

  const persistedLogs: ConnectionLog[] = [
    {
      id: 'log-saved',
      hostId: 'h1',
      hostLabel: 'Saved RDP',
      hostname: '10.0.0.1',
      username: 'admin',
      protocol: 'rdp',
      startTime: 1000,
      endTime: 2000,
      localUsername: 'u',
      localHostname: 'l',
      saved: true,
      recordingId: savedClipId,
      recordings: [
        {
          id: savedClipId,
          startedAt: 1000,
          endedAt: 2000,
          durationMs: 1000,
          bytes: 500,
          mimeType: 'video/webm',
          hasAudio: false,
        },
      ],
    },
    {
      id: 'log-unsaved',
      hostId: 'h2',
      hostLabel: 'Unsaved RDP',
      hostname: '10.0.0.2',
      username: 'admin',
      protocol: 'rdp',
      startTime: 3000,
      endTime: 4000,
      localUsername: 'u',
      localHostname: 'l',
      saved: false,
      recordingId: unsavedClipId,
      recordings: [
        {
          id: unsavedClipId,
          startedAt: 3000,
          endedAt: 4000,
          durationMs: 1000,
          bytes: 600,
          mimeType: 'video/webm',
          hasAudio: false,
        },
      ],
      remoteDesktopMeta: {
        resolution: { width: 1920, height: 1080 },
        thumbnailId: unsavedThumbId,
      },
    },
  ];

  globalThis.localStorage.setItem(STORAGE_KEY_CONNECTION_LOGS, JSON.stringify(persistedLogs));
  // Simulate detached Settings window: connectionLogsStore is unmounted/empty.
  publishConnectionLogsSnapshot({ connectionLogs: [] });
  registerConnectionLogsActions(null);

  const clearAllCalls: Array<{ protectedIds?: string[] }> = [];
  (globalThis.window as unknown as Record<string, unknown>).netcatty = {
    remoteDesktopRecordings: {
      clearAll: async (opts: { protectedIds?: string[] }) => {
        clearAllCalls.push(opts);
        return { deleted: 1 };
      },
    },
  };

  try {
    assert.deepEqual(collectProtectedRemoteDesktopMediaIds(), [savedClipId]);

    const res = await clearAllRemoteDesktopRecordingsAndSyncLogs();
    assert.equal(res.deleted, 1);
    assert.equal(clearAllCalls.length, 1);
    assert.deepEqual(clearAllCalls[0].protectedIds, [savedClipId]);

    const after = JSON.parse(
      globalThis.localStorage.getItem(STORAGE_KEY_CONNECTION_LOGS) || '[]',
    ) as ConnectionLog[];
    assert.equal(after.length, 2);
    assert.equal(after[0].recordingId, savedClipId);
    assert.equal(after[0].recordings?.length, 1);
    assert.equal(after[1].recordingId, undefined);
    assert.equal(after[1].recordings, undefined);
    assert.equal(after[1].remoteDesktopMeta?.thumbnailId, undefined);
    assert.deepEqual(after[1].remoteDesktopMeta?.resolution, { width: 1920, height: 1080 });
  } finally {
    registerConnectionLogsActions(null);
    publishConnectionLogsSnapshot({ connectionLogs: [] });
    env.restore();
  }
});

test('clearAllRemoteDesktopRecordingsAndSyncLogs does not deadlock when updateConnectionLog acquires connection-logs lock', async () => {
  const env = installDomEnv();
  const unsavedClipId = '44444444-4444-4444-8444-444444444444';
  const liveLog: ConnectionLog = {
    id: 'log-live-unsaved',
    hostId: 'h3',
    hostLabel: 'Live RDP',
    hostname: '10.0.0.3',
    username: 'admin',
    protocol: 'rdp',
    startTime: 5000,
    endTime: 6000,
    localUsername: 'u',
    localHostname: 'l',
    saved: false,
    recordingId: unsavedClipId,
    recordings: [
      {
        id: unsavedClipId,
        startedAt: 5000,
        endedAt: 6000,
        durationMs: 1000,
        bytes: 700,
        mimeType: 'video/webm',
        hasAudio: false,
      },
    ],
  };

  let lockHeld = false;
  let updatedCount = 0;
  const fakeLocks = {
    request: async (_name: string, cb: () => Promise<unknown>) => {
      if (lockHeld) {
        throw new Error('DEADLOCK: re-entrant lock acquisition on connection-logs');
      }
      lockHeld = true;
      try {
        return await cb();
      } finally {
        lockHeld = false;
      }
    },
  };
  const prevNavigatorDesc = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  Object.defineProperty(globalThis, 'navigator', {
    value: { locks: fakeLocks },
    configurable: true,
  });

  publishConnectionLogsSnapshot({ connectionLogs: [liveLog] });
  registerConnectionLogsActions({
    updateConnectionLog: async () => {
      await withVaultImportLock('connection-logs', async () => {
        updatedCount += 1;
      });
    },
    toggleConnectionLogSaved: () => {},
    deleteConnectionLog: () => {},
    clearUnsavedConnectionLogs: () => {},
  });

  (globalThis.window as unknown as Record<string, unknown>).netcatty = {
    remoteDesktopRecordings: {
      clearAll: async () => ({ deleted: 1 }),
    },
  };

  try {
    const res = await clearAllRemoteDesktopRecordingsAndSyncLogs();
    assert.equal(res.deleted, 1);
    assert.equal(updatedCount, 1);
  } finally {
    if (prevNavigatorDesc) Object.defineProperty(globalThis, 'navigator', prevNavigatorDesc);
    else Reflect.deleteProperty(globalThis, 'navigator');
    registerConnectionLogsActions(null);
    publishConnectionLogsSnapshot({ connectionLogs: [] });
    env.restore();
  }
});
