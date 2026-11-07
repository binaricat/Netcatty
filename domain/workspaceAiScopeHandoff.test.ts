import assert from 'node:assert/strict';
import test from 'node:test';
import { getScopedHistorySessions } from '../components/ai/scopedHistorySessions';
import { resolveDisplayedPanelView } from '../components/ai/aiPanelViewState';
import type { AISession } from '../infrastructure/ai/types';

import {
  handoffDissolvedWorkspaceAIScope,
  retargetWorkspaceActiveChatAfterMemberLoss,
  seedWorkspaceAIActiveSessionFromMembers,
} from './workspaceAiScopeHandoff.ts';

test('closing the last member keeps its inherited chat visible in the empty workspace', () => {
  const inherited: AISession = {
    id: 'chat-a', title: 'Keep this conversation', agentId: 'catty',
    scope: { type: 'terminal', targetId: 'term-a', hostIds: ['host-a'] },
    messages: [{ id: 'message-1', role: 'user', content: 'Continue this work', timestamp: 1 }],
    createdAt: 1, updatedAt: 2,
  };
  const unrelated: AISession = { ...inherited, id: 'other-chat', scope: { type: 'terminal', targetId: 'other-terminal' } };
  const result = retargetWorkspaceActiveChatAfterMemberLoss({
    activeSessionIdMap: {
      'workspace:ws-1': inherited.id, 'terminal:term-a': inherited.id,
      'terminal:other-terminal': unrelated.id,
    },
    sessions: [inherited, unrelated], workspaceId: 'ws-1',
    previousMemberTerminalIds: ['term-a'], currentMemberTerminalIds: [],
    activeTargetIds: new Set(['ws-1', 'other-terminal']),
  });
  assert.equal(result.changed, true);
  assert.deepEqual(result.sessions[0].scope, { type: 'workspace', targetId: 'ws-1', hostIds: ['host-a'] });
  assert.equal(result.sessions[0].id, inherited.id);
  assert.equal(result.sessions[0].messages, inherited.messages);
  assert.equal(result.sessions[0].updatedAt, inherited.updatedAt);
  assert.equal(result.sessions[1], unrelated);
  assert.equal(result.activeSessionIdMap['terminal:term-a'], null);
  assert.equal(result.activeSessionIdMap['workspace:ws-1'], inherited.id);
  assert.equal(result.activeSessionIdMap['terminal:other-terminal'], unrelated.id);

  // Exercise the actual panel filtering/resolution, including restored data.
  for (const sessions of [result.sessions, JSON.parse(JSON.stringify(result.sessions)) as AISession[]]) {
    const history = getScopedHistorySessions(sessions, 'workspace', 'ws-1', [], new Set(), new Set(), result.activeSessionIdMap);
    assert.ok(history.some((session) => session.id === inherited.id));
    assert.deepEqual(resolveDisplayedPanelView(
      { mode: 'session', sessionId: inherited.id }, false, history, inherited.id, 'workspace', inherited.id,
    ), { mode: 'session', sessionId: inherited.id });
    assert.deepEqual(resolveDisplayedPanelView(
      { mode: 'draft' }, true, history, inherited.id, 'workspace', inherited.id,
    ), { mode: 'draft' });
  }
});

test('detaching the last still-live terminal keeps its own chat and selection', () => {
  const sessions = [{ id: 'chat-a', scope: { type: 'terminal', targetId: 'term-a' }, updatedAt: 1 }];
  const activeSessionIdMap = { 'workspace:ws-1': 'chat-a', 'terminal:term-a': 'chat-a' };
  const result = retargetWorkspaceActiveChatAfterMemberLoss({
    sessions, activeSessionIdMap, workspaceId: 'ws-1',
    previousMemberTerminalIds: ['term-a'], currentMemberTerminalIds: [],
    activeTargetIds: new Set(['ws-1', 'term-a']),
  });
  assert.equal(result.changed, false);
  assert.equal(result.sessions, sessions);
  assert.equal(result.activeSessionIdMap, activeSessionIdMap);
});

