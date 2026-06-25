import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createCattyToolsFromCatalog, resolveSessionQueueKeyForTests } from './capabilityTools';
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
    const tools = createCattyToolsFromCatalog(
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

    const result = await tools.vault_notes_get.execute(
      { noteId: 'note-1' },
      { toolCallId: 'call-1', messages: [] },
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
    const tools = createCattyToolsFromCatalog(
      {},
      { sessions: [] },
      [],
      'auto',
      undefined,
      'chat-1',
      store,
    );

    const result = await tools.tool_output_read.execute(
      { handleId: handle.id, mode: 'full', maxChars: body.length + 100 },
      { toolCallId: 'call-1', messages: [] },
    ) as { content: string };

    assert.equal(result.content, body);
  });
});
