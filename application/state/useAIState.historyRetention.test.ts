import assert from 'node:assert/strict';
import test from 'node:test';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { JSDOM } from 'jsdom';
import type { AISession } from '../../infrastructure/ai/types';
import { STORAGE_KEY_AI_ACTIVE_SESSION_MAP, STORAGE_KEY_AI_SESSIONS, STORAGE_KEY_AI_SESSIONS_OVERFLOW, STORAGE_KEY_AI_SESSIONS_DISK_OVERFLOW, STORAGE_KEY_CLOUD_SYNC_AI_SESSIONS } from '../../infrastructure/config/storageKeys';
import { useAIState } from './useAIState';
import { useAISessionsStore } from './aiSessionsStore';
import { __resetBackupMirrorForTests, flushBackupMirror, readSessionsFromStorage, setLatestAIActiveSessionMapSnapshot, setLatestAISessionsSnapshot, writeSessionsForStorage } from './aiStateSnapshots';

for (const enabled of [true, false]) {
  test(`appending to long history preserves the synced prefix (chat sync ${enabled})`, async () => {
    const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost' });
    for (const name of ['window', 'document', 'localStorage', 'CustomEvent', 'Event'] as const) {
      Object.defineProperty(globalThis, name, { configurable: true, value: name === 'window' ? dom.window : dom.window[name] });
    }
    Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { configurable: true, value: true });
    const source: AISession = {
      id: 'long-chat', title: 'Long chat', agentId: 'codex', externalSessionId: 'native-thread',
      scope: { type: 'global' }, createdAt: 1, updatedAt: 501,
      messages: [{ id: 'system', role: 'system', content: 'Instruction', timestamp: 0 },
        ...Array.from({ length: 500 }, (_, index) => ({ id: `message-${index}`, role: 'user' as const, content: `Prompt ${index}`, timestamp: index + 1 }))],
    };
    setLatestAISessionsSnapshot([source]);
    dom.window.localStorage.setItem(STORAGE_KEY_AI_SESSIONS, JSON.stringify([source]));
    dom.window.localStorage.setItem(STORAGE_KEY_CLOUD_SYNC_AI_SESSIONS, JSON.stringify({ enabled }));
    let ai: ReturnType<typeof useAIState>;
    let sessions: readonly AISession[] = [];
    function Harness() {
      ai = useAIState();
      sessions = useAISessionsStore().sessions;
      return null;
    }
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    try {
      await act(async () => { root.render(React.createElement(Harness)); });
      await act(async () => {
        ai!.addMessageToSession(source.id, { id: 'new-reply', role: 'assistant', content: 'Continued', timestamp: 502 });
      });
      const updated = sessions.find(value => value.id === source.id)!;
      assert.equal(updated.messages.length, enabled ? 502 : 500);
      assert.equal(updated.messages[0].id, 'system');
      assert.equal(updated.messages[1].id, enabled ? 'message-0' : 'message-2');
      assert.equal(updated.messages.at(-1)?.id, 'new-reply');
      assert.equal(updated.externalSessionId, 'native-thread');
    } finally {
      await act(async () => { root.unmount(); });
      container.remove();
      dom.window.close();
    }
  });
}

