import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { CattyTurnDriver } from './turnDrivers/cattyTurnDriver';
import type { TurnDriverContext, TurnInput } from './turnDrivers/types';

const mcpServerBridge = await import('../../../electron/bridges/mcpServerBridge.cjs');

/**
 * cleanup() deletes the CLI discovery file. Point it at a temp path so a test
 * run cannot remove the live Netcatty user's discovery.json (#3501).
 */
function useTempCliDiscovery(t: test.TestContext): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'netcatty-catty-attach-'));
  const filePath = path.join(dir, 'discovery.json');
  mcpServerBridge.init({
    sessions: new Map(),
    sftpClients: new Map(),
    cliDiscoveryFilePath: filePath,
  });
  t.after(() => {
    try {
      mcpServerBridge.cleanup();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
  return filePath;
}

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
  useTempCliDiscovery(t);
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
  const attachPath = path.resolve('/tmp/hosts_export_2026-06-25.csv');
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
      filePath: attachPath,
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
    filePath: attachPath,
    sizeBytes: Buffer.byteLength(csvText),
  }]);

  const read = mcpServerBridge.handleReadAttachment({
    chatSessionId: 'chat-1',
    filename: 'hosts_export_2026-06-25.csv',
  });
  assert.equal(read.ok, true);
  assert.equal(read.text, csvText);
});
