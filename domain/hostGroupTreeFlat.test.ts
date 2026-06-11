import test from 'node:test';
import assert from 'node:assert/strict';

import { buildHostGroupTree } from './hostGroupTree.ts';
import { flattenHostGroupTree, hostTreeFlatRowKey } from './hostGroupTreeFlat.ts';
import type { Host } from '../types';

const host = (id: string, label: string, group?: string): Host => ({
  id,
  label,
  hostname: `${id}.example.com`,
  username: 'root',
  port: 22,
  group,
  tags: [],
  os: 'linux',
});

test('flattenHostGroupTree emits group rows before visible children in saved order', () => {
  const { groupTree, ungroupedHosts } = buildHostGroupTree(
    [
      host('1', 'web-1', 'prod/web'),
      host('2', 'db-1', 'prod/db'),
      host('3', 'local'),
    ],
    ['prod/web'],
  );

  const expanded = new Set(['prod', 'prod/web', 'prod/db']);
  const rows = flattenHostGroupTree({
    groupNodes: groupTree,
    ungroupedHosts,
    expandedPaths: expanded,
    searchActive: false,
  });

  assert.deepEqual(
    rows.map((row) => (row.kind === 'group' ? `g:${row.node.path}` : `h:${row.host.id}`)),
    ['g:prod', 'g:prod/web', 'h:1', 'g:prod/db', 'h:2', 'h:3'],
  );
});

test('flattenHostGroupTree uses saved group order when provided', () => {
  const { groupTree, ungroupedHosts } = buildHostGroupTree(
    [
      host('1', 'web-1', 'prod/web'),
      host('2', 'db-1', 'prod/db'),
    ],
    ['prod/web', 'prod/db'],
    [
      { path: 'prod/db', order: 1000 },
      { path: 'prod/web', order: 2000 },
    ],
  );

  const rows = flattenHostGroupTree({
    groupNodes: groupTree,
    ungroupedHosts,
    expandedPaths: new Set(['prod', 'prod/web', 'prod/db']),
    searchActive: false,
  });

  assert.deepEqual(
    rows.map((row) => (row.kind === 'group' ? `g:${row.node.path}` : `h:${row.host.id}`)),
    ['g:prod', 'g:prod/db', 'h:2', 'g:prod/web', 'h:1'],
  );
});

test('flattenHostGroupTree uses saved group order for host-only groups', () => {
  const { groupTree, ungroupedHosts } = buildHostGroupTree(
    [
      host('1', 'web-1', 'prod/web'),
      host('2', 'db-1', 'prod/db'),
    ],
    [],
    [
      { path: 'prod/db', order: 1000 },
      { path: 'prod/web', order: 2000 },
    ],
  );

  const rows = flattenHostGroupTree({
    groupNodes: groupTree,
    ungroupedHosts,
    expandedPaths: new Set(['prod', 'prod/web', 'prod/db']),
    searchActive: false,
  });

  assert.deepEqual(
    rows.map((row) => (row.kind === 'group' ? `g:${row.node.path}` : `h:${row.host.id}`)),
    ['g:prod', 'g:prod/db', 'h:2', 'g:prod/web', 'h:1'],
  );
});

test('flattenHostGroupTree hides collapsed subtrees', () => {
  const { groupTree, ungroupedHosts } = buildHostGroupTree(
    [host('1', 'web-1', 'prod/web')],
    [],
  );

  const rows = flattenHostGroupTree({
    groupNodes: groupTree,
    ungroupedHosts,
    expandedPaths: new Set(['prod']),
    searchActive: false,
  });

  assert.deepEqual(rows.map(hostTreeFlatRowKey), ['g:prod', 'g:prod/web']);
});

test('flattenHostGroupTree expands all rows while searching', () => {
  const { groupTree, ungroupedHosts } = buildHostGroupTree(
    [host('1', 'web-1', 'prod/web')],
    [],
  );

  const rows = flattenHostGroupTree({
    groupNodes: groupTree,
    ungroupedHosts,
    expandedPaths: new Set(),
    searchActive: true,
  });

  assert.deepEqual(rows.map(hostTreeFlatRowKey), ['g:prod', 'g:prod/web', 'h:1']);
});
