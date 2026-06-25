import test from 'node:test';
import assert from 'node:assert/strict';

import {
  AgentBudgetTracker,
  createBudgetStopCondition,
  normalizeAgentBudgetLimits,
} from './agentBudget.ts';

test('AgentBudgetTracker stops on tool-call budget', () => {
  const tracker = new AgentBudgetTracker(normalizeAgentBudgetLimits({
    maxSteps: 20,
    maxToolCalls: 2,
  }));

  assert.equal(tracker.recordToolCall(), null);
  const reason = tracker.recordToolCall();
  assert.equal(reason?.kind, 'tool-calls');
  assert.equal(reason?.usage.toolCalls, 2);
});

test('AgentBudgetTracker stops on token budget from step usage', () => {
  const tracker = new AgentBudgetTracker(normalizeAgentBudgetLimits({
    maxSteps: 20,
    maxToolCalls: 20,
    maxTokens: 100,
  }));

  assert.equal(tracker.recordStepUsage({ inputTokens: 40, outputTokens: 50 }), null);
  const reason = tracker.recordStepUsage({ promptTokens: 8, completionTokens: 4 });
  assert.equal(reason?.kind, 'tokens');
  assert.equal(reason?.usage.tokens, 102);
});

test('budget stop condition syncs AI SDK steps usage', () => {
  const tracker = new AgentBudgetTracker(normalizeAgentBudgetLimits({
    maxSteps: 20,
    maxToolCalls: 20,
    maxCostUsd: 0.01,
    costPerMillionTokensUsd: 10,
  }));
  const stopWhen = createBudgetStopCondition(tracker);

  assert.equal(stopWhen({ steps: [{ usage: { totalTokens: 999 } }] }), false);
  assert.equal(stopWhen({ steps: [{ usage: { totalTokens: 1000 } }] }), true);
  assert.equal(tracker.getStopReason()?.kind, 'cost');
});
