import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildOrderedWorkTabIds,
  isHostTreeWorkTabSurface,
  isRootPageTabId,
  isTerminalContentTabSurface,
  reorderWorkTabIds,
  resolveWorkTabActiveHostId,
  resolveWorkTabHostTreeTheme,
} from './workTabSurface';
import type { EditorTab } from '../state/editorTabStore';
import type { Host, TerminalSession, TerminalTheme, Workspace } from '../../types';

const makeTheme = (id: string, type: TerminalTheme['type'], background: string): TerminalTheme => ({
  id,
  name: id,
  type,
  colors: {
    background,
    foreground: type === 'dark' ? '#ffffff' : '#000000',
    cursor: '#888888',
    selection: '#555555',
    black: '#000000',
    red: '#ff0000',
    green: '#00ff00',
    yellow: '#ffff00',
    blue: '#0000ff',
    magenta: '#ff00ff',
    cyan: '#00ffff',
    white: '#ffffff',
    brightBlack: '#444444',
    brightRed: '#ff5555',
    brightGreen: '#55ff55',
    brightYellow: '#ffff55',
    brightBlue: '#5555ff',
    brightMagenta: '#ff55ff',
    brightCyan: '#55ffff',
    brightWhite: '#ffffff',
  },
});

test('work tab order keeps custom positions and appends new tabs', () => {
  assert.deepEqual(
    buildOrderedWorkTabIds(['log-1', 'session-1'], ['session-1', 'workspace-1', 'log-1', 'editor:file-1']),
    ['log-1', 'session-1', 'workspace-1', 'editor:file-1'],
  );
});

test('work tab order removes duplicate ids before rendering', () => {
  assert.deepEqual(
    buildOrderedWorkTabIds(
      ['session-2', 'session-1', 'session-2', 'session-1'],
      ['session-1', 'session-2', 'session-3', 'session-3'],
    ),
    ['session-2', 'session-1', 'session-3'],
  );
});

test('work tab order reorders with newly materialized tabs', () => {
  assert.deepEqual(
    reorderWorkTabIds(
      ['session-1', 'session-2', 'session-3'],
      ['session-1', 'session-2', 'session-3'],
      'session-1',
      'session-3',
      'after',
    ),
    ['session-2', 'session-3', 'session-1'],
  );
});

test('root pages are not work tab surfaces', () => {
  assert.equal(isRootPageTabId('vault'), true);
  assert.equal(isRootPageTabId('sftp'), true);
  assert.equal(isRootPageTabId('session-1'), false);
});

test('shared host tree is visible for editor, log, session, and workspace tabs', () => {
  const sessionIds = new Set(['session-1']);
  const workspaceIds = new Set(['workspace-1']);
  const logViewIds = new Set(['log-1']);
  const orderedTabs = ['session-1', 'workspace-1', 'editor:file-1', 'log-1'];

  for (const activeTabId of orderedTabs) {
    assert.equal(isHostTreeWorkTabSurface({
      enabled: true,
      activeTabId,
      logViewIds,
      orderedTabs,
      sessionIds,
      workspaceIds,
    }), true);
  }
});

test('shared host tree recognizes active log view before tab ordering catches up', () => {
  assert.equal(isHostTreeWorkTabSurface({
    enabled: true,
    activeTabId: 'log-1',
    logViewIds: new Set(['log-1']),
    orderedTabs: [],
    sessionIds: new Set(),
    workspaceIds: new Set(),
  }), true);
});

test('terminal content surface is limited to sessions and workspaces', () => {
  const sessionIds = new Set(['session-1']);
  const workspaceIds = new Set(['workspace-1']);

  assert.equal(isTerminalContentTabSurface({ activeTabId: 'session-1', sessionIds, workspaceIds }), true);
  assert.equal(isTerminalContentTabSurface({ activeTabId: 'workspace-1', sessionIds, workspaceIds }), true);
  assert.equal(isTerminalContentTabSurface({ activeTabId: 'editor:file-1', sessionIds, workspaceIds }), false);
  assert.equal(isTerminalContentTabSurface({ activeTabId: 'log-1', sessionIds, workspaceIds }), false);
});

test('shared host tree resolves active host ids across work tab types', () => {
  const sessions = [
    { id: 'session-1', hostId: 'host-1' },
    { id: 'session-2', hostId: 'host-2', workspaceId: 'workspace-1' },
  ] as TerminalSession[];
  const workspaces = [{
    id: 'workspace-1',
    focusedSessionId: 'session-2',
    root: { id: 'pane-2', type: 'pane', sessionId: 'session-2' },
  }] as Workspace[];
  const editorTabs = [
    { id: 'file-1', hostId: 'host-3' },
  ] as EditorTab[];

  assert.equal(resolveWorkTabActiveHostId({ activeTabId: 'session-1', sessions, workspaces, editorTabs }), 'host-1');
  assert.equal(resolveWorkTabActiveHostId({ activeTabId: 'workspace-1', sessions, workspaces, editorTabs }), 'host-2');
  assert.equal(resolveWorkTabActiveHostId({ activeTabId: 'editor:file-1', sessions, workspaces, editorTabs }), 'host-3');
  assert.equal(resolveWorkTabActiveHostId({ activeTabId: 'log-1', sessions, workspaces, editorTabs }), null);
});