test('startup and cross-window updates load overflow chats and mirror the merged history', async () => {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost' });
  for (const name of ['window', 'document', 'localStorage', 'CustomEvent', 'Event'] as const) {
    Object.defineProperty(globalThis, name, { configurable: true, value: name === 'window' ? dom.window : dom.window[name] });
  }
  Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { configurable: true, value: true });
  const primary: AISession = {
    id: 'primary', title: 'Primary', agentId: 'catty', scope: { type: 'global' },
    createdAt: 1, updatedAt: 2, messages: [],
  };
  const overflow = { ...primary, id: 'overflow', title: 'Overflow', updatedAt: 1 };
  dom.window.localStorage.setItem(STORAGE_KEY_AI_SESSIONS, JSON.stringify([primary]));
  dom.window.localStorage.setItem(STORAGE_KEY_AI_SESSIONS_OVERFLOW, JSON.stringify([overflow]));
  setLatestAISessionsSnapshot(null as unknown as AISession[]);
  __resetBackupMirrorForTests();
  const backups: string[] = [];
  Object.assign(dom.window, { netcatty: { aiSessionsBackupWrite: async ({ json }: { json: string }) => {
    backups.push(json);
    return { ok: true };
  } } });
  let sessions: readonly AISession[] = [];
  function Harness() {
    useAIState();
    sessions = useAISessionsStore().sessions;
    return null;
  }
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  try {
    await act(async () => { root.render(React.createElement(Harness)); });
    assert.deepEqual(sessions, [primary, overflow]);
    flushBackupMirror();
    assert.deepEqual(JSON.parse(backups[0]), [primary, overflow]);
    const updatedOverflow = { ...overflow, title: 'Updated elsewhere', updatedAt: 3 };
    await act(async () => {
      dom.window.localStorage.setItem(STORAGE_KEY_AI_SESSIONS_OVERFLOW, JSON.stringify([updatedOverflow]));
      dom.window.dispatchEvent(new dom.window.StorageEvent('storage', { key: STORAGE_KEY_AI_SESSIONS_OVERFLOW }));
    });
    assert.deepEqual(sessions, [updatedOverflow, primary]);
  } finally {
    await act(async () => { root.unmount(); });
    __resetBackupMirrorForTests();
    setLatestAISessionsSnapshot([]);
    container.remove();
    dom.window.close();
  }
});

for (const scopeType of ['global', 'terminal'] as const) {
  test(`import retains disk-only chats in live history across rename and deletion (${scopeType})`, async () => {
    const dom = new JSDOM('<!doctype html><html><body></body></html>', {
      url: 'http://localhost', storageQuota: 5 * 1024 * 1024,
    });
    const previousDOMException = globalThis.DOMException;
    for (const name of ['window', 'document', 'localStorage', 'CustomEvent', 'Event', 'DOMException'] as const) {
      Object.defineProperty(globalThis, name, { configurable: true, value: name === 'window' ? dom.window : dom.window[name] });
    }
    Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { configurable: true, value: true });
    const source: AISession[] = Array.from({ length: 6 }, (_, index) => ({
      id: `imported-${index}`, title: `Imported ${index}`, agentId: 'catty',
      scope: scopeType === 'global' ? { type: 'global' } : { type: 'terminal', targetId: 'closed-terminal' },
      createdAt: 1, updatedAt: 6 - index,
      messages: [{ id: 'm', role: 'user', content: 'x'.repeat(Math.floor(1.1 * 1024 * 1024)), timestamp: 1 }],
    }));
    const ids = source.map(session => session.id);
    const backups: string[] = [];
    Object.assign(dom.window, { netcatty: {
      aiSessionsBackupImport: async () => ({ success: true, json: JSON.stringify(source) }),
      aiSessionsBackupWrite: async ({ json }: { json: string }) => { backups.push(json); return { ok: true }; },
    } });
    dom.window.localStorage.setItem(STORAGE_KEY_AI_SESSIONS, '[]');
    setLatestAISessionsSnapshot([]);
    setLatestAIActiveSessionMapSnapshot({});
    __resetBackupMirrorForTests();
    let ai!: ReturnType<typeof useAIState>;
    let sessions: readonly AISession[] = [];
    function Harness() {
      ai = useAIState();
      sessions = useAISessionsStore().sessions;
      return null;
    }
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    try {
      await act(async () => { root.render(React.createElement(Harness)); });
      await act(async () => { ai.cleanupOrphanedSessions(new Set()); });
      let importedCount = 0;
      await act(async () => { importedCount = await ai.importSessionsBackup(); });
      assert.equal(importedCount, source.length);
      assert.deepEqual(sessions.map(session => session.id), ids);
      assert.deepEqual(readSessionsFromStorage().map(session => session.id), [ids[0]]);
      assert.deepEqual(JSON.parse(dom.window.localStorage.getItem(STORAGE_KEY_AI_SESSIONS_DISK_OVERFLOW)!), ids.slice(1));
      assert.equal(sessions.every(session => !!session.scopeDangling === (scopeType === 'terminal')), true);
      flushBackupMirror();
      assert.deepEqual(JSON.parse(backups.at(-1)!), sessions);

      await act(async () => { ai.updateSessionTitle(ids[0], 'Renamed after import'); });
      assert.deepEqual(sessions.map(session => session.id), ids);
      assert.equal(sessions[0].title, 'Renamed after import');
      assert.deepEqual(JSON.parse(dom.window.localStorage.getItem(STORAGE_KEY_AI_SESSIONS_DISK_OVERFLOW)!), ids.slice(1));
      flushBackupMirror();
      assert.deepEqual(JSON.parse(backups.at(-1)!), sessions);

      await act(async () => { ai.deleteSession(ids[5]); });
      assert.deepEqual(sessions.map(session => session.id), ids.slice(0, 5));
      assert.deepEqual(JSON.parse(dom.window.localStorage.getItem(STORAGE_KEY_AI_SESSIONS_DISK_OVERFLOW)!), ids.slice(1, 5));
      flushBackupMirror();
      assert.deepEqual(JSON.parse(backups.at(-1)!), sessions);
    } finally {
      await act(async () => { root.unmount(); });
      __resetBackupMirrorForTests();
      setLatestAISessionsSnapshot([]);
      setLatestAIActiveSessionMapSnapshot({});
      container.remove();
      dom.window.close();
      Object.defineProperty(globalThis, 'DOMException', { configurable: true, value: previousDOMException });
    }
  });
}

