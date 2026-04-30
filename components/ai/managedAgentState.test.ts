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
      acpCommand: 'codex-acp',
      acpArgs: [],
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
      acpCommand: 'claude-agent-acp',
      acpArgs: [],
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

test('buildManagedAgentState does not remove user-created matching agents', () => {
  const agents: ExternalAgentConfig[] = [
    {
      id: 'my-claude-wrapper',
      name: 'My Claude Wrapper',
      command: '/usr/local/bin/claude',
      enabled: true,
      acpCommand: 'claude-agent-acp',
      acpArgs: [],
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
      acpCommand: 'codex-acp',
      acpArgs: [],
    },
  ];

  const state = buildManagedAgentState(
    agents,
    'my-codex-wrapper',
    'codex',
    { path: '/opt/netcatty/codex-acp', version: 'Bundled ACP', available: true },
  );

  assert.deepEqual(
    state.agents.map((agent) => agent.id),
    ['my-codex-wrapper', 'discovered_codex'],
  );
  assert.equal(state.agents[0], agents[0]);
  assert.equal(state.defaultAgentId, 'my-codex-wrapper');
});
