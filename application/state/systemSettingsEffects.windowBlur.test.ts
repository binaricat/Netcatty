import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { JSDOM } from 'jsdom';

import { STORAGE_KEY_WINDOW_BACKGROUND_BLUR } from '../../infrastructure/config/storageKeys';
import { DEFAULT_HTTP_NETWORK_PROXY } from '../../domain/httpNetworkProxy';
import { useSystemSettingsEffects } from './systemSettingsEffects';

type Harness = {
  dom: JSDOM;
  params: Parameters<typeof useSystemSettingsEffects>[0];
  bridgeRequests: boolean[];
  blurNotifications: unknown[];
  restore: () => void;
};

function setUp(enabled: boolean, windowBackgroundBlur: boolean): Harness {
  const dom = new JSDOM('<html><body><div id="root"></div></body></html>', { url: 'http://localhost' });
  Object.defineProperty(dom.window.navigator, 'platform', { value: 'MacIntel' });
  const previousGlobals = new Map<string, PropertyDescriptor | undefined>();
  const replacements = {
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    localStorage: dom.window.localStorage,
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  for (const [key, value] of Object.entries(replacements)) {
    previousGlobals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { value, configurable: true });
  }
  const bridgeRequests: boolean[] = [];
  const blurNotifications: unknown[] = [];
  Object.assign(dom.window, {
    netcatty: {
      setWindowBackgroundBlur: async (value: boolean) => { bridgeRequests.push(value); },
    },
  });
  const noop = () => {};
  const params: Parameters<typeof useSystemSettingsEffects>[0] = {
    enabled,
    toggleWindowHotkey: '',
    globalHotkeyEnabled: false,
    closeToTray: false,
    showTrayIcon: false,
    autoLaunchEnabled: false,
    windowOpacityRecord: { opacity: 0.7, preferredOpacity: 0.7, version: 1 },
    windowOpacityMutationSourceRef: { current: 'local' },
    windowBackgroundBlur,
    appIconVariant: 'original',
    autoUpdateEnabled: false,
    httpNetworkProxy: DEFAULT_HTTP_NETWORK_PROXY,
    persistMountedRef: { current: true },
    setHotkeyRegistrationError: noop,
    setAutoUpdateEnabled: noop,
    setAppIconVariant: noop,
    setAutoLaunchEnabled: noop,
    setAutoLaunchSupported: noop,
    notifySettingsChanged: (key, value) => {
      if (key === STORAGE_KEY_WINDOW_BACKGROUND_BLUR) blurNotifications.push(value);
    },
  };
  return {
    dom,
    params,
    bridgeRequests,
    blurNotifications,
    restore: () => {
      for (const [key, descriptor] of previousGlobals) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else Reflect.deleteProperty(globalThis, key);
      }
      dom.window.close();
    },
  };
}

const Probe = (props: Parameters<typeof useSystemSettingsEffects>[0]) => {
  useSystemSettingsEffects(props);
  return null;
};

test('opacity changes and remounts preserve the chosen blur preference', async () => {
  const harness = setUp(true, true);
  const { dom, params, bridgeRequests, blurNotifications, restore } = harness;
  let renderer: ReactTestRenderer | undefined;
  try {
    await act(async () => { renderer = create(React.createElement(Probe, params)); });
    assert.equal(document.documentElement.classList.contains('window-background-blur'), true);
    const opaqueParams = { ...params, windowOpacityRecord: { ...params.windowOpacityRecord, opacity: 1, version: 2 } };
    await act(async () => { renderer!.update(React.createElement(Probe, opaqueParams)); });
    assert.equal(document.documentElement.classList.contains('window-background-blur'), false);
    assert.equal(dom.window.localStorage.getItem(STORAGE_KEY_WINDOW_BACKGROUND_BLUR), 'true');
    assert.deepEqual(bridgeRequests, [true]);
    assert.deepEqual(blurNotifications, [true]);
    await act(async () => { renderer!.unmount(); });
    await act(async () => { renderer = create(React.createElement(Probe, opaqueParams)); });
    assert.equal(dom.window.localStorage.getItem(STORAGE_KEY_WINDOW_BACKGROUND_BLUR), 'true');
    await act(async () => { renderer!.update(React.createElement(Probe, params)); });
    assert.equal(document.documentElement.classList.contains('window-background-blur'), true);
    await act(async () => { renderer!.update(React.createElement(Probe, { ...params, windowBackgroundBlur: false })); });
    assert.equal(dom.window.localStorage.getItem(STORAGE_KEY_WINDOW_BACKGROUND_BLUR), 'false');
    assert.equal(document.documentElement.classList.contains('window-background-blur'), false);
    assert.deepEqual(bridgeRequests, [true, true, false]);
  } finally {
    await act(async () => { renderer?.unmount(); });
    restore();
  }
});

test('detached session windows only apply the blur class, never own the setting', async () => {
  // Peer session windows run with enableSystemEffects off. They must still
  // paint the transparent backing, but persistence, cross-window broadcast and
  // the (all-windows) native vibrancy IPC stay with the settings owners.
  const harness = setUp(false, true);
  const { dom, params, bridgeRequests, blurNotifications, restore } = harness;
  let renderer: ReactTestRenderer | undefined;
  try {
    await act(async () => { renderer = create(React.createElement(Probe, params)); });
    assert.equal(document.documentElement.classList.contains('window-background-blur'), true);
    assert.equal(document.documentElement.style.getPropertyValue('--window-content-opacity'), '0.7');
    assert.equal(dom.window.localStorage.getItem(STORAGE_KEY_WINDOW_BACKGROUND_BLUR), null);
    assert.deepEqual(bridgeRequests, []);
    assert.deepEqual(blurNotifications, []);

    await act(async () => {
      renderer!.update(React.createElement(Probe, { ...params, windowBackgroundBlur: false }));
    });
    assert.equal(document.documentElement.classList.contains('window-background-blur'), false);
    assert.equal(dom.window.localStorage.getItem(STORAGE_KEY_WINDOW_BACKGROUND_BLUR), null);
    assert.deepEqual(bridgeRequests, []);
    assert.deepEqual(blurNotifications, []);
  } finally {
    await act(async () => { renderer?.unmount(); });
    restore();
  }
});