test('an empty workspace does not adopt unrelated or already workspace-scoped chats', () => {
  for (const scope of [
    { type: 'terminal', targetId: 'unrelated-terminal' },
    { type: 'workspace', targetId: 'ws-1' },
  ]) {
    const sessions = [{ id: 'chat-a', scope, updatedAt: 1 }];
    const activeSessionIdMap = { 'workspace:ws-1': 'chat-a', 'terminal:term-a': 'other-chat' };
    const result = retargetWorkspaceActiveChatAfterMemberLoss({
      sessions, activeSessionIdMap, workspaceId: 'ws-1',
      previousMemberTerminalIds: ['term-a'], currentMemberTerminalIds: [],
      activeTargetIds: new Set(['ws-1']),
    });
    assert.equal(result.changed, false);
    assert.equal(result.sessions, sessions);
    assert.equal(result.activeSessionIdMap, activeSessionIdMap);
  }
});

test('an empty workspace does not infer terminal closure without live-target evidence', () => {
  const sessions = [{ id: 'chat-a', scope: { type: 'terminal', targetId: 'term-a' }, updatedAt: 1 }];
  const activeSessionIdMap = { 'workspace:ws-1': 'chat-a', 'terminal:term-a': 'chat-a' };
  const result = retargetWorkspaceActiveChatAfterMemberLoss({
    sessions, activeSessionIdMap, workspaceId: 'ws-1',
    previousMemberTerminalIds: ['term-a'], currentMemberTerminalIds: [],
  });
  assert.equal(result.changed, false);
  assert.equal(result.sessions, sessions);
  assert.equal(result.activeSessionIdMap, activeSessionIdMap);
});

test('seedWorkspaceAIActiveSessionFromMembers writes focused terminal chat onto a new workspace', () => {
  const next = seedWorkspaceAIActiveSessionFromMembers({
    activeSessionIdMap: {
      'terminal:term-a': 'chat-a',
      'terminal:term-b': 'chat-b',
    },
    workspaceId: 'ws-1',
    memberTerminalIds: ['term-a', 'term-b'],
    preferredTerminalId: 'term-a',
  });

  assert.ok(next);
  assert.deepEqual(next.activeSessionIdMap, {
    'terminal:term-a': 'chat-a',
    'terminal:term-b': 'chat-b',
    'workspace:ws-1': 'chat-a',
  });
  assert.equal(next.panelViewChanged, true);
  assert.deepEqual(next.panelViewByScope['workspace:ws-1'], {
    mode: 'session',
    sessionId: 'chat-a',
  });
});

test('seedWorkspaceAIActiveSessionFromMembers leaves an existing workspace active alone', () => {
  assert.equal(
    seedWorkspaceAIActiveSessionFromMembers({
      activeSessionIdMap: {
        'workspace:ws-1': 'chat-ws',
        'terminal:term-a': 'chat-a',
      },
      workspaceId: 'ws-1',
      memberTerminalIds: ['term-a'],
      preferredTerminalId: 'term-a',
    }),
    null,
  );
});

test('handoffDissolvedWorkspaceAIScope copies active chat and remints workspace sessions', () => {
  const result = handoffDissolvedWorkspaceAIScope({
    activeSessionIdMap: {
      'workspace:ws-1': 'chat-ws',
      'terminal:term-b': 'chat-b',
    },
    sessions: [
      {
        id: 'chat-ws',
        scope: { type: 'workspace', targetId: 'ws-1', hostIds: ['host-a'] },
        updatedAt: 1,
      },
      {
        id: 'chat-b',
        scope: { type: 'terminal', targetId: 'term-b', hostIds: ['host-b'] },
        updatedAt: 1,
      },
    ],
    workspaceId: 'ws-1',
    terminalIds: ['term-a', 'term-b'],
    preferredTerminalId: 'term-a',
  });

  assert.equal(result.changed, true);
  assert.equal(result.activeSessionIdMap['terminal:term-a'], 'chat-ws');
  assert.equal(result.sessions[0]?.scope.type, 'terminal');
  assert.equal(result.sessions[0]?.scope.targetId, 'term-a');
  assert.equal(result.sessions[1]?.scope.targetId, 'term-b');
  assert.deepEqual(result.panelViewByScope['terminal:term-a'], {
    mode: 'session',
    sessionId: 'chat-ws',
  });
});

