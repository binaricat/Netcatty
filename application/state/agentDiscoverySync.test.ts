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

test('applyDiscoveredUpdatesToExternalAgents migrates Python Antigravity state to agy and removes its API key', () => {
  const agents: ExternalAgentConfig[] = [{
    id: 'discovered_antigravity',
    name: 'Google Antigravity',
    command: 'python3',
    args: [],
    icon: 'gemini',
    enabled: true,
    available: false,
    apiKey: 'enc:v1:test',
    commandSource: 'auto',
  }];
  const discovered: DiscoveredAgent[] = [{
    command: 'antigravity',
    name: 'Google Antigravity',
    icon: 'gemini',
    description: 'Google Antigravity via the official Agy CLI',
    args: [],
    path: '/usr/local/bin/agy',
    binPath: '/usr/local/bin/agy',
    version: 'Antigravity CLI 1.1.7',
    available: true,
    sdkBackend: 'antigravity',
  }];

  const next = applyDiscoveredUpdatesToExternalAgents(agents, discovered);

  assert.equal(next[0].available, true);
  assert.equal(next[0].command, '/usr/local/bin/agy');
  assert.equal(next[0].apiKey, undefined);
  assert.equal(next[0].cliVersion, 'Antigravity CLI 1.1.7');
});

test('applyDiscoveredUpdatesToExternalAgents disables a legacy Antigravity runtime without discovery', () => {
  const agents: ExternalAgentConfig[] = [{
    id: 'discovered_antigravity',
    name: 'Google Antigravity',
    command: 'python3',
    args: [],
    icon: 'gemini',
    enabled: true,
    available: true,
    commandSource: 'auto',
  }];

  const next = applyDiscoveredUpdatesToExternalAgents(agents, []);

  assert.equal(next[0].apiKey, undefined);
  assert.equal(next[0].command, 'python3');
  assert.equal(next[0].available, false);
});

test('applyDiscoveredUpdatesToExternalAgents disables the legacy Windows Python launcher', () => {
  const agents: ExternalAgentConfig[] = [{
    id: 'discovered_antigravity',
    name: 'Google Antigravity',
    command: 'C:\\Windows\\py.exe',
    args: [],
    icon: 'gemini',
    enabled: true,
    available: true,
    sdkBackend: 'antigravity',
  }];

  const next = applyDiscoveredUpdatesToExternalAgents(agents, []);

  assert.equal(next[0].command, 'C:\\Windows\\py.exe');
  assert.equal(next[0].available, false);
});

test('applyDiscoveredUpdatesToExternalAgents keeps manual Antigravity paths', () => {
  const agents: ExternalAgentConfig[] = [{
    id: 'discovered_antigravity',
    name: 'Google Antigravity',
    command: '/custom/python',
    args: [],
    icon: 'gemini',
    enabled: true,
    available: true,
    sdkBackend: 'antigravity',
    commandSource: 'manual',
    cliVersion: 'custom-probe',
  }];
  const discovered: DiscoveredAgent[] = [{
    command: 'antigravity',
    name: 'Google Antigravity',
    icon: 'gemini',
    description: 'Google Antigravity via the official Agy CLI',
    args: [],
    path: '/usr/local/bin/agy',
    binPath: '/usr/local/bin/agy',
    version: 'Antigravity CLI 1.1.7',
    available: true,
    sdkBackend: 'antigravity',
  }];

  const next = applyDiscoveredUpdatesToExternalAgents(agents, discovered);

  assert.equal(next[0].available, false);
  assert.equal(next[0].command, '/custom/python');
  assert.equal(next[0].apiKey, undefined);
  assert.equal(next[0].cliVersion, 'custom-probe');
});

test('applyDiscoveredUpdatesToExternalAgents recovers manual path when discovery matches it', () => {
  const agents: ExternalAgentConfig[] = [{
    id: 'discovered_antigravity',
    name: 'Google Antigravity',
    command: '/custom/agy',
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
    description: 'Google Antigravity via the official Agy CLI',
    args: [],
    path: '/custom/agy',
    binPath: '/custom/agy',
    version: 'Antigravity CLI 1.1.7',
    available: true,
    sdkBackend: 'antigravity',
  }];

  const next = applyDiscoveredUpdatesToExternalAgents(agents, discovered);

  assert.equal(next[0].available, true);
  assert.equal(next[0].command, '/custom/agy');
  assert.equal(next[0].apiKey, undefined);
  assert.equal(next[0].cliVersion, 'Antigravity CLI 1.1.7');
});

test('applyDiscoveredUpdatesToExternalAgents preserves legacy manual executable paths', () => {
  const cases: Array<{
    agent: ExternalAgentConfig;
    discovered: DiscoveredAgent;
    envKey?: string;
  }> = [
    {
      agent: {
        id: 'discovered_claude',
        name: 'Claude Code',
        command: '/custom/bin/claude',
        args: [],
        icon: 'claude',
        enabled: true,
        available: true,
        sdkBackend: 'claude',
        cliVersion: 'custom-version',
        env: { CLAUDE_CODE_EXECUTABLE: '/custom/bin/claude' },
      },
      discovered: {
        command: 'claude',
        name: 'Claude Code',
        icon: 'claude',
        description: 'Claude Code',
        args: [],
        path: '/usr/bin/claude',
        binPath: '/usr/bin/claude',
        version: 'system-version',
        available: true,
        sdkBackend: 'claude',
      },
      envKey: 'CLAUDE_CODE_EXECUTABLE',
    },
    {
      agent: {
        id: 'discovered_opencode',
        name: 'OpenCode',
        command: '/custom/bin/opencode',
        args: [],
        icon: 'opencode',
        enabled: true,
        available: true,
        sdkBackend: 'opencode',
        cliVersion: 'custom-version',
        env: { OPENCODE_BIN: '/custom/bin/opencode' },
      },
      discovered: {
        command: 'opencode',
        name: 'OpenCode',
        icon: 'opencode',
        description: 'OpenCode',
        args: [],
        path: '/usr/bin/opencode',
        binPath: '/usr/bin/opencode',
        version: 'system-version',
        available: true,
        sdkBackend: 'opencode',
      },
      envKey: 'OPENCODE_BIN',
    },
    {
      agent: {
        id: 'discovered_antigravity',
        name: 'Google Antigravity',
        command: '/custom/bin/google-agent',
        args: [],
        icon: 'gemini',
        enabled: true,
        available: false,
        sdkBackend: 'antigravity',
        cliVersion: 'custom-version',
      },
      discovered: {
        command: 'antigravity',
        name: 'Google Antigravity',
        icon: 'gemini',
        description: 'Google Antigravity via the official Agy CLI',
        args: [],
        path: '/usr/bin/agy',
        binPath: '/usr/bin/agy',
        version: 'system-version',
        available: true,
        sdkBackend: 'antigravity',
      },
    },
  ];

  for (const { agent, discovered, envKey } of cases) {
    const next = applyDiscoveredUpdatesToExternalAgents([agent], [discovered]);
    assert.equal(next[0].command, agent.command);
    assert.equal(next[0].cliVersion, 'custom-version');
    assert.equal(next[0].available, agent.available);
    if (envKey) assert.equal(next[0].env?.[envKey], agent.command);
  }
});
