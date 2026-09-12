import assert from 'node:assert/strict';
import test from 'node:test';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { JSDOM } from 'jsdom';
import type { Terminal } from '@xterm/xterm';
import { useTerminalContextActions } from './hooks/useTerminalContextActions';

test('saving captures the screen before the dialog, prevents duplicate dialogs, and supports preview and cancellation', async () => {
  const dom = new JSDOM('<div id="root"></div><div id="terminal"></div>', { url: 'http://localhost' });
  const previous = new Map<string, PropertyDescriptor | undefined>();
  for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true })) {
    previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  const requests: Array<Parameters<NonNullable<NetcattyBridge['exportSessionLog']>>[0]> = [];
  let finishSave: (result: { success: boolean; canceled?: boolean }) => void = () => {};
  Object.assign(dom.window, { netcatty: { exportSessionLog: (payload: typeof requests[number]) => {
    requests.push(payload);
    return new Promise((resolve) => { finishSave = resolve; });
  } } });
  let visibleText = 'corrected';
  const term = {
    cols: 80, rows: 1, element: dom.window.document.createElement('div'),
    buffer: { active: { type: 'normal', viewportY: 0, length: 1,
      getLine: () => ({ translateToString: () => visibleText }),
    } },
  };
  dom.window.document.getElementById('terminal')!.append(term.element);
  const termRef = { current: term as unknown as Terminal };
  let actions!: ReturnType<typeof useTerminalContextActions>;
  function Harness() {
    actions = useTerminalContextActions({ termRef, sourceSessionId: 'session', sessionName: 'My terminal',
      sessionRef: { current: null }, isLocalConnection: true, supportsRemoteImagePaste: false,
      terminalBackend: { writeToSession() {} },
    });
    return null;
  }
  const root = createRoot(dom.window.document.getElementById('root')!);
  try {
    await act(async () => root.render(<Harness />));
    const firstSave = actions.onSaveScreen();
    visibleText = 'later output';
    await actions.onSaveScreen();
    assert.equal(requests.length, 1);
    assert.equal(requests[0].terminalData, 'corrected');
    assert.equal(requests[0].plainText, true);
    assert.equal(requests[0].hostLabel, 'My terminal');
    finishSave({ success: false, canceled: true });
    await firstSave;
    const preview = dom.window.document.createElement('pre');
    preview.setAttribute('data-terminal-history-preview', 'true');
    preview.textContent = 'history\n\n  row';
    term.element.parentElement!.append(preview);
    const secondSave = actions.onSaveScreen();
    assert.equal(requests.length, 2);
    assert.equal(requests[1].terminalData, 'history\n\n  row');
    finishSave({ success: true });
    await secondSave;
    termRef.current = null as unknown as Terminal;
    await actions.onSaveScreen();
    assert.equal(requests.length, 2);
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