test('handoffDissolvedWorkspaceAIScope retargets inherited chat when its pane is gone', () => {
  const result = handoffDissolvedWorkspaceAIScope({
    activeSessionIdMap: {
      'workspace:ws-1': 'chat-a',
      'terminal:term-a': 'chat-a',
    },
    sessions: [
      {
        id: 'chat-a',
        scope: { type: 'terminal', targetId: 'term-a', hostIds: ['host-a'] },
        updatedAt: 1,
      },
    ],
    workspaceId: 'ws-1',
    terminalIds: ['term-b'],
    preferredTerminalId: 'term-b',
  });

  assert.equal(result.changed, true);
  assert.equal(result.activeSessionIdMap['terminal:term-b'], 'chat-a');
  assert.equal(result.activeSessionIdMap['terminal:term-a'], null);
  assert.equal(result.sessions[0]?.scope.targetId, 'term-b');
  assert.deepEqual(result.panelViewByScope['terminal:term-b'], {
    mode: 'session',
    sessionId: 'chat-a',
  });
});

test('handoffDissolvedWorkspaceAIScope keeps inherited chat on its surviving owner pane', () => {
  const result = handoffDissolvedWorkspaceAIScope({
    activeSessionIdMap: {
      'workspace:ws-1': 'chat-a',
      'terminal:term-a': 'chat-a',
      'terminal:term-b': 'chat-b',
    },
    sessions: [
      {
        id: 'chat-a',
        scope: { type: 'terminal', targetId: 'term-a', hostIds: ['host-a'] },
        updatedAt: 1,
      },
      {
        id: 'chat-b',
        scope: { type: 'terminal', targetId: 'term-b', hostIds: ['host-b'] },
        updatedAt: 1,
      },
    ],
    workspaceId: 'ws-1',
    terminalIds: ['term-a', 'term-b'],
    preferredTerminalId: 'term-b',
  });

  assert.equal(result.activeSessionIdMap['terminal:term-a'], 'chat-a');
  assert.equal(result.activeSessionIdMap['terminal:term-b'], 'chat-b');
  assert.equal(result.sessions[0]?.scope.type, 'terminal');
  assert.equal(result.sessions[0]?.scope.targetId, 'term-a');
  assert.equal(result.sessions[0]?.updatedAt, 1);
  assert.equal(result.sessions[1]?.scope.targetId, 'term-b');
  assert.deepEqual(result.panelViewByScope['terminal:term-a'], {
    mode: 'session',
    sessionId: 'chat-a',
  });
  assert.equal(result.panelViewByScope['terminal:term-b'], undefined);
});

test('handoffDissolvedWorkspaceAIScope keeps owner history when the other pane is preferred', () => {
  const result = handoffDissolvedWorkspaceAIScope({
    activeSessionIdMap: {
      'workspace:ws-1': 'chat-a',
      'terminal:term-b': 'chat-b',
    },
    sessions: [
      {
        id: 'chat-a',
        scope: { type: 'terminal', targetId: 'term-a', hostIds: ['host-a'] },
        updatedAt: 1,
      },
      {
        id: 'chat-b',
        scope: { type: 'terminal', targetId: 'term-b', hostIds: ['host-b'] },
        updatedAt: 1,
      },
    ],
    workspaceId: 'ws-1',
    terminalIds: ['term-a', 'term-b'],
    preferredTerminalId: 'term-b',
    panelViewByScope: {
      'workspace:ws-1': { mode: 'session', sessionId: 'chat-a' },
    },
  });

  assert.equal(result.changed, true);
  assert.equal(result.activeSessionIdMap['terminal:term-a'], 'chat-a');
  assert.equal(result.activeSessionIdMap['terminal:term-b'], 'chat-b');
  assert.equal(result.sessions[0]?.scope.targetId, 'term-a');
  assert.equal(result.sessions[1]?.id, 'chat-b');
  assert.equal(result.sessions[1]?.scope.targetId, 'term-b');
  assert.deepEqual(result.panelViewByScope['terminal:term-a'], {
    mode: 'session',
    sessionId: 'chat-a',
  });
});

