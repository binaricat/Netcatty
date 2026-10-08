import assert from 'node:assert/strict';
import test from 'node:test';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { JSDOM } from 'jsdom';

import type { AISession, UploadedFile } from '../../infrastructure/ai/types.ts';
import { useAIState } from './useAIState.ts';
import { useAISessionsStore } from './aiSessionsStore.ts';

const SCOPE_KEY = 'terminal:terminal-a';

const SOURCE_SESSION: AISession = {
  id: 'chat-source',
  title: 'Undo source',
  agentId: 'catty',
  scope: { type: 'terminal', targetId: 'terminal-a' },
  messages: [
    { id: 'user-1', role: 'user', content: 'first prompt', timestamp: 1 },
    { id: 'assistant-1', role: 'assistant', content: 'first answer', timestamp: 2 },
    {
      id: 'user-2',
      role: 'user',
      content: 'bad last prompt',
      timestamp: 3,
      attachments: [
        { base64Data: 'QUJD', mediaType: 'text/plain', filename: 'note.txt', lineCount: 2 },
      ],
    },
    { id: 'assistant-2', role: 'assistant', content: 'bad answer', timestamp: 4 },
  ],
  createdAt: 1,
  updatedAt: 4,
};

type HookCapture = {
  ai: ReturnType<typeof useAIState> | null;
  sessions: AISession[];
  activeSessionIdMap: Record<string, string | null>;
};

function UndoHarness({ capture }: { capture: HookCapture }) {
  capture.ai = useAIState();
  const store = useAISessionsStore();
  capture.sessions = store.sessions as AISession[];
  capture.activeSessionIdMap = store.activeSessionIdMap as Record<string, string | null>;
  return null;
}

async function setupAiState(sessions: AISession[]) {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', {
    url: 'http://localhost',
  });
  Object.defineProperty(globalThis, 'window', { configurable: true, value: dom.window });
  Object.defineProperty(globalThis, 'document', { configurable: true, value: dom.window.document });
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: dom.window.localStorage });
  Object.defineProperty(globalThis, 'CustomEvent', { configurable: true, value: dom.window.CustomEvent });
  Object.defineProperty(globalThis, 'Event', { configurable: true, value: dom.window.Event });
  Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { configurable: true, value: true });

  dom.window.localStorage.setItem('netcatty_ai_sessions_v1', JSON.stringify(sessions));

  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  const capture: HookCapture = { ai: null, sessions: [], activeSessionIdMap: {} };
  await act(async () => {
    root.render(<UndoHarness capture={capture} />);
  });
  return { dom, container, root, capture };
}

test('undoLastTurnInSession branches and restores the last user turn', async () => {
  const { dom, container, root, capture } = await setupAiState([SOURCE_SESSION]);
  assert.ok(capture.ai);

  let result: Awaited<ReturnType<typeof runUndo>> | null = null;
  async function runUndo(): Promise<{ sessionId: string } | null> {
    return capture.ai!.undoLastTurnInSession('chat-source');
  }

  await act(async () => {
    result = await runUndo();
  });

  assert.ok(result);
  assert.notEqual(result!.sessionId, 'chat-source');

  const sessions = capture.sessions;
  const branch = sessions.find((session) => session.id === result!.sessionId);
  assert.ok(branch);
  // Branch keeps the conversation up to the boundary before the last turn.
  assert.deepEqual(
    branch!.messages.map((message) => message.content),
    ['first prompt', 'first answer'],
  );
  // Original session stays intact (non-destructive).
  const original = sessions.find((session) => session.id === 'chat-source');
  assert.equal(original?.messages.length, 4);
  // Branch becomes the active session for the scope.
  assert.equal(capture.activeSessionIdMap[SCOPE_KEY], result!.sessionId);

  const attachments = result!.restored.attachments as UploadedFile[];
  assert.equal(result!.restored.text, 'bad last prompt');
  assert.equal(attachments.length, 1);
  assert.equal(attachments[0].filename, 'note.txt');
  assert.equal(attachments[0].dataUrl, 'data:text/plain;base64,QUJD');

  await act(async () => root.unmount());
  container.remove();
  dom.window.close();
});

test('undoLastTurnInSession returns null when there is nothing to undo', async () => {
  const emptySession: AISession = {
    ...SOURCE_SESSION,
    id: 'chat-empty',
    messages: [],
  };
  const { dom, container, root, capture } = await setupAiState([emptySession]);
  assert.ok(capture.ai);

  let result: unknown;
  await act(async () => {
    result = capture.ai!.undoLastTurnInSession('chat-empty');
  });
  assert.equal(result, null);

  await act(async () => root.unmount());
  container.remove();
  dom.window.close();
});
