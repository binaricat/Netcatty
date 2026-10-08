import assert from 'node:assert/strict';
import test from 'node:test';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { JSDOM } from 'jsdom';

import type { AISession } from '../../infrastructure/ai/types.ts';
import { useAIState } from './useAIState.ts';
import { useAISessionsStore } from './aiSessionsStore.ts';

const scopeKey = 'terminal:terminal-branch';
const source: AISession = {
  id: 'original',
  title: 'Original',
  agentId: 'catty',
  scope: { type: 'terminal', targetId: 'terminal-branch' },
  messages: [
    { id: 'question-1', role: 'user', content: 'First question', timestamp: 1 },
    { id: 'answer-1', role: 'assistant', content: 'First answer', timestamp: 2 },
    { id: 'question-2', role: 'user', content: 'Second question', timestamp: 3 },
    { id: 'answer-2', role: 'assistant', content: 'Second answer', timestamp: 4 },
  ],
  externalSessionId: 'remote-original',
  createdAt: 1,
  updatedAt: 4,
};

let state: ReturnType<typeof useAIState>;
let sessions: ReturnType<typeof useAISessionsStore>;
function Harness() {
  state = useAIState();
  sessions = useAISessionsStore();
  return null;
}

test('branch and undo create independent selected sessions without resuming provider state', async () => {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost' });
  for (const [key, value] of Object.entries({
    window: dom.window,
    document: dom.window.document,
    localStorage: dom.window.localStorage,
    CustomEvent: dom.window.CustomEvent,
    Event: dom.window.Event,
    IS_REACT_ACT_ENVIRONMENT: true,
  })) {
    Object.defineProperty(globalThis, key, { configurable: true, value });
  }
  dom.window.localStorage.setItem('netcatty_ai_sessions_v1', JSON.stringify([source]));
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => root.render(<Harness />));

  let fork: ReturnType<typeof state.branchSession> = null;
  await act(async () => {
    fork = state.branchSession(source.id, { kind: 'after-turn', assistantMessageId: 'answer-1' }, scopeKey);
  });
  assert.ok(fork);
  assert.deepEqual(fork.session.messages.map(message => message.content), ['First question', 'First answer']);
  assert.equal(fork.session.externalSessionId, undefined);
  assert.equal(sessions.activeSessionIdMap[scopeKey], fork.session.id);
  assert.deepEqual(sessions.sessions.find(session => session.id === source.id)?.messages, source.messages);
  assert.ok(sessions.sessions.some(session => session.id === fork.session.id));

  let undone: ReturnType<typeof state.branchSession> = null;
  await act(async () => {
    undone = state.branchSession(source.id, { kind: 'before-latest-turn' }, scopeKey);
  });
  assert.ok(undone);
  assert.deepEqual(undone.session.messages.map(message => message.content), ['First question', 'First answer']);
  assert.equal(undone.userDraft?.content, 'Second question');
  assert.equal(sessions.activeSessionIdMap[scopeKey], undone.session.id);
  assert.equal(sessions.panelViewByScope[scopeKey]?.mode, 'session');
  assert.ok((JSON.parse(dom.window.localStorage.getItem('netcatty_ai_sessions_v1') ?? '[]') as AISession[])
    .some(session => session.id === undone.session.id));

  await act(async () => root.unmount());
  container.remove();
  dom.window.close();
});
