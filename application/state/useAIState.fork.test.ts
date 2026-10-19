import assert from 'node:assert/strict';
import test from 'node:test';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { JSDOM } from 'jsdom';

import type { AISession } from '../../infrastructure/ai/types.ts';
import { getAgentRuntime } from '../../infrastructure/ai/harness/globalAgentRuntime.ts';
import { useAIState } from './useAIState.ts';
import { useAISessionsStore } from './aiSessionsStore.ts';
import { setLatestAISessionsSnapshot } from './aiStateSnapshots.ts';

const SOURCE_SESSION: AISession = {
  id: 'chat-source',
  title: 'Fork source',
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

function ForkHarness({ capture }: { capture: HookCapture }) {
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
    root.render(React.createElement(ForkHarness, { capture }));
  });
  return { dom, container, root, capture };
}

test('fork retains the completed prefix, replay metadata, and source-owned outputs', async () => {
  const runtime = getAgentRuntime();
  const outputStore = runtime.getToolOutputStore('chat-source');
  const handle = outputStore.store({ chatSessionId: 'chat-source', capabilityId: 'terminal.exec', content: 'saved output' });
  runtime.getSessionStateStore().updateFromToolResult('chat-source', 'terminal_start',
    { sessionId: 'terminal-a', command: 'running-command' },
    JSON.stringify({ jobId: 'source-job', status: 'running', nextOffset: 7 }), false);
  const source = structuredClone(SOURCE_SESSION);
  source.externalSessionId = 'original-provider-thread';
  source.messages[1].content = `Preview handleId=${handle.id}`;
  source.messages[1].providerContinuation = { reasoningParts: [{ text: 'checked', providerOptions: { anthropic: { signature: 'signed-thinking' } } }] };
  const { dom, container, root, capture } = await setupAiState([source]);
  let branch: AISession | null = null;
  await act(async () => { branch = await capture.ai!.forkSessionFromMessage(source.id, 'assistant-1', { type: 'terminal', targetId: 'reconnected' }); });
  assert.ok(branch);
  assert.notEqual(branch!.id, source.id);
  assert.equal(branch!.externalSessionId, undefined);
  assert.deepEqual(branch!.messages[1].providerContinuation, source.messages[1].providerContinuation);
  assert.match(branch!.messages[1].content, /Preview/);
  assert.doesNotMatch(branch!.messages[1].content, /handleId=/);
  assert.deepEqual(branch!.scope, { type: 'terminal', targetId: 'reconnected', hostIds: undefined });
  assert.equal(capture.activeSessionIdMap['terminal:reconnected'], branch!.id);
  assert.deepEqual({ ...capture.sessions.find(item => item.id === source.id), updatedAt: source.updatedAt }, source);
  assert.equal(outputStore.read({ handleId: handle.id }, branch!.id), null);
  assert.equal(outputStore.read({ handleId: handle.id }, source.id), 'saved output');
  assert.deepEqual(runtime.getSessionStateStore().get(branch!.id).activeJobs, {});
  assert.ok(runtime.getSessionStateStore().get(source.id).activeJobs['source-job']);
  runtime.getSessionStateStore().clear(source.id);
  outputStore.prune(source.id);
  await act(async () => root.unmount()); container.remove(); dom.window.close();
});

test('fork rejects an incomplete boundary without adding a chat', async () => {
  const source = structuredClone(SOURCE_SESSION);
  source.messages[1].executionStatus = 'failed';
  const { dom, container, root, capture } = await setupAiState([source]);
  let result: unknown;
  await act(async () => { result = await capture.ai!.forkSessionFromMessage(source.id, 'assistant-1'); });
  assert.equal(result, null);
  assert.equal(capture.sessions.length, 1);
  await act(async () => root.unmount()); container.remove(); dom.window.close();
});

for (const newerCount of [49, 50]) {
  test(`fork preserves the original on reload with ${newerCount} newer chats`, async () => {
    const newer = Array.from({ length: newerCount }, (_, index) => ({ ...structuredClone(SOURCE_SESSION), id: `history-${index}`, updatedAt: 100 + index }));
    const { dom, container, root, capture } = await setupAiState([...newer, SOURCE_SESSION]);
    let branch: AISession | null = null;
    await act(async () => { branch = await capture.ai!.forkSessionFromMessage(SOURCE_SESSION.id, 'assistant-1'); });
    assert.ok(branch);
    const saved: AISession[] = JSON.parse(dom.window.localStorage.getItem('netcatty_ai_sessions_v1')!);
    assert.equal(saved.length, 50);
    assert.deepEqual(saved.find(item => item.id === SOURCE_SESSION.id)?.messages, SOURCE_SESSION.messages);
    assert.deepEqual(saved.find(item => item.id === branch!.id)?.messages, SOURCE_SESSION.messages.slice(0, 2));
    await act(async () => root.unmount()); container.remove(); dom.window.close();
    const reloaded = await setupAiState(saved);
    assert.equal(reloaded.capture.sessions.find(item => item.id === SOURCE_SESSION.id)?.messages.length, 4);
    assert.equal(reloaded.capture.sessions.find(item => item.id === branch!.id)?.messages.length, 2);
    await act(async () => reloaded.root.unmount()); reloaded.container.remove(); reloaded.dom.window.close();
  });
}
