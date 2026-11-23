import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { JSDOM } from 'jsdom';
import { installBrowserLockFixture } from '../testSupport/browserLockFixture';
import { withVaultImportLock } from '../state/vaultManagedImportLock';
import { selectConnectionLogForTerminalDataCapture } from '../../domain/connectionLog';
import type { TerminalSession } from '../../domain/models';
import { createConnectionLogBuffer } from '../../components/terminal/connectionLogBuffer';
import { handleTerminalDataCaptureImpl, startRestoredSessionConnectionLogImpl } from './AppHandlers';
import { createPreloadApi } from '../../electron/preload/api.cjs';
import { finalizeSessionLogs } from '../../electron/bridges/sessionLogShutdown.cjs';

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

test('quit persists replay before acknowledgment; restored reconnect keeps the old log and starts a new one', async () => {
  const dom = new JSDOM('', { url: 'http://localhost' });
  const globals = ['window', 'localStorage', 'CustomEvent', 'navigator', 'IS_REACT_ACT_ENVIRONMENT'];
  const previous = new Map(globals.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  Object.defineProperties(globalThis, {
    window: { value: dom.window, configurable: true },
    localStorage: { value: dom.window.localStorage, configurable: true },
    CustomEvent: { value: dom.window.CustomEvent, configurable: true },
    IS_REACT_ACT_ENVIRONMENT: { value: true, configurable: true },
  });
  installBrowserLockFixture();
  const { useVaultState } = await import('../state/useVaultState');
  let vault!: ReturnType<typeof useVaultState>;
  let root: ReactTestRenderer | undefined;
  const Probe = () => { vault = useVaultState(); return null; };
  const mount = async () => {
    await act(async () => { root = create(React.createElement(Probe)); });
    for (let attempt = 0; !vault.isInitialized && attempt < 50; attempt++) {
      await act(async () => { await tick(); });
    }
    assert.equal(vault.isInitialized, true);
  };
  const session: TerminalSession = {
    id: 'restorable-tab', hostId: 'host', hostLabel: 'Host', hostname: 'host.test',
    username: 'user', protocol: 'ssh', status: 'connected',
  };
  const systemInfoRef = { current: { username: 'local-user', hostname: 'local-host' } };
  const capture = (data: string) => handleTerminalDataCaptureImpl(() => ({
    IS_DEV: false, connectionLogs: vault.connectionLogs, sessions: [session],
    selectConnectionLogForTerminalDataCapture, updateConnectionLog: vault.updateConnectionLog,
  }), session.id, data);
  try {
    await mount();
    let oldId!: string;
    await act(async () => {
      oldId = vault.addConnectionLog({
        sessionId: session.id, hostId: session.hostId, hostLabel: session.hostLabel,
        hostname: session.hostname, username: session.username, protocol: 'ssh', startTime: 1,
        localUsername: 'local-user', localHostname: 'local-host', saved: false,
      });
      // Wait for the initial catalog write before blocking the capture write.
      await vault.updateConnectionLog(oldId, {});
    });
    const buffer = createConnectionLogBuffer(10000);
    buffer.append('output before quitting\r\n');
    const ipcMain = new EventEmitter();
    const ipcRenderer = new EventEmitter() as EventEmitter & { send: (channel: string, payload: unknown) => void };
    const webContents = { send: (channel: string, payload: unknown) => ipcRenderer.emit(channel, {}, payload) };
    ipcRenderer.send = (channel, payload) => ipcMain.emit(channel, { sender: webContents }, payload);
    const api = createPreloadApi({ ipcRenderer });
    const off = api.onFinalizeSessionLogs(() => capture(buffer.toString()));
    let release!: () => void;
    const blockedWrite = withVaultImportLock('connection-logs', () => new Promise<void>((resolve) => { release = resolve; }));
    await tick();
    let acknowledged = false;
    await act(async () => {
      const quit = finalizeSessionLogs(webContents, { ipcMain }).then((success: boolean) => {
        acknowledged = true;
        assert.equal(success, true);
      });
      await tick();
      assert.equal(acknowledged, false, 'main must wait for the persistence queue');
      release();
      await blockedWrite;
      await quit;
    });
    off();
    // Remounting reads durable storage. Node has no IndexedDB, so this also
    // exercises the existing localStorage replay fallback.
    await act(async () => { root?.unmount(); });
    await mount();
    const oldLog = vault.connectionLogs.find((log) => log.id === oldId)!;
    assert.ok(oldLog.endTime);
    assert.equal(oldLog.terminalData, 'output before quitting\r\n');
    await act(async () => {
      startRestoredSessionConnectionLogImpl(() => ({ addConnectionLog: vault.addConnectionLog, systemInfoRef }), {
        ...session, status: 'disconnected', restoreState: 'restored-disconnected',
      });
    });
    const newLog = vault.connectionLogs.find((log) => log.id !== oldId)!;
    assert.equal(newLog.sessionId, session.id);
    assert.equal(newLog.endTime, undefined);
    assert.equal(newLog.terminalData, undefined);
    await act(async () => { await capture('output after reconnect\r\n'); });
    await act(async () => { root?.unmount(); });
    await mount();
    assert.equal(vault.connectionLogs.find((log) => log.id === oldId)?.terminalData, oldLog.terminalData);
    assert.equal(vault.connectionLogs.find((log) => log.id === oldId)?.endTime, oldLog.endTime);
    assert.equal(vault.connectionLogs.find((log) => log.id === newLog.id)?.terminalData, 'output after reconnect\r\n');
    assert.ok(vault.connectionLogs.find((log) => log.id === newLog.id)?.endTime);
  } finally {
    await act(async () => { root?.unmount(); });
    dom.window.close();
    for (const key of globals) {
      const descriptor = previous.get(key);
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});

test('terminal quit listener drains output and awaits capture without tearing down tabs', () => {
  const source = readFileSync(new URL('../../components/Terminal.tsx', import.meta.url), 'utf8');
  const start = source.indexOf('onFinalizeSessionLogs?.(async () => {');
  assert.ok(start > 0);
  const listener = source.slice(start, source.indexOf('const attachHomeWebContentsIdRef', start));
  assert.match(listener, /await flushPendingTerminalWritesBeforeHibernate\(term\)/);
  assert.match(listener, /await handleTerminalDataCaptureOnce\(sessionId, finalizeTerminalLogData\(\), \{ finalized: true \}\)/);
  assert.doesNotMatch(listener, /closeSession|teardown/);
  const effects = readFileSync(new URL('./AppSideEffects.tsx', import.meta.url), 'utf8');
  const handler = effects.slice(effects.indexOf('const handleSessionStatusChange ='), effects.indexOf('const handleUpdateHostFromTerminal ='));
  assert.ok(handler.indexOf('startRestoredSessionConnectionLogImpl(') < handler.indexOf('updateSessionStatus(sessionId, status)'));
  assert.match(handler, /restoredSessionLogsStartedRef\.current\.has\(sessionId\)/);
});
