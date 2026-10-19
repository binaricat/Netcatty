import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { act, create } from 'react-test-renderer';
import { installDomEnvironment } from '../../components/test-support/renderReactDom';
import { netcattyBridge } from '../../infrastructure/services/netcattyBridge';
import type { HostBrowserPanelEvent, HostBrowserState } from '../../domain/hostBrowser';
import { useHostBrowserControls } from './useHostBrowserControls';

const state = (label: string): HostBrowserState => ({ hostId: label, label, route: 'connected', error: null, activeTabId: null, tabs: [] });

test('browser events stay scoped and a late initial read cannot overwrite a newer page', async (t) => {
  const env = installDomEnvironment();
  let resolveInitial: (value: HostBrowserState) => void = () => assert.fail('initial read missing');
  let emit: (event: HostBrowserPanelEvent) => void = () => {};
  let unsubscribed = false;
  t.mock.method(netcattyBridge, 'require', () => ({
    getHostBrowserPanelState: () => new Promise<HostBrowserState>((resolve) => { resolveInitial = resolve; }),
    commandHostBrowserPanel: async () => state('command'),
    listHostBrowserPanelBookmarks: async () => [],
    listHostBrowserPanelDownloads: async () => [],
    onHostBrowserPanelEvent: (callback: typeof emit) => { emit = callback; return () => { unsubscribed = true; }; },
  }));
  let controls: ReturnType<typeof useHostBrowserControls>;
  function Panel() { controls = useHostBrowserControls('browser-a', true); return null; }
  let renderer: ReturnType<typeof create>;
  t.after(async () => { if (renderer) await act(async () => renderer.unmount()); env.cleanup(); });
  await act(async () => { renderer = create(React.createElement(Panel)); });
  await act(async () => emit({ browserId: 'browser-b', type: 'state', state: state('wrong host') }));
  assert.equal(controls.state, null);
  await act(async () => emit({ browserId: 'browser-a', type: 'state', state: state('new page') }));
  await act(async () => resolveInitial(state('old page')));
  assert.equal(controls.state?.label, 'new page');
  await act(async () => renderer.unmount());
  assert.equal(unsubscribed, true);
});

test('switching browser contexts invalidates an outstanding navigation response', async (t) => {
  const env = installDomEnvironment();
  let finish: (value: HostBrowserState) => void = () => assert.fail('command missing');
  const commands: string[] = [];
  t.mock.method(netcattyBridge, 'require', () => ({
    getHostBrowserPanelState: async (id: string) => state(id),
    commandHostBrowserPanel: (id: string) => { commands.push(id); return new Promise<HostBrowserState>((resolve) => { finish = resolve; }); },
    listHostBrowserPanelBookmarks: async () => [], listHostBrowserPanelDownloads: async () => [],
    onHostBrowserPanelEvent: () => () => {},
  }));
  let controls: ReturnType<typeof useHostBrowserControls>;
  function Panel({ id }: { id: string }) { controls = useHostBrowserControls(id, true); return null; }
  let renderer: ReturnType<typeof create>;
  t.after(async () => { if (renderer) await act(async () => renderer.unmount()); env.cleanup(); });
  await act(async () => { renderer = create(React.createElement(Panel, { id: 'browser-a' })); });
  let pending: Promise<boolean>;
  await act(async () => { pending = controls.command({ type: 'navigate', url: 'http://localhost/' }); });
  await act(async () => renderer.update(React.createElement(Panel, { id: 'browser-b' })));
  await act(async () => finish(state('late browser-a')));
  assert.equal(await pending, false);
  assert.equal(controls.state?.label, 'browser-b');
  assert.deepEqual(commands, ['browser-a']);
});
