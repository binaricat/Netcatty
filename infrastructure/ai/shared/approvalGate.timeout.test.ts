import assert from 'node:assert/strict';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

import {
  cancelApprovalTimeout,
  clearAllPendingApprovals,
  onApprovalCleared,
  requestApproval,
  registerGrantPersister,
  resolveApproval,
  setupMcpApprovalBridge,
} from './approvalGate';
import { resolveCattyApprovalDeadlines } from './approvalConstants';

function stubNow(startMs: number): { advance: (deltaMs: number) => void; restore: () => void } {
  const realNow = Date.now;
  let now = startMs;
  Date.now = () => now;
  return {
    advance: (deltaMs: number) => {
      now += deltaMs;
    },
    restore: () => {
      Date.now = realNow;
    },
  };
}

test('resolveCattyApprovalDeadlines keeps hard deadline >= idle and 3x by default', () => {
  assert.deepEqual(resolveCattyApprovalDeadlines(100), { idleMs: 100, hardDeadlineMs: 300 });
  assert.deepEqual(resolveCattyApprovalDeadlines(5 * 60 * 1000), {
    idleMs: 5 * 60 * 1000,
    hardDeadlineMs: 15 * 60 * 1000,
  });
  // Cap at 30m when 3× would exceed, unless idle itself is larger.
  assert.deepEqual(resolveCattyApprovalDeadlines(20 * 60 * 1000), {
    idleMs: 20 * 60 * 1000,
    hardDeadlineMs: 30 * 60 * 1000,
  });
  assert.deepEqual(resolveCattyApprovalDeadlines(40 * 60 * 1000), {
    idleMs: 40 * 60 * 1000,
    hardDeadlineMs: 40 * 60 * 1000,
  });
});

test('cancelApprovalTimeout re-arms a fresh idle window, not the original absolute remainder', async () => {
  clearAllPendingApprovals();
  const cleared: string[] = [];
  const unsub = onApprovalCleared((ids) => {
    cleared.push(...ids);
  });
  const clock = stubNow(1_000_000);

  try {
    const toolCallId = `timeout-idle-rearm-${Date.now()}`;
    // idle 100ms, hard 300ms
    const approvalPromise = requestApproval(
      toolCallId,
      'terminal_execute',
      { sessionId: 's1', command: 'echo hi' },
      'chat-1',
      100,
    );

    // Review near end of first idle window — previously this left ~30ms absolute
    // remainder and denied while the user was still deciding.
    clock.advance(70);
    cancelApprovalTimeout(toolCallId);

    // Fresh idle (100ms) should keep the approval pending well past the old
    // absolute mark at t=100.
    await delay(50);
    assert.equal(cleared.includes(toolCallId), false, 'must stay pending through re-armed idle');

    // Still before hard deadline (300): jump clock so remaining hard is short.
    clock.advance(220); // now = start+290; remaining hard = 10ms; re-arm idle capped to 10
    cancelApprovalTimeout(toolCallId);

    const outcome = await Promise.race([
      approvalPromise.then((approved) => ({ approved })),
      delay(120).then(() => ({ approved: 'timeout-wait' as const })),
    ]);
    assert.deepEqual(outcome, { approved: false });
    assert.ok(cleared.includes(toolCallId));
  } finally {
    clock.restore();
    unsub();
    clearAllPendingApprovals();
  }
});

test('cancelApprovalTimeout survives past the idle deadline while reviewing', async () => {
  clearAllPendingApprovals();
  const cleared: string[] = [];
  const unsub = onApprovalCleared((ids) => {
    cleared.push(...ids);
  });
  const clock = stubNow(3_000_000);

  try {
    const toolCallId = `timeout-past-idle-${Date.now()}`;
    const idleMs = 80;
    const approvalPromise = requestApproval(
      toolCallId,
      'terminal_execute',
      { sessionId: 's1', command: 'echo hi' },
      'chat-1',
      idleMs,
    );

    // Review near end of first idle — re-arms a full idleMs from now (hard = 3x).
    clock.advance(idleMs - 20);
    cancelApprovalTimeout(toolCallId);

    // Wall-clock past the original idle mark; re-armed idle still has ~idleMs left.
    await delay(40);
    assert.equal(cleared.includes(toolCallId), false, 'active review must outlive original idle');

    resolveApproval(toolCallId, true);
    assert.equal(await approvalPromise, true);
  } finally {
    clock.restore();
    unsub();
    clearAllPendingApprovals();
  }
});

test('cancelApprovalTimeout still allows explicit approve before hard Catty deadline', async () => {
  clearAllPendingApprovals();
  const clock = stubNow(2_000_000);

  try {
    const toolCallId = `timeout-approve-${Date.now()}`;
    const approvalPromise = requestApproval(
      toolCallId,
      'sftp_write',
      { path: '/tmp/x' },
      'chat-1',
      200,
    );

    clock.advance(150);
    cancelApprovalTimeout(toolCallId);
    resolveApproval(toolCallId, true);
    assert.equal(await approvalPromise, true);
  } finally {
    clock.restore();
    clearAllPendingApprovals();
  }
});

test('cancelApprovalTimeout rejects expired Catty approvals synchronously after hard deadline', async () => {
  clearAllPendingApprovals();
  const cleared: string[] = [];
  const unsub = onApprovalCleared((ids) => {
    cleared.push(...ids);
  });
  const clock = stubNow(4_000_000);

  try {
    const toolCallId = `timeout-hard-sync-${Date.now()}`;
    // idle 50ms → hard 150ms
    const approvalPromise = requestApproval(
      toolCallId,
      'terminal_execute',
      { sessionId: 's1', command: 'echo hi' },
      'chat-1',
      50,
    );

    clock.advance(160); // past hard deadline
    cancelApprovalTimeout(toolCallId);

    // Must already be denied — no setTimeout(0) race window for approve.
    assert.ok(cleared.includes(toolCallId), 'must clear synchronously when hard deadline elapsed');
    assert.equal(await approvalPromise, false);

    // Late approve after hard-deadline deny must not resurrect the request.
    resolveApproval(toolCallId, true);
    assert.equal(await approvalPromise, false);
  } finally {
    clock.restore();
    unsub();
    clearAllPendingApprovals();
  }
});

