import assert from 'node:assert/strict';
import test from 'node:test';
import type { Host, Snippet } from './models';
import {
  collectSnippetDeleteIds,
  deleteSelectedSnippetsFromVault,
  pruneHostsStaleSnippetBindings,
  rebaseSnippetVaultWrite,
} from './snippetSelection.ts';

test('collectSnippetDeleteIds merges id and ids payloads', () => {
  assert.deepEqual(
    [...collectSnippetDeleteIds({ id: 'a', ids: ['b', 'a', ''] })].sort(),
    ['a', 'b'],
  );
  assert.equal(collectSnippetDeleteIds(undefined).size, 0);
  assert.equal(collectSnippetDeleteIds({ ids: [] }).size, 0);
});

test('deleteSelectedSnippetsFromVault removes host bindings for every selected snippet', () => {
  const snippets: Snippet[] = [
    { id: 'login', label: 'Login', command: 'echo login', kind: 'script' },
    {
      id: 'connect',
      label: 'Connect',
      command: 'echo connect',
      kind: 'script',
      trigger: 'onConnect',
      targets: ['host-a', 'host-b'],
    },
    {
      id: 'keep',
      label: 'Keep',
      command: 'echo keep',
      kind: 'script',
      trigger: 'onConnect',
      targets: ['host-a'],
    },
  ];
  const hosts: Host[] = [
    {
      id: 'host-a',
      name: 'Host A',
      host: 'host-a.example.com',
      port: 22,
      username: 'root',
      loginScriptId: 'login',
      connectScriptIds: ['connect', 'keep'],
    },
    {
      id: 'host-b',
      name: 'Host B',
      host: 'host-b.example.com',
      port: 22,
      username: 'root',
      connectScriptIds: ['connect'],
    },
  ];

  const result = deleteSelectedSnippetsFromVault(
    snippets,
    hosts,
    new Set(['login', 'connect', 'missing']),
  );

  assert.deepEqual(result.snippets.map((snippet) => snippet.id), ['keep']);
  assert.equal(result.deletedCount, 2);
  assert.equal(result.hosts[0].loginScriptId, undefined);
  assert.deepEqual(result.hosts[0].connectScriptIds, ['keep']);
  assert.deepEqual(result.hosts[1].connectScriptIds, []);
  assert.equal(hosts[0].loginScriptId, 'login');
  assert.deepEqual(hosts[0].connectScriptIds, ['connect', 'keep']);
});

test('pruneHostsStaleSnippetBindings drops bindings to missing snippets', () => {
  const snippets: Snippet[] = [
    {
      id: 'keep',
      label: 'Keep',
      command: 'echo keep',
      kind: 'script',
      trigger: 'onConnect',
    },
  ];
  const hosts: Host[] = [
    {
      id: 'host-a',
      name: 'Host A',
      host: 'host-a.example.com',
      port: 22,
      username: 'root',
      loginScriptId: 'gone',
      connectScriptIds: ['gone', 'keep'],
    },
  ];

  const pruned = pruneHostsStaleSnippetBindings(hosts, snippets);
  assert.notEqual(pruned, hosts);
  assert.equal(pruned[0].loginScriptId, undefined);
  assert.deepEqual(pruned[0].connectScriptIds, ['keep']);
  assert.equal(
    pruneHostsStaleSnippetBindings(pruned, snippets),
    pruned,
  );
});

test('rebaseSnippetVaultWrite does not resurrect snippets deleted on disk', () => {
  const base: Snippet[] = [
    { id: 'a', label: 'A', command: 'echo a' },
    { id: 'b', label: 'B', command: 'echo b' },
  ];
  const ours: Snippet[] = [
    { id: 'a', label: 'A edited', command: 'echo a2' },
    { id: 'b', label: 'B', command: 'echo b' },
  ];
  // Concurrent bulk-delete removed B before our queued save ran.
  const theirs: Snippet[] = [
    { id: 'a', label: 'A', command: 'echo a' },
  ];

  const merged = rebaseSnippetVaultWrite({ base, ours, theirs });
  assert.deepEqual(merged.map((snippet) => snippet.id), ['a']);
  assert.equal(merged[0]?.label, 'A edited');
});

