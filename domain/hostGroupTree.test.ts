import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { buildHostGroupTree } from './hostGroupTree';
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

describe('buildHostGroupTree', () => {
  it('groups hosts and keeps ungrouped hosts separate', () => {
    const { groupTree, ungroupedHosts } = buildHostGroupTree(
      [
        host('1', 'web-1', 'prod/web'),
        host('2', 'db-1', 'prod/db'),
        host('3', 'local'),
      ],
      ['prod/web'],
    );

    assert.equal(groupTree.length, 1);
    assert.equal(groupTree[0].name, 'prod');
    assert.equal(ungroupedHosts.length, 1);
    assert.equal(ungroupedHosts[0].id, '3');
  });
});