test('shared host tree falls back to the first workspace session when focused session is missing', () => {
  const sessions = [
    { id: 'session-1', hostId: 'host-1', workspaceId: 'workspace-1' },
    { id: 'session-2', hostId: 'host-2', workspaceId: 'workspace-1' },
  ] as TerminalSession[];
  const workspaces = [{
    id: 'workspace-1',
    focusedSessionId: 'missing-session',
    root: {
      id: 'split-1',
      type: 'split',
      direction: 'horizontal',
      children: [
        { id: 'pane-1', type: 'pane', sessionId: 'session-1' },
        { id: 'pane-2', type: 'pane', sessionId: 'session-2' },
      ],
      sizes: [0.5, 0.5],
    },
  }] as Workspace[];

  assert.equal(resolveWorkTabActiveHostId({
    activeTabId: 'workspace-1',
    sessions,
    workspaces,
    editorTabs: [],
  }), 'host-1');
});

test('shared host tree fallback prefers workspace tree order over sessions array order', () => {
  const sessions = [
    { id: 'session-2', hostId: 'host-2', workspaceId: 'workspace-1' },
    { id: 'session-1', hostId: 'host-1', workspaceId: 'workspace-1' },
  ] as TerminalSession[];
  const workspaces = [{
    id: 'workspace-1',
    focusedSessionId: 'missing-session',
    root: {
      id: 'split-1',
      type: 'split',
      direction: 'horizontal',
      children: [
        { id: 'pane-1', type: 'pane', sessionId: 'session-1' },
        { id: 'pane-2', type: 'pane', sessionId: 'session-2' },
      ],
      sizes: [0.5, 0.5],
    },
  }] as Workspace[];

  assert.equal(resolveWorkTabActiveHostId({
    activeTabId: 'workspace-1',
    sessions,
    workspaces,
    editorTabs: [],
  }), 'host-1');
});

test('shared host tree uses the active host theme when follow-app terminal theme is off', () => {
  const currentTheme = makeTheme('app-dark', 'dark', '#111111');
  const hostTheme = makeTheme('host-light', 'light', '#fafafa');
  const host = {
    id: 'host-1',
    label: 'Host',
    hostname: 'host.local',
    username: 'root',
    tags: [],
    os: 'linux',
    theme: hostTheme.id,
    themeOverride: true,
  } as Host;

  const resolved = resolveWorkTabHostTreeTheme({
    activeHostId: host.id,
    accentMode: 'theme',
    currentTerminalTheme: currentTheme,
    customAccent: '#8b5cf6',
    followAppTerminalTheme: false,
    hostById: new Map([[host.id, host]]),
    themeById: new Map([[currentTheme.id, currentTheme], [hostTheme.id, hostTheme]]),
  });

  assert.equal(resolved.id, hostTheme.id);
});

test('shared host tree uses the followed terminal theme when follow-app terminal theme is on', () => {
  const currentTheme = makeTheme('app-light', 'light', '#ffffff');
  const hostTheme = makeTheme('host-dark', 'dark', '#050505');
  const host = {
    id: 'host-1',
    label: 'Host',
    hostname: 'host.local',
    username: 'root',
    tags: [],
    os: 'linux',
    theme: hostTheme.id,
    themeOverride: true,
  } as Host;

  const resolved = resolveWorkTabHostTreeTheme({
    activeHostId: host.id,
    accentMode: 'theme',
    currentTerminalTheme: currentTheme,
    customAccent: '#8b5cf6',
    followAppTerminalTheme: true,
    hostById: new Map([[host.id, host]]),
    themeById: new Map([[currentTheme.id, currentTheme], [hostTheme.id, hostTheme]]),
  });

  assert.equal(resolved.id, currentTheme.id);
});

test('shared host tree falls back to the current terminal theme without an active host', () => {
  const currentTheme = makeTheme('app-dark', 'dark', '#111111');

  const resolved = resolveWorkTabHostTreeTheme({
    activeHostId: null,
    accentMode: 'theme',
    currentTerminalTheme: currentTheme,
    customAccent: '#8b5cf6',
    followAppTerminalTheme: false,
    hostById: new Map(),
    themeById: new Map([[currentTheme.id, currentTheme]]),
  });

  assert.equal(resolved.id, currentTheme.id);
});