test('startup recovers disk-only chats before mirroring a valid partial primary', async () => {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', {
    url: 'http://localhost', storageQuota: 5 * 1024 * 1024,
  });
  const previousDOMException = globalThis.DOMException;
  for (const name of ['window', 'document', 'localStorage', 'CustomEvent', 'Event', 'DOMException'] as const) {
    Object.defineProperty(globalThis, name, { configurable: true, value: name === 'window' ? dom.window : dom.window[name] });
  }
  Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { configurable: true, value: true });
  const source: AISession[] = Array.from({ length: 6 }, (_, index) => ({
    id: `chat-${index}`, title: `Chat ${index}`, agentId: 'catty', scope: { type: 'global' },
    createdAt: 1, updatedAt: 6 - index,
    messages: [{ id: 'm', role: 'user', content: 'x'.repeat(Math.floor(1.1 * 1024 * 1024)), timestamp: 1 }],
  }));
  const backups: string[] = [];
  let reads = 0;
  let resolveRead!: (backup: { ok: boolean; json: string }) => void;
  Object.assign(dom.window, { netcatty: {
    aiSessionsBackupWrite: async ({ json }: { json: string }) => { backups.push(json); return { ok: true }; },
    aiSessionsBackupReadLatest: () => {
      reads += 1;
      return new Promise(resolve => { resolveRead = resolve; });
    },
  } });
  __resetBackupMirrorForTests();
  assert.equal(writeSessionsForStorage(source), true);
  flushBackupMirror();
  assert.deepEqual(JSON.parse(backups[0]), source);
  assert.deepEqual(readSessionsFromStorage(), [source[0]]);
  assert.deepEqual(JSON.parse(dom.window.localStorage.getItem(STORAGE_KEY_AI_SESSIONS_DISK_OVERFLOW)!), source.slice(1).map(session => session.id));
  // A newer local copy must win, and an old deleted chat in the backup must
  // stay deleted: only the explicitly recorded disk-only IDs are recovered.
  const primary = { ...source[0], title: 'Newer primary', updatedAt: 10 };
  dom.window.localStorage.setItem(STORAGE_KEY_AI_SESSIONS, JSON.stringify([primary]));
  const expected = [primary, ...source.slice(1)];
  const staleBackup = JSON.stringify([...source, { ...source[5], id: 'deleted-chat' }]);
  backups.length = 0;
  __resetBackupMirrorForTests();
  setLatestAISessionsSnapshot(null as unknown as AISession[]);
  let sessions: readonly AISession[] = [];
  function Harness() {
    useAIState();
    sessions = useAISessionsStore().sessions;
    return null;
  }
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  try {
    await act(async () => { root.render(React.createElement(Harness)); });
    assert.equal(reads, 1);
    flushBackupMirror();
    assert.deepEqual(backups, []);
    await act(async () => { resolveRead({ ok: true, json: staleBackup }); });
    assert.deepEqual(sessions, expected);
    flushBackupMirror();
    assert.deepEqual(JSON.parse(backups.at(-1)!), expected);
    assert.deepEqual(readSessionsFromStorage(), [primary]);
  } finally {
    await act(async () => { root.unmount(); });
    __resetBackupMirrorForTests();
    setLatestAISessionsSnapshot([]);
    container.remove();
    dom.window.close();
    Object.defineProperty(globalThis, 'DOMException', { configurable: true, value: previousDOMException });
  }
});

