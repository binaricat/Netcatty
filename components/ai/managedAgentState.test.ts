import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildManagedAgentState,
  getInitialManagedAgentPaths,
  updateCodebuddyManagedEnv,
} from '../settings/tabs/ai/managedAgentState';
import type { ExternalAgentConfig } from '../../infrastructure/ai/types';

test('buildManagedAgentState removes stale managed agents when path detection fails', () => {
  const agents: ExternalAgentConfig[] = [
    {
      id: 'discovered_codex',
      name: 'Codex CLI',
      command: '/usr/local/bin/codex',
      enabled: true,
      sdkBackend: 'codex',
    },
    {
      id: 'custom-agent',
      name: 'Custom Agent',
      command: '/usr/local/bin/custom-agent',
      enabled: true,
    },
  ];

  const state = buildManagedAgentState(
    agents,
    'discovered_codex',
    'codex',
    { path: '/usr/local/bin/codex', version: null, available: false },
  );

  assert.deepEqual(
    state.agents.map((agent) => agent.id),
    ['custom-agent'],
  );
  assert.equal(state.defaultAgentId, 'catty');
});

test('buildManagedAgentState keeps unrelated defaults when removing stale managed agents', () => {
  const agents: ExternalAgentConfig[] = [
    {
      id: 'discovered_claude',
      name: 'Claude Code',
      command: '/usr/local/bin/claude',
      enabled: true,
      sdkBackend: 'claude',
    },
    {
      id: 'custom-agent',
      name: 'Custom Agent',
      command: '/usr/local/bin/custom-agent',
      enabled: true,
    },
  ];

  const state = buildManagedAgentState(
    agents,
    'custom-agent',
    'claude',
    { path: '/usr/local/bin/claude', version: null, available: false },
  );

  assert.deepEqual(
    state.agents.map((agent) => agent.id),
    ['custom-agent'],
  );
  assert.equal(state.defaultAgentId, 'custom-agent');
});

test('buildManagedAgentState stores the system Claude executable for SDK runs', () => {
  const state = buildManagedAgentState(
    [],
    'catty',
    'claude',
    { path: '/opt/homebrew/bin/claude', version: '2.1.145 (Claude Code)', available: true },
  );

  assert.equal(state.agents.length, 1);
  assert.equal(state.agents[0].command, '/opt/homebrew/bin/claude');
  assert.equal(state.agents[0].sdkBackend, 'claude');
  assert.deepEqual(state.agents[0].env, {
    CLAUDE_CODE_EXECUTABLE: '/opt/homebrew/bin/claude',
  });
});

test('buildManagedAgentState stores SDK backend keys for discovered managed agents', () => {
  const codexState = buildManagedAgentState(
    [],
    'catty',
    'codex',
    { path: '/opt/homebrew/bin/codex', version: '1.0.0', available: true },
  );
  const copilotState = buildManagedAgentState(
    [],
    'catty',
    'copilot',
    { path: '/opt/homebrew/bin/copilot', version: '1.0.0', available: true },
  );

  assert.equal(codexState.agents[0].sdkBackend, 'codex');
  assert.equal(copilotState.agents[0].sdkBackend, 'copilot');
  assert.equal(copilotState.agents[0].acpArgs, undefined);
});

test('getInitialManagedAgentPaths ignores auto-detected command paths', () => {
  const state = buildManagedAgentState(
    [],
    'catty',
    'codex',
    { path: '/opt/homebrew/bin/codex', version: '1.0.0', available: true },
    'auto',
  );

  assert.equal(state.agents[0].commandSource, 'auto');
  assert.equal(getInitialManagedAgentPaths(state.agents).codex, '');
});

test('getInitialManagedAgentPaths keeps manual and legacy command paths', () => {
  const manualState = buildManagedAgentState(
    [],
    'catty',
    'codex',
    { path: '/opt/homebrew/bin/codex', version: '1.0.0', available: true },
    'manual',
  );

  assert.equal(getInitialManagedAgentPaths(manualState.agents).codex, '/opt/homebrew/bin/codex');
  assert.equal(getInitialManagedAgentPaths([{
    id: 'discovered_codex',
    name: 'Codex CLI',
    command: '/legacy/bin/codex',
    enabled: true,
    available: true,
    sdkBackend: 'codex',
  }]).codex, '/legacy/bin/codex');
});

test('buildManagedAgentState stores SDK backend key for discovered Cursor', () => {
  const state = buildManagedAgentState(
    [],
    'catty',
    'cursor',
    { path: 'cursor', version: 'Cursor SDK 1.0.18', available: true },
  );

  assert.equal(state.agents[0].id, 'discovered_cursor');
  assert.equal(state.agents[0].name, 'Cursor');
  assert.equal(state.agents[0].command, 'cursor');
  assert.equal(state.agents[0].sdkBackend, 'cursor');
});

