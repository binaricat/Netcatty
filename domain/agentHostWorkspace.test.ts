import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveAgentHostOpenWorkspace, resolveAgentHostWorkspace } from './agentHostWorkspace';

const CONTEXT = (activeTabId: string | undefined) => ({
  activeTabId,
  workspaceIds: ['ws-a', 'ws-b'],
  terminalSessions: [
    { id: 'term-in-a', workspaceId: 'ws-a' },
    { id: 'term-standalone' },
  ],
});

test('current resolves only to an existing workspace, not a terminal tab', () => {
  assert.deepEqual(resolveAgentHostWorkspace('current', 'ws-1', ['ws-1']), { workspaceId: 'ws-1' });
  assert.match(resolveAgentHostWorkspace('current', 'terminal-1', ['ws-1']).error ?? '', /workspace/i);
});

test('explicit missing workspace is rejected without standalone fallback', () => {
  assert.match(resolveAgentHostWorkspace('missing', 'ws-1', ['ws-1']).error ?? '', /workspace/i);
  assert.deepEqual(resolveAgentHostWorkspace('ws-1', 'other', ['ws-1']), { workspaceId: 'ws-1' });
  assert.deepEqual(resolveAgentHostWorkspace(undefined, 'ws-1', ['ws-1']), {});
});

test('workspace chat opens into its own workspace even when another is focused', () => {
  const chat = { scope: { type: 'workspace', targetId: 'ws-b' } };
  assert.deepEqual(
    resolveAgentHostOpenWorkspace(undefined, chat, CONTEXT('ws-a')),
    { workspaceId: 'ws-b' },
  );
  assert.deepEqual(
    resolveAgentHostOpenWorkspace('current', chat, CONTEXT('ws-a')),
    { workspaceId: 'ws-b' },
  );
});

test('terminal chat opens into the workspace containing its terminal', () => {
  const chat = { scope: { type: 'terminal', targetId: 'term-in-a' } };
  assert.deepEqual(
    resolveAgentHostOpenWorkspace(undefined, chat, CONTEXT('ws-b')),
    { workspaceId: 'ws-a' },
  );
});

test('terminal chat without a workspace and unbound chats stay standalone', () => {
  const standaloneTermChat = { scope: { type: 'terminal', targetId: 'term-standalone' } };
  assert.deepEqual(resolveAgentHostOpenWorkspace(undefined, standaloneTermChat, CONTEXT('ws-a')), {});
  assert.deepEqual(resolveAgentHostOpenWorkspace(undefined, undefined, CONTEXT('ws-a')), {});
  assert.deepEqual(
    resolveAgentHostOpenWorkspace(undefined, { scope: { type: 'global' } }, CONTEXT('ws-a')),
    {},
  );
});

test('dangling or closed chat bindings fall back instead of erroring', () => {
  assert.deepEqual(
    resolveAgentHostOpenWorkspace(
      undefined,
      { scope: { type: 'workspace', targetId: 'ws-b' }, scopeDangling: true },
      CONTEXT('ws-a'),
    ),
    {},
  );
  assert.deepEqual(
    resolveAgentHostOpenWorkspace(
      undefined,
      { scope: { type: 'workspace', targetId: 'ws-closed' } },
      CONTEXT('ws-a'),
    ),
    {},
  );
});

test('an explicit workspaceId keeps overriding the chat binding', () => {
  const chat = { scope: { type: 'workspace', targetId: 'ws-b' } };
  assert.deepEqual(
    resolveAgentHostOpenWorkspace('ws-a', chat, CONTEXT('ws-b')),
    { workspaceId: 'ws-a' },
  );
  assert.match(
    resolveAgentHostOpenWorkspace('missing', chat, CONTEXT('ws-b')).error ?? '',
    /workspace/i,
  );
});

test("unbound 'current' keeps the active-workspace meaning", () => {
  assert.deepEqual(
    resolveAgentHostOpenWorkspace('current', undefined, CONTEXT('ws-a')),
    { workspaceId: 'ws-a' },
  );
  assert.match(
    resolveAgentHostOpenWorkspace('current', undefined, CONTEXT('terminal-1')).error ?? '',
    /workspace/i,
  );
});
