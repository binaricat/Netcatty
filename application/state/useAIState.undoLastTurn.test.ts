import assert from 'node:assert/strict';
import test from 'node:test';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { JSDOM } from 'jsdom';

import type { AISession, UploadedFile } from '../../infrastructure/ai/types.ts';
import { getAgentRuntime } from '../../infrastructure/ai/harness/globalAgentRuntime.ts';
import { useAIState } from './useAIState.ts';
import { useAISessionsStore } from './aiSessionsStore.ts';
import { getSessionScopeMatchRank } from '../../components/ai/sessionScopeMatch.ts';
import { setLatestAISessionsSnapshot } from './aiStateSnapshots.ts';

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

  setLatestAISessionsSnapshot(sessions);
  dom.window.localStorage.setItem('netcatty_ai_sessions_v1', JSON.stringify(sessions));

  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  const capture: HookCapture = { ai: null, sessions: [], activeSessionIdMap: {} };
  await act(async () => {
    root.render(React.createElement(UndoHarness, { capture }));
  });
  return { dom, container, root, capture };
}

test('undoLastTurnInSession branches and restores the last user turn', async () => {
  const { dom, container, root, capture } = await setupAiState([SOURCE_SESSION]);
  assert.ok(capture.ai);

  let result: Awaited<ReturnType<typeof runUndo>> | null = null;
  async function runUndo() {
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
    result = await capture.ai!.undoLastTurnInSession('chat-empty');
  });
  assert.equal(result, null);

  await act(async () => root.unmount());
  container.remove();
  dom.window.close();
});

test('undo copies chat only, preserving original outputs and job ownership', async () => {
  const runtime = getAgentRuntime();
  const outputStore = runtime.getToolOutputStore('chat-source');
  const handle = outputStore.store({
    chatSessionId: 'chat-source', capabilityId: 'terminal.exec', content: 'original saved output',
  });
  const stateStore = runtime.getSessionStateStore();
  stateStore.updateFromToolResult('chat-source', 'terminal_start',
    { sessionId: 'terminal-a', command: 'long-running-command' },
    JSON.stringify({ jobId: 'original-job', status: 'running', nextOffset: 7 }), false);
  const source = structuredClone(SOURCE_SESSION);
  source.messages[1].content = `Preview with handleId=${handle.id}`;
  const { dom, container, root, capture } = await setupAiState([source]);
  const original = JSON.stringify(source);
  let result: { sessionId: string } | null = null;
  await act(async () => { result = await capture.ai!.undoLastTurnInSession(source.id); });
  assert.ok(result);
  assert.equal(outputStore.read({ handleId: handle.id }, result!.sessionId), null);
  assert.equal(outputStore.read({ handleId: handle.id }, source.id), 'original saved output');
  assert.deepEqual(stateStore.get(result!.sessionId).activeJobs, {});
  assert.ok(stateStore.get(source.id).activeJobs['original-job']);
  assert.equal(JSON.stringify({ ...capture.sessions.find(item => item.id === source.id), updatedAt: source.updatedAt }), original);
  assert.ok(capture.sessions.find(item => item.id === result!.sessionId)!.messages[1].content.includes('Preview'));
  stateStore.clear(source.id);
  outputStore.prune(source.id);
  await act(async () => root.unmount());
  container.remove(); dom.window.close();
});

for (const newerCount of [49, 50]) {
  test(`undo retains an old source and its branch after reload with ${newerCount} newer chats`, async () => {
    const newer = Array.from({ length: newerCount }, (_, index) => ({
      ...structuredClone(SOURCE_SESSION), id: `history-${index}`, updatedAt: 100 + index,
    }));
    const { dom, container, root, capture } = await setupAiState([...newer, SOURCE_SESSION]);
    let branchId: string | undefined;
    await act(async () => {
      branchId = (await capture.ai!.undoLastTurnInSession(SOURCE_SESSION.id))?.sessionId;
    });
    assert.ok(branchId);
    const saved: AISession[] = JSON.parse(dom.window.localStorage.getItem('netcatty_ai_sessions_v1')!);
    assert.equal(saved.length, 50);
    const original = saved.find(item => item.id === SOURCE_SESSION.id);
    assert.ok(original, 'the original must survive updatedAt-based history pruning');
    assert.deepEqual({ ...original, updatedAt: SOURCE_SESSION.updatedAt }, SOURCE_SESSION);
    assert.deepEqual(saved.find(item => item.id === branchId)?.messages, SOURCE_SESSION.messages.slice(0, 2));
    assert.ok(original.updatedAt >= newer.at(-1)!.updatedAt);
    await act(async () => root.unmount());
    container.remove(); dom.window.close();

    // Remount the actual hook from the persisted records, as on app reload.
    const reloaded = await setupAiState(saved);
    assert.deepEqual(reloaded.capture.sessions.find(item => item.id === SOURCE_SESSION.id)?.messages, SOURCE_SESSION.messages);
    assert.deepEqual(reloaded.capture.sessions.find(item => item.id === branchId)?.messages, SOURCE_SESSION.messages.slice(0, 2));
    await act(async () => reloaded.root.unmount());
    reloaded.container.remove(); reloaded.dom.window.close();
  });
}

for (const viewingScope of [
  { type: 'terminal' as const, targetId: 'terminal-b' },
  { type: 'workspace' as const, targetId: 'workspace-b' },
]) {
  test(`undo stays visible when a ${viewingScope.type} views a chat from a closed terminal`, async () => {
    const source = {
      ...structuredClone(SOURCE_SESSION),
      scope: { type: 'terminal' as const, targetId: 'terminal-closed', hostIds: ['host-a'] },
    };
    const { dom, container, root, capture } = await setupAiState([source]);
    const sourceBefore = structuredClone(source);
    let branchId: string | undefined;
    await act(async () => {
      capture.ai!.setActiveSessionId('terminal:terminal-b', source.id);
      branchId = (await capture.ai!.undoLastTurnInSession(source.id, viewingScope))?.sessionId;
    });
    assert.ok(branchId);
    const branch = capture.sessions.find(item => item.id === branchId)!;
    assert.deepEqual(branch.messages, source.messages.slice(0, 2));
    assert.deepEqual(branch.scope, { ...source.scope, ...viewingScope });
    assert.equal(capture.activeSessionIdMap[`${viewingScope.type}:${viewingScope.targetId}`], branch.id);
    // The real history predicate must still include the selected branch after
    // the source terminal no longer belongs to the current workspace.
    assert.equal(getSessionScopeMatchRank(
      branch, viewingScope.type, viewingScope.targetId, ['host-a'],
      new Set([branch.id]), new Set(['terminal-b']), new Set([source.id]),
    ), 3);
    const original = capture.sessions.find(item => item.id === source.id)!;
    assert.deepEqual({ ...original, updatedAt: sourceBefore.updatedAt }, sourceBefore);
    const saved = JSON.parse(dom.window.localStorage.getItem('netcatty_ai_sessions_v1')!) as AISession[];
    assert.deepEqual(saved.find(item => item.id === branchId)?.scope, branch.scope);
    await act(async () => root.unmount());
    container.remove(); dom.window.close();
  });
}