for (const scopeType of ['terminal', 'workspace'] as const) {
  test(`startup orphan cleanup preserves pending disk-only recovery (${scopeType})`, async () => {
    const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost' });
    for (const name of ['window', 'document', 'localStorage', 'CustomEvent', 'Event'] as const) {
      Object.defineProperty(globalThis, name, { configurable: true, value: name === 'window' ? dom.window : dom.window[name] });
    }
    Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { configurable: true, value: true });
    const primary: AISession = {
      id: 'closed-primary', title: 'Closed primary', agentId: 'catty',
      scope: { type: scopeType, targetId: 'closed-target' },
      createdAt: 1, updatedAt: 2, messages: [],
    };
    const diskOnly: AISession = {
      ...primary, id: 'disk-only', title: 'Disk only', updatedAt: 1,
      scope: { type: scopeType, targetId: 'another-closed-target' },
    };
    dom.window.localStorage.setItem(STORAGE_KEY_AI_SESSIONS, JSON.stringify([primary]));
    dom.window.localStorage.setItem(STORAGE_KEY_AI_SESSIONS_DISK_OVERFLOW, JSON.stringify([diskOnly.id]));
    setLatestAISessionsSnapshot(null as unknown as AISession[]);
    __resetBackupMirrorForTests();
    const backups: string[] = [];
    let reads = 0;
    let resolveRead!: (backup: { ok: boolean; json: string }) => void;
    Object.assign(dom.window, { netcatty: {
      aiSessionsBackupWrite: async ({ json }: { json: string }) => { backups.push(json); return { ok: true }; },
      aiSessionsBackupReadLatest: () => {
        reads += 1;
        return new Promise(resolve => { resolveRead = resolve; });
      },
    } });
    let sessions: readonly AISession[] = [];
    function Harness() {
      const ai = useAIState();
      sessions = useAISessionsStore().sessions;
      // TerminalLayerSupport performs this cleanup on mount, while the disk
      // backup IPC read can still be pending.
      React.useEffect(() => { ai.cleanupOrphanedSessions(new Set()); }, [ai.cleanupOrphanedSessions]);
      return null;
    }
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    try {
      await act(async () => { root.render(React.createElement(Harness)); });
      assert.equal(reads, 1);
      assert.deepEqual(sessions, [{ ...primary, scopeDangling: true }]);
      assert.deepEqual(JSON.parse(dom.window.localStorage.getItem(STORAGE_KEY_AI_SESSIONS_DISK_OVERFLOW)!), [diskOnly.id]);
      flushBackupMirror();
      assert.deepEqual(backups, []);

      await act(async () => { resolveRead({ ok: true, json: JSON.stringify([primary, diskOnly]) }); });
      const expected = [primary, diskOnly].map(session => ({ ...session, scopeDangling: true }));
      assert.deepEqual(sessions, expected);
      assert.deepEqual(readSessionsFromStorage(), expected);
      assert.equal(dom.window.localStorage.getItem(STORAGE_KEY_AI_SESSIONS_DISK_OVERFLOW), null);
      flushBackupMirror();
      assert.deepEqual(JSON.parse(backups.at(-1)!), expected);
    } finally {
      await act(async () => { root.unmount(); });
      __resetBackupMirrorForTests();
      setLatestAISessionsSnapshot([]);
      container.remove();
      dom.window.close();
    }
  });
}

