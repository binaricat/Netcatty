import assert from 'node:assert/strict';
import test from 'node:test';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { JSDOM } from 'jsdom';

import type { AISession, UploadedFile } from '../../infrastructure/ai/types.ts';
import { getAgentRuntime } from '../../infrastructure/ai/harness/globalAgentRuntime.ts';
import { useAIState } from './useAIState.ts';
import { useAISessionsStore } from './aiSessionsStore.ts';
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

test('undoLastTurnInSession does not publish the branch when inheritance registration fails', async () => {
  const { dom, container, root, capture } = await setupAiState([SOURCE_SESSION]);
  assert.ok(capture.ai);

  // The branch inherits this background job, so undo must register the branch
  // with the main process before publishing it.
  const sessionStateStore = getAgentRuntime().getSessionStateStore();
  sessionStateStore.updateFromToolResult(
    'chat-source',
    'terminal_start',
    { sessionId: 'sess-1', command: 'npm run dev' },
    JSON.stringify({ jobId: 'job-1', status: 'running', nextOffset: 0 }),
    false,
  );

  const registrationCalls: Array<[string, string, string[]]> = [];
  dom.window.netcatty = {
    aiRegisterInheritedBackgroundJobs: async (
      chatSessionId: string,
      ownerChatSessionId: string,
      jobIds: string[],
    ) => {
      registrationCalls.push([chatSessionId, ownerChatSessionId, jobIds]);
      return { ok: false, error: 'main process unreachable' };
    },
  } as never;

  let result: Awaited<ReturnType<typeof runUndo>> | null = null;
  async function runUndo() {
    return capture.ai!.undoLastTurnInSession('chat-source');
  }

  await act(async () => {
    result = await runUndo();
  });

  // Registration rejects (ok=false) on every retry attempt: publishing the
  // branch would leave it polling "Background job not found" forever, so the
  // undo propagates the failure instead.
  assert.equal(registrationCalls.length, 3);
  assert.deepEqual(registrationCalls[0][2], ['job-1']);
  assert.equal(registrationCalls[0][1], 'chat-source');
  assert.equal(result, null);
  // No branch session was published and the runtime state copied for the
  // not-yet-published branch was dropped again. (capture.sessions is the
  // module-singleton store snapshot, so earlier tests in this file keep their
  // published branches visible — assert on this test's own branch id.)
  const branchedId = registrationCalls[0][0];
  assert.ok(!capture.sessions.some((session) => session.id === branchedId));
  assert.equal(Object.keys(sessionStateStore.get(branchedId).activeJobs).length, 0);

  sessionStateStore.clear('chat-source');
  sessionStateStore.clear(branchedId);
  delete dom.window.netcatty;
  await act(async () => root.unmount());
  container.remove();
  dom.window.close();
});

