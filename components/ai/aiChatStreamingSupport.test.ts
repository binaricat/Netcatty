import test from 'node:test';
import assert from 'node:assert/strict';

import {
  extractToolResultDenialReason,
  isToolResultError,
} from './hooks/aiChatStreamingSupport';
import { APPROVAL_DENIAL_REASONS } from '../../infrastructure/ai/shared/approvalPolicy';

test('tool result helpers detect structured denial reasons', () => {
  const output = {
    error: 'Operation denied by user.',
    denialReason: APPROVAL_DENIAL_REASONS.USER_DENIED,
  };

  assert.equal(isToolResultError(output), true);
  assert.equal(extractToolResultDenialReason(output), APPROVAL_DENIAL_REASONS.USER_DENIED);
});

test('tool result helpers detect denial reasons in MCP text errors', () => {
  const output = 'Error (timeout_auto_denied): Operation automatically denied because approval timed out.';

  assert.equal(isToolResultError(output), true);
  assert.equal(extractToolResultDenialReason(output), APPROVAL_DENIAL_REASONS.TIMEOUT_AUTO_DENIED);
});
