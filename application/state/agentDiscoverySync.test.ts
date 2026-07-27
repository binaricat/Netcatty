import assert from 'node:assert/strict';
import test from 'node:test';
import type { DiscoveredAgent, ExternalAgentConfig } from '../../infrastructure/ai/types';
import { applyDiscoveredUpdatesToExternalAgents } from './agentDiscoverySync';

test('applyDiscoveredUpdatesToExternalAgents does not recover Cursor available from cross-mode discovery', () => {
  const agents: ExternalAgentConfig[] = [{
    id: 'discovered_cursor',
    name: 'Cursor',
    command: 'cursor',
    args: [],
    icon: 'cursor',
    enabled: true,
    available: false,
    sdkBackend: 'cursor',
    cursorAuthMode: 'api-key',
    commandSource: 'auto',
  }];
  // Discovery available is the union of both auth modes (CLI login ok, no API key).
  const discovered: DiscoveredAgent[] = [{
    command: 'cursor',
    name: 'Cursor',
    icon: 'cursor',
    description: "Cursor's coding agent via Cursor SDK",
    args: [],
    path: 'cursor',
    binPath: '/usr/local/bin/cursor-agent',
    version: 'Cursor Agent CLI',
    available: true,
    sdkBackend: 'cursor',
    authSource: 'cli-login',
  }];

  const next = applyDiscoveredUpdatesToExternalAgents(agents, discovered);

  assert.equal(next[0].available, false);
  assert.equal(next[0].cursorAuthMode, 'api-key');
});

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
    cliVersion: 'custom-probe',
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

  assert.equal(next[0].available, false);
  assert.equal(next[0].command, '/custom/python');
  assert.equal(next[0].cliVersion, 'custom-probe');
});

test('applyDiscoveredUpdatesToExternalAgents recovers manual path when discovery matches it', () => {
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
    path: '/custom/python',
    binPath: '/custom/python',
    version: 'Antigravity SDK 0.1.8 (Python 3.12.0)',
    available: true,
    sdkBackend: 'antigravity',
  }];

  const next = applyDiscoveredUpdatesToExternalAgents(agents, discovered);

  assert.equal(next[0].available, true);
  assert.equal(next[0].command, '/custom/python');
  assert.equal(next[0].cliVersion, 'Antigravity SDK 0.1.8 (Python 3.12.0)');
});
