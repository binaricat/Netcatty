import assert from 'node:assert/strict';
import test from 'node:test';
import { requestHostBrowserPanel, subscribeHostBrowserPanelRequests, type HostBrowserPanelRequest } from './hostBrowserPanelRequests';

test('detached terminal requests reach the main window instead of being dropped', async () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const forwarded: HostBrowserPanelRequest[] = [];
  const delivered: HostBrowserPanelRequest[] = [];
  let nativeListener: ((request: HostBrowserPanelRequest) => void) | undefined;
  let removed = false;
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { netcatty: {
    requestHostBrowserPanel: async (request: HostBrowserPanelRequest) => { forwarded.push(request); return true; },
    onHostBrowserPanelRequest: (listener: typeof nativeListener) => {
      nativeListener = listener;
      return () => { removed = true; nativeListener = undefined; };
    },
  } } });
  let unsubscribe: (() => void) | undefined;
  try {
    const request = { host: { id: 'host', hostname: 'host', label: 'Host', username: 'test' }, url: 'http://localhost:3000/' } as HostBrowserPanelRequest;
    requestHostBrowserPanel(request);
    await Promise.resolve();
    assert.deepEqual(forwarded, [request]);
    unsubscribe = subscribeHostBrowserPanelRequests((value) => delivered.push(value));
    assert.ok(nativeListener);
    nativeListener(request);
    assert.deepEqual(delivered, [request]);
    assert.equal(forwarded.length, 1, 'main-window consumption must not forward the request again');
    unsubscribe(); unsubscribe = undefined;
    assert.equal(removed, true);
  } finally {
    unsubscribe?.();
    if (previous) Object.defineProperty(globalThis, 'window', previous);
    else Reflect.deleteProperty(globalThis, 'window');
  }
});
