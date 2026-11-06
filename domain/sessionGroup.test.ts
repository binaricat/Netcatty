import assert from 'node:assert/strict';
import test from 'node:test';
import type { TerminalSession } from './models';
import { getSessionGroups, normalizeSessionGroups, resolveSessionGroupSession, selectSessionInGroup } from './sessionGroup';
import { buildSessionRestorePayload, sanitizeSessionRestorePayload } from './sessionRestore';

const session = (id: string, extra: Partial<TerminalSession> = {}): TerminalSession => ({
  id, hostId: 'host', hostLabel: 'Host', hostname: 'example.test', username: 'root', status: 'connected', ...extra,
});

test('flat groups retain their id after the original session closes and select a valid member', () => {
  const members = normalizeSessionGroups([session('second', { sessionGroupId: 'first' }), session('third', { sessionGroupId: 'first' })]);
  assert.deepEqual(getSessionGroups(members), [{ id: 'first', sessionIds: ['second', 'third'], activeSessionId: 'second' }]);
  assert.equal(resolveSessionGroupSession(selectSessionInGroup(members, 'third'), 'first')?.id, 'third');
  assert.equal(resolveSessionGroupSession(members, 'third')?.id, 'third');
});

test('workspace and hidden sessions never become group members', () => {
  const members = normalizeSessionGroups([
    session('solo'),
    session('pane', { workspaceId: 'ws', sessionGroupId: 'solo', sessionGroupFocused: true }),
    session('hidden', { hiddenFromTabs: true }),
  ]);
  assert.deepEqual(getSessionGroups(members).map(group => group.sessionIds), [['solo']]);
  assert.equal(members[1].sessionGroupId, undefined);
  assert.equal(members[1].workspaceId, 'ws');
});

test('restore preserves group identity, order and selection without creating workspaces', () => {
  const payload = buildSessionRestorePayload({
    sessions: [session('second', { sessionGroupId: 'closed-first' }), session('third', { sessionGroupId: 'closed-first', sessionGroupFocused: true })],
    workspaces: [], tabOrder: ['closed-first'], activeTabId: 'closed-first',
  });
  const restored = sanitizeSessionRestorePayload(JSON.parse(JSON.stringify(payload)));
  assert.deepEqual(restored.workspaces, []);
  assert.deepEqual(restored.tabOrder, ['closed-first']);
  assert.equal(restored.activeTabId, 'closed-first');
  assert.equal(resolveSessionGroupSession(restored.sessions, 'closed-first')?.id, 'third');
});

test('legacy workspace tabs migrate into independent groups while split workspaces remain intact', () => {
  const restored = sanitizeSessionRestorePayload({
    sessions: [session('one', { workspaceId: 'old-group' }), session('two', { workspaceId: 'old-group' }), session('pane', { workspaceId: 'split' })],
    workspaces: [
      { id: 'old-group', title: 'Host', focusLayout: 'tabs', viewMode: 'focus', focusedSessionId: 'two', focusSessionOrder: ['two', 'one'], root: { id: 'root', type: 'split', direction: 'vertical', children: [{ id: 'p1', type: 'pane', sessionId: 'one' }, { id: 'p2', type: 'pane', sessionId: 'two' }] } },
      { id: 'split', title: 'Workspace', root: { id: 'p3', type: 'pane', sessionId: 'pane' } },
    ],
    tabOrder: ['old-group', 'split'], activeTabId: 'old-group',
  });
  assert.deepEqual(restored.workspaces.map(workspace => workspace.id), ['split']);
  assert.deepEqual(restored.tabOrder, ['old-group', 'split']);
  assert.deepEqual(getSessionGroups(restored.sessions), [{ id: 'old-group', sessionIds: ['two', 'one'], activeSessionId: 'two' }]);
  assert.ok(restored.sessions.filter(member => member.sessionGroupId).every(member => !member.workspaceId));
});
