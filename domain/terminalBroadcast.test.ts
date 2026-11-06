import assert from 'node:assert/strict';
import test from 'node:test';

import {
  composeSendTargetAfterToolbarToggle,
  flipComposeSendTarget,
  resolveTerminalBroadcastTargetIds,
  shouldBroadcastDuringSensitivePrompt,
} from './terminalBroadcast.ts';
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

test('compose send target follows toolbar broadcast, then flips on its own', () => {
  assert.equal(composeSendTargetAfterToolbarToggle(true), 'all');
  assert.equal(composeSendTargetAfterToolbarToggle(false), 'active');
  assert.equal(flipComposeSendTarget('all'), 'active');
  assert.equal(flipComposeSendTarget('active'), 'all');
  // An independent flip does not rewrite the toolbar-derived default.
  assert.equal(composeSendTargetAfterToolbarToggle(true), 'all');
});

test('compose peer fan-out can reach orphan peers while toolbar broadcast is off', () => {
  const sessions = [
    session('source'),
    session('peer'),
    session('hidden-orphan', { hiddenFromTabs: true }),
  ];
  assert.deepEqual(
    resolveTerminalBroadcastTargetIds({
      sessions,
      sourceSessionId: 'source',
      globalBroadcastEnabled: false,
      includeGlobalPeersWithoutToolbar: true,
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
  assert.deepEqual(
    resolveTerminalBroadcastTargetIds({
      sessions: [session('hidden-source', { hiddenFromTabs: true }), session('peer')],
      sourceSessionId: 'hidden-source',
      globalBroadcastEnabled: false,
      includeGlobalPeersWithoutToolbar: true,
    }),
    [],
  );
});

test('sensitive prompts pause broadcasting unless the password bypass is on', () => {
  assert.equal(
    shouldBroadcastDuringSensitivePrompt({
      sensitivePromptActive: false,
      broadcastPasswordBypass: false,
    }),
    true,
  );
  assert.equal(
    shouldBroadcastDuringSensitivePrompt({
      sensitivePromptActive: true,
      broadcastPasswordBypass: false,
    }),
    false,
  );
  assert.equal(
    shouldBroadcastDuringSensitivePrompt({
      sensitivePromptActive: true,
      broadcastPasswordBypass: true,
    }),
    true,
  );
});

test('sensitive prompts stay fail-closed on every screen unless bypassed (#4107)', () => {
  for (const sensitivePromptSource of [undefined, 'heuristic', 'explicit'] as const) {
    for (const alternateScreen of [false, true]) {
      for (const sensitivePromptActive of [false, true]) {
        for (const broadcastPasswordBypass of [false, true]) {
          assert.equal(shouldBroadcastDuringSensitivePrompt({
            sensitivePromptActive,
            broadcastPasswordBypass,
            sensitivePromptSource,
            alternateScreen,
          }), !sensitivePromptActive || broadcastPasswordBypass);
        }
      }
    }
  }
});
