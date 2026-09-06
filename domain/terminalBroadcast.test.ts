import assert from 'node:assert/strict';
import test from 'node:test';

import { resolveTerminalBroadcastTargetIds } from './terminalBroadcast.ts';
import type { TerminalSession } from './models.ts';

const session = (
  id: string,
  overrides: Pick<TerminalSession, 'workspaceId' | 'hiddenFromTabs'> = {},
): Pick<TerminalSession, 'id' | 'workspaceId' | 'hiddenFromTabs'> => ({
  id,
  ...overrides,
});

test('workspace broadcast targets only other sessions in the source workspace', () => {
  assert.deepEqual(
    resolveTerminalBroadcastTargetIds({
      sessions: [
        session('source', { workspaceId: 'workspace-1' }),
        session('peer', { workspaceId: 'workspace-1' }),
        session('other-workspace', { workspaceId: 'workspace-2' }),
        session('orphan'),
      ],
      sourceSessionId: 'source',
      globalBroadcastEnabled: true,
    }),
    ['peer'],
  );
});

test('global broadcast targets only other visible orphan sessions', () => {
  const sessions = [
    session('source'),
    session('peer'),
    session('workspace-peer', { workspaceId: 'workspace-1' }),
    session('hidden-orphan', { hiddenFromTabs: true }),
  ];

  assert.deepEqual(
    resolveTerminalBroadcastTargetIds({
      sessions,
      sourceSessionId: 'source',
      globalBroadcastEnabled: true,
    }),
    ['peer'],
  );
  assert.deepEqual(
    resolveTerminalBroadcastTargetIds({
      sessions,
      sourceSessionId: 'source',
      globalBroadcastEnabled: false,
    }),
    [],
  );
});

test('direct target IDs bypass workspace and global mode selection', () => {
  assert.deepEqual(
    resolveTerminalBroadcastTargetIds({
      sessions: [
        session('source', { workspaceId: 'workspace-1' }),
        session('peer', { workspaceId: 'workspace-1' }),
        session('direct-target'),
      ],
      sourceSessionId: 'source',
      globalBroadcastEnabled: false,
      directTargetSessionIds: ['direct-target'],
    }),
    ['direct-target'],
  );
});

test('missing or hidden global sources do not fan out', () => {
  const sessions = [session('hidden-source', { hiddenFromTabs: true }), session('peer')];
  assert.deepEqual(
    resolveTerminalBroadcastTargetIds({
      sessions,
      sourceSessionId: 'missing',
      globalBroadcastEnabled: true,
    }),
    [],
  );
  assert.deepEqual(
    resolveTerminalBroadcastTargetIds({
      sessions,
      sourceSessionId: 'hidden-source',
      globalBroadcastEnabled: true,
    }),
    [],
  );
});
