import assert from 'node:assert/strict';
import test from 'node:test';

import {
  retainStableSessionsIgnoringPresentation,
  terminalPaneSessionsEqual,
} from './terminalPaneSessionsEqual.ts';
import type { TerminalSession } from './models.ts';

const session = (overrides: Partial<TerminalSession> = {}): TerminalSession => ({
  id: 's1',
  hostId: 'h1',
  hostLabel: 'example',
  status: 'connected',
  hostname: 'example.test',
  username: 'root',
  port: 22,
  protocol: 'ssh',
  ...overrides,
});

test('terminalPaneSessionsEqual ignores dynamicTitle and codingCliProviderId', () => {
  const prev = [session({ dynamicTitle: 'old', codingCliProviderId: 'claude' })];
  const next = [session({ dynamicTitle: 'new', codingCliProviderId: 'codex' })];
  assert.equal(terminalPaneSessionsEqual(prev, next), true);
});

test('terminalPaneSessionsEqual ignores promptHostname presentation updates', () => {
  const prev = [session({ promptHostname: 'jumpserver.example.com' })];
  const next = [session({ promptHostname: '10.1.64.1' })];
  assert.equal(terminalPaneSessionsEqual(prev, next), true);
  assert.equal(retainStableSessionsIgnoringPresentation(prev, next), prev);
});

test('terminalPaneSessionsEqual detects status and fontSize changes', () => {
  const base = session();
  assert.equal(
    terminalPaneSessionsEqual([base], [session({ status: 'disconnected' })]),
    false,
  );
  assert.equal(
    terminalPaneSessionsEqual([base], [session({ fontSize: 18 })]),
    false,
  );
});

test('terminalPaneSessionsEqual detects workspace membership changes', () => {
  const base = session();
  assert.equal(
    terminalPaneSessionsEqual([base], [session({ workspaceId: 'ws-1' })]),
    false,
  );
});

test('terminalPaneSessionsEqual detects pendingInitialCwd clear and startupCommand changes', () => {
  const withSeed = session({ pendingInitialCwd: '/home/seed' });
  assert.equal(
    terminalPaneSessionsEqual([withSeed], [session({ pendingInitialCwd: undefined })]),
    false,
  );
  assert.equal(
    terminalPaneSessionsEqual(
      [session({ startupCommand: 'htop' })],
      [session({ startupCommand: 'top' })],
    ),
    false,
  );
});

test('retainStableSessionsIgnoringPresentation keeps prior identity for title-only churn', () => {
  const prev = [session({ dynamicTitle: 'old' })];
  const next = [session({ dynamicTitle: 'new', codingCliProviderId: 'claude' })];
  assert.equal(retainStableSessionsIgnoringPresentation(prev, next), prev);
  assert.notEqual(
    retainStableSessionsIgnoringPresentation(prev, [session({ status: 'connecting' })]),
    prev,
  );
});