for (const mutation of ['rename', 'create', 'delete', 'delete-pending'] as const) {
  test(`live ${mutation} preserves intended history across pending disk recovery`, async () => {
    const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost' });
    for (const name of ['window', 'document', 'localStorage', 'CustomEvent', 'Event'] as const) {
      Object.defineProperty(globalThis, name, { configurable: true, value: name === 'window' ? dom.window : dom.window[name] });
    }
    Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { configurable: true, value: true });
    const primary: AISession = {
      id: 'primary', title: 'Primary', agentId: 'catty', scope: { type: 'global' },
      createdAt: 1, updatedAt: 2, messages: [],
    };
    const diskOnly = { ...primary, id: 'disk-only', updatedAt: 1 };
    dom.window.localStorage.setItem(STORAGE_KEY_AI_SESSIONS, JSON.stringify([primary]));
    dom.window.localStorage.setItem(STORAGE_KEY_AI_SESSIONS_DISK_OVERFLOW, JSON.stringify([diskOnly.id]));
    dom.window.localStorage.setItem(STORAGE_KEY_AI_ACTIVE_SESSION_MAP, JSON.stringify({ 'global:': diskOnly.id }));
    setLatestAIActiveSessionMapSnapshot({ 'global:': diskOnly.id });
    setLatestAISessionsSnapshot(null as unknown as AISession[]);
    __resetBackupMirrorForTests();
    const backups: string[] = [];
    let resolveRead!: (backup: { ok: boolean; json: string }) => void;
    Object.assign(dom.window, { netcatty: {
      aiSessionsBackupWrite: async ({ json }: { json: string }) => { backups.push(json); return { ok: true }; },
      aiSessionsBackupReadLatest: () => new Promise(resolve => { resolveRead = resolve; }),
    } });
    let ai!: ReturnType<typeof useAIState>;
    let snapshot!: ReturnType<typeof useAISessionsStore>;
    function Harness() {
      ai = useAIState();
      snapshot = useAISessionsStore();
      return null;
    }
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    try {
      await act(async () => { root.render(React.createElement(Harness)); });
      assert.equal(snapshot.activeSessionIdMap['global:'], diskOnly.id);
      await act(async () => {
        if (mutation === 'rename') ai.updateSessionTitle(primary.id, 'Renamed before recovery');
        else if (mutation === 'create') ai.createSession({ type: 'global' }, 'catty');
        else ai.deleteSession(mutation === 'delete-pending' ? diskOnly.id : primary.id);
      });
      const liveBeforeRecovery = [...snapshot.sessions];
      const expectedActiveId = mutation === 'create' ? liveBeforeRecovery[0].id
        : mutation === 'delete-pending' ? null : diskOnly.id;
      assert.equal(snapshot.activeSessionIdMap['global:'], expectedActiveId);
      assert.deepEqual(readSessionsFromStorage(), liveBeforeRecovery);
      const recoveryMarker = dom.window.localStorage.getItem(STORAGE_KEY_AI_SESSIONS_DISK_OVERFLOW);
      assert.deepEqual(recoveryMarker == null ? null : JSON.parse(recoveryMarker), mutation === 'delete-pending' ? null : [diskOnly.id]);
      flushBackupMirror();
      assert.deepEqual(backups.map(json => JSON.parse(json)), mutation === 'delete-pending' ? [liveBeforeRecovery] : []);

      await act(async () => { resolveRead({ ok: true, json: JSON.stringify([primary, diskOnly]) }); });
      const expected = mutation === 'delete-pending' ? liveBeforeRecovery : [...liveBeforeRecovery, diskOnly];
      assert.deepEqual(snapshot.sessions, expected);
      assert.deepEqual(readSessionsFromStorage(), expected);
      assert.equal(dom.window.localStorage.getItem(STORAGE_KEY_AI_SESSIONS_DISK_OVERFLOW), null);
      flushBackupMirror();
      assert.deepEqual(JSON.parse(backups.at(-1)!), expected);
    } finally {
      await act(async () => { root.unmount(); });
      __resetBackupMirrorForTests();
      setLatestAISessionsSnapshot([]);
      setLatestAIActiveSessionMapSnapshot({});
      container.remove();
      dom.window.close();
    }
  });
}

