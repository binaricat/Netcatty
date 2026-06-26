import assert from 'node:assert/strict';
import test from 'node:test';
import { CattyTurnDriver } from './turnDrivers/cattyTurnDriver';
import type { TurnDriverContext, TurnInput } from './turnDrivers/types';

const mcpServerBridge = await import('../../../electron/bridges/mcpServerBridge.cjs');

function createTurnContext(): TurnDriverContext {
  return {
    turnId: 'turn-1',
    chatSessionId: 'chat-1',
    sessionId: 'chat-1',
    backend: 'catty',
    signal: new AbortController().signal,
    emit: () => {},
    toolOutputStore: {
      store: () => ({ id: 'handle-1', contentLength: 0 }),
      read: () => null,
      clearSession: () => {},
    },
    toolResultDedup: {
      fingerprintFor: () => 'fingerprint',
      check: () => null,
      remember: () => {},
      buildCachedNotice: () => ({}),
      clearTurn: () => {},
    },
    sessionStateStore: {
      mergeFromUserGoal: () => {},
      toReinjectionText: () => undefined,
      get: () => ({ decisions: [], activeHosts: {}, blockers: [], updatedAt: Date.now() }),
      clear: () => {},
      updateFromToolResult: () => {},
      mergeFromAssistantContent: () => {},
    },
  } as TurnDriverContext;
}

test('Catty turn registers current message file attachments for attachment tools', async (t) => {
  mcpServerBridge.cleanup();
  const csvText = 'label,hostname,username\nprod,prod.example.com,root\n';
  const bridge = {
    aiSetChatSessionCancelled: async () => ({ ok: true }),
    aiMcpUpdateSessions: async () => undefined,
    aiMcpUpdateAttachments: async (
      attachments: Array<{ base64Data?: string; mediaType?: string; filename?: string; filePath?: string }>,
      chatSessionId?: string,
    ) => {
      mcpServerBridge.updateAttachmentMetadata(attachments, chatSessionId);
      return { ok: true };
    },
  };
  t.after(() => mcpServerBridge.cleanup());

  const controller = new AbortController();
  const input: TurnInput = {
    backend: 'catty',
    chatSessionId: 'chat-1',
    sendScopeKey: 'chat-1',
    userText: '把这些主机都导入到 vault',
    signal: controller.signal,
    currentSession: undefined,
    assistantMsgId: 'assistant-1',
    context: {
      activeProvider: undefined,
      activeModelId: '',
      scopeType: 'terminal',
      globalPermissionMode: 'confirm',
      terminalSessions: [],
      autoTitleSession: () => {},
    },
    attachments: [{
      filename: 'hosts_export_2026-06-25.csv',
      mediaType: 'text/csv',
      base64Data: Buffer.from(csvText).toString('base64'),
      filePath: '/tmp/hosts_export_2026-06-25.csv',
    }],
    maxIterations: 5,
    bridge,
    ui: {
      addMessageToSession: () => {},
      updateLastMessage: () => {},
      updateMessageById: () => {},
      reportStreamError: () => {},
      setStreamingForScope: () => {},
    },
  };

  await new CattyTurnDriver().run(input, createTurnContext());

  const listed = mcpServerBridge.handleListAttachments({ chatSessionId: 'chat-1' });
  assert.equal(listed.ok, true);
  assert.deepEqual(listed.attachments, [{
    filename: 'hosts_export_2026-06-25.csv',
    mediaType: 'text/csv',
    filePath: '/tmp/hosts_export_2026-06-25.csv',
    sizeBytes: Buffer.byteLength(csvText),
  }]);

  const read = mcpServerBridge.handleReadAttachment({
    chatSessionId: 'chat-1',
    filename: 'hosts_export_2026-06-25.csv',
  });
  assert.equal(read.ok, true);
  assert.equal(read.text, csvText);
});
