import assert from 'node:assert/strict';
import test from 'node:test';
import type { Host, Snippet } from './models';
import {
  appendHostConnectScript,
  ensureHostConnectScriptIds,
  getEditableHostConnectScriptIds,
  getGlobalConnectScripts,
  getHostConnectScriptIds,
  hasHostConnectAutomation,
  migrateHostConnectScriptIds,
  reorderHostConnectScript,
  removeHostConnectScript,
  resolveConnectScriptsForHost,
  shouldMarkConnectAutomationConsumed,
  shouldUseFreshSshConnectionForAutomation,
  syncHostsForSnippetTargetChange,
  syncSnippetsForHostConnectQueueSave,
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

test('hasHostConnectAutomation covers host, global, and unresolved connect scripts', () => {
  assert.equal(
    hasHostConnectAutomation(
      { ...host, connectScriptIds: ['host-script'] },
      [script({ id: 'host-script', targets: ['host-a'] })],
    ),
    true,
  );
  assert.equal(
    hasHostConnectAutomation(host, [script({ id: 'global', targetsAllHosts: true })]),
    true,
  );
  assert.equal(
    hasHostConnectAutomation({ ...host, loginScriptId: 'not-loaded-yet' }, []),
    true,
  );
  assert.equal(hasHostConnectAutomation(host, []), false);
});

test('fresh SSH automation policy is conservative before vault hydration and for pending scripts', () => {
  assert.equal(shouldUseFreshSshConnectionForAutomation({
    host,
    snippets: [],
    vaultInitialized: false,
  }), true);
  assert.equal(shouldUseFreshSshConnectionForAutomation({
    host,
    snippets: [],
    vaultInitialized: true,
    hasPendingScript: true,
  }), true);
  assert.equal(shouldUseFreshSshConnectionForAutomation({
    host,
    snippets: [],
    vaultInitialized: true,
  }), false);
  assert.equal(shouldUseFreshSshConnectionForAutomation({
    host,
    snippets: [script({ id: 'global', targetsAllHosts: true })],
    vaultInitialized: true,
    connectAutomationConsumed: true,
  }), false);
  assert.equal(shouldUseFreshSshConnectionForAutomation({
    host,
    snippets: [script({ id: 'global', targetsAllHosts: true })],
    vaultInitialized: true,
    hasPendingScript: true,
    connectAutomationConsumed: true,
  }), true);
});

test('empty hydrated vault finalizes the current connection automation decision', () => {
  assert.equal(shouldMarkConnectAutomationConsumed({
    allConnectScriptsDone: true,
    vaultInitialized: true,
    hasUnresolvedBindings: false,
  }), true);
  assert.equal(shouldMarkConnectAutomationConsumed({
    allConnectScriptsDone: true,
    vaultInitialized: false,
    hasUnresolvedBindings: false,
  }), false);
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

test('append keeps default manual scripts in the editable host queue', () => {
  const snippets = [
    script({ id: 'reset', label: '重置密码', trigger: 'manual' }),
    script({ id: 'teest', label: 'teest', trigger: 'manual' }),
  ];

  let next = appendHostConnectScript(host, 'reset', snippets);
  assert.deepEqual(getEditableHostConnectScriptIds(next, snippets), ['reset']);
  // Runtime still ignores non-onConnect until host save promotes the trigger.
  assert.deepEqual(getHostConnectScriptIds(next, snippets), []);

  next = appendHostConnectScript(next, 'teest', snippets);
  assert.deepEqual(getEditableHostConnectScriptIds(next, snippets), ['reset', 'teest']);
  assert.deepEqual(next.connectScriptIds, ['reset', 'teest']);
});

test('ensureHostConnectScriptIds preserves pending manual queue entries while editing', () => {
  const snippets = [script({ id: 'reset', trigger: 'manual' })];
  const draft = { ...host, connectScriptIds: ['reset', 'missing'] };
  const ensured = ensureHostConnectScriptIds(draft, snippets);
  assert.deepEqual(ensured.connectScriptIds, ['reset']);
  assert.deepEqual(getEditableHostConnectScriptIds(ensured, snippets), ['reset']);
  assert.deepEqual(getHostConnectScriptIds(ensured, snippets), []);
});

test('syncSnippetsForHostConnectQueueSave promotes already-persisted manual queue entries', () => {
  const snippets = [
    script({ id: 'reset', trigger: 'manual', targets: [] }),
    script({ id: 'ready', trigger: 'onConnect', targets: ['host-a'] }),
  ];
  const { snippets: next, changed } = syncSnippetsForHostConnectQueueSave(
    snippets,
    'host-a',
    ['reset', 'ready'],
    ['reset', 'ready'],
  );
  assert.equal(changed, true);
  assert.equal(next.find((item) => item.id === 'reset')?.trigger, 'onConnect');
  assert.deepEqual(next.find((item) => item.id === 'reset')?.targets, ['host-a']);
  assert.equal(next.find((item) => item.id === 'ready'), snippets[1]);
});

test('syncSnippetsForHostConnectQueueSave leaves global onConnect scripts untouched', () => {
  const global = script({ id: 'both', targetsAllHosts: true, targets: ['host-a'] });
  const { snippets: next, changed } = syncSnippetsForHostConnectQueueSave(
    [global],
    'host-a',
    ['both'],
    ['both'],
  );
  assert.equal(changed, false);
  assert.equal(next[0], global);
  assert.equal(next[0].targetsAllHosts, true);
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
