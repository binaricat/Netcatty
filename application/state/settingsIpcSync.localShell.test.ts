import assert from 'node:assert/strict';
import test from 'node:test';
import React, { useState } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { useSettingsIpcSync } from './settingsIpcSync.ts';
import { useSettingsStorageSync } from './settingsStorageSync.ts';
import type { TerminalSidePanelAutoOpenTab } from '../../domain/terminalSidePanelAutoOpen.ts';
import {
  STORAGE_KEY_LOCAL_SHELL_SIDE_PANEL_AUTO_OPEN as enabledKey,
  STORAGE_KEY_LOCAL_SHELL_SIDE_PANEL_AUTO_OPEN_TAB as tabKey,
} from '../../infrastructure/config/storageKeys.ts';

for (const pathway of ['ipc', 'storage'] as const) {
  test(`${pathway} receives local shell settings, rejects invalid tabs and cleans up`, async (t) => {
    let receive: ((payload: { key: string; value: unknown }) => void) | undefined;
    let unsubscribed = false;
    const fakeWindow = Object.assign(new EventTarget(), {
      netcatty: {
        onSettingsChanged(callback: typeof receive) {
          receive = callback;
          return () => { unsubscribed = true; };
        },
      },
    });
    for (const [key, value] of Object.entries({ window: fakeWindow, IS_REACT_ACT_ENVIRONMENT: true })) {
      const previous = Object.getOwnPropertyDescriptor(globalThis, key);
      Object.defineProperty(globalThis, key, { value, configurable: true });
      t.after(() => {
        if (previous) Object.defineProperty(globalThis, key, previous);
        else Reflect.deleteProperty(globalThis, key);
      });
    }
    let current = { enabled: false, tab: 'scripts' };
    let renderer: ReactTestRenderer | undefined;
    function Harness() {
      const [enabled, setEnabled] = useState(false);
      const [tab, setTab] = useState<TerminalSidePanelAutoOpenTab>('scripts');
      current = { enabled, tab };
      const params = {
        localShellSidePanelAutoOpen: enabled,
        localShellSidePanelAutoOpenTab: tab,
        setLocalShellSidePanelAutoOpenState: setEnabled,
        setLocalShellSidePanelAutoOpenTabState: setTab,
      };
      // Only local-shell events are dispatched; unrelated settings are not used.
      useSettingsIpcSync({ ...params, enabled: pathway === 'ipc' } as unknown as Parameters<typeof useSettingsIpcSync>[0]);
      useSettingsStorageSync({ ...params, enabled: pathway === 'storage' } as Parameters<typeof useSettingsStorageSync>[0]);
      return null;
    }
    async function send(key: string, value: unknown) {
      await act(async () => {
        if (pathway === 'ipc') receive!({ key, value });
        else fakeWindow.dispatchEvent(Object.assign(new Event('storage'), { key, newValue: value === null ? null : String(value) }));
      });
    }
    try {
      await act(async () => { renderer = create(React.createElement(Harness)); });
      await send(enabledKey, true);
      await send(tabKey, 'notes');
      assert.deepEqual(current, { enabled: true, tab: 'notes' });
      await send(tabKey, 'invalid');
      await send(tabKey, null);
      await send(enabledKey, null);
      assert.deepEqual(current, { enabled: true, tab: 'notes' });
      if (pathway === 'ipc') {
        await send(enabledKey, 'false');
        assert.equal(current.enabled, true);
      }
      await send(enabledKey, false);
      await send(tabKey, 'history');
      assert.deepEqual(current, { enabled: false, tab: 'history' });
      await act(async () => { renderer!.unmount(); });
      renderer = undefined;
      if (pathway === 'ipc') assert.equal(unsubscribed, true);
    } finally {
      await act(async () => { renderer?.unmount(); });
    }
  });
}
