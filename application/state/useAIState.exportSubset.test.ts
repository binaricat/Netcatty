import assert from 'node:assert/strict';
import test from 'node:test';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { JSDOM } from 'jsdom';
import type { AISession } from '../../infrastructure/ai/types';
import { useAIState } from './useAIState';
import { setLatestAISessionsSnapshot } from './aiStateSnapshots';

// Global session manager (issue #4098 phase 4): exportSessionsBackup with a
// session-id subset exports only those chats; without one it exports the
// whole store as before (#4018).
test('exportSessionsBackup exports a single-chat subset or the whole store', async () => {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost' });
  for (const name of ['window', 'document', 'localStorage', 'CustomEvent', 'Event'] as const) {
    Object.defineProperty(globalThis, name, { configurable: true, value: name === 'window' ? dom.window : dom.window[name] });
  }
  Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { configurable: true, value: true });

  const sessions: AISession[] = [
    { id: 'chat-a', title: 'A', agentId: 'catty', scope: { type: 'terminal', targetId: 't-1' }, messages: [], createdAt: 1, updatedAt: 10 },
    { id: 'chat-b', title: 'B', agentId: 'codex', scope: { type: 'workspace', targetId: 'w-1' }, messages: [], createdAt: 2, updatedAt: 20 },
  ] as AISession[];

  // Seed the module snapshot so useAIState boots with the live store.
  setLatestAISessionsSnapshot(sessions);

  const exportCalls: string[] = [];
  (dom.window as unknown as { netcatty: unknown }).netcatty = {
    aiSessionsBackupExport: async ({ json }: { json: string }) => {
      exportCalls.push(json);
      return { success: true, filePath: '/tmp/export.json' };
    },
  };

  let ai: ReturnType<typeof useAIState>;
  function Harness() {
    ai = useAIState();
    return null;
  }
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  try {
    await act(async () => { root.render(React.createElement(Harness)); });
    await act(async () => {
      // Hydration completes asynchronously; the export path reads the live ref.
      await Promise.resolve();
    });

    const subsetPath = await ai!.exportSessionsBackup(['chat-b']);
    assert.equal(subsetPath, '/tmp/export.json');
    assert.equal(exportCalls.length, 1);
    const subset = JSON.parse(exportCalls[0]) as AISession[];
    assert.deepEqual(subset.map((session) => session.id), ['chat-b']);

    const wholePath = await ai!.exportSessionsBackup();
    assert.equal(wholePath, '/tmp/export.json');
    const whole = JSON.parse(exportCalls[1]) as AISession[];
    assert.deepEqual(whole.map((session) => session.id).sort(), ['chat-a', 'chat-b']);
  } finally {
    await act(async () => { root.unmount(); });
    container.remove();
    dom.window.close();
  }
});