test('rebaseSnippetVaultWrite keeps local adds when base is the persisted ancestor', () => {
  // Queued save 1 added X (never persisted); save 2 edited X. Rebase must use
  // the disk ancestor — not save 1's optimistic array — or X looks deleted.
  const persisted: Snippet[] = [
    { id: 'a', label: 'A', command: 'echo a' },
  ];
  const afterAdd: Snippet[] = [
    { id: 'a', label: 'A', command: 'echo a' },
    { id: 'x', label: 'X', command: 'echo x' },
  ];
  const afterEdit: Snippet[] = [
    { id: 'a', label: 'A', command: 'echo a' },
    { id: 'x', label: 'X edited', command: 'echo x2' },
  ];

  const wrongBase = rebaseSnippetVaultWrite({
    base: afterAdd,
    ours: afterEdit,
    theirs: persisted,
  });
  assert.deepEqual(wrongBase.map((snippet) => snippet.id), ['a']);

  const merged = rebaseSnippetVaultWrite({
    base: persisted,
    ours: afterEdit,
    theirs: persisted,
  });
  assert.deepEqual(merged.map((snippet) => snippet.id), ['a', 'x']);
  assert.equal(merged[1]?.label, 'X edited');
  assert.equal(merged[1]?.command, 'echo x2');
});

test('rebaseSnippetVaultWrite keeps concurrent disk additions and local additions', () => {
  const base: Snippet[] = [
    { id: 'a', label: 'A', command: 'echo a' },
  ];
  const ours: Snippet[] = [
    { id: 'a', label: 'A', command: 'echo a' },
    { id: 'local', label: 'Local', command: 'echo local' },
  ];
  const theirs: Snippet[] = [
    { id: 'a', label: 'A', command: 'echo a' },
    { id: 'remote', label: 'Remote', command: 'echo remote' },
  ];

  const merged = rebaseSnippetVaultWrite({ base, ours, theirs });
  assert.deepEqual(merged.map((snippet) => snippet.id).sort(), ['a', 'local', 'remote']);
});

test('rebaseSnippetVaultWrite preserves concurrent disk adds across a local clear', () => {
  // Documents why clearVaultData must bypass rebase (replace: true): an empty
  // local array still looks like "keep theirs-only ids" under 3-way merge.
  const base: Snippet[] = [
    { id: 'a', label: 'A', command: 'echo a' },
  ];
  const ours: Snippet[] = [];
  const theirs: Snippet[] = [
    { id: 'a', label: 'A', command: 'echo a' },
    { id: 'remote', label: 'Remote', command: 'echo remote' },
  ];

  const merged = rebaseSnippetVaultWrite({ base, ours, theirs });
  assert.deepEqual(merged.map((snippet) => snippet.id), ['remote']);
});

test('rebaseSnippetVaultWrite keeps local deletes even when disk still has the row', () => {
  const base: Snippet[] = [
    { id: 'a', label: 'A', command: 'echo a' },
    { id: 'b', label: 'B', command: 'echo b' },
  ];
  const ours: Snippet[] = [
    { id: 'a', label: 'A', command: 'echo a' },
  ];
  const theirs: Snippet[] = [
    { id: 'a', label: 'A', command: 'echo a' },
    { id: 'b', label: 'B edited elsewhere', command: 'echo b2' },
  ];

  const merged = rebaseSnippetVaultWrite({ base, ours, theirs });
  assert.deepEqual(merged.map((snippet) => snippet.id), ['a']);
});