test('undoLastTurnInSession refuses to publish a branch when tool-output storage is not durable', async () => {
  // The branch's retained prefix references a stored tool output. The alias
  // pass that moves it under the branch id defers unfulfilled restores/copies
  // through in-memory queues, so publishing the branch while secure storage is
  // not durable would leave the references permanently unresolvable if the app
  // closes before storage recovers. Undo must abort (and before it registers
  // any background-job inheritance it would then have to roll back).
  const sessionWithToolOutput: AISession = {
    ...SOURCE_SESSION,
    id: 'chat-with-handle',
    messages: [
      { id: 'user-1', role: 'user', content: 'first prompt', timestamp: 1 },
      { id: 'assistant-1', role: 'assistant', content: 'saved handleId=tool-output-kept-1', timestamp: 2 },
      { id: 'user-2', role: 'user', content: 'bad last prompt', timestamp: 3 },
      { id: 'assistant-2', role: 'assistant', content: 'bad answer', timestamp: 4 },
    ],
  };
  // useAIState prefers the module-singleton snapshot over localStorage when
  // it is non-null, so seed it (and reset it at cleanup) to make this test's
  // source session visible to the undo's session lookup.
  setLatestAISessionsSnapshot([sessionWithToolOutput]);
  const { dom, container, root, capture } = await setupAiState([sessionWithToolOutput]);
  assert.ok(capture.ai);

  const registrationCalls: string[] = [];
  const forgetCalls: string[] = [];
  dom.window.netcatty = {
    getToolOutputPersistenceStatus: async () => ({ durable: false, reason: 'locked' }),
    writeToolOutputTemp: async () => ({ ok: false }),
    readToolOutputTemp: async () => null,
    deleteToolOutputTemp: async () => ({ ok: true }),
    aiRegisterInheritedBackgroundJobs: async () => {
      registrationCalls.push('registered');
      return { ok: true };
    },
    aiForgetInheritedBackgroundJobs: async (chatSessionId: string) => {
      forgetCalls.push(chatSessionId);
      return { ok: true };
    },
  } as never;

  let result: Awaited<ReturnType<typeof undo>> | null = null;
  async function undo() {
    return capture.ai!.undoLastTurnInSession('chat-with-handle');
  }
  const sessionIdsBefore = capture.sessions.map((session) => session.id);
  await act(async () => {
    result = await undo();
  });

  assert.equal(result, null);
  assert.deepEqual(registrationCalls, []);
  assert.deepEqual(forgetCalls, []);
  // No branch session was published for the aborted undo.
  assert.deepEqual(capture.sessions.map((session) => session.id), sessionIdsBefore);

  await act(async () => root.unmount());
  container.remove();
  dom.window.close();
  setLatestAISessionsSnapshot(null as unknown as AISession[]);
});

test('undoLastTurnInSession publishes a branch with retained tool outputs once storage is durable', async () => {
  const sessionWithToolOutput: AISession = {
    ...SOURCE_SESSION,
    id: 'chat-with-handle',
    messages: [
      { id: 'user-1', role: 'user', content: 'first prompt', timestamp: 1 },
      { id: 'assistant-1', role: 'assistant', content: 'saved handleId=tool-output-kept-1', timestamp: 2 },
      { id: 'user-2', role: 'user', content: 'bad last prompt', timestamp: 3 },
      { id: 'assistant-2', role: 'assistant', content: 'bad answer', timestamp: 4 },
    ],
  };
  // useAIState prefers the module-singleton snapshot over localStorage when
  // it is non-null, so seed it (and reset it at cleanup) to make this test's
  // source session visible to the undo's session lookup.
  setLatestAISessionsSnapshot([sessionWithToolOutput]);
  const { dom, container, root, capture } = await setupAiState([sessionWithToolOutput]);
  assert.ok(capture.ai);

  // The retained handle must be restorable from durable storage (and its
  // content readable) so the alias pass can materialize the branch-owned
  // durable copy that publishing a branch now requires: unlike before, undo
  // confirms every retained alias was materialized instead of publishing
  // while the copy is merely queued for an in-memory retry.
  dom.window.netcatty = {
    getToolOutputPersistenceStatus: async () => ({ durable: true }),
    writeToolOutputTemp: async () => ({ ok: true, path: '/tmp/tool-output-branch.log' }),
    restoreToolOutputTemp: async () => ({
      path: '/tmp/tool-output.log',
      record: {
        schemaVersion: 1 as const,
        handleId: 'tool-output-kept-1',
        chatSessionId: 'chat-with-handle',
        capabilityId: 'terminal_observability',
        totalChars: 4,
        storedChars: 4,
        sourceTruncated: false,
        preview: 'test',
        storedAt: 1,
        accessedAt: 1,
      },
    }),
    readToolOutputTemp: async () => ({
      mode: 'range' as const,
      content: 'test',
      totalChars: 4,
      startOffset: 0,
      endOffset: 4,
      nextOffset: 4,
      hasMore: false,
    }),
    deleteToolOutputTemp: async () => ({ ok: true }),
    deleteChatToolOutputsTemp: async () => ({ deletedCount: 0 }),
  } as never;

  let result: Awaited<ReturnType<typeof undo>> | null = null;
  async function undo() {
    return capture.ai!.undoLastTurnInSession('chat-with-handle');
  }
  await act(async () => {
    result = await undo();
  });

  assert.ok(result);
  assert.ok(capture.sessions.some((session) => session.id === result!.sessionId));

  await act(async () => root.unmount());
  container.remove();
  dom.window.close();
  setLatestAISessionsSnapshot(null as unknown as AISession[]);
});