test('buildManagedAgentState preserves a saved Cursor API key when SDK is not ready', () => {
  const agents: ExternalAgentConfig[] = [
    {
      id: 'discovered_cursor',
      name: 'Cursor',
      command: 'cursor',
      enabled: true,
      available: true,
      sdkBackend: 'cursor',
      apiKey: 'enc:v1:test',
    },
  ];

  const state = buildManagedAgentState(
    agents,
    'discovered_cursor',
    'cursor',
    { path: 'cursor', version: 'Cursor SDK', available: false, installed: true },
  );

  assert.equal(state.agents[0].id, 'discovered_cursor');
  assert.equal(state.agents[0].apiKey, 'enc:v1:test');
  assert.equal(state.agents[0].enabled, false);
  assert.equal(state.agents[0].available, false);
  assert.equal(state.defaultAgentId, 'catty');
});

test('buildManagedAgentState stores CODEBUDDY_CODE_PATH for codebuddy', () => {
  const state = buildManagedAgentState(
    [],
    'catty',
    'codebuddy',
    { path: '/opt/homebrew/bin/codebuddy', version: '0.1.0', available: true },
  );

  assert.equal(state.agents.length, 1);
  assert.equal(state.agents[0].command, '/opt/homebrew/bin/codebuddy');
  assert.equal(state.agents[0].sdkBackend, 'codebuddy');
  assert.deepEqual(state.agents[0].env, {
    CODEBUDDY_CODE_PATH: '/opt/homebrew/bin/codebuddy',
  });
});

test('updateCodebuddyManagedEnv creates a disabled managed entry before CLI detection', () => {
  const state = updateCodebuddyManagedEnv([], 'internal', 'CODEBUDDY_API_KEY=secret');

  assert.equal(state.length, 1);
  assert.equal(state[0].id, 'discovered_codebuddy');
  assert.equal(state[0].command, 'codebuddy');
  assert.equal(state[0].enabled, false);
  assert.deepEqual(state[0].env, {
    CODEBUDDY_INTERNET_ENVIRONMENT: 'internal',
    CODEBUDDY_API_KEY: 'secret',
  });
});

test('buildManagedAgentState preserves disabled CodeBuddy config when path detection fails', () => {
  const agents = updateCodebuddyManagedEnv([], 'ioa', 'CODEBUDDY_AUTH_TOKEN=token');

  const state = buildManagedAgentState(
    agents,
    'discovered_codebuddy',
    'codebuddy',
    { path: null, version: null, available: false },
  );

  assert.equal(state.defaultAgentId, 'catty');
  assert.equal(state.agents.length, 1);
  assert.equal(state.agents[0].id, 'discovered_codebuddy');
  assert.equal(state.agents[0].enabled, false);
  assert.deepEqual(state.agents[0].env, {
    CODEBUDDY_INTERNET_ENVIRONMENT: 'ioa',
    CODEBUDDY_AUTH_TOKEN: 'token',
  });
});

test('buildManagedAgentState enables preconfigured CodeBuddy when path detection succeeds', () => {
  const agents = updateCodebuddyManagedEnv([], 'internal', 'CODEBUDDY_API_KEY=secret');

  const state = buildManagedAgentState(
    agents,
    'catty',
    'codebuddy',
    { path: '/opt/homebrew/bin/codebuddy', version: '0.1.0', available: true },
  );

  assert.equal(state.agents.length, 1);
  assert.equal(state.agents[0].enabled, true);
  assert.equal(state.agents[0].command, '/opt/homebrew/bin/codebuddy');
  assert.deepEqual(state.agents[0].env, {
    CODEBUDDY_INTERNET_ENVIRONMENT: 'internal',
    CODEBUDDY_API_KEY: 'secret',
    CODEBUDDY_CODE_PATH: '/opt/homebrew/bin/codebuddy',
  });
});

test('updateCodebuddyManagedEnv removes an empty pre-detection placeholder', () => {
  const agents = updateCodebuddyManagedEnv([], 'internal', 'CODEBUDDY_API_KEY=secret');
  const cleared = updateCodebuddyManagedEnv(agents, '', '');

  assert.deepEqual(cleared, []);
});

test('buildManagedAgentState does not remove user-created matching agents', () => {
  const agents: ExternalAgentConfig[] = [
    {
      id: 'my-claude-wrapper',
      name: 'My Claude Wrapper',
      command: '/usr/local/bin/claude',
      enabled: true,
      sdkBackend: 'claude',
    },
  ];

  const state = buildManagedAgentState(
    agents,
    'my-claude-wrapper',
    'claude',
    { path: '/usr/local/bin/claude', version: null, available: false },
  );

  assert.deepEqual(state.agents, agents);
  assert.equal(state.defaultAgentId, 'my-claude-wrapper');
});

test('buildManagedAgentState only rewrites settings-managed discovered agents', () => {
  const agents: ExternalAgentConfig[] = [
    {
      id: 'my-codex-wrapper',
      name: 'My Codex Wrapper',
      command: '/usr/local/bin/codex',
      enabled: true,
      sdkBackend: 'codex',
    },
  ];

  const state = buildManagedAgentState(
    agents,
    'my-codex-wrapper',
    'codex',
    { path: '/opt/netcatty/codex', version: 'Bundled legacy adapter', available: true },
  );

  assert.deepEqual(
    state.agents.map((agent) => agent.id),
    ['my-codex-wrapper', 'discovered_codex'],
  );
  assert.equal(state.agents[0], agents[0]);
  assert.equal(state.defaultAgentId, 'my-codex-wrapper');
});
