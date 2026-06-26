import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  createCattyToolsFromCatalog,
  resolveSessionQueueKeyForTests,
  withCattyToolContext,
} from './capabilityTools';
import { ToolOutputStore } from './toolOutputStore';

describe('capabilityTools session queue keys', () => {
  it('does not queue read-only harness tools behind terminal session writes', () => {
    const key = resolveSessionQueueKeyForTests(
      {
        capabilityId: 'harness.workspace.get_session_info',
        toolName: 'workspace_get_session_info',
        policy: { write: false, bypassesApproval: true },
      },
      { sessionId: 'session-a' },
      'chat-1',
    );
    assert.equal(key, null);
  });

  it('still serializes terminal.execute on the same session', () => {
    const key = resolveSessionQueueKeyForTests(
      {
        capabilityId: 'terminal.execute',
        toolName: 'terminal_execute',
        policy: { write: true, bypassesApproval: false },
      },
      { sessionId: 'session-a', command: 'ls' },
      'chat-1',
    );
    assert.equal(key, 'chat-1:session-a');
  });
});

describe('capabilityTools result fitting', () => {
  it('truncates large vault note content and stores the full note body behind a handle', async () => {
    const store = new ToolOutputStore();
    const body = `${'note line\n'.repeat(1000)}important ending`;
    const { tools, toolsContext } = createCattyToolsFromCatalog(
      {
        aiCapability: async () => ({
          ok: true,
          note: {
            id: 'note-1',
            title: 'Long note',
            content: body,
          },
        }),
      },
      { sessions: [] },
      [],
      'auto',
      undefined,
      'chat-1',
      store,
    );

    const result = await withCattyToolContext(
      tools.vault_notes_get,
      toolsContext.vault_notes_get,
      'call-1',
    ).execute(
      { noteId: 'note-1' },
    ) as { note: { content: string } };

    assert.notEqual(result.note.content, body);
    assert.match(result.note.content, /tool output handle/);
    const handleId = result.note.content.match(/handleId=(tool-output-[^\]\s]+)/)?.[1];
    assert.ok(handleId);
    assert.equal(store.read({ handleId, mode: 'full', maxChars: body.length + 100 }, 'chat-1'), body);
  });

  it('does not refit explicit tool output read-back content', async () => {
    const store = new ToolOutputStore();
    const body = `${'full note line\n'.repeat(1000)}important ending`;
    const handle = store.store({
      chatSessionId: 'chat-1',
      capabilityId: 'vault.notes.get',
      content: body,
    });
    const { tools, toolsContext } = createCattyToolsFromCatalog(
      {},
      { sessions: [] },
      [],
      'auto',
      undefined,
      'chat-1',
      store,
    );

    const result = await withCattyToolContext(
      tools.tool_output_read,
      toolsContext.tool_output_read,
      'call-1',
    ).execute(
      { handleId: handle.id, mode: 'full', maxChars: body.length + 100 },
    ) as { content: string };

    assert.equal(result.content, body);
  });
});

describe('capabilityTools terminal context reader', () => {
  it('reads terminal context from the only scoped terminal when sessionId is omitted', async () => {
    const { tools, toolsContext } = createCattyToolsFromCatalog(
      {},
      {
        sessions: [{
          sessionId: 'session-1',
          hostId: 'host-1',
          hostname: 'prod.internal',
          label: 'prod',
          connected: true,
        }],
        readTerminalContext: async (request) => ({
          ok: true,
          sessionId: request.sessionId,
          label: 'prod',
          range: request.range ?? 'viewport',
          content: 'line-a\nline-b',
          totalLines: 2,
          startLine: 0,
          endLine: 1,
          returnedLines: 2,
          hasMoreBefore: false,
          hasMoreAfter: false,
          source: 'live',
        }),
      },
      [],
      'auto',
      undefined,
      'chat-1',
    );

    const result = await withCattyToolContext(
      tools.terminal_read_context,
      toolsContext.terminal_read_context,
      'call-1',
    ).execute(
      { range: 'tail', maxLines: 20 },
    ) as { sessionId: string; content: string; range: string };

    assert.equal(result.sessionId, 'session-1');
    assert.equal(result.range, 'tail');
    assert.equal(result.content, 'line-a\nline-b');
  });

  it('fits large terminal context reads through the shared tool output store', async () => {
    const store = new ToolOutputStore();
    const body = `${'terminal line output '.repeat(900)}important ending`;
    const { tools, toolsContext } = createCattyToolsFromCatalog(
      {},
      {
        sessions: [{
          sessionId: 'session-1',
          hostId: 'host-1',
          hostname: 'prod.internal',
          label: 'prod',
          connected: true,
        }],
        readTerminalContext: async (request) => ({
          ok: true,
          sessionId: request.sessionId,
          label: 'prod',
          range: request.range ?? 'viewport',
          content: body,
          totalLines: 1,
          startLine: 0,
          endLine: 0,
          returnedLines: 1,
          hasMoreBefore: false,
          hasMoreAfter: false,
          source: 'live',
        }),
      },
      [],
      'auto',
      undefined,
      'chat-1',
      store,
    );

    const result = await withCattyToolContext(
      tools.terminal_read_context,
      toolsContext.terminal_read_context,
      'call-1',
    ).execute(
      { range: 'viewport' },
    ) as { content: string };

    assert.notEqual(result.content, body);
    assert.match(result.content, /tool output handle/);
    const handleId = result.content.match(/handleId=(tool-output-[^\]\s]+)/)?.[1];
    assert.ok(handleId);
    assert.equal(store.read({ handleId, mode: 'full', maxChars: body.length + 100 }, 'chat-1'), body);
  });

  it('asks for sessionId when multiple scoped terminals are available', async () => {
    const { tools, toolsContext } = createCattyToolsFromCatalog(
      {},
      {
        sessions: [
          { sessionId: 'session-1', hostId: 'host-1', hostname: 'a', label: 'a', connected: true },
          { sessionId: 'session-2', hostId: 'host-2', hostname: 'b', label: 'b', connected: true },
        ],
      },
      [],
      'auto',
      undefined,
      'chat-1',
    );

    const result = await withCattyToolContext(
      tools.terminal_read_context,
      toolsContext.terminal_read_context,
      'call-1',
    ).execute(
      { range: 'viewport' },
    ) as { error?: string };

    assert.match(result.error ?? '', /sessionId/);
  });
});
