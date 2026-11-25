import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  createCattyToolsFromCatalog,
  resolveSessionQueueKeyForTests,
  withCattyToolContext,
} from './capabilityTools';
import { ToolOutputStore } from './toolOutputStore';
import { buildTerminalWriteFingerprint, ToolResultDedup } from './toolResultDedup';
import { collectPreservedTerminalWriteFingerprints } from './turnDrivers/cattyMessageBuilder';

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
  it('bounds failed terminal output and stores the original partial output behind a handle', async () => {
    const store = new ToolOutputStore();
    const partialOutput = `${'build output\n'.repeat(20_000)}FATAL_MID=E_CONN_RESET_7319`;
    const longError = `API_TOKEN=tok_live_1234567890 ${'diagnostic '.repeat(2_000)}`;
    const { tools, toolsContext } = createCattyToolsFromCatalog(
      {
        aiExec: async () => ({
          ok: false,
          error: longError,
          stdout: partialOutput,
          stderr: '',
          exitCode: -1,
        }),
      },
      {
        sessions: [{
          sessionId: 'session-1',
          hostId: 'host-1',
          hostname: 'prod.internal',
          label: 'prod',
          protocol: 'ssh',
          connected: true,
        }],
      },
      [],
      'auto',
      undefined,
      'chat-1',
      store,
    );

    const result = await withCattyToolContext(
      tools.terminal_execute,
      toolsContext.terminal_execute,
      'call-1',
    ).execute({ sessionId: 'session-1', command: 'npm test' }) as {
      error: string;
      stdout?: string;
    };

    assert.ok(result.error.length < 10_000);
    assert.doesNotMatch(result.error, /tok_live/);
    assert.match(result.error, /tool output handle/);
    assert.ok((result.stdout?.length ?? 0) < 30_000);
    assert.match(result.stdout ?? '', /output handle/);
    const handleId = result.stdout?.match(/handleId=(tool-output-[^\]\s]+)/)?.[1];
    assert.ok(handleId);
    assert.match(
      store.read({ handleId, mode: 'tail', maxChars: 1_000 }, 'chat-1') ?? '',
      /FATAL_MID=E_CONN_RESET_7319/,
    );
  });

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
    const recovered = store.readChunk({
      handleId,
      mode: 'search',
      query: 'important ending',
    }, 'chat-1');
    assert.match(recovered?.content ?? '', /important ending/);
  });

  it('hard-caps explicit tool output reads and returns a continuation cursor', async () => {
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
    ) as { content: string; nextOffset: number; hasMore: boolean; totalChars: number };

    assert.ok(result.content.length <= 12_000);
    assert.equal(result.nextOffset, result.content.length);
    assert.equal(result.hasMore, true);
    assert.equal(result.totalChars, body.length);
  });

  it('enforces a shared saved-output read budget across one turn', async () => {
    const store = new ToolOutputStore();
    const dedup = new ToolResultDedup();
    dedup.beginTurn();
    const handle = store.store({
      chatSessionId: 'chat-1',
      capabilityId: 'terminal.execute',
      content: 'x'.repeat(50_000),
    });
    const { tools, toolsContext } = createCattyToolsFromCatalog(
      {}, { sessions: [] }, [], 'auto', undefined, 'chat-1', store, dedup,
    );
    const reader = withCattyToolContext(tools.tool_output_read, toolsContext.tool_output_read);

    const first = await reader.execute({ handleId: handle.id, mode: 'range', offset: 0, maxChars: 12_000 });
    const second = await reader.execute({ handleId: handle.id, mode: 'range', offset: 12_000, maxChars: 12_000 });
    const third = await reader.execute({ handleId: handle.id, mode: 'range', offset: 24_000, maxChars: 12_000 }) as { error?: string };

    assert.equal((first as { content: string }).content.length, 12_000);
    assert.equal((second as { content: string }).content.length, 12_000);
    assert.match(third.error ?? '', /read budget/);
  });

  it('replays a completed terminal command instead of executing it again after retry compaction', async () => {
    let executions = 0;
    const dedup = new ToolResultDedup();
    dedup.beginTurn();
    const { tools, toolsContext } = createCattyToolsFromCatalog(
      {
        aiExec: async () => {
          executions += 1;
          return { ok: true, stdout: 'deployed once', stderr: '', exitCode: 0 };
        },
      },
      {
        sessions: [{
          sessionId: 'session-1',
          hostId: 'host-1',
          hostname: 'prod',
          label: 'prod',
          connected: true,
        }],
      },
      [], 'auto', undefined, 'chat-1', undefined, dedup,
    );
    const execute = withCattyToolContext(tools.terminal_execute, toolsContext.terminal_execute);
    await execute.execute({ sessionId: 'session-1', command: 'deploy production' });
    dedup.enableWriteReplay();
    const replay = await execute.execute({ sessionId: 'session-1', command: 'deploy production' }) as {
      replayedCompletedResult?: boolean;
    };

    assert.equal(executions, 1);
    assert.equal(replay.replayedCompletedResult, true);

    const intentionalRepeat = await execute.execute({ sessionId: 'session-1', command: 'deploy production' }) as {
      replayedCompletedResult?: boolean;
    };
    assert.equal(executions, 2);
    assert.equal(intentionalRepeat.replayedCompletedResult, undefined);
  });

  it('executes an intentional repeat when the completed result is already in retry history', async () => {
    let executions = 0;
    const dedup = new ToolResultDedup();
    dedup.beginTurn();
    const { tools, toolsContext } = createCattyToolsFromCatalog(
      {
        aiExec: async () => {
          executions += 1;
          return { ok: true, stdout: `run ${executions}`, stderr: '', exitCode: 0 };
        },
      },
      {
        sessions: [{
          sessionId: 'session-1',
          hostId: 'host-1',
          hostname: 'prod',
          label: 'prod',
          connected: true,
        }],
      },
      [], 'auto', undefined, 'chat-1', undefined, dedup,
    );
    const execute = withCattyToolContext(tools.terminal_execute, toolsContext.terminal_execute);
    const args = { sessionId: 'session-1', command: 'npm test' };
    await execute.execute(args);
    const retryHistory = [
      {
        id: 'assistant-progress',
        role: 'assistant' as const,
        content: '',
        timestamp: 1,
        toolCalls: [{ id: 'call-1', name: 'terminal_execute', arguments: args }],
      },
      {
        id: 'tool-progress',
        role: 'tool' as const,
        content: '',
        timestamp: 2,
        toolResults: [{ toolCallId: 'call-1', content: 'run 1' }],
      },
    ];
    dedup.enableWriteReplay(collectPreservedTerminalWriteFingerprints(
      retryHistory,
      'assistant-progress',
      'chat-1',
    ));

    const repeat = await execute.execute(args) as { replayedCompletedResult?: boolean };
    assert.equal(executions, 2);
    assert.equal(repeat.replayedCompletedResult, undefined);
  });

  it('pairs reused tool call IDs with the nearest preceding terminal command', () => {
    const commandA = { sessionId: 'session-1', command: 'npm test a' };
    const commandB = { sessionId: 'session-1', command: 'npm test b' };
    const retryHistory = [
      {
        id: 'assistant-a', role: 'assistant' as const, content: '', timestamp: 1,
        toolCalls: [{ id: 'reused-call', name: 'terminal_execute', arguments: commandA }],
      },
      {
        id: 'tool-a', role: 'tool' as const, content: '', timestamp: 2,
        toolResults: [{ toolCallId: 'reused-call', content: 'result a' }],
      },
      {
        id: 'assistant-b', role: 'assistant' as const, content: '', timestamp: 3,
        toolCalls: [{ id: 'reused-call', name: 'terminal_execute', arguments: commandB }],
      },
      {
        id: 'tool-b', role: 'tool' as const, content: '', timestamp: 4,
        toolResults: [{ toolCallId: 'reused-call', content: 'result b' }],
      },
    ];

    assert.deepEqual(
      collectPreservedTerminalWriteFingerprints(retryHistory, 'assistant-a', 'chat-1'),
      [
        buildTerminalWriteFingerprint('terminal_execute', 'chat-1', commandA),
        buildTerminalWriteFingerprint('terminal_execute', 'chat-1', commandB),
      ],
    );
  });

  it('replays a started background job instead of starting it twice after retry compaction', async () => {
    let starts = 0;
    const dedup = new ToolResultDedup();
    const { tools, toolsContext } = createCattyToolsFromCatalog(
      { aiCapability: async () => ({
        ok: true,
        jobId: `job-${++starts}`,
        status: 'running',
        command: 'deploy --password swordfish',
        output: 'x'.repeat(30_000),
      }) },
      { sessions: [] }, [], 'auto', undefined, 'chat-start', undefined, dedup,
    );
    const start = withCattyToolContext(tools.terminal_start, toolsContext.terminal_start);
    await start.execute({ sessionId: 'session-1', command: 'npm run build' });
    dedup.enableWriteReplay();
    const replay = await start.execute({ sessionId: 'session-1', command: 'npm run build' }) as {
      replayedCompletedResult?: boolean;
      jobId?: string;
      command?: string;
      output?: string;
    };
    assert.equal(starts, 1);
    assert.equal(replay.jobId, 'job-1');
    assert.equal(replay.replayedCompletedResult, true);
    assert.doesNotMatch(replay.command ?? '', /swordfish/);
    assert.match(replay.output ?? '', /tool output handle/);

    const intentionalRestart = await start.execute({ sessionId: 'session-1', command: 'npm run build' }) as {
      replayedCompletedResult?: boolean;
      jobId?: string;
    };
    assert.equal(starts, 2);
    assert.equal(intentionalRestart.jobId, 'job-2');
    assert.equal(intentionalRestart.replayedCompletedResult, undefined);
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
    const recovered = store.readChunk({
      handleId,
      mode: 'search',
      query: 'important ending',
    }, 'chat-1');
    assert.match(recovered?.content ?? '', /important ending/);
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

  it('returns a small cached notice for an unchanged terminal context range', async () => {
    const dedup = new ToolResultDedup();
    dedup.beginTurn();
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
        readTerminalContext: async () => ({
          ok: true,
          sessionId: 'session-1',
          range: 'tail',
          content: 'same terminal screen',
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
      undefined,
      dedup,
    );

    const reader = withCattyToolContext(
      tools.terminal_read_context,
      toolsContext.terminal_read_context,
    );
    const first = await reader.execute({ sessionId: 'session-1', range: 'tail' });
    const second = await reader.execute({ sessionId: 'session-1', range: 'tail' });

    assert.equal(typeof first, 'object');
    assert.match(String(second), /^\[cached\]/);
  });

  it('routes terminal_read_context through netcatty/readContext when the session is detached into a popup', async () => {
    const rpcCalls: Array<{ method: string; params: Record<string, unknown>; chatSessionId?: string }> = [];
    let localCalls = 0;
    const { tools, toolsContext } = createCattyToolsFromCatalog(
      {
        aiCapability: async (method: string, params: Record<string, unknown>, chatSessionId?: string) => {
          rpcCalls.push({ method, params, chatSessionId });
          return {
            ok: true,
            sessionId: 'session-1',
            range: 'tail',
            content: 'live popup output',
            totalLines: 1,
            startLine: 0,
            endLine: 0,
            returnedLines: 1,
            hasMoreBefore: false,
            hasMoreAfter: false,
            source: 'live',
          };
        },
      },
      {
        sessions: [{
          sessionId: 'session-1',
          hostId: 'host-1',
          hostname: 'prod.internal',
          label: 'prod',
          connected: true,
        }],
        detachedSessionIds: new Set(['session-1']),
        readTerminalContext: async () => {
          localCalls += 1;
          return {
            ok: true,
            sessionId: 'session-1',
            range: 'tail',
            content: 'stale home screen',
            totalLines: 1,
            startLine: 0,
            endLine: 0,
            returnedLines: 1,
            hasMoreBefore: false,
            hasMoreAfter: false,
            source: 'live',
          };
        },
      },
      [],
      'auto',
      undefined,
      'chat-detached',
    );

    const reader = withCattyToolContext(
      tools.terminal_read_context,
      toolsContext.terminal_read_context,
    );
    const result = await reader.execute({ sessionId: 'session-1', range: 'tail', maxLines: 20 }) as {
      ok: boolean;
      content: string;
    };

    assert.equal(result.ok, true);
    assert.equal(result.content, 'live popup output');
    assert.equal(localCalls, 0);
    assert.deepEqual(rpcCalls, [{
      method: 'netcatty/readContext',
      params: { sessionId: 'session-1', range: 'tail', startLine: undefined, maxLines: 20 },
      chatSessionId: 'chat-detached',
    }]);
  });
});

describe('capabilityTools terminal polling', () => {
  it('tags polled output handles with the owning terminal for close cleanup', async () => {
    const store = new ToolOutputStore();
    const dedup = new ToolResultDedup();
    const { tools, toolsContext } = createCattyToolsFromCatalog(
      {
        aiCapability: async (method: string) => method.includes('jobStart')
          ? { ok: true, jobId: 'job-owned', status: 'running', nextOffset: 0 }
          : { ok: true, jobId: 'job-owned', status: 'running', output: 'x'.repeat(30_000), nextOffset: 30_000 },
      },
      { sessions: [] }, [], 'auto', undefined, 'chat-owned', store, dedup,
    );
    await withCattyToolContext(tools.terminal_start, toolsContext.terminal_start)
      .execute({ sessionId: 'session-owned', command: 'npm run dev' });
    const result = await withCattyToolContext(tools.terminal_poll, toolsContext.terminal_poll)
      .execute({ jobId: 'job-owned', offset: 0 }) as { output: string };
    const handleId = result.output.match(/handleId=(tool-output-[^\]\s]+)/)?.[1];
    assert.ok(handleId);
    store.pruneTerminalSession('chat-owned', 'session-owned');
    assert.equal(store.get(handleId, 'chat-owned'), undefined);
  });

  it('deduplicates an unchanged job output range', async () => {
    const dedup = new ToolResultDedup();
    dedup.beginTurn();
    const { tools, toolsContext } = createCattyToolsFromCatalog(
      {
        aiCapability: async () => ({
          ok: true,
          jobId: 'job-1',
          sessionId: 'session-1',
          status: 'running',
          output: 'same build output',
          outputBaseOffset: 0,
          nextOffset: 17,
          totalOutputChars: 17,
        }),
      },
      { sessions: [] },
      [],
      'auto',
      undefined,
      'chat-1',
      undefined,
      dedup,
    );

    const poll = withCattyToolContext(tools.terminal_poll, toolsContext.terminal_poll);
    const first = await poll.execute({ jobId: 'job-1', offset: 0 });
    const second = await poll.execute({ jobId: 'job-1', offset: 0 });

    assert.equal(typeof first, 'object');
    assert.match(String(second), /^\[cached\]/);
  });

  it('bounds follow-style monitor output before it reaches the model', async () => {
    const store = new ToolOutputStore();
    const rawOutput = `${'x '.repeat(400)}\n${'log line\n'.repeat(500)}MONITOR_MIDDLE_EVIDENCE_7319\n${'tail line\n'.repeat(500)}`;
    const { tools, toolsContext } = createCattyToolsFromCatalog(
      {
        aiCapability: async () => ({
          ok: true,
          jobId: 'monitor-job-unique',
          command: 'tail -f /var/log/app.log',
          status: 'running',
          output: rawOutput,
          nextOffset: 9_000,
        }),
      },
      { sessions: [] },
      [],
      'auto',
      undefined,
      'chat-monitor',
      store,
    );
    const result = await withCattyToolContext(
      tools.terminal_poll,
      toolsContext.terminal_poll,
    ).execute({ jobId: 'monitor-job-unique', offset: 0 }) as { output: string };

    assert.ok(result.output.length < 3_500);
    assert.ok(result.output.split('\n')[0].length <= 500);
    const handleId = result.output.match(/handleId=(tool-output-[^\]\s]+)/)?.[1];
    assert.ok(handleId);
    assert.match(
      store.read({ handleId, mode: 'search', query: 'MONITOR_MIDDLE_EVIDENCE_7319' }, 'chat-monitor') ?? '',
      /MONITOR_MIDDLE_EVIDENCE_7319/,
    );
  });

  it('does not count empty monitor polls as output bursts', async () => {
    let polls = 0;
    const { tools, toolsContext } = createCattyToolsFromCatalog(
      {
        aiCapability: async () => ({
          ok: true,
          jobId: 'quiet-monitor-job',
          command: 'tail -f /var/log/app.log',
          status: 'running',
          output: polls++ < 12 ? '' : 'first new line',
          nextOffset: 0,
        }),
      },
      { sessions: [] },
      [],
      'auto',
      undefined,
      'chat-quiet-monitor',
    );
    const poll = withCattyToolContext(tools.terminal_poll, toolsContext.terminal_poll);
    for (let index = 0; index < 12; index += 1) {
      await poll.execute({ jobId: 'quiet-monitor-job', offset: 0 });
    }
    const result = await poll.execute({ jobId: 'quiet-monitor-job', offset: 0 }) as { output: string };

    assert.equal(result.output, 'first new line');
  });
});

