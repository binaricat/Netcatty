import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import type { Host } from '../../domain/models';
import { getTerminalDirectory, observeTerminalDirectory } from './terminalDirectoryRegistry';
import { useTerminalDirectorySession } from './useTerminalDirectorySession';
import { useComposeDirectoryPicker } from './useComposeDirectoryPicker';

type SessionProps = Parameters<typeof useTerminalDirectorySession>[0];

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

function installBridge(t: TestContext, getAppInfo?: NetcattyBridge['getAppInfo']) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'window');
  let probes = 0; let lists = 0;
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { netcatty: {
    getAppInfo,
    getSessionPwd: async () => { probes++; return { success: true, cwd: '/actual' }; },
    listLocalDir: async () => { lists++; return []; },
  } } });
  t.after(() => {
    if (previous) Object.defineProperty(globalThis, 'window', previous);
    else Reflect.deleteProperty(globalThis, 'window');
  });
  return { counts: () => ({ probes, lists }) };
}

const options = (id: string, protocol = 'local', shellType = 'posix'): SessionProps => ({
  sessionId: id, status: 'connected',
  host: { id, label: 'Test', hostname: 'host', username: 'me', protocol } as Host,
  shellType, getBackendId: () => id, isReady: () => true, publish() {},
});

for (const wrapper of ['wsl-Ubuntu', 'git-bash', 'cygwin']) {
  test(`Windows ${wrapper} reports directory navigation unavailable and performs no reads`, async t => {
    const bridge = installBridge(t, async () => ({ name: 'Netcatty', version: 'test', platform: 'win32' }));
    const id = 'windows-' + wrapper;
    let model!: ReturnType<typeof useComposeDirectoryPicker>;
    function Harness() {
      const props = options(id);
      props.host = { ...props.host, localShell: wrapper };
      useTerminalDirectorySession(props);
      model = useComposeDirectoryPicker(id);
      return null;
    }
    let root!: ReactTestRenderer;
    await act(async () => { root = create(React.createElement(Harness)); });
    t.after(async () => { await act(async () => { root.unmount(); }); });
    assert.equal(getTerminalDirectory(id), null);
    assert.equal(model.available, false);
    await act(async () => { model.setOpen(true); await model.refresh(); });
    assert.equal(model.error, 'unavailable');
    assert.deepEqual(bridge.counts(), { probes: 0, lists: 0 });
  });
}

for (const platform of ['linux', 'darwin']) {
  test(`local POSIX directory controller registers on ${platform}`, async t => {
    installBridge(t, async () => ({ name: 'Netcatty', version: 'test', platform }));
    const id = 'local-' + platform;
    function Harness() { useTerminalDirectorySession(options(id)); return null; }
    let root!: ReactTestRenderer;
    await act(async () => { root = create(React.createElement(Harness)); });
    t.after(async () => { await act(async () => { root.unmount(); }); });
    assert.ok(getTerminalDirectory(id));
  });
}

test('Windows SSH sessions do not inherit the local cwd platform limitation', async t => {
  let platformQueries = 0;
  installBridge(t, async () => { platformQueries++; return { name: 'Netcatty', version: 'test', platform: 'win32' }; });
  const id = 'windows-ssh';
  function Harness() { useTerminalDirectorySession(options(id, 'ssh')); return null; }
  let root!: ReactTestRenderer;
  await act(async () => { root = create(React.createElement(Harness)); });
  t.after(async () => { await act(async () => { root.unmount(); }); });
  assert.ok(getTerminalDirectory(id));
  assert.equal(platformQueries, 0);
});

test('a late platform query cannot register a disconnected terminal', async t => {
  let finish!: (info: { name: string; version: string; platform: string }) => void;
  installBridge(t, () => new Promise(resolve => { finish = resolve; }));
  const id = 'disconnected-during-platform-query';
  const stopObserving = observeTerminalDirectory(id);
  t.after(stopObserving);
  function Harness({ status }: { status: string }) { useTerminalDirectorySession({ ...options(id), status }); return null; }
  let root!: ReactTestRenderer;
  await act(async () => { root = create(React.createElement(Harness, { status: 'connected' })); });
  await act(async () => { root.update(React.createElement(Harness, { status: 'disconnected' })); });
  await act(async () => { finish({ name: 'Netcatty', version: 'test', platform: 'linux' }); });
  assert.equal(getTerminalDirectory(id), null);
  await act(async () => { root.unmount(); });
});
