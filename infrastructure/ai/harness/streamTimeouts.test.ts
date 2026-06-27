import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildCattyStreamTimeouts } from './streamTimeouts';
import { CATTY_APPROVAL_TIMEOUT_MS } from '../shared/approvalConstants';

describe('buildCattyStreamTimeouts', () => {
  it('keeps stream budgets from undercutting the configured command timeout', () => {
    const oneDayMs = 86_400 * 1000;
    const timeouts = buildCattyStreamTimeouts({
      commandTimeoutMs: oneDayMs,
    });

    assert.ok(timeouts.chunkMs > oneDayMs);
    assert.ok(timeouts.toolMs > oneDayMs);
    assert.ok(timeouts.stepMs > oneDayMs);
    assert.ok(timeouts.totalMs > oneDayMs);
  });

  it('includes confirm-mode approval time in long command stream budgets', () => {
    const commandTimeoutMs = 60 * 1000;
    const expectedMinimum = commandTimeoutMs + CATTY_APPROVAL_TIMEOUT_MS + (90 * 1000);
    const timeouts = buildCattyStreamTimeouts({
      permissionMode: 'confirm',
      commandTimeoutMs,
    });

    assert.ok(timeouts.chunkMs >= expectedMinimum);
    assert.ok(timeouts.toolMs >= expectedMinimum);
    assert.ok(timeouts.stepMs >= expectedMinimum);
    assert.ok(timeouts.totalMs >= expectedMinimum);
  });
});
