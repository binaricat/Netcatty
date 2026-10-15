import assert from 'node:assert/strict';
import test from 'node:test';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { JSDOM } from 'jsdom';

import type { AISession, AISessionScope } from '../../infrastructure/ai/types.ts';
import { getScopedHistorySessions } from '../../components/ai/scopedHistorySessions.ts';
import { useAIState } from './useAIState.ts';
import { useAISessionsStore } from './aiSessionsStore.ts';

const scopeKey = 'terminal:terminal-fork';
const terminalScope: AISessionScope = { type: 'terminal', targetId: 'terminal-fork' };

const source: AISession = {
  id: 'original',
  title: 'Original',
  agentId: 'catty',
  scope: terminalScope,
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

// A workspace member can be continuing a chat created on an older terminal; the
// chat is part of the workspace only through that member's active selection.
const inheritedSource: AISession = {
  ...source,
  id: 'inherited',
  scope: { type: 'terminal', targetId: 'terminal-old', hostIds: ['host-1'] },
};

let state: ReturnType<typeof useAIState>;
let sessions: ReturnType<typeof useAISessionsStore>;
function Harness() {
  state = useAIState();
  sessions = useAISessionsStore();
  return null;
}

test('fork copies the conversation into the creating scope without touching the source', async () => {
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
  dom.window.localStorage.setItem('netcatty_ai_sessions_v1', JSON.stringify([source, inheritedSource]));
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => root.render(<Harness />));

  let forked: AISession | null = null;
  await act(async () => {
    forked = state.forkSession('original', 'answer-1', terminalScope, scopeKey);
  });
  assert.ok(forked);
  assert.deepEqual(forked.messages.map(message => message.content), ['First question', 'First answer']);
  // A fork is a new chat: it cannot resume the source's provider thread.
  assert.equal(forked.externalSessionId, undefined);
  assert.equal(forked.scope, terminalScope);
  assert.equal(sessions.activeSessionIdMap[scopeKey], forked.id);
  // The source stays in history, untouched.
  assert.deepEqual(sessions.sessions.find(session => session.id === source.id)?.messages, source.messages);
  assert.equal(sessions.sessions.find(session => session.id === source.id)?.externalSessionId, 'remote-original');
  assert.ok((JSON.parse(dom.window.localStorage.getItem('netcatty_ai_sessions_v1') ?? '[]') as AISession[])
    .some(session => session.id === forked.id));

  // Only a completed response can anchor a fork.
  await act(async () => {
    assert.equal(state.forkSession('original', 'question-1', terminalScope, scopeKey), null);
    assert.equal(state.forkSession('original', 'missing', terminalScope, scopeKey), null);
    assert.equal(state.forkSession('missing', 'answer-1', terminalScope, scopeKey), null);
  });

  // Forking an inherited member chat from the workspace must keep the fork in
  // that workspace's history instead of normalizing straight back to the draft.
  const workspaceScope: AISessionScope = { type: 'workspace', targetId: 'workspace-1', hostIds: ['host-1'] };
  const workspaceScopeKey = 'workspace:workspace-1';
  const memberTerminalId = 'terminal-member';
  const workspaceMemberTerminalIds = new Set([memberTerminalId]);
  const workspaceHistoryIds = () => getScopedHistorySessions(
    [...sessions.sessions],
    'workspace',
    'workspace-1',
    ['host-1'],
    new Set<string>(),
    workspaceMemberTerminalIds,
    sessions.activeSessionIdMap,
  ).map(session => session.id);

  await act(async () => {
    state.setActiveSessionId(`terminal:${memberTerminalId}`, inheritedSource.id);
  });
  assert.ok(workspaceHistoryIds().includes(inheritedSource.id));

  let workspaceFork: AISession | null = null;
  await act(async () => {
    workspaceFork = state.forkSession('inherited', 'answer-2', workspaceScope, workspaceScopeKey);
  });
  assert.ok(workspaceFork);
  assert.deepEqual(workspaceFork.scope, workspaceScope);
  assert.equal(sessions.activeSessionIdMap[workspaceScopeKey], workspaceFork.id);
  assert.ok(workspaceHistoryIds().includes(workspaceFork.id));
  // The member terminal keeps the chat it was already showing.
  assert.equal(sessions.activeSessionIdMap[`terminal:${memberTerminalId}`], inheritedSource.id);

  await act(async () => root.unmount());
  container.remove();
  dom.window.close();
});