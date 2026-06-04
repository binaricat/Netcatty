import test from 'node:test';
import assert from 'node:assert/strict';
import { getExternalAgentSdkBackend, matchesManagedAgentConfig } from './managedAgents';

test('managed Claude matching ignores legacy adapter command-only configs', () => {
  assert.equal(
    matchesManagedAgentConfig(
      {
        id: 'custom-claude-adapter',
        command: 'claude-agent-acp',
        acpCommand: 'custom-acp',
      },
      'claude',
    ),
    false,
  );
});

test('managed Claude matching ignores legacy adapter configs', () => {
  assert.equal(
    matchesManagedAgentConfig(
      {
        id: 'custom-claude-adapter',
        command: 'claude-agent-acp',
        acpCommand: 'claude-agent-acp',
      },
      'claude',
    ),
    false,
  );
});

test('codex managed config no longer matches legacy adapter backend values', () => {
  assert.equal(
    matchesManagedAgentConfig({ id: 'x', command: 'codex', sdkBackend: 'codex' }, 'codex'),
    true,
  );
  assert.equal(
    matchesManagedAgentConfig({ id: 'x', command: 'other', acpCommand: 'codex-acp' }, 'codex'),
    false,
  );
});

test('claude managed config matches by sdk backend value', () => {
  assert.equal(
    matchesManagedAgentConfig({ id: 'discovered_claude', command: 'claude', sdkBackend: 'claude' }, 'claude'),
    true,
  );
});

test('legacy backend field is still accepted for saved settings', () => {
  assert.equal(
    getExternalAgentSdkBackend({ acpCommand: 'codex' }),
    'codex',
  );
});
