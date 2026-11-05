import assert from 'node:assert/strict';
import test from 'node:test';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { JSDOM } from 'jsdom';
import type { AISession } from '../../infrastructure/ai/types';
import { STORAGE_KEY_AI_SESSIONS, STORAGE_KEY_CLOUD_SYNC_AI_SESSIONS } from '../../infrastructure/config/storageKeys';
import { useAIState } from './useAIState';
import { useAISessionsStore } from './aiSessionsStore';
import { setLatestAISessionsSnapshot } from './aiStateSnapshots';

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

