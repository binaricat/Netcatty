import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import React, { useEffect, useRef } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { JSDOM } from 'jsdom';
import { installBrowserLockFixture } from '../testSupport/browserLockFixture';
import { useSessionState } from '../state/useSessionState';
import { captureClosingTerminalSessions, useTerminalSessionCloseCapture } from '../state/terminalSessionCloseCapture';
import { selectConnectionLogForTerminalDataCapture } from '../../domain/connectionLog';
import { createConnectionLogBuffer } from '../../components/terminal/connectionLogBuffer';
import { TerminalConnectionProgress } from '../../components/terminal/TerminalConnectionProgress';
import { I18nProvider } from '../i18n/I18nProvider';
import { handleTerminalDataCaptureImpl } from './AppHandlers';

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

test('explicit close persists never-connected logs; runtime remounts leave them open', async (t) => {
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
  try {
    for (const scenario of [
      { name: 'tab X before connected, empty buffer', status: 'connecting', data: '' },
      { name: 'failed-dialog close, empty buffer', status: 'disconnected', data: '' },
      { name: 'failed-dialog close preserves buffered diagnostics', status: 'disconnected', data: 'SSH diagnostic\r\n' },
      { name: 'batch close before connected', status: 'connecting', data: '', closeMode: 'batch' },
      { name: 'workspace close before connected', status: 'connecting', data: '', closeMode: 'workspace' },
    ] as const) {
      await t.test(scenario.name, async () => {
        let vault!: ReturnType<typeof useVaultState>;
        let state!: ReturnType<typeof useSessionState>;
        let root: ReactTestRenderer | undefined;
        let sessionId!: string;
        let logId!: string;
        const captures: Promise<void>[] = [];
        const capturedData: string[] = [];
        function TerminalProbe() {
          const hasConnectedRef = useRef(false);
          const terminalDataCapturedRef = useRef(false);
          const buffer = useRef(createConnectionLogBuffer(10000));
          useEffect(() => {
            buffer.current.append(scenario.data);
            return () => { buffer.current.reset(); };
          }, []);
          useTerminalSessionCloseCapture({
            sessionId, enabled: true, hasConnectedRef, terminalDataCapturedRef,
            finalizeTerminalLogData: () => buffer.current.toString(),
            onTerminalDataCapture: (id, data, options) => {
              assert.equal(options.finalized, true);
              assert.ok(state.sessions.some((session) => session.id === id), 'capture starts before removal');
              terminalDataCapturedRef.current = true;
              capturedData.push(data);
              const pending = handleTerminalDataCaptureImpl(() => ({
                IS_DEV: false, connectionLogs: vault.connectionLogs, sessions: state.sessions,
                selectConnectionLogForTerminalDataCapture, updateConnectionLog: vault.updateConnectionLog,
              }), id, data);
              captures.push(pending);
              return pending;
            },
          });
          return scenario.status === 'disconnected' ? React.createElement(
            I18nProvider, { locale: 'en' }, React.createElement(TerminalConnectionProgress, {
              status: 'disconnected', error: 'Connection refused', timeLeft: 0,
              isCancelling: false, showLogs: false, progressLogs: [],
              onCancelConnect: () => {}, onCloseSession: () => state.closeSession(sessionId),
            }),
          ) : null;
        }
        function Probe({ showTerminal = true }) {
          vault = useVaultState();
          state = useSessionState({ persistSessionRestore: false });
          return showTerminal && state.sessions.some((session) => session.id === sessionId)
            ? React.createElement(TerminalProbe) : null;
        }
        const mount = async () => {
          await act(async () => { root = create(React.createElement(Probe)); });
          for (let attempt = 0; !vault.isInitialized && attempt < 50; attempt++) {
            await act(async () => { await tick(); });
          }
          assert.equal(vault.isInitialized, true);
        };
        try {
          await mount();
          await act(async () => { sessionId = state.createLocalTerminal(); });
          await act(async () => {
            state.updateSessionStatus(sessionId, scenario.status);
            const session = state.sessions.find((candidate) => candidate.id === sessionId)!;
            logId = vault.addConnectionLog({
              sessionId, hostId: session.hostId, hostLabel: session.hostLabel,
              hostname: session.hostname, username: session.username,
              protocol: session.protocol, startTime: Date.now(),
              localUsername: 'local-user', localHostname: 'local-host', saved: false,
            });
            await vault.updateConnectionLog(logId, {});
          });
          if ('closeMode' in scenario && scenario.closeMode === 'workspace') {
            let otherId!: string;
            await act(async () => { otherId = state.createLocalTerminal(); });
            await act(async () => { state.createWorkspaceFromSessions(sessionId, otherId, 'right'); });
          }
          // Recycle the renderer while retaining the session, as with a pane
          // remount. Neither disposal nor the replacement runtime may end its log.
          await act(async () => { root!.update(React.createElement(Probe, { showTerminal: false })); });
          await act(async () => { root!.update(React.createElement(Probe)); });
          assert.equal(captures.length, 0);
          assert.equal(vault.connectionLogs.find((log) => log.id === logId)?.endTime, undefined);

          // Both UI actions converge here. This exercises the actual state
          // removal, owning-terminal hook, capture handler and vault persistence.
          await act(async () => {
            if ('closeMode' in scenario && scenario.closeMode === 'workspace') {
              state.closeWorkspace(state.workspaces[0].id);
            } else if ('closeMode' in scenario && scenario.closeMode === 'batch') {
              state.closeSessions([sessionId]);
            } else if (scenario.status === 'disconnected') {
              // Click the actual Close button rendered inside the failed dialog.
              root!.root.findByType('button').props.onClick();
            } else {
              state.closeSession(sessionId);
            }
            await Promise.all(captures);
          });
          assert.equal(state.sessions.some((session) => session.id === sessionId), false);
          assert.deepEqual(capturedData, [scenario.data]);
          await act(async () => { state.closeSession(sessionId); });
          assert.equal(captures.length, 1, 'removed runtimes must unregister their capture');
          await act(async () => { root!.unmount(); });
          root = undefined;
          await mount();
          const persisted = vault.connectionLogs.find((log) => log.id === logId)!;
          assert.ok(persisted.endTime, 'a durable endTime must exist even without terminal output');
          assert.equal(persisted.terminalData || '', scenario.data);
        } finally {
          await act(async () => { root?.unmount(); });
        }
      });
    }
  } finally {
    dom.window.close();
    for (const key of globals) {
      const descriptor = previous.get(key);
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});

test('close capture skips non-owning, already connected and already captured runtimes', async (t) => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'IS_REACT_ACT_ENVIRONMENT');
  Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { value: true, configurable: true });
  try {
    for (const scenario of [
      { name: 'attached popup / inactive restored placeholder', enabled: false, connected: false, captured: false },
      { name: 'connected terminal uses existing drain path', enabled: true, connected: true, captured: false },
      { name: 'quit already captured the log', enabled: true, connected: false, captured: true },
    ]) {
      await t.test(scenario.name, async () => {
        let calls = 0;
        let root!: ReactTestRenderer;
        function Probe() {
          useTerminalSessionCloseCapture({
            sessionId: 'guarded', enabled: scenario.enabled,
            hasConnectedRef: useRef(scenario.connected),
            terminalDataCapturedRef: useRef(scenario.captured),
            finalizeTerminalLogData: () => { calls++; return ''; },
            onTerminalDataCapture: () => { calls++; },
          });
          return null;
        }
        await act(async () => { root = create(React.createElement(Probe)); });
        try {
          await act(async () => { captureClosingTerminalSessions(['guarded']); });
          assert.equal(calls, 0);
        } finally {
          await act(async () => { root.unmount(); });
        }
      });
    }
  } finally {
    if (previous) Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', previous);
    else Reflect.deleteProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT');
  }
});

