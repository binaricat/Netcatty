import test from 'node:test';
import assert from 'node:assert/strict';
import { matchesManagedAgentConfig } from './managedAgents';

test('managed Claude matching ignores claude-agent-acp command-only configs', () => {
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

test('managed Claude matching ignores claude-agent-acp adapter configs', () => {
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
