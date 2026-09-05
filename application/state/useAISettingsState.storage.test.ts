import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

import { STORAGE_KEY_AI_COMMAND_BLOCKLIST } from '../../infrastructure/config/storageKeys.ts';
import { useAISettingsState } from './useAISettingsState.ts';

test('command blocklist storage events refresh the mounted AI settings state', async () => {
  const store = new Map<string, string>();
  const fakeStorage = {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => store.set(key, String(value)),
    removeItem: (key: string) => store.delete(key),
  };
  const fakeWindow = new EventTarget() as EventTarget & { netcatty?: unknown };
  const globals = globalThis as typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT?: boolean;
    localStorage?: typeof fakeStorage;
    window?: typeof fakeWindow;
  };
  const previousActEnvironment = globals.IS_REACT_ACT_ENVIRONMENT;
  const previousLocalStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  globals.IS_REACT_ACT_ENVIRONMENT = true;
  Object.defineProperty(globalThis, 'localStorage', { value: fakeStorage, configurable: true });
  Object.defineProperty(globalThis, 'window', { value: fakeWindow, configurable: true });

  let currentBlocklist: string[] = [];
  let renderer: ReactTestRenderer | null = null;
  const Probe = () => {
    currentBlocklist = useAISettingsState().commandBlocklist;
    return null;
  };

  try {
    await act(async () => {
      renderer = create(React.createElement(Probe));
    });
    fakeStorage.setItem(STORAGE_KEY_AI_COMMAND_BLOCKLIST, JSON.stringify(['company-blocked-command']));
    const event = new Event('storage');
    Object.defineProperty(event, 'key', { value: STORAGE_KEY_AI_COMMAND_BLOCKLIST });
    await act(async () => {
      fakeWindow.dispatchEvent(event);
    });
    assert.deepEqual(currentBlocklist, ['company-blocked-command']);
  } finally {
    await act(async () => {
      renderer?.unmount();
    });
    globals.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
    if (previousLocalStorage) Object.defineProperty(globalThis, 'localStorage', previousLocalStorage);
    else delete globals.localStorage;
    if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow);
    else delete globals.window;
  }
});