test('undoLastTurnInSession aborts when a retained tool output cannot be restored', async () => {
  // Persistence reports durable, but the record behind the retained handle is
  // missing (for example it was written while storage was unavailable).
  // Publishing the branch would leave its retained reference permanently
  // unresolvable, so the undo must abort instead of confirming the alias.
  const sessionWithToolOutput: AISession = {
    ...SOURCE_SESSION,
    id: 'chat-with-handle',
    messages: [
      { id: 'user-1', role: 'user', content: 'first prompt', timestamp: 1 },
      { id: 'assistant-1', role: 'assistant', content: 'saved handleId=tool-output-kept-1', timestamp: 2 },
      { id: 'user-2', role: 'user', content: 'bad last prompt', timestamp: 3 },
      { id: 'assistant-2', role: 'assistant', content: 'bad answer', timestamp: 4 },
    ],
  };
  setLatestAISessionsSnapshot([sessionWithToolOutput]);
  const { dom, container, root, capture } = await setupAiState([sessionWithToolOutput]);
  assert.ok(capture.ai);

  const deleteChatCalls: string[] = [];
  dom.window.netcatty = {
    getToolOutputPersistenceStatus: async () => ({ durable: true }),
    writeToolOutputTemp: async () => ({ ok: true, path: '/tmp/tool-output-branch.log' }),
    restoreToolOutputTemp: async () => null,
    readToolOutputTemp: async () => null,
    deleteToolOutputTemp: async () => ({ ok: true }),
    deleteChatToolOutputsTemp: async (chatSessionId: string) => {
      deleteChatCalls.push(chatSessionId);
      return { deletedCount: 0 };
    },
  } as never;

  let result: Awaited<ReturnType<typeof undo>> | null = null;
  async function undo() {
    return capture.ai!.undoLastTurnInSession('chat-with-handle');
  }
  const sessionIdsBefore = capture.sessions.map((session) => session.id);
  await act(async () => {
    result = await undo();
  });

  // The confirm gate exhausted its budget driving the restore retries without
  // materializing every retained alias, so the branch was not published. The
  // aborted branch's (partial, source-shared) tool-output work was pruned.
  assert.equal(result, null);
  assert.deepEqual(capture.sessions.map((session) => session.id), sessionIdsBefore);
  // The prune of the aborted branch id ran during the rollback.
  assert.equal(deleteChatCalls.length, 1);
  assert.ok(!sessionIdsBefore.includes(deleteChatCalls[0]));

  await act(async () => root.unmount());
  container.remove();
  dom.window.close();
  setLatestAISessionsSnapshot(null as unknown as AISession[]);
});