describe('capabilityTools configurable toolOutputMaxChars', () => {
  it('keeps larger terminal_execute stdout inline up to custom limit and spills above it', async () => {
    const store = new ToolOutputStore();
    const mediumStdout = Array.from({ length: 1_000 }, (_, i) => `line-${String(i).padStart(4, '0')}-${'a'.repeat(28)}`).join('\n');
    const hugeStdout = `${Array.from({ length: 1_800 }, (_, i) => `row-${String(i).padStart(4, '0')}-${'b'.repeat(32)}`).join('\n')}\nUNIQUE_END_MARKER_4147`;
    assert.ok(mediumStdout.length > 35_000 && mediumStdout.length < 60_000);
    assert.ok(hugeStdout.length > 70_000);

    let nextOutput = mediumStdout;
    const { tools, toolsContext } = createCattyToolsFromCatalog(
      {
        aiExec: async () => ({
          ok: true,
          stdout: nextOutput,
          stderr: '',
          exitCode: 0,
        }),
      },
      {
        sessions: [{
          sessionId: 'session-1',
          hostId: 'host-1',
          hostname: 'prod.internal',
          label: 'prod',
          protocol: 'ssh',
          connected: true,
        }],
      },
      [],
      'auto',
      undefined,
      'chat-custom-limit',
      store,
      undefined,
      { toolOutputMaxChars: 60_000 },
    );

    const exec = withCattyToolContext(tools.terminal_execute, toolsContext.terminal_execute);
    const mediumResult = await exec.execute({ sessionId: 'session-1', command: 'cat medium.log' }) as { stdout: string };
    assert.equal(mediumResult.stdout, mediumStdout);
    assert.doesNotMatch(mediumResult.stdout, /output handle/);

    nextOutput = hugeStdout;
    const hugeResult = await exec.execute({ sessionId: 'session-1', command: 'cat huge.log' }) as { stdout: string };
    assert.notEqual(hugeResult.stdout, hugeStdout);
    assert.ok(hugeResult.stdout.length > 50_000, 'truncated output should utilize the configured limit rather than collapsing to 4.8k');
    assert.match(hugeResult.stdout, /output handle/);
    const handleId = hugeResult.stdout.match(/handleId=(tool-output-[^\]\s]+)/)?.[1];
    assert.ok(handleId);
    assert.match(
      store.read({ handleId, mode: 'tail', maxChars: 1_000 }, 'chat-custom-limit') ?? '',
      /UNIQUE_END_MARKER_4147/,
    );
  });

  it('honors custom toolOutputMaxChars for sftp_read_file with and without dedup', async () => {
    const mediumFile = Array.from({ length: 1_000 }, (_, i) => `config_${i}=${'v'.repeat(30)}`).join('\n');
    const hugeFile = `${Array.from({ length: 1_800 }, (_, i) => `entry_${i}=${'w'.repeat(34)}`).join('\n')}\nSFTP_TAIL_4147`;
    assert.ok(mediumFile.length > 35_000 && mediumFile.length < 60_000);
    assert.ok(hugeFile.length > 70_000);

    for (const withDedup of [true, false]) {
      const store = new ToolOutputStore();
      const dedup = withDedup ? new ToolResultDedup() : undefined;
      dedup?.beginTurn();
      const { tools, toolsContext } = createCattyToolsFromCatalog(
        {
          aiCapability: async (_method: string, params: Record<string, unknown>) => ({
            ok: true,
            path: params.path,
            content: params.path === '/etc/medium.conf' ? mediumFile : hugeFile,
          }),
        },
        { sessions: [] },
        [],
        'auto',
        undefined,
        `chat-sftp-${withDedup ? 'dedup' : 'plain'}`,
        store,
        dedup,
        { toolOutputMaxChars: 60_000 },
      );

      const readFile = withCattyToolContext(tools.sftp_read_file, toolsContext.sftp_read_file);
      const mediumResult = await readFile.execute({ sessionId: 'session-1', path: '/etc/medium.conf' }) as {
        content?: string;
        handleId?: string;
      };
      assert.equal(mediumResult.content, mediumFile);
      assert.equal(mediumResult.handleId, undefined);

      const hugeResult = await readFile.execute({ sessionId: 'session-1', path: '/etc/huge.conf' }) as {
        content?: string;
        handleId?: string;
      };
      const handleId = hugeResult.handleId ?? hugeResult.content?.match(/handleId=(tool-output-[^\]\s]+)/)?.[1];
      assert.ok(handleId, `expected handleId for oversized SFTP file (withDedup=${withDedup})`);
      const recovered = store.readChunk(
        { handleId, mode: 'search', query: 'SFTP_TAIL_4147' },
        `chat-sftp-${withDedup ? 'dedup' : 'plain'}`,
      );
      assert.match(recovered?.content ?? '', /SFTP_TAIL_4147/);
    }
  });
});
