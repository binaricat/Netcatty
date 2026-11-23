import assert from 'node:assert/strict';
import test from 'node:test';

import {
  aiPanelContextsEqual,
  aiTerminalSessionInfosEqual,
  retainStableAiPanelContexts,
  retainStableAiTerminalSessionInfos,
  type AIPanelContextLike,
  type AIPanelTerminalSessionLike,
} from './aiPanelContextsEqual.ts';

const sessionInfo = (
  overrides: Partial<AIPanelTerminalSessionLike> = {},
): AIPanelTerminalSessionLike => ({
  sessionId: 's1',
  hostId: 'h1',
  hostname: 'example.test',
  label: 'example',
  connected: true,
  ...overrides,
});

const context = (
  overrides: Partial<AIPanelContextLike> = {},
): AIPanelContextLike => ({
  scopeType: 'terminal',
  scopeTargetId: 's1',
  scopeHostIds: ['h1'],
  scopeLabel: 'example',
  terminalSessions: [sessionInfo()],
  ...overrides,
});

test('aiPanelContextsEqual is true for structurally equal maps with different identity', () => {
  const a = new Map([['s1', context()]]);
  const b = new Map([['s1', context()]]);
  assert.equal(aiPanelContextsEqual(a, b), true);
  assert.equal(retainStableAiPanelContexts(a, b), a);
});

test('aiPanelContextsEqual is false when connection status changes', () => {
  const a = new Map([['s1', context({ terminalSessions: [sessionInfo({ connected: true })] })]]);
  const b = new Map([['s1', context({ terminalSessions: [sessionInfo({ connected: false })] })]]);
  assert.equal(aiPanelContextsEqual(a, b), false);
  assert.equal(retainStableAiPanelContexts(a, b), b);
});

test('aiPanelContextsEqual is false when port-forward status changes', () => {
  const a = new Map([['s1', context({
    terminalSessions: [sessionInfo({
      activePortForwards: [{ ruleId: 'r1', status: 'active', localPort: 8080 }],
    })],
  })]]);
  const b = new Map([['s1', context({
    terminalSessions: [sessionInfo({
      activePortForwards: [{ ruleId: 'r1', status: 'connecting', localPort: 8080 }],
    })],
  })]]);
  assert.equal(aiPanelContextsEqual(a, b), false);
});

test('retainStableAiTerminalSessionInfos preserves identity for structurally equal lists', () => {
  const a = [sessionInfo({ sessionId: 's1' }), sessionInfo({ sessionId: 's2', label: 'core' })];
  const b = [sessionInfo({ sessionId: 's1' }), sessionInfo({ sessionId: 's2', label: 'core' })];
  assert.equal(aiTerminalSessionInfosEqual(a, b), true);
  assert.equal(retainStableAiTerminalSessionInfos(a, b), a);

  const c = [sessionInfo({ sessionId: 's1' }), sessionInfo({ sessionId: 's2', label: 'renamed' })];
  assert.equal(aiTerminalSessionInfosEqual(a, c), false);
  assert.equal(retainStableAiTerminalSessionInfos(a, c), c);
});
