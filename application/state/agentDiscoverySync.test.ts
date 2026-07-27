import assert from 'node:assert/strict';
import test from 'node:test';
import type { DiscoveredAgent, ExternalAgentConfig } from '../../infrastructure/ai/types';
import { applyDiscoveredUpdatesToExternalAgents } from './agentDiscoverySync';

test('applyDiscoveredUpdatesToExternalAgents recovers sticky Antigravity available:false', () => {
  const agents: ExternalAgentConfig[] = [{
    id: 'discovered_antigravity',
    name: 'Google Antigravity',
    command: 'python3',
    args: [],
    icon: 'gemini',
    enabled: true,
    available: false,
    apiKey: 'enc:v1:test',
    sdkBackend: 'antigravity',
    commandSource: 'auto',
  }];
  const discovered: DiscoveredAgent[] = [{
    command: 'antigravity',
    name: 'Google Antigravity',
    icon: 'gemini',
    description: 'Google Antigravity via the official Python SDK',
    args: [],
    path: '/usr/bin/python3',
    binPath: '/usr/bin/python3',
    version: 'Antigravity SDK 0.1.8 (Python 3.12.0)',
    available: true,
    sdkBackend: 'antigravity',
  }];

  const next = applyDiscoveredUpdatesToExternalAgents(agents, discovered);

  assert.equal(next[0].available, true);
  assert.equal(next[0].command, '/usr/bin/python3');
  assert.equal(next[0].apiKey, 'enc:v1:test');
  assert.equal(next[0].cliVersion, 'Antigravity SDK 0.1.8 (Python 3.12.0)');
});

test('applyDiscoveredUpdatesToExternalAgents keeps manual Antigravity paths', () => {
  const agents: ExternalAgentConfig[] = [{
    id: 'discovered_antigravity',
    name: 'Google Antigravity',
    command: '/custom/python',
    args: [],
    icon: 'gemini',
    enabled: true,
    available: false,
    apiKey: 'enc:v1:test',
    sdkBackend: 'antigravity',
    commandSource: 'manual',
  }];
  const discovered: DiscoveredAgent[] = [{
    command: 'antigravity',
    name: 'Google Antigravity',
    icon: 'gemini',
    description: 'Google Antigravity via the official Python SDK',
    args: [],
    path: '/usr/bin/python3',
    binPath: '/usr/bin/python3',
    version: 'Antigravity SDK 0.1.8 (Python 3.12.0)',
    available: true,
    sdkBackend: 'antigravity',
  }];

  const next = applyDiscoveredUpdatesToExternalAgents(agents, discovered);

  assert.equal(next[0].available, true);
  assert.equal(next[0].command, '/custom/python');
});
