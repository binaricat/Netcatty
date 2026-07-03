import assert from 'node:assert/strict';
import test from 'node:test';
import type { Host, Snippet } from './models';
import {
  appendHostConnectScript,
  getGlobalConnectScripts,
  getHostConnectScriptIds,
  migrateHostConnectScriptIds,
  reorderHostConnectScript,
  removeHostConnectScript,
  resolveConnectScriptsForHost,
  syncHostsForSnippetTargetChange,
} from './hostConnectScripts.ts';

const host: Host = {
  id: 'host-a',
  label: 'A',
  hostname: 'a.example',
  username: 'root',
  os: 'linux',
  protocol: 'ssh',
  tags: [],
};

const script = (overrides: Partial<Snippet>): Snippet => ({
  id: 's-default',
  label: 'default',
  command: 'nct.log("x");',
  kind: 'script',
  trigger: 'onConnect',
  ...overrides,
});

test('migrateHostConnectScriptIds prefers loginScriptId then linked onConnect scripts', () => {
  const snippets = [
    script({ id: 'login', targets: ['host-a'], order: 1000 }),
    script({ id: 'linked', targets: ['host-a'], order: 2000 }),
    script({ id: 'other', targets: ['host-a'], order: 3000 }),
  ];
  const migrated = migrateHostConnectScriptIds({ ...host, loginScriptId: 'login' }, snippets);
  assert.deepEqual(migrated, ['login', 'linked', 'other']);
});

test('resolveConnectScriptsForHost runs globals before host queue and dedupes', () => {
  const snippets = [
    script({ id: 'global', targetsAllHosts: true, order: 1000, label: 'Global' }),
    script({ id: 'host-only', targets: ['host-a'], order: 2000, label: 'Host' }),
    script({ id: 'both', targetsAllHosts: true, targets: ['host-a'], order: 3000, label: 'Both' }),
  ];
  const resolved = resolveConnectScriptsForHost(
    { ...host, connectScriptIds: ['both', 'host-only'] },
    snippets,
  );
  assert.deepEqual(resolved.map((item) => item.id), ['global', 'both', 'host-only']);
});

test('append updates host connectScriptIds order', () => {
  const snippets = [
    script({ id: 'a', targets: ['host-a'] }),
    script({ id: 'b', targets: ['host-a'] }),
  ];
  let next = appendHostConnectScript(host, 'a', snippets);
  next = appendHostConnectScript(next, 'b', snippets);
  assert.deepEqual(getHostConnectScriptIds(next, snippets), ['a', 'b']);
});

test('syncHostsForSnippetTargetChange appends and removes queue entries', () => {
  const snippets = [script({ id: 'run', targets: ['host-a'], trigger: 'onConnect' })];
  const hosts = syncHostsForSnippetTargetChange(
    [host],
    script({ id: 'run', targets: ['host-a'], trigger: 'onConnect' }),
    [],
    snippets,
  );
  assert.deepEqual(hosts[0].connectScriptIds, ['run']);

  const removed = syncHostsForSnippetTargetChange(
    hosts,
    script({ id: 'run', targets: [], trigger: 'onConnect' }),
    ['host-a'],
    snippets,
  );
  assert.deepEqual(removed[0].connectScriptIds, []);
});

test('getGlobalConnectScripts sorts by order', () => {
  const snippets = [
    script({ id: 'z', targetsAllHosts: true, order: 2000, label: 'Z' }),
    script({ id: 'a', targetsAllHosts: true, order: 1000, label: 'A' }),
  ];
  assert.deepEqual(getGlobalConnectScripts(snippets).map((item) => item.id), ['a', 'z']);
});

test('reorderHostConnectScript moves item before or after target', () => {
  const snippets = [
    script({ id: 'a', targets: ['host-a'] }),
    script({ id: 'b', targets: ['host-a'] }),
    script({ id: 'c', targets: ['host-a'] }),
  ];
  const base = { ...host, connectScriptIds: ['a', 'b', 'c'] };
  const movedAfter = reorderHostConnectScript(base, 'a', 'c', 'after', snippets);
  assert.deepEqual(getHostConnectScriptIds(movedAfter, snippets), ['b', 'c', 'a']);
  const movedBefore = reorderHostConnectScript(base, 'c', 'a', 'before', snippets);
  assert.deepEqual(getHostConnectScriptIds(movedBefore, snippets), ['c', 'a', 'b']);
});

test('removeHostConnectScript clears empty queue', () => {
  const snippets = [script({ id: 'only', targets: ['host-a'] })];
  const updated = removeHostConnectScript(
    { ...host, connectScriptIds: ['only'] },
    'only',
    snippets,
  );
  assert.deepEqual(updated.connectScriptIds, []);
});
