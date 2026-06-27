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

  it('scales the total stream budget for multi-step long command turns', () => {
    const commandTimeoutMs = 10 * 60 * 1000;
    const singleStepBudgetMs = commandTimeoutMs + CATTY_APPROVAL_TIMEOUT_MS + (90 * 1000);
    const timeouts = buildCattyStreamTimeouts({
      permissionMode: 'confirm',
      commandTimeoutMs,
      maxIterations: 2,
    });

    assert.ok(timeouts.chunkMs >= singleStepBudgetMs);
    assert.ok(timeouts.toolMs >= singleStepBudgetMs);
    assert.ok(timeouts.stepMs >= singleStepBudgetMs);
    assert.ok(timeouts.totalMs != null);
    assert.ok(timeouts.totalMs >= singleStepBudgetMs * 2);
  });

  it('omits total timeout when the multi-step budget exceeds timer limits', () => {
    const timeouts = buildCattyStreamTimeouts({
      commandTimeoutMs: 86_400 * 1000,
      maxIterations: 100,
    });

    assert.equal(timeouts.totalMs, undefined);
    assert.ok(timeouts.chunkMs > 86_400 * 1000);
    assert.ok(timeouts.toolMs > 86_400 * 1000);
    assert.ok(timeouts.stepMs > 86_400 * 1000);
  });
});
