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

test('codex managed config no longer matches codex-acp acpCommand', () => {
  // Post-migration acpCommand carries the sdk backend key ('codex'), not 'codex-acp'.
  assert.equal(
    matchesManagedAgentConfig({ id: 'x', command: 'codex', acpCommand: 'codex' }, 'codex'),
    true,
  );
  assert.equal(
    matchesManagedAgentConfig({ id: 'x', command: 'other', acpCommand: 'codex-acp' }, 'codex'),
    false,
  );
});

test('claude managed config matches by sdk backend value', () => {
  assert.equal(
    matchesManagedAgentConfig({ id: 'discovered_claude', command: 'claude', acpCommand: 'claude' }, 'claude'),
    true,
  );
});