test('undoLastTurnInSession aborts when a retained tool output cannot be durably copied', async () => {
  // The alias is created in memory but its durable write keeps failing, so its
  // branch-owned copy is only queued for an in-memory retry. Confirming that
  // the copy actually landed must fail and abort the undo, otherwise an app
  // exit before the retry would leave the retained reference unresolvable
  // after a restart.
  const sessionWithToolOutput: AISession = {
    ...SOURCE_SESSION,
    id: 'chat-with-handle',
    messages: [
      { id: 'user-1', role: 'user', content: 'first prompt', timestamp: 1 },
      { id: 'assistant-1', role: 'assistant', content: 'saved handleId=tool-output-kept-1', timestamp: 2 },
      { id: 'user-2', role: 'user', content: 'bad last prompt', timestamp: 3 },
      { id: 'assistant-2', role: 'assistant', content: 'bad answer', timestamp: 4 },
    ],
  };
  setLatestAISessionsSnapshot([sessionWithToolOutput]);
  const { dom, container, root, capture } = await setupAiState([sessionWithToolOutput]);
  assert.ok(capture.ai);

  const deleteChatCalls: string[] = [];
  dom.window.netcatty = {
    getToolOutputPersistenceStatus: async () => ({ durable: true }),
    writeToolOutputTemp: async () => ({ ok: false, error: 'disk full' }),
    restoreToolOutputTemp: async () => ({
      path: '/tmp/tool-output.log',
      record: {
        schemaVersion: 1 as const,
        handleId: 'tool-output-kept-1',
        chatSessionId: 'chat-with-handle',
        capabilityId: 'terminal_observability',
        totalChars: 4,
        storedChars: 4,
        sourceTruncated: false,
        preview: 'test',
        storedAt: 1,
        accessedAt: 1,
      },
    }),
    readToolOutputTemp: async () => ({
      mode: 'range' as const,
      content: 'test',
      totalChars: 4,
      startOffset: 0,
      endOffset: 4,
      nextOffset: 4,
      hasMore: false,
    }),
    deleteToolOutputTemp: async () => ({ ok: true }),
    deleteChatToolOutputsTemp: async (chatSessionId: string) => {
      deleteChatCalls.push(chatSessionId);
      return { deletedCount: 0 };
    },
  } as never;

  let result: Awaited<ReturnType<typeof undo>> | null = null;
  async function undo() {
    return capture.ai!.undoLastTurnInSession('chat-with-handle');
  }
  const sessionIdsBefore = capture.sessions.map((session) => session.id);
  await act(async () => {
    result = await undo();
  });

  assert.equal(result, null);
  assert.deepEqual(capture.sessions.map((session) => session.id), sessionIdsBefore);
  // The durable session delete for the aborted branch id still ran during the
  // rollback (no branch-owned copy was ever written).
  assert.equal(deleteChatCalls.length, 1);
  assert.ok(!sessionIdsBefore.includes(deleteChatCalls[0]));

  await act(async () => root.unmount());
  container.remove();
  dom.window.close();
  setLatestAISessionsSnapshot(null as unknown as AISession[]);
});

test('undoLastTurnInSession retries the inheritance rollback before abandoning the branch', async () => {
  const { dom, container, root, capture } = await setupAiState([SOURCE_SESSION]);
  assert.ok(capture.ai);

  const sessionStateStore = getAgentRuntime().getSessionStateStore();
  sessionStateStore.updateFromToolResult(
    'chat-source',
    'terminal_start',
    { sessionId: 'sess-1', command: 'npm run dev' },
    JSON.stringify({ jobId: 'job-1', status: 'running', nextOffset: 0 }),
    false,
  );

  const forgetCalls: string[] = [];
  dom.window.netcatty = {
    aiRegisterInheritedBackgroundJobs: async () => ({ ok: false, error: 'main process unreachable' }),
    aiForgetInheritedBackgroundJobs: async (chatSessionId: string) => {
      forgetCalls.push(chatSessionId);
      // First call fails transiently; the second confirms the rollback.
      return forgetCalls.length === 1
        ? { ok: false, error: 'ipc hiccup' }
        : { ok: true };
    },
  } as never;

  let result: Awaited<ReturnType<typeof runUndo>> | null = null;
  async function runUndo() {
    return capture.ai!.undoLastTurnInSession('chat-source');
  }
  await act(async () => {
    result = await runUndo();
  });

  // The rollback is awaited, validated, and retried — not fire-and-forget.
  const branchedId = forgetCalls[0];
  assert.equal(result, null);
  assert.deepEqual(forgetCalls, [branchedId, branchedId]);
  assert.ok(!capture.sessions.some((session) => session.id === branchedId));
  assert.equal(Object.keys(sessionStateStore.get(branchedId).activeJobs).length, 0);

  sessionStateStore.clear('chat-source');
  sessionStateStore.clear(branchedId);
  delete dom.window.netcatty;
  await act(async () => root.unmount());
  container.remove();
  dom.window.close();
});

