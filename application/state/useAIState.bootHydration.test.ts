/**
 * Boot-scenario regression tests for the IndexedDB migration review fixes
 * (issue #4125 review): P2① baseline seeding after an IndexedDB failure,
 * P2② pointer validation gated on hydration, P2③ disk-backup restore when
 * IndexedDB stays unopenable, and P2④ adopting an intentional cross-window
 * deletion.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { JSDOM } from 'jsdom';
import type { AISession } from '../../infrastructure/ai/types';
import {
  STORAGE_KEY_AI_ACTIVE_SESSION_MAP,
  STORAGE_KEY_AI_SESSIONS,
} from '../../infrastructure/config/storageKeys';
import { useAIState } from './useAIState';
import { getAISessionsSnapshot } from './aiSessionsStore';
import {
  __flushIdbWritesForTests,
  __resetAiSessionsHydrationForTests,
  __resetIdbPersistenceForTests,
  getPersistedAiSessionsSnapshot,
  setLatestAIActiveSessionMapSnapshot,
  setLatestAIDraftsByScopeSnapshot,
  setLatestAIPanelViewByScopeSnapshot,
  setLatestAISessionsSnapshot,
} from './aiStateSnapshots';
import {
  idbDeleteSessionIds,
  idbPutSessions,
  openAiSessionsIdb,
  resetAiSessionsIdbForTests,
} from './aiSessionIdbStorage';
import { installFakeIndexedDb } from './testSupport/fakeIndexedDb';

function makeSession(id: string, updatedAt: number): AISession {
  return {
    id,
    title: id,
    agentId: 'catty',
    scope: { type: 'global' },
    messages: [],
    createdAt: updatedAt,
    updatedAt,
  } as AISession;
}

function installDom() {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost' });
  for (const name of ['window', 'document', 'localStorage', 'CustomEvent', 'Event'] as const) {
    Object.defineProperty(globalThis, name, { configurable: true, value: name === 'window' ? dom.window : dom.window[name] });
  }
  Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { configurable: true, value: true });
  return dom;
}

interface Mounted {
  ai: ReturnType<typeof useAIState>;
  root: ReturnType<typeof createRoot>;
  container: HTMLDivElement;
}

async function mountAiState(): Promise<Mounted> {
  const holder: { ai?: ReturnType<typeof useAIState> } = {};
  function Harness() {
    holder.ai = useAIState();
    return null;
  }
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => { root.render(React.createElement(Harness)); });
  return { ai: holder.ai!, root, container };
}

async function unmount(mounted: Mounted, dom: JSDOM) {
  await act(async () => { mounted.root.unmount(); });
  mounted.container.remove();
  dom.window.close();
}

test.beforeEach(() => {
  // Post-boot defaults first, then back to pending so every test starts
  // from the pre-hydration state its own hook instance controls.
  __resetIdbPersistenceForTests();
  __resetAiSessionsHydrationForTests();
  // Module-level snapshots leak across tests (the hook's initial state and
  // the boot merge path read them) — reset to the cold-start state. The
  // map snapshot must be null so the hook falls back to localStorage.
  setLatestAISessionsSnapshot([]);
  setLatestAIActiveSessionMapSnapshot(null as unknown as Record<string, string | null>);
  setLatestAIDraftsByScopeSnapshot({});
  setLatestAIPanelViewByScopeSnapshot({});
});

// ── P2①: idbFailed boot must persist the legacy set before seeding the baseline ──

test('P2①a: after a transient IndexedDB open failure the legacy sessions are persisted and the baseline seeded', async () => {
  const dom = installDom();
  const idb = installFakeIndexedDb({ failOpenTimes: 1 });
  const legacy = [makeSession('chat-a', 2), makeSession('chat-b', 1)];
  dom.window.localStorage.setItem(STORAGE_KEY_AI_SESSIONS, JSON.stringify(legacy));
  const mounted = await mountAiState();
  try {
    // One open retry happened inside the boot effect: the legacy set now
    // lives in IndexedDB (old code never retried and left the store empty).
    const ids = idb.db.dumpStore('sessions').map((s) => (s as AISession).id).sort();
    assert.deepEqual(ids, ['chat-a', 'chat-b']);
    assert.deepEqual(
      getPersistedAiSessionsSnapshot().map((s) => s.id).sort(),
      ['chat-a', 'chat-b'],
    );
    assert.deepEqual(getAISessionsSnapshot().sessions.map((s) => s.id).sort(), ['chat-a', 'chat-b']);
  } finally {
    await unmount(mounted, dom);
    idb.restore();
    resetAiSessionsIdbForTests();
  }
});

test('P2①b: with IndexedDB unreachable the baseline stays unset, so a later edit rewrites every record', async () => {
  const dom = installDom();
  const failing = installFakeIndexedDb({ failOpen: true });
  const legacy = [makeSession('chat-a', 2), makeSession('chat-b', 1)];
  dom.window.localStorage.setItem(STORAGE_KEY_AI_SESSIONS, JSON.stringify(legacy));
  const mounted = await mountAiState();
  let recovered: ReturnType<typeof installFakeIndexedDb> | null = null;
  try {
    // The retry open also failed: nothing was persisted, and the diff
    // baseline must remain unset.
    assert.deepEqual(failing.db.dumpStore('sessions'), []);

    // IndexedDB recovers, then the user edits ONE session. The full set
    // must reach the store, not only the edited record.
    failing.restore();
    resetAiSessionsIdbForTests();
    recovered = installFakeIndexedDb();
    await act(async () => {
      mounted.ai.addMessageToSession('chat-a', { id: 'm-1', role: 'user', content: 'Edited', timestamp: 3 });
    });
    await new Promise((resolve) => setTimeout(resolve, 600)); // debounced persist
    await act(async () => {});
    await __flushIdbWritesForTests();
    const ids = recovered.db.dumpStore('sessions').map((s) => (s as AISession).id).sort();
    assert.deepEqual(ids, ['chat-a', 'chat-b']);
  } finally {
    await unmount(mounted, dom);
    if (recovered) recovered.restore();
    resetAiSessionsIdbForTests();
  }
});

// ── P2②: pointer validation waits for hydration ──

test('P2②: pointers survive cold mount before hydration and stay valid after the boot load', async () => {
  const dom = installDom();
  const source = makeSession('chat-1', 1);
  dom.window.localStorage.setItem(STORAGE_KEY_AI_SESSIONS, JSON.stringify([source]));
  dom.window.localStorage.setItem(
    STORAGE_KEY_AI_ACTIVE_SESSION_MAP,
    JSON.stringify({ 'terminal:t1': 'chat-1' }),
  );
  const mounted = await mountAiState();
  try {
    // Old code nulled the pointer here: the validation effect ran against
    // the initially-empty in-memory session array.
    assert.equal(getAISessionsSnapshot().activeSessionIdMap['terminal:t1'], 'chat-1');
    assert.equal(
      JSON.parse(dom.window.localStorage.getItem(STORAGE_KEY_AI_ACTIVE_SESSION_MAP)!)['terminal:t1'],
      'chat-1',
    );
    // After hydration the session is restored and the pointer is intact.
    await act(async () => {});
    assert.deepEqual(getAISessionsSnapshot().sessions.map((s) => s.id), ['chat-1']);
    assert.equal(getAISessionsSnapshot().activeSessionIdMap['terminal:t1'], 'chat-1');
  } finally {
    await unmount(mounted, dom);
  }
});

// ── P2③: unopenable IndexedDB + corrupt legacy → disk backup is applied ──

test('P2③: with IndexedDB unopenable and the legacy store corrupt the newest disk backup generation is applied', async () => {
  const dom = installDom();
  installFakeIndexedDb({ failOpen: true });
  dom.window.localStorage.setItem(STORAGE_KEY_AI_SESSIONS, 'not-json'); // corrupt legacy
  const backup = [makeSession('backup-chat', 5)];
  const warns: unknown[][] = [];
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]) => { warns.push(args); };
  try {
    Object.assign(dom.window, {
      netcatty: { aiSessionsBackupReadLatest: async () => ({ ok: true, json: JSON.stringify(backup) }) },
    });
    const mounted = await mountAiState();
    try {
      await act(async () => {});
      // The backup generation became the recovery source (old code: the
      // failing IndexedDB recheck rejection was swallowed and the restore
      // never ran).
      assert.deepEqual(getAISessionsSnapshot().sessions.map((s) => s.id), ['backup-chat']);
      assert.deepEqual(getPersistedAiSessionsSnapshot().map((s) => s.id), ['backup-chat']);
      // The unopenable-store error was surfaced, not swallowed.
      assert.ok(warns.some((args) => String(args[0]).includes('IndexedDB recheck failed')));
    } finally {
      await unmount(mounted, dom);
    }
  } finally {
    console.warn = originalWarn;
    delete (dom.window as unknown as { netcatty?: unknown }).netcatty;
    resetAiSessionsIdbForTests();
  }
});

// ── P2④: an empty getAll after hydration is an intentional deletion ──

test('P2④: adopting an empty IndexedDB store after another window deleted the last chat', async () => {
  const dom = installDom();
  const idb = installFakeIndexedDb();
  const source = makeSession('chat-1', 1);
  await idbPutSessions(await openAiSessionsIdb(), [source]);
  const mounted = await mountAiState();
  try {
    await act(async () => {});
    assert.deepEqual(getAISessionsSnapshot().sessions.map((s) => s.id), ['chat-1']);
    // Another window deletes the last chat and announces the change. The
    // announcement must come from a second BroadcastChannel: a channel never
    // delivers to itself (the module-level channel is the receiving window).
    await idbDeleteSessionIds(await openAiSessionsIdb(), ['chat-1']);
    const otherWindow = new BroadcastChannel('netcatty_ai_sessions_changed');
    await act(async () => {
      otherWindow.postMessage(Date.now());
      await new Promise((resolve) => setTimeout(resolve, 25));
    });
    otherWindow.close();
    // Old code early-returned on the empty getAll and kept the deleted
    // session alive locally.
    assert.deepEqual(getAISessionsSnapshot().sessions, []);
    assert.deepEqual(getPersistedAiSessionsSnapshot(), []);
  } finally {
    await unmount(mounted, dom);
    idb.restore();
    resetAiSessionsIdbForTests();
  }
});