test('count-cap eviction clears a loaded disk-only marker and resumes backup mirroring', () => {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost' });
  for (const name of ['window', 'document', 'localStorage', 'CustomEvent', 'Event'] as const) {
    Object.defineProperty(globalThis, name, { configurable: true, value: name === 'window' ? dom.window : dom.window[name] });
  }
  const source: AISession[] = Array.from({ length: 51 }, (_, index) => ({
    id: `chat-${index}`, title: `Chat ${index}`, agentId: 'catty', scope: { type: 'global' },
    createdAt: 1, updatedAt: 51 - index, messages: [],
  }));
  dom.window.localStorage.setItem(STORAGE_KEY_AI_SESSIONS_DISK_OVERFLOW, JSON.stringify([source[50].id]));
  const backups: string[] = [];
  Object.assign(dom.window, { netcatty: { aiSessionsBackupWrite: async ({ json }: { json: string }) => {
    backups.push(json);
    return { ok: true };
  } } });
  __resetBackupMirrorForTests();
  try {
    assert.equal(writeSessionsForStorage(source), true);
    assert.deepEqual(readSessionsFromStorage(), source.slice(0, 50));
    assert.equal(dom.window.localStorage.getItem(STORAGE_KEY_AI_SESSIONS_DISK_OVERFLOW), null);
    flushBackupMirror();
    assert.deepEqual(backups.map(json => JSON.parse(json)), [source.slice(0, 50)]);
  } finally {
    __resetBackupMirrorForTests();
    dom.window.close();
  }
});

for (const keepPrimary of [true, false]) {
  test(`deletion clears disk-only recovery and remains authoritative (keep primary ${keepPrimary})`, async () => {
    const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost' });
    for (const name of ['window', 'document', 'localStorage', 'CustomEvent', 'Event'] as const) {
      Object.defineProperty(globalThis, name, { configurable: true, value: name === 'window' ? dom.window : dom.window[name] });
    }
    Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { configurable: true, value: true });
    const primary: AISession = {
      id: 'primary', title: 'Primary', agentId: 'catty', scope: { type: 'global' },
      createdAt: 1, updatedAt: 2, messages: [],
    };
    dom.window.localStorage.setItem(STORAGE_KEY_AI_SESSIONS, JSON.stringify([primary]));
    dom.window.localStorage.setItem(STORAGE_KEY_AI_SESSIONS_DISK_OVERFLOW, JSON.stringify(['deleted-chat']));
    const remaining = keepPrimary ? [primary] : [];
    assert.equal(writeSessionsForStorage(remaining, { deletedSessionIds: ['deleted-chat'] }), true);
    assert.equal(dom.window.localStorage.getItem(STORAGE_KEY_AI_SESSIONS_DISK_OVERFLOW), null);
    __resetBackupMirrorForTests();
    setLatestAISessionsSnapshot(null as unknown as AISession[]);
    let reads = 0;
    Object.assign(dom.window, { netcatty: { aiSessionsBackupReadLatest: async () => {
      reads += 1;
      return { ok: true, json: JSON.stringify([primary, { ...primary, id: 'deleted-chat' }]) };
    } } });
    let sessions: readonly AISession[] = [];
    function Harness() {
      useAIState();
      sessions = useAISessionsStore().sessions;
      return null;
    }
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    try {
      await act(async () => { root.render(React.createElement(Harness)); });
      assert.equal(reads, 0);
      assert.deepEqual(sessions, remaining);
    } finally {
      await act(async () => { root.unmount(); });
      __resetBackupMirrorForTests();
      setLatestAISessionsSnapshot([]);
      container.remove();
      dom.window.close();
    }
  });
}
