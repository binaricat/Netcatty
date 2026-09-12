import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';

import type { TerminalTheme } from '../../domain/models.ts';
import {
  applyCurrentProviderResponse,
  isPluginTerminalProviderRefreshCurrent,
  mergePluginTerminalThemeColors,
  resolvePluginTerminalTheme,
  toPluginTerminalTheme,
  waitForProviderResponse,
} from './usePluginTerminalProviders.ts';

const baseTheme = {
  id: 'base',
  name: 'Base',
  type: 'dark',
  colors: {
    background: '#000000', foreground: '#ffffff', cursor: '#ffffff', selection: '#333333',
    black: '#000000', red: '#ff0000', green: '#00ff00', yellow: '#ffff00', blue: '#0000ff',
    magenta: '#ff00ff', cyan: '#00ffff', white: '#ffffff', brightBlack: '#777777',
    brightRed: '#ff7777', brightGreen: '#77ff77', brightYellow: '#ffff77', brightBlue: '#7777ff',
    brightMagenta: '#ff77ff', brightCyan: '#77ffff', brightWhite: '#ffffff',
  },
} as const satisfies TerminalTheme;

test('theme provider requests keep the existing palette contract with intense color enabled or disabled', () => {
  for (const foregroundIntense of ['#ff8800', undefined]) {
    const theme = { ...baseTheme, colors: { ...baseTheme.colors, foregroundIntense } };
    assert.deepEqual(toPluginTerminalTheme(theme), { type: baseTheme.type, colors: baseTheme.colors });
    assert.equal(theme.colors.foregroundIntense, foregroundIntense);
    assert.equal(resolvePluginTerminalTheme(theme, { background: '#112233' }).colors.foregroundIntense, foregroundIntense);
  }
});

test('terminal theme Providers merge deterministically over the host theme', () => {
  const merged = mergePluginTerminalThemeColors([
    { background: '#102030', cursor: '#abcdef' },
    { background: '#ffffff', foreground: '#f0f0f0' },
  ]);
  assert.deepEqual(merged, {
    background: '#102030',
    cursor: '#abcdef',
    foreground: '#f0f0f0',
  });
  assert.deepEqual(resolvePluginTerminalTheme(baseTheme, merged).colors, {
    ...baseTheme.colors,
    ...merged,
  });
  assert.equal(resolvePluginTerminalTheme(baseTheme, {}).id, baseTheme.id);
});

test('terminal components delegate Provider state to the application hook', () => {
  const terminal = fs.readFileSync(new URL('../../components/Terminal.tsx', import.meta.url), 'utf8');
  const effects = fs.readFileSync(new URL('../../components/terminal/useTerminalEffects.ts', import.meta.url), 'utf8');
  assert.match(terminal, /usePluginTerminalProviders\(/);
  assert.doesNotMatch(terminal, /getWindowPluginTerminalProviderRegistry|PluginTerminalProviderAvailability/);
  assert.doesNotMatch(effects, /getWindowPluginTerminalProviderRegistry|PluginTerminalProviderAvailability/);
});

test('application-owned Provider timeout aborts and returns a stale response', async () => {
  const controller = new AbortController();
  const result = await waitForProviderResponse(new Promise(() => {}), controller, 1);
  assert.equal(controller.signal.aborted, true);
  assert.deepEqual(result, { requestId: '', stale: true, results: [] });
});

test('a deferred Provider response cannot update state after the live session disconnects', async () => {
  let resolveResponse!: (value: { requestId: string; stale: boolean; results: [] }) => void;
  const response = new Promise<{ requestId: string; stale: boolean; results: [] }>((resolve) => {
    resolveResponse = resolve;
  });
  const initial = {
    sessionId: 'session-a',
    hostId: 'host-a',
    workspaceId: 'workspace-a',
    protocol: 'ssh',
    status: 'connected',
    shellType: 'posix',
    baseTheme,
  } as const;
  let current = { ...initial } as Parameters<typeof isPluginTerminalProviderRefreshCurrent>[1];
  let applied = false;
  const pending = applyCurrentProviderResponse(
    response,
    () => isPluginTerminalProviderRefreshCurrent(initial, current),
    () => { applied = true; },
    () => { applied = true; },
  );
  current = { ...current, status: 'disconnected' };
  resolveResponse({ requestId: 'late', stale: false, results: [] });
  await pending;
  assert.equal(applied, false);
});

test('session identity and shell discovery invalidate Provider output metadata', () => {
  const initial = {
    sessionId: 'session-a',
    hostId: 'host-a',
    workspaceId: 'workspace-a',
    protocol: 'ssh',
    status: 'connected',
    shellType: undefined,
    baseTheme,
  } as const;
  assert.equal(isPluginTerminalProviderRefreshCurrent(initial, { ...initial, shellType: 'posix' }), false);
  assert.equal(isPluginTerminalProviderRefreshCurrent(initial, { ...initial, sessionId: 'session-b' }), false);
  assert.equal(isPluginTerminalProviderRefreshCurrent(initial, { ...initial, hostId: 'host-b' }), false);
  assert.equal(isPluginTerminalProviderRefreshCurrent(initial, { ...initial, workspaceId: 'workspace-b' }), false);
  assert.equal(isPluginTerminalProviderRefreshCurrent(initial, { ...initial, protocol: 'telnet' }), false);
  assert.equal(isPluginTerminalProviderRefreshCurrent(initial, initial), true);
});

test('a current stale Provider response clears the previous output', async () => {
  let cleared = false;
  await applyCurrentProviderResponse(
    Promise.resolve({ requestId: 'timeout', stale: true, results: [] }),
    () => true,
    () => assert.fail('stale response must not be applied'),
    () => { cleared = true; },
  );
  assert.equal(cleared, true);
});
