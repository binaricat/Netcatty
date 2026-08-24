import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildCattyStreamTimeouts } from './streamTimeouts';
import { CATTY_APPROVAL_HARD_DEADLINE_MS } from '../shared/approvalConstants';
import {
  DEFAULT_RESPONSE_IDLE_TIMEOUT_SECONDS,
  MAX_RESPONSE_IDLE_TIMEOUT_SECONDS,
  normalizeResponseIdleTimeoutSeconds,
} from '../types';

describe('normalizeResponseIdleTimeoutSeconds', () => {
  it('keeps stored response wait values within the supported range', () => {
    assert.equal(normalizeResponseIdleTimeoutSeconds(Number.NaN), DEFAULT_RESPONSE_IDLE_TIMEOUT_SECONDS);
    assert.equal(normalizeResponseIdleTimeoutSeconds(0), 1);
    assert.equal(
      normalizeResponseIdleTimeoutSeconds(MAX_RESPONSE_IDLE_TIMEOUT_SECONDS + 1),
      MAX_RESPONSE_IDLE_TIMEOUT_SECONDS,
    );
  });
});

describe('buildCattyStreamTimeouts', () => {
  it('uses the configured response idle timeout for inactive model streams', () => {
    const responseIdleTimeoutMs = 12 * 60 * 1000;
    const timeouts = buildCattyStreamTimeouts({ responseIdleTimeoutMs });

    assert.equal(timeouts.chunkMs, responseIdleTimeoutMs);
    assert.ok(timeouts.stepMs > responseIdleTimeoutMs);
    assert.ok(timeouts.totalMs != null);
    assert.ok(timeouts.totalMs > responseIdleTimeoutMs);
  });

  it('scales the total stream budget so every step can use the configured response wait', () => {
    const responseIdleTimeoutMs = 20 * 60 * 1000;
    const timeouts = buildCattyStreamTimeouts({
      responseIdleTimeoutMs,
      maxIterations: 3,
    });

    assert.ok(timeouts.totalMs != null);
    assert.ok(timeouts.totalMs > responseIdleTimeoutMs * 3);
  });

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

  it('budgets sequential response waiting and command execution in each step', () => {
    const responseIdleTimeoutMs = 20 * 60 * 1000;
    const commandTimeoutMs = 10 * 60 * 1000;
    const timeouts = buildCattyStreamTimeouts({
      responseIdleTimeoutMs,
      commandTimeoutMs,
      maxIterations: 2,
    });

    assert.ok(timeouts.stepMs > responseIdleTimeoutMs + commandTimeoutMs);
    assert.ok(timeouts.totalMs != null);
    assert.ok(timeouts.totalMs >= timeouts.stepMs * 2);
  });

  it('includes confirm-mode hard approval deadline in long command stream budgets', () => {
    const commandTimeoutMs = 60 * 1000;
    const expectedMinimum = commandTimeoutMs + CATTY_APPROVAL_HARD_DEADLINE_MS + (90 * 1000);
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
    const singleStepBudgetMs = commandTimeoutMs + CATTY_APPROVAL_HARD_DEADLINE_MS + (90 * 1000);
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
