import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { publishTerminalCommandCompletion } from '../terminalCommandCompletion';
import { useSftpCommandRefresh } from './useSftpCommandRefresh';

const environment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
const previous = environment.IS_REACT_ACT_ENVIRONMENT;
environment.IS_REACT_ACT_ENVIRONMENT = true;
after(() => { environment.IS_REACT_ACT_ENVIRONMENT = previous; });

test('completion refresh is coalesced, visible, idle and bound to its original pane', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let count = 0;
  let options = {
    sessionId: 'terminal-1', enabled: true, visible: true, busy: false,
    matchesTerminal: true, paneId: 'pane-1', connectionId: 'connection-1',
    path: '/browsed', connected: true, refresh: async () => { count += 1; },
  };
  function Probe() { useSftpCommandRefresh(options); return null; }
  let renderer: ReactTestRenderer;
  await act(async () => { renderer = create(React.createElement(Probe)); });
  const update = async (patch: Partial<typeof options>) => {
    options = { ...options, ...patch };
    await act(async () => { renderer.update(React.createElement(Probe)); });
  };
  const finish = async () => { await act(async () => { t.mock.timers.tick(250); }); };
  publishTerminalCommandCompletion('another-terminal');
  await finish();
  assert.equal(count, 0);
  publishTerminalCommandCompletion('terminal-1');
  publishTerminalCommandCompletion('terminal-1');
  await finish();
  assert.equal(count, 1);
  for (const patch of [{ enabled: false }, { visible: false }, { connected: false }, { matchesTerminal: false }]) {
    await update(patch);
    publishTerminalCommandCompletion('terminal-1');
    await finish();
    assert.equal(count, 1);
    await update({ enabled: true, visible: true, busy: false, connected: true, matchesTerminal: true });
  }
  await update({ busy: true });
  publishTerminalCommandCompletion('terminal-1');
  await finish();
  assert.equal(count, 1);
  await update({ busy: false });
  await finish();
  assert.equal(count, 2);
  for (const patch of [{ path: '/new' }, { paneId: 'pane-2' }, { connectionId: 'connection-2' }, { sessionId: 'terminal-2' }]) {
    publishTerminalCommandCompletion(options.sessionId);
    await update(patch);
    await finish();
    assert.equal(count, 2);
  }
  publishTerminalCommandCompletion(options.sessionId);
  await act(async () => { renderer.unmount(); });
  await finish();
  assert.equal(count, 2);
});
