import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { useSftpPaneActions } from './useSftpPaneActions';
import { createEmptyPane, type SftpPane } from './types';
import type { SftpFileEntry } from '../../../types';

const environment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
const previous = environment.IS_REACT_ACT_ENVIRONMENT;
environment.IS_REACT_ACT_ENVIRONMENT = true;
after(() => { environment.IS_REACT_ACT_ENVIRONMENT = previous; });

test('command refresh keeps current directory/filter/selection and drops deleted selections', async () => {
  const file = (name: string): SftpFileEntry => ({ name, type: 'file', size: 1, sizeFormatted: '1 B', lastModified: 0, lastModifiedFormatted: '1970-01-01' });
  let result = [file('kept'), file('new')];
  const selection = new Set(['kept']);
  const pane: SftpPane = { ...createEmptyPane('pane'), connection: { id: 'conn', hostId: 'host', hostLabel: 'Host', status: 'connected', currentPath: '/browsed', homeDir: '/', isLocal: true }, files: [file('kept')], selectedFiles: selection, filter: 'ke' };
  const left = { current: { tabs: [pane], activeTabId: pane.id } };
  const calls: string[] = [];
  let actions: ReturnType<typeof useSftpPaneActions>;
  const update: Parameters<typeof useSftpPaneActions>[0]['updateTab'] = (_side, id, updater) => {
    left.current.tabs = left.current.tabs.map((p) => p.id === id ? updater(p) : p);
  };
  function Probe() {
    actions = useSftpPaneActions({
      hosts: [], getActivePane: () => left.current.tabs[0], updateTab: update,
      updateActiveTab: (side, updater) => update(side, pane.id, updater),
      leftTabsRef: left, rightTabsRef: { current: { tabs: [], activeTabId: null } },
      navSeqRef: { current: { left: 0, right: 0 } }, dirCacheRef: { current: new Map() },
      sftpSessionsRef: { current: new Map() }, lastConnectedHostRef: { current: { left: null, right: null } },
      connectionCacheKeyMapRef: { current: new Map() }, makeCacheKey: (id, path) => id + path,
      clearCacheForConnection() {}, listLocalFiles: async (path) => { calls.push(path); return result; },
      listRemoteFiles: async () => [], handleSessionError() {}, releaseConnection: async () => {},
      isSessionError: () => false, clearSelectionsExcept() {}, dirCacheTtlMs: 1000,
    });
    return null;
  }
  let renderer: ReactTestRenderer;
  await act(async () => { renderer = create(React.createElement(Probe)); });
  await actions!.refresh('left', { tabId: pane.id, preserveSelection: true });
  assert.deepEqual(calls, ['/browsed']);
  assert.equal(left.current.tabs[0].selectedFiles, selection);
  assert.equal(left.current.tabs[0].filter, 'ke');
  assert.deepEqual(left.current.tabs[0].files.map((f) => f.name), ['kept', 'new']);
  result = [file('new')];
  await actions!.refresh('left', { preserveSelection: true });
  assert.equal(left.current.tabs[0].selectedFiles.size, 0);
  assert.equal(left.current.tabs[0].connection?.currentPath, '/browsed');
  await act(async () => { renderer.unmount(); });
});
