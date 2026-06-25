import test from 'node:test';
import assert from 'node:assert/strict';

import {
  clearAllPendingApprovals,
  onApprovalCleared,
  onApprovalRequest,
  requestApproval,
  resolveApproval,
} from './shared/approvalGate';
import { APPROVAL_DENIAL_REASONS } from './shared/approvalPolicy';

test('approval gate reports user_denied for rejected confirm prompts', async () => {
  clearAllPendingApprovals();
  const requests: string[] = [];
  const unsubscribe = onApprovalRequest((request) => {
    requests.push(request.toolCallId);
  });

  try {
    const resultPromise = requestApproval('call-user-denied', 'terminal_execute', { command: 'pwd' }, 'chat-1', 1_000);
    assert.deepEqual(requests, ['call-user-denied']);

    resolveApproval('call-user-denied', false);
    const result = await resultPromise;

    assert.deepEqual(result, {
      approved: false,
      reason: APPROVAL_DENIAL_REASONS.USER_DENIED,
      message: 'Operation denied by user.',
    });
  } finally {
    unsubscribe();
    clearAllPendingApprovals();
  }
});

test('approval gate auto-denies unanswered prompts after timeout', async () => {
  clearAllPendingApprovals();
  const cleared: Array<{ toolCallId: string; reason: string }> = [];
  const unsubscribe = onApprovalCleared((events) => {
    cleared.push(...events);
  });

  try {
    const result = await requestApproval('call-timeout', 'terminal_execute', { command: 'pwd' }, 'chat-1', 1);

    assert.equal(result.approved, false);
    if (!result.approved) {
      assert.equal(result.reason, APPROVAL_DENIAL_REASONS.TIMEOUT_AUTO_DENIED);
    }
    assert.deepEqual(cleared, [{
      toolCallId: 'call-timeout',
      reason: APPROVAL_DENIAL_REASONS.TIMEOUT_AUTO_DENIED,
    }]);
  } finally {
    unsubscribe();
    clearAllPendingApprovals();
  }
});

test('approval gate reports policy_denied when scoped approvals are cleared', async () => {
  clearAllPendingApprovals();
  const cleared: Array<{ toolCallId: string; reason: string }> = [];
  const unsubscribe = onApprovalCleared((events) => {
    cleared.push(...events);
  });

  try {
    const resultPromise = requestApproval('call-cleared', 'terminal_execute', { command: 'pwd' }, 'chat-1', 1_000);
    clearAllPendingApprovals('chat-1');
    const result = await resultPromise;

    assert.equal(result.approved, false);
    if (!result.approved) {
      assert.equal(result.reason, APPROVAL_DENIAL_REASONS.POLICY_DENIED);
    }
    assert.deepEqual(cleared, [{
      toolCallId: 'call-cleared',
      reason: APPROVAL_DENIAL_REASONS.POLICY_DENIED,
    }]);
  } finally {
    unsubscribe();
    clearAllPendingApprovals();
  }
});