test('rebaseSnippetVaultWrite preserves concurrent disk edits of unrelated snippets', () => {
  const base: Snippet[] = [
    { id: 'a', label: 'A', command: 'echo a', order: 1000 },
    { id: 'b', label: 'B', command: 'echo b', order: 2000 },
  ];
  // Local edit/reorder of A only; B content matches base (order may renumber).
  const ours: Snippet[] = [
    { id: 'a', label: 'A edited', command: 'echo a2', order: 1000 },
    { id: 'b', label: 'B', command: 'echo b', order: 2000 },
  ];
  const theirs: Snippet[] = [
    { id: 'a', label: 'A', command: 'echo a', order: 1000 },
    { id: 'b', label: 'B edited elsewhere', command: 'echo b2', order: 2000 },
  ];

  const merged = rebaseSnippetVaultWrite({ base, ours, theirs });
  assert.deepEqual(merged.map((snippet) => snippet.id), ['a', 'b']);
  assert.equal(merged[0]?.label, 'A edited');
  assert.equal(merged[1]?.label, 'B edited elsewhere');
  assert.equal(merged[1]?.command, 'echo b2');
});

test('rebaseSnippetVaultWrite prefers local when both sides edited the same snippet', () => {
  const base: Snippet[] = [
    { id: 'a', label: 'A', command: 'echo a' },
  ];
  const ours: Snippet[] = [
    { id: 'a', label: 'A local', command: 'echo local' },
  ];
  const theirs: Snippet[] = [
    { id: 'a', label: 'A remote', command: 'echo remote' },
  ];

  const merged = rebaseSnippetVaultWrite({ base, ours, theirs });
  assert.equal(merged[0]?.label, 'A local');
  assert.equal(merged[0]?.command, 'echo local');
});

test('rebaseSnippetVaultWrite treats order-only local renumber as unchanged content', () => {
  const base: Snippet[] = [
    { id: 'a', label: 'A', command: 'echo a', order: 1000 },
    { id: 'b', label: 'B', command: 'echo b', order: 2000 },
  ];
  // Local reorder renumbers every row without editing B's body.
  const ours: Snippet[] = [
    { id: 'b', label: 'B', command: 'echo b', order: 1000 },
    { id: 'a', label: 'A', command: 'echo a', order: 2000 },
  ];
  const theirs: Snippet[] = [
    { id: 'a', label: 'A', command: 'echo a', order: 1000 },
    { id: 'b', label: 'B disk', command: 'echo b2', order: 2000 },
  ];

  const merged = rebaseSnippetVaultWrite({ base, ours, theirs });
  assert.deepEqual(merged.map((snippet) => snippet.id), ['b', 'a']);
  assert.equal(merged[0]?.label, 'B disk');
  assert.equal(merged[0]?.command, 'echo b2');
  // Keep local order field so the reorder is not undone by disk's stale order.
  assert.equal(merged[0]?.order, 1000);
  assert.equal(merged[1]?.order, 2000);
});

test('rebaseSnippetVaultWrite preserves concurrent disk reorder across unrelated local edits', () => {
  const base: Snippet[] = [
    { id: 'a', label: 'A', command: 'echo a', order: 1000 },
    { id: 'b', label: 'B', command: 'echo b', order: 2000 },
  ];
  // Local content edit of A only; relative order matches base.
  const ours: Snippet[] = [
    { id: 'a', label: 'A edited', command: 'echo a2', order: 1000 },
    { id: 'b', label: 'B', command: 'echo b', order: 2000 },
  ];
  // Another window reordered the list on disk.
  const theirs: Snippet[] = [
    { id: 'b', label: 'B', command: 'echo b', order: 1000 },
    { id: 'a', label: 'A', command: 'echo a', order: 2000 },
  ];

  const merged = rebaseSnippetVaultWrite({ base, ours, theirs });
  assert.deepEqual(merged.map((snippet) => snippet.id), ['b', 'a']);
  assert.equal(merged[0]?.order, 1000);
  assert.equal(merged[1]?.label, 'A edited');
  assert.equal(merged[1]?.command, 'echo a2');
  assert.equal(merged[1]?.order, 2000);
});