test('undoLastTurnInSession retries a persistently failing inheritance rollback to exhaustion', async () => {
  const { dom, container, root, capture } = await setupAiState([SOURCE_SESSION]);
  assert.ok(capture.ai);

  const sessionStateStore = getAgentRuntime().getSessionStateStore();
  sessionStateStore.updateFromToolResult(
    'chat-source',
    'terminal_start',
    { sessionId: 'sess-1', command: 'npm run dev' },
    JSON.stringify({ jobId: 'job-1', status: 'running', nextOffset: 0 }),
    false,
  );

  const forgetCalls: string[] = [];
  dom.window.netcatty = {
    aiRegisterInheritedBackgroundJobs: async () => ({ ok: false, error: 'main process unreachable' }),
    aiForgetInheritedBackgroundJobs: async (chatSessionId: string) => {
      forgetCalls.push(chatSessionId);
      return { ok: false, error: 'ipc gone' };
    },
  } as never;

  let result: Awaited<ReturnType<typeof runUndo>> | null = null;
  async function runUndo() {
    return capture.ai!.undoLastTurnInSession('chat-source');
  }
  await act(async () => {
    result = await runUndo();
  });

  // Even a rollback that always fails is attempted for every retry slot
  // (never swallowed silently) before the undo abandons the branch.
  const branchedId = forgetCalls[0];
  assert.equal(result, null);
  assert.equal(forgetCalls.length, 5);
  assert.ok(forgetCalls.every((id) => id === branchedId));
  assert.ok(!capture.sessions.some((session) => session.id === branchedId));

  sessionStateStore.clear('chat-source');
  sessionStateStore.clear(branchedId);
  delete dom.window.netcatty;
  await act(async () => root.unmount());
  container.remove();
  dom.window.close();
});

test('undoLastTurnInSession publishes the branch once inheritance registration succeeds', async () => {
  const { dom, container, root, capture } = await setupAiState([SOURCE_SESSION]);
  assert.ok(capture.ai);

  const sessionStateStore = getAgentRuntime().getSessionStateStore();
  sessionStateStore.updateFromToolResult(
    'chat-source',
    'terminal_start',
    { sessionId: 'sess-1', command: 'npm run dev' },
    JSON.stringify({ jobId: 'job-1', status: 'running', nextOffset: 0 }),
    false,
  );

  const registrationCalls: Array<[string, string, string[]]> = [];
  dom.window.netcatty = {
    aiRegisterInheritedBackgroundJobs: async (
      chatSessionId: string,
      ownerChatSessionId: string,
      jobIds: string[],
    ) => {
      registrationCalls.push([chatSessionId, ownerChatSessionId, jobIds]);
      return { ok: true, registered: jobIds.length };
    },
  } as never;

  let result: Awaited<ReturnType<typeof runUndo>> | null = null;
  async function runUndo() {
    return capture.ai!.undoLastTurnInSession('chat-source');
  }

  await act(async () => {
    result = await runUndo();
  });

  assert.ok(result);
  assert.equal(registrationCalls.length, 1);
  assert.equal(registrationCalls[0][1], 'chat-source');
  assert.deepEqual(registrationCalls[0][2], ['job-1']);
  assert.ok(capture.sessions.some((session) => session.id === result!.sessionId));

  sessionStateStore.clear('chat-source');
  sessionStateStore.clear(result!.sessionId);
  delete dom.window.netcatty;
  await act(async () => root.unmount());
  container.remove();
  dom.window.close();
});
