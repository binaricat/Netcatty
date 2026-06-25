import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { stopAgentTurn } from './agentStop';
import { globalTraceStore } from './traceStore';

describe('stopAgentTurn', () => {
  it('aborts, cancels bridge surfaces, and emits turn_end', async () => {
    const calls: string[] = [];
    const controller = new AbortController();
    const sessionId = 'chat-stop-test';

    globalTraceStore.clear(sessionId);

    await stopAgentTurn({
      chatSessionId: sessionId,
      abortController: controller,
      bridge: {
        aiCattyCancelExec: async (id) => { calls.push(`catty:${id}`); },
        aiSdkAgentCancel: async (_req, id) => { calls.push(`sdk:${id}`); return { ok: true }; },
        aiSetChatSessionCancelled: async (id, cancelled) => {
          calls.push(`cancelled:${id}:${cancelled}`);
          return { ok: true };
        },
      },
      reason: 'slash',
      backend: 'catty',
    });

    assert.equal(controller.signal.aborted, true);
    assert.deepEqual(calls, [
      `catty:${sessionId}`,
      `sdk:${sessionId}`,
      `cancelled:${sessionId}:true`,
    ]);

    const events = globalTraceStore.getEvents(sessionId);
    assert.equal(events.at(-1)?.type, 'turn_end');
    assert.equal((events.at(-1) as { reason?: string }).reason, 'aborted');
  });
});
