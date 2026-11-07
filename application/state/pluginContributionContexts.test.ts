import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildTerminalPluginContributionContext,
  resolveActivePluginKeybindingContext,
} from './pluginContributionContexts.ts';
import type { TerminalSession, Workspace } from '../../types.ts';

const sessions: TerminalSession[] = [
  {
    id: 'session-1',
    hostId: 'host-1',
    hostLabel: 'Host 1',
    username: 'root',
    hostname: 'example.com',
    status: 'connected',
    protocol: 'ssh',
    workspaceId: 'workspace-1',
  },
  {
    id: 'session-2',
    hostId: 'local-2',
    hostLabel: 'Local',
    username: '',
    hostname: 'localhost',
    status: 'disconnected',
    protocol: 'local',
  },
];

const workspaces: Workspace[] = [{
  id: 'workspace-1',
  title: 'Workspace',
  root: { id: 'pane-1', type: 'pane', sessionId: 'session-1' },
}];

test('builds a resource-bearing terminal command context', () => {
  assert.deepEqual(buildTerminalPluginContributionContext({
    surface: 'terminal/context',
    sessionId: 'session-1',
    status: 'connected',
    hostId: 'host-1',
    hostProtocol: 'ssh',
    workspaceId: 'workspace-1',
    hasSelection: true,
    alternateScreen: false,
    reconnectable: false,
  }), {
    'netcatty.surface': 'terminal/context',
    'terminal.sessionId': 'session-1',
    'terminal.status': 'connected',
    'host.id': 'host-1',
    'host.protocol': 'ssh',
    'workspace.id': 'workspace-1',
    'terminal.hasSelection': true,
    'terminal.alternateScreen': false,
    'terminal.reconnectable': false,
  });
});

test('resolves the focused workspace session for global keybindings', () => {
  assert.deepEqual(resolveActivePluginKeybindingContext({
    activeTabId: 'workspace-1',
    sessions,
    workspaces,
  }), {
    'netcatty.surface': 'keybinding',
    'terminal.sessionId': 'session-1',
    'terminal.status': 'connected',
    'host.id': 'host-1',
    'host.protocol': 'ssh',
    'workspace.id': 'workspace-1',
    'netcatty.activeTabId': 'workspace-1',
  });
});

test('uses the anchor chat owner when focus is missing (#4098 phase 2)', () => {
  const splitWorkspace: Workspace = {
    id: 'workspace-1',
    title: 'Workspace',
    anchorChatId: 'chat-2',
    root: {
      id: 'split-1',
      type: 'split',
      direction: 'vertical',
      children: [
        { id: 'pane-1', type: 'pane', sessionId: 'session-1' },
        { id: 'pane-2', type: 'pane', sessionId: 'session-3' },
      ],
      sizes: [1, 1],
    },
  };
  const chatOwnerSessions: TerminalSession[] = [
    ...sessions,
    {
      id: 'session-3',
      hostId: 'host-3',
      hostLabel: 'Host 3',
      username: 'root',
      hostname: 'example.org',
      status: 'connected',
      protocol: 'ssh',
      workspaceId: 'workspace-1',
    },
  ];

  assert.equal(
    resolveActivePluginKeybindingContext({
      activeTabId: 'workspace-1',
      sessions: chatOwnerSessions,
      workspaces: [splitWorkspace],
      aiSessions: [
        { id: 'chat-2', scope: { type: 'terminal', targetId: 'session-3' }, updatedAt: 2 },
        { id: 'chat-1', scope: { type: 'terminal', targetId: 'session-1' }, updatedAt: 1 },
      ],
    })['terminal.sessionId'],
    // anchorChatId's chat is terminal-scoped to session-3, which wins even
    // though session-1's chat is older and session-1 is the first member.
    'session-3',
  );
});

test('falls back to the most-recently-active member when there is no anchor (#4098 phase 2)', () => {
  const splitWorkspace: Workspace = {
    id: 'workspace-1',
    title: 'Workspace',
    root: {
      id: 'split-1',
      type: 'split',
      direction: 'vertical',
      children: [
        { id: 'pane-1', type: 'pane', sessionId: 'session-1' },
        { id: 'pane-2', type: 'pane', sessionId: 'session-3' },
      ],
      sizes: [1, 1],
    },
  };
  const chatOwnerSessions: TerminalSession[] = [
    ...sessions,
    {
      id: 'session-3',
      hostId: 'host-3',
      hostLabel: 'Host 3',
      username: 'root',
      hostname: 'example.org',
      status: 'connected',
      protocol: 'ssh',
      workspaceId: 'workspace-1',
    },
  ];

  assert.equal(
    resolveActivePluginKeybindingContext({
      activeTabId: 'workspace-1',
      sessions: chatOwnerSessions,
      workspaces: [splitWorkspace],
      aiSessions: [
        { id: 'chat-1', scope: { type: 'terminal', targetId: 'session-1' }, updatedAt: 1 },
        { id: 'chat-2', scope: { type: 'terminal', targetId: 'session-3' }, updatedAt: 9 },
      ],
    })['terminal.sessionId'],
    'session-3',
  );
});

test('resolves standalone sessions and fails closed for non-terminal tabs', () => {
  assert.equal(
    resolveActivePluginKeybindingContext({ activeTabId: 'session-2', sessions, workspaces })['terminal.sessionId'],
    'session-2',
  );
  assert.deepEqual(resolveActivePluginKeybindingContext({
    activeTabId: 'vault',
    sessions,
    workspaces,
  }), {
    'netcatty.surface': 'keybinding',
    'netcatty.activeTabId': 'vault',
  });
});


test('empty workspace does not target the detached owner of its anchored chat', () => {
  const context = resolveActivePluginKeybindingContext({
    activeTabId: 'workspace-1',
    sessions: sessions.map((session) => ({ ...session, workspaceId: undefined })),
    workspaces: [{ ...workspaces[0], focusedSessionId: undefined, anchorChatId: 'chat-1', root: {
      id: 'empty', type: 'split', direction: 'vertical', children: [], sizes: [],
    } }],
    aiSessions: [{ id: 'chat-1', scope: { type: 'terminal', targetId: 'session-1' }, updatedAt: 1 }],
  });
  assert.equal(context['terminal.sessionId'], undefined);
  assert.equal(context['host.id'], undefined);
  assert.equal(context['workspace.id'], 'workspace-1');
});