test('repeated cancelApprovalTimeout re-arms idle on each review interaction', async () => {
  clearAllPendingApprovals();
  const cleared: string[] = [];
  const unsub = onApprovalCleared((ids) => {
    cleared.push(...ids);
  });
  const clock = stubNow(5_000_000);

  try {
    const toolCallId = `timeout-multi-rearm-${Date.now()}`;
    const idleMs = 100;
    const approvalPromise = requestApproval(
      toolCallId,
      'terminal_execute',
      { sessionId: 's1', command: 'echo hi' },
      'chat-1',
      idleMs,
    );

    // Simulate successive review events (focus, scroll, key) — each re-arms.
    clock.advance(60);
    cancelApprovalTimeout(toolCallId);
    clock.advance(60);
    cancelApprovalTimeout(toolCallId);
    clock.advance(60);
    cancelApprovalTimeout(toolCallId);

    // Still before hard deadline (300ms); original idle marks have long passed.
    await delay(20);
    assert.equal(cleared.includes(toolCallId), false, 'each re-arm must keep approval pending');

    resolveApproval(toolCallId, true);
    assert.equal(await approvalPromise, true);
  } finally {
    clock.restore();
    unsub();
    clearAllPendingApprovals();
  }
});

test('idle approval timeout still auto-denies when the user never reviews', async () => {
  clearAllPendingApprovals();
  const cleared: string[] = [];
  const unsub = onApprovalCleared((ids) => {
    cleared.push(...ids);
  });

  const toolCallId = `timeout-fire-${Date.now()}`;
  const approved = await requestApproval(
    toolCallId,
    'terminal_execute',
    { sessionId: 's1', command: 'echo hi' },
    'chat-1',
    30,
  );

  assert.equal(approved, false);
  assert.ok(cleared.includes(toolCallId));

  unsub();
  clearAllPendingApprovals();
});

test('cancelApprovalTimeout asks main to drop Codex App Server interaction timers', () => {
  clearAllPendingApprovals();
  const calls: string[] = [];
  const previous = (globalThis as { window?: unknown }).window;
  (globalThis as { window?: unknown }).window = {
    netcatty: {
      cancelCodexAppServerInteractionTimeout: async (id: string) => {
        calls.push(id);
        return { ok: true, cancelled: true };
      },
    },
  };

  try {
    const toolCallId = `codex_interaction_1_${Date.now()}`;
    cancelApprovalTimeout(toolCallId);
    assert.deepEqual(calls, [toolCallId]);
  } finally {
    (globalThis as { window?: unknown }).window = previous;
    clearAllPendingApprovals();
  }
});

test('requestApproval joins an existing waiter for the same toolCallId', async () => {
  clearAllPendingApprovals();
  const toolCallId = `dup-approval-${Date.now()}`;
  const first = requestApproval(toolCallId, 'sftp_write', { path: '/tmp/a' }, 'chat-1', 60_000);
  const second = requestApproval(toolCallId, 'sftp_write', { path: '/tmp/a' }, 'chat-1', 60_000);
  resolveApproval(toolCallId, { approved: true, scope: 'once' });
  assert.deepEqual(await Promise.all([first, second]), [true, true]);
  clearAllPendingApprovals();
});

test('resolveApproval skips MCP IPC when the pending entry is already gone', () => {
  clearAllPendingApprovals();
  const calls: Array<{ id: string; approved: boolean }> = [];
  const previous = (globalThis as { window?: unknown }).window;
  (globalThis as { window?: unknown }).window = {
    netcatty: {
      respondMcpApproval: async (id: string, approved: boolean) => {
        calls.push({ id, approved });
        return { ok: true };
      },
    },
  };

  try {
    resolveApproval('mcp_approval_stale', true);
    assert.deepEqual(calls, []);
  } finally {
    (globalThis as { window?: unknown }).window = previous;
    clearAllPendingApprovals();
  }
});

test('MCP grants persist only after main confirms an active approval', async () => {
  clearAllPendingApprovals();
  const previous = (globalThis as { window?: unknown }).window;
  const saved: string[] = [];
  let receiveRequest: ((payload: unknown) => void) | undefined;
  let accepted = false;
  (globalThis as { window?: unknown }).window = {
    netcatty: {
      onMcpApprovalRequest: (listener: (payload: unknown) => void) => {
        receiveRequest = listener;
        return () => {};
      },
      respondMcpApproval: async () => ({ ok: true, accepted }),
    },
  };
  const removePersister = registerGrantPersister((grant) => saved.push(grant.id));
  const stopBridge = setupMcpApprovalBridge();
  try {
    for (const shouldAccept of [false, true]) {
      accepted = shouldAccept;
      const id = `mcp_approval_ack_${shouldAccept}`;
      receiveRequest?.({ approvalId: id, toolName: 'terminal_execute', args: {}, chatSessionId: '__external_mcp__' });
      resolveApproval(id, {
        approved: true,
        persistGrant: { id, capabilityId: 'terminal.execute', sessionPattern: 'host:h1', createdAt: 1 },
      });
      await delay(0);
      assert.equal(saved.includes(id), shouldAccept);
    }
  } finally {
    stopBridge();
    removePersister();
    (globalThis as { window?: unknown }).window = previous;
    clearAllPendingApprovals();
  }
});
