import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

import {
  STORAGE_KEY_AI_ACTIVE_PROVIDER,
  STORAGE_KEY_AI_AGENT_MODEL_MAP,
  STORAGE_KEY_AI_AGENT_PROVIDER_MAP,
  STORAGE_KEY_AI_COMMAND_BLOCKLIST,
  STORAGE_KEY_AI_PERMISSION_MODE,
  STORAGE_KEY_AI_PROVIDERS,
  STORAGE_KEY_AI_SESSION_MESSAGE_CAP,
  STORAGE_KEY_AI_SHOW_TERMINAL_SELECTION_ACTION,
} from '../../infrastructure/config/storageKeys.ts';
import type { ProviderConfig } from '../../infrastructure/ai/types.ts';
import { useAISettingsState, useSharedAISettingsState } from './useAISettingsState.ts';

function setupStorageHarness() {
  const store = new Map<string, string>();
  const writes: Array<[string, string]> = [];
  const fakeStorage = {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => {
      writes.push([key, String(value)]);
      store.set(key, String(value));
    },
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

  return {
    store,
    writes,
    fakeStorage,
    fakeWindow,
    dispatchStorage: (key: string) => {
      const event = new Event('storage');
      Object.defineProperty(event, 'key', { value: key });
      fakeWindow.dispatchEvent(event);
    },
    cleanup: () => {
      globals.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
      if (previousLocalStorage) Object.defineProperty(globalThis, 'localStorage', previousLocalStorage);
      else delete globals.localStorage;
      if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow);
      else delete globals.window;
    },
  };
}

test('command blocklist storage events refresh the mounted AI settings state', async () => {
  const env = setupStorageHarness();
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
    env.fakeStorage.setItem(STORAGE_KEY_AI_COMMAND_BLOCKLIST, JSON.stringify(['company-blocked-command']));
    await act(async () => {
      env.dispatchStorage(STORAGE_KEY_AI_COMMAND_BLOCKLIST);
    });
    assert.deepEqual(currentBlocklist, ['company-blocked-command']);
  } finally {
    await act(async () => {
      renderer?.unmount();
    });
    env.cleanup();
  }
});

test('useSharedAISettingsState preserves invalid-permission-mode ignore option vs useAISettingsState fallback', async () => {
  const env = setupStorageHarness();
  env.fakeStorage.setItem(STORAGE_KEY_AI_PERMISSION_MODE, 'auto');

  let sharedMode = '';
  let settingsPageMode = '';
  let renderer: ReactTestRenderer | null = null;

  const Probe = () => {
    sharedMode = useSharedAISettingsState({ ignoreInvalidPermissionModeOnStorage: true }).globalPermissionMode;
    settingsPageMode = useAISettingsState().globalPermissionMode;
    return null;
  };

  try {
    await act(async () => {
      renderer = create(React.createElement(Probe));
    });
    assert.equal(sharedMode, 'auto');
    assert.equal(settingsPageMode, 'auto');

    env.fakeStorage.setItem(STORAGE_KEY_AI_PERMISSION_MODE, 'bogus-mode');
    await act(async () => {
      env.dispatchStorage(STORAGE_KEY_AI_PERMISSION_MODE);
    });

    assert.equal(sharedMode, 'auto');
    assert.equal(settingsPageMode, 'confirm');
  } finally {
    await act(async () => {
      renderer?.unmount();
    });
    env.cleanup();
  }
});

test('useSharedAISettingsState onRemoveProvider replaces localStorage map cleanup and updateProvider skips no-op writes', async () => {
  const env = setupStorageHarness();
  const provider: ProviderConfig = {
    id: 'prov-1',
    providerId: 'openai',
    name: 'OpenAI',
    apiKey: 'secret',
    enabled: true,
    defaultModel: 'gpt-4o',
    modelContextWindows: { 'gpt-4o': 128000 },
  };
  env.fakeStorage.setItem(STORAGE_KEY_AI_PROVIDERS, JSON.stringify([provider]));
  env.fakeStorage.setItem(STORAGE_KEY_AI_ACTIVE_PROVIDER, 'prov-1');
  env.fakeStorage.setItem(STORAGE_KEY_AI_AGENT_PROVIDER_MAP, JSON.stringify({ catty: 'prov-1' }));
  env.fakeStorage.setItem(STORAGE_KEY_AI_AGENT_MODEL_MAP, JSON.stringify({ catty: 'gpt-4o' }));
  env.writes.length = 0;

  const removedIds: string[] = [];
  let api: ReturnType<typeof useSharedAISettingsState> | null = null;
  let renderer: ReactTestRenderer | null = null;

  const Probe = () => {
    const onRemoveProvider = React.useCallback((id: string) => {
      removedIds.push(id);
    }, []);
    api = useSharedAISettingsState({ onRemoveProvider });
    return null;
  };

  try {
    await act(async () => {
      renderer = create(React.createElement(Probe));
    });

    await act(async () => {
      api!.updateProvider('prov-1', {
        name: 'OpenAI',
        modelContextWindows: { 'gpt-4o': 128000 },
      });
    });
    assert.equal(
      env.writes.filter(([key]) => key === STORAGE_KEY_AI_PROVIDERS).length,
      0,
      'no-op provider patch should not rewrite localStorage',
    );

    await act(async () => {
      api!.removeProvider('prov-1');
    });
    assert.deepEqual(removedIds, ['prov-1']);
    assert.equal(api!.activeProviderId, '');
    assert.equal(
      env.writes.filter(([key]) => key === STORAGE_KEY_AI_AGENT_PROVIDER_MAP || key === STORAGE_KEY_AI_AGENT_MODEL_MAP).length,
      0,
      'custom onRemoveProvider must replace default localStorage agent-map cleanup',
    );
  } finally {
    await act(async () => {
      renderer?.unmount();
    });
    env.cleanup();
  }
});

test('SettingsPage-only storage keys do not trigger re-renders in useSharedAISettingsState', async () => {
  const env = setupStorageHarness();
  let sharedRenders = 0;
  let settingsCap = 0;
  let renderer: ReactTestRenderer | null = null;

  const SharedProbe = () => {
    sharedRenders += 1;
    useSharedAISettingsState({ ignoreInvalidPermissionModeOnStorage: true });
    return null;
  };
  const SettingsProbe = () => {
    settingsCap = useAISettingsState().aiSessionMessageCap;
    return null;
  };

  try {
    await act(async () => {
      renderer = create(
        React.createElement(React.Fragment, null,
          React.createElement(SharedProbe),
          React.createElement(SettingsProbe),
        ),
      );
    });
    const rendersAfterMount = sharedRenders;

    env.fakeStorage.setItem(STORAGE_KEY_AI_SESSION_MESSAGE_CAP, '500');
    env.fakeStorage.setItem(STORAGE_KEY_AI_SHOW_TERMINAL_SELECTION_ACTION, 'false');
    await act(async () => {
      env.dispatchStorage(STORAGE_KEY_AI_SESSION_MESSAGE_CAP);
      env.dispatchStorage(STORAGE_KEY_AI_SHOW_TERMINAL_SELECTION_ACTION);
    });

    assert.equal(settingsCap, 500);
    assert.equal(sharedRenders, rendersAfterMount);
  } finally {
    await act(async () => {
      renderer?.unmount();
    });
    env.cleanup();
  }
});
