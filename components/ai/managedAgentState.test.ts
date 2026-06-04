import test from 'node:test';
import assert from 'node:assert/strict';

import { buildManagedAgentState } from '../settings/tabs/ai/managedAgentState';
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