test('both UI close paths reach session removal and Terminal registers the owning capture', () => {
  const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');
  const app = read('./AppView.tsx');
  assert.match(app, /onCloseSession=\{closeSession\}/);
  assert.match(read('../../components/top-tabs/TopTabItems.tsx'), /onClick=\{\(e\) => onCloseSession\(session\.id, e\)\}/);
  const terminal = read('../../components/Terminal.tsx');
  assert.match(terminal, /useTerminalSessionCloseCapture\(\{\s*sessionId,\s*enabled: !attachExistingSession && restoreState !== "restored-disconnected",\s*hasConnectedRef,\s*terminalDataCapturedRef,\s*finalizeTerminalLogData,\s*onTerminalDataCapture: handleTerminalDataCaptureOnce,/);
  const handler = terminal.slice(terminal.indexOf('const handleCloseDisconnectedSession ='), terminal.indexOf('const handleHostKeyClose ='));
  assert.match(handler, /onCloseSession\?\.\(sessionId\)/);
  assert.match(read('../../components/TerminalLayer.tsx'), /onCloseSession\(sessionId\)/);
  assert.match(read('../../components/terminal/TerminalView.tsx'), /onCloseSession: handleCloseDisconnectedSession/);
  assert.match(read('../../components/terminal/TerminalConnectionProgress.tsx'), /onClick=\{onCloseSession\}/);
});
