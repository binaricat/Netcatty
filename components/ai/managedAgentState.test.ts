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

test('buildManagedAgentState migrates Antigravity to the official agy CLI without an API key', () => {
  const state = buildManagedAgentState(
    [{
      id: 'discovered_antigravity',
      name: 'Google Antigravity',
      command: '/old/antigravity-runtime',
      enabled: false,
      available: true,
      sdkBackend: 'antigravity',
      apiKey: 'obsolete-key',
    }],
    'catty',
    'antigravity',
    { path: '/usr/local/bin/agy', version: 'Antigravity CLI 1.1.7', available: true },
    'auto',
  );

  assert.equal(state.agents[0].command, '/usr/local/bin/agy');
  assert.equal(state.agents[0].cliVersion, 'Antigravity CLI 1.1.7');
  assert.equal(state.agents[0].enabled, false);
  assert.equal(state.agents[0].available, true);
  assert.equal(state.agents[0].apiKey, undefined);
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
  assert.equal(codexState.agents[0].cliVersion, '1.0.0');
  assert.equal(copilotState.agents[0].sdkBackend, 'copilot');
  assert.equal(copilotState.agents[0].acpArgs, undefined);
});

test('buildManagedAgentState preserves the experimental Codex runtime across path refreshes', () => {
  const state = buildManagedAgentState(
    [{
      id: 'discovered_codex',
      name: 'Codex CLI',
      command: '/old/codex',
      enabled: true,
      sdkBackend: 'codex',
      codexRuntime: 'app-server',
    }],
    'discovered_codex',
    'codex',
    { path: '/new/codex', version: '0.144.3', available: true },
  );

  assert.equal(state.agents[0].codexRuntime, 'app-server');
  assert.equal(state.agents[0].command, '/new/codex');
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

test('getInitialManagedAgentPaths drops legacy Antigravity runtimes but keeps manual agy paths', () => {
  const antigravity = (command: string): ExternalAgentConfig => ({
    id: 'discovered_antigravity',
    name: 'Google Antigravity',
    command,
    commandSource: 'manual',
    enabled: true,
    sdkBackend: 'antigravity',
  });

  assert.equal(getInitialManagedAgentPaths([antigravity('/usr/bin/python3')]).antigravity, '');
  assert.equal(getInitialManagedAgentPaths([antigravity('C:\\Windows\\py.exe')]).antigravity, '');
  assert.equal(getInitialManagedAgentPaths([antigravity('/opt/antigravity/localharness')]).antigravity, '');
  assert.equal(
    getInitialManagedAgentPaths([antigravity('/opt/tools/google-agent')]).antigravity,
    '/opt/tools/google-agent',
  );
  assert.equal(getInitialManagedAgentPaths([antigravity('/usr/local/bin/agy')]).antigravity, '/usr/local/bin/agy');
  assert.equal(getInitialManagedAgentPaths([antigravity('C:\\Tools\\agy.exe')]).antigravity, 'C:\\Tools\\agy.exe');
  assert.equal(
    getInitialManagedAgentPaths([antigravity('/Applications/Antigravity/antigravity')]).antigravity,
    '/Applications/Antigravity/antigravity',
  );
  assert.equal(
    getInitialManagedAgentPaths([antigravity('C:\\Tools\\antigravity.exe')]).antigravity,
    'C:\\Tools\\antigravity.exe',
  );
  assert.equal(
    getInitialManagedAgentPaths([antigravity('C:\\Tools\\antigravity.cmd')]).antigravity,
    'C:\\Tools\\antigravity.cmd',
  );
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
  // Keep enabled so a later mode/path that becomes available is not sticky-disabled.
  assert.equal(state.agents[0].enabled, true);
  assert.equal(state.agents[0].available, false);
  assert.equal(state.defaultAgentId, 'catty');
});

test('buildManagedAgentState preserves enabled when CLI login probe is temporarily unavailable', () => {
  const agents: ExternalAgentConfig[] = [
    {
      id: 'discovered_cursor',
      name: 'Cursor',
      command: '/bin/cursor-agent',
      enabled: true,
      available: true,
      sdkBackend: 'cursor',
      cursorAuthMode: 'cli-login',
      apiKey: 'enc:v1:test',
    },
  ];

  const unavailable = buildManagedAgentState(
    agents,
    'discovered_cursor',
    'cursor',
    {
      path: 'cursor',
      version: 'Cursor Agent CLI',
      available: false,
      installed: true,
      cliLoginOk: false,
      apiKeyOk: true,
      sdkInstalled: true,
    },
  );
  assert.equal(unavailable.agents[0].enabled, true);
  assert.equal(unavailable.agents[0].available, false);
  assert.equal(unavailable.agents[0].apiKey, 'enc:v1:test');
  assert.equal(unavailable.agents[0].cursorAuthMode, 'cli-login');

  // When CLI login returns, mode-aware available becomes true and enabled stays on.
  const recovered = buildManagedAgentState(
    unavailable.agents,
    'catty',
    'cursor',
    {
      path: '/bin/cursor-agent',
      cliBinPath: '/bin/cursor-agent',
      version: 'Cursor Agent CLI',
      available: true,
      installed: true,
      cliLoginOk: true,
      apiKeyOk: true,
      sdkInstalled: true,
      authSource: 'cli-login',
    },
  );
  assert.equal(recovered.agents[0].enabled, true);
  assert.equal(recovered.agents[0].available, true);
  assert.equal(recovered.agents[0].cursorAuthMode, 'cli-login');
  assert.equal(recovered.agents[0].command, '/bin/cursor-agent');
});

test('buildManagedAgentState keeps API key when Cursor stays on CLI login mode', () => {
  const agents: ExternalAgentConfig[] = [
    {
      id: 'discovered_cursor',
      name: 'Cursor',
      command: '/bin/cursor-agent',
      enabled: true,
      available: true,
      sdkBackend: 'cursor',
      cursorAuthMode: 'cli-login',
      apiKey: 'enc:v1:keep-me',
    },
  ];

  const state = buildManagedAgentState(
    agents,
    'discovered_cursor',
    'cursor',
    {
      path: '/bin/cursor-agent',
      cliBinPath: '/bin/cursor-agent',
      version: 'Cursor Agent CLI',
      available: true,
      installed: true,
      cliLoginOk: true,
      apiKeyOk: true,
      sdkInstalled: true,
      authSource: 'cli-login',
    },
  );

  assert.equal(state.agents[0].apiKey, 'enc:v1:keep-me');
  assert.equal(state.agents[0].cursorAuthMode, 'cli-login');
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

test('buildManagedAgentState stores OPENCODE_BIN for opencode', () => {
  const state = buildManagedAgentState(
    [],
    'catty',
    'opencode',
    { path: '/opt/homebrew/bin/opencode', version: '1.0.0', available: true },
  );

  assert.equal(state.agents.length, 1);
  assert.equal(state.agents[0].id, 'discovered_opencode');
  assert.equal(state.agents[0].command, '/opt/homebrew/bin/opencode');
  assert.equal(state.agents[0].sdkBackend, 'opencode');
  assert.deepEqual(state.agents[0].env, {
    OPENCODE_BIN: '/opt/homebrew/bin/opencode',
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