test('rebaseSnippetVaultWrite preserves disk insertion position across unrelated local edits', () => {
  const base: Snippet[] = [
    { id: 'a', label: 'A', command: 'echo a', order: 1000 },
    { id: 'b', label: 'B', command: 'echo b', order: 2000 },
  ];
  // Local content edit only; shared-id sequence still matches base.
  const ours: Snippet[] = [
    { id: 'a', label: 'A edited', command: 'echo a2', order: 1000 },
    { id: 'b', label: 'B', command: 'echo b', order: 2000 },
  ];
  // Another window inserted X between A and B and renumbered orders.
  const theirs: Snippet[] = [
    { id: 'a', label: 'A', command: 'echo a', order: 1000 },
    { id: 'x', label: 'X', command: 'echo x', order: 2000 },
    { id: 'b', label: 'B', command: 'echo b', order: 3000 },
  ];

  const merged = rebaseSnippetVaultWrite({ base, ours, theirs });
  assert.deepEqual(merged.map((snippet) => snippet.id), ['a', 'x', 'b']);
  assert.equal(merged[0]?.label, 'A edited');
  // Renumber so sortByVaultOrder matches the anchored sequence (X must not
  // share B's pre-merge order of 2000).
  assert.equal(merged[1]?.label, 'X');
  assert.equal(merged[0]?.order, 1000);
  assert.equal(merged[1]?.order, 2000);
  assert.equal(merged[2]?.order, 3000);
});

test('rebaseSnippetVaultWrite preserves remote insertion anchors alongside local additions', () => {
  const base: Snippet[] = [
    { id: 'a', label: 'A', command: 'echo a', order: 1000 },
    { id: 'b', label: 'B', command: 'echo b', order: 2000 },
  ];
  // Local append — must not force whole-list "ours first" ordering.
  const ours: Snippet[] = [
    { id: 'a', label: 'A', command: 'echo a', order: 1000 },
    { id: 'b', label: 'B', command: 'echo b', order: 2000 },
    { id: 'l', label: 'Local', command: 'echo l', order: 3000 },
  ];
  // Remote inserted R between A and B.
  const theirs: Snippet[] = [
    { id: 'a', label: 'A', command: 'echo a', order: 1000 },
    { id: 'r', label: 'Remote', command: 'echo r', order: 2000 },
    { id: 'b', label: 'B', command: 'echo b', order: 3000 },
  ];

  const merged = rebaseSnippetVaultWrite({ base, ours, theirs });
  assert.deepEqual(merged.map((snippet) => snippet.id), ['a', 'r', 'b', 'l']);
  assert.deepEqual(
    merged.map((snippet) => snippet.order),
    [1000, 2000, 3000, 4000],
  );
});

test('rebaseSnippetVaultWrite preserves disk reorder alongside a local addition', () => {
  const base: Snippet[] = [
    { id: 'a', label: 'A', command: 'echo a', order: 1000 },
    { id: 'b', label: 'B', command: 'echo b', order: 2000 },
  ];
  // Local window only added X; shared-id sequence still matches base.
  const ours: Snippet[] = [
    { id: 'a', label: 'A', command: 'echo a', order: 1000 },
    { id: 'b', label: 'B', command: 'echo b', order: 2000 },
    { id: 'x', label: 'X', command: 'echo x', order: 3000 },
  ];
  // Another window reordered existing snippets on disk.
  const theirs: Snippet[] = [
    { id: 'b', label: 'B', command: 'echo b', order: 1000 },
    { id: 'a', label: 'A', command: 'echo a', order: 2000 },
  ];

  const merged = rebaseSnippetVaultWrite({ base, ours, theirs });
  assert.deepEqual(merged.map((snippet) => snippet.id), ['b', 'a', 'x']);
  assert.equal(merged[0]?.order, 1000);
  assert.equal(merged[1]?.order, 2000);
  assert.equal(merged[2]?.label, 'X');
});
