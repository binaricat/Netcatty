import test from 'node:test';
import assert from 'node:assert/strict';

import { canSendWithAgent, findEnabledExternalAgent } from './agentSendEligibility';
import type { ExternalAgentConfig } from '../../infrastructure/ai/types';

const agents: ExternalAgentConfig[] = [
  {
    id: 'enabled-agent',
    name: 'Enabled Agent',
    command: '/usr/local/bin/enabled-agent',
    sdkBackend: 'codex',
    enabled: true,
  },
  {
    id: 'disabled-agent',
    name: 'Disabled Agent',
    command: '/usr/local/bin/disabled-agent',
    sdkBackend: 'codex',
    enabled: false,
  },
  {
    id: 'missing-backend-agent',
    name: 'Missing Backend Agent',
    command: '/usr/local/bin/missing-backend-agent',
    enabled: true,
  },
];

test('canSendWithAgent allows Catty and enabled external agents', () => {
  assert.equal(canSendWithAgent('catty', agents), true);
  assert.equal(canSendWithAgent('enabled-agent', agents), true);
});

test('canSendWithAgent blocks missing or disabled external agents', () => {
  assert.equal(canSendWithAgent('disabled-agent', agents), false);
  assert.equal(canSendWithAgent('missing-backend-agent', agents), false);
  assert.equal(canSendWithAgent('missing-agent', agents), false);
});

test('findEnabledExternalAgent ignores disabled external agents', () => {
  assert.equal(findEnabledExternalAgent(agents, 'enabled-agent')?.name, 'Enabled Agent');
  assert.equal(findEnabledExternalAgent(agents, 'disabled-agent'), undefined);
});