test('handoffDissolvedWorkspaceAIScope is a no-op without a preferred terminal', () => {
  const sessions = [
    {
      id: 'chat-ws',
      scope: { type: 'workspace', targetId: 'ws-1' },
      updatedAt: 1,
    },
  ];
  const result = handoffDissolvedWorkspaceAIScope({
    activeSessionIdMap: { 'workspace:ws-1': 'chat-ws' },
    sessions,
    workspaceId: 'ws-1',
    terminalIds: [],
  });

  assert.equal(result.changed, false);
  assert.equal(result.sessions, sessions);
});

test('retargetWorkspaceActiveChatAfterMemberLoss remints chat from a closed pane', () => {
  const result = retargetWorkspaceActiveChatAfterMemberLoss({
    activeSessionIdMap: {
      'workspace:ws-1': 'chat-a',
      'terminal:term-a': 'chat-a',
    },
    sessions: [
      {
        id: 'chat-a',
        scope: { type: 'terminal', targetId: 'term-a', hostIds: ['host-a'] },
        updatedAt: 1,
      },
    ],
    workspaceId: 'ws-1',
    previousMemberTerminalIds: ['term-a', 'term-b', 'term-c'],
    currentMemberTerminalIds: ['term-b', 'term-c'],
    preferredTerminalId: 'term-b',
  });

  assert.equal(result.changed, true);
  assert.equal(result.sessions[0]?.scope.targetId, 'term-b');
  assert.equal(result.activeSessionIdMap['terminal:term-a'], null);
});

test('retarget prefers the most-recently-active survivor over the first positional member (#4098)', () => {
  // term-b is the first surviving member, but term-c owns the most recently
  // updated chat — the retarget must land there, not on sessions[0]'s owner.
  const result = retargetWorkspaceActiveChatAfterMemberLoss({
    activeSessionIdMap: {
      'workspace:ws-1': 'chat-a',
      'terminal:term-a': 'chat-a',
    },
    sessions: [
      {
        id: 'chat-a',
        scope: { type: 'terminal', targetId: 'term-a', hostIds: ['host-a'] },
        updatedAt: 1,
      },
      {
        id: 'chat-b',
        scope: { type: 'terminal', targetId: 'term-b', hostIds: ['host-b'] },
        updatedAt: 4,
      },
      {
        id: 'chat-c',
        scope: { type: 'terminal', targetId: 'term-c', hostIds: ['host-c'] },
        updatedAt: 9,
      },
    ],
    workspaceId: 'ws-1',
    previousMemberTerminalIds: ['term-a', 'term-b', 'term-c'],
    currentMemberTerminalIds: ['term-b', 'term-c'],
  });

  assert.equal(result.changed, true);
  assert.equal(result.sessions[0]?.scope.targetId, 'term-c');
  assert.equal(result.activeSessionIdMap['terminal:term-a'], null);
});

test('retargetWorkspaceActiveChatAfterMemberLoss is a no-op when active chat pane survives', () => {
  const sessions = [
    {
      id: 'chat-a',
      scope: { type: 'terminal', targetId: 'term-a', hostIds: ['host-a'] },
      updatedAt: 1,
    },
  ];
  const result = retargetWorkspaceActiveChatAfterMemberLoss({
    activeSessionIdMap: {
      'workspace:ws-1': 'chat-a',
    },
    sessions,
    workspaceId: 'ws-1',
    previousMemberTerminalIds: ['term-a', 'term-b'],
    currentMemberTerminalIds: ['term-a', 'term-b'],
    preferredTerminalId: 'term-b',
  });

  assert.equal(result.changed, false);
  assert.equal(result.sessions, sessions);
});
