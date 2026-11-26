import assert from 'node:assert/strict';
import test from 'node:test';
import {
  normalizeGroupTargetPath,
  resolveHostGroupForSave,
  remapSnippetTargetGroupPaths,
  removeSnippetTargetGroupPaths,
} from './hostGroupPathMutations.ts';
import type { Snippet } from './models';

const dirtyPaths = ['prod / web', 'prod//web', 'prod\\web', ' prod / web ', '/ prod / / web //'];

test('Host Details normalizes new and changed group paths with the shared rules', () => {
  for (const value of dirtyPaths) {
    assert.equal(normalizeGroupTargetPath(value), 'prod/web');
    assert.equal(resolveHostGroupForSave(value), 'prod/web', 'new host');
    assert.equal(resolveHostGroupForSave(value, ''), 'prod/web', 'previously ungrouped host');
    assert.equal(resolveHostGroupForSave(value, 'staging'), 'prod/web', 'changed group');
  }
});

test('Host Details preserves unchanged stored paths on unrelated edits', () => {
  for (const storedGroup of [...dirtyPaths, '', '   ']) {
    const value = storedGroup.trim() || storedGroup || '';
    assert.equal(resolveHostGroupForSave(value, storedGroup), storedGroup);
    assert.equal(resolveHostGroupForSave(storedGroup, storedGroup), storedGroup);
  }
});

test('Host Details normalizes an explicitly changed group equivalent after trimming', () => {
  for (const storedGroup of [' prod/web ', ' prod / web ']) {
    assert.equal(resolveHostGroupForSave(storedGroup.trim(), storedGroup, true), 'prod/web');
  }
});

test('Host Details allows changed paths to normalize to ungrouped', () => {
  for (const value of ['', ' / / \\ ']) {
    assert.equal(resolveHostGroupForSave(value, 'prod / web'), '');
    assert.equal(resolveHostGroupForSave(value), '');
  }
});

const snippets: Snippet[] = [{
  id: 'script-a',
  label: 'A',
  command: 'echo a',
  kind: 'script',
  targetGroups: ['Production', 'Production/Web', 'Staging'],
}];

test('remapSnippetTargetGroupPaths follows group rename and descendants', () => {
  const next = remapSnippetTargetGroupPaths(snippets, 'Production', 'Platform');
  assert.deepEqual(next[0].targetGroups, ['Platform', 'Platform/Web', 'Staging']);
});

test('removeSnippetTargetGroupPaths removes a deleted group subtree', () => {
  const next = removeSnippetTargetGroupPaths(snippets, ['Production']);
  assert.deepEqual(next[0].targetGroups, ['Staging']);
});

test('removeSnippetTargetGroupPaths preserves an explicit empty scope', () => {
  const next = removeSnippetTargetGroupPaths([
    { ...snippets[0], targetGroups: ['Production'] },
  ], ['Production']);
  assert.deepEqual(next[0].targetGroups, []);
});

test('remapSnippetTargetGroupPaths deduplicates rename collisions', () => {
  const next = remapSnippetTargetGroupPaths([
    { ...snippets[0], targetGroups: ['Platform', 'Production'] },
  ], 'Production', 'Platform');
  assert.deepEqual(next[0].targetGroups, ['Platform']);
});

test('group path mutations normalize imported legacy paths', () => {
  const legacy = [{ ...snippets[0], targetGroups: [' Production\\Web ', 'Production//Web'] }];
  const renamed = remapSnippetTargetGroupPaths(legacy, 'Production/Web', 'Platform/Web');
  assert.deepEqual(renamed[0].targetGroups, ['Platform/Web']);
  const removed = removeSnippetTargetGroupPaths(legacy, ['Production/Web']);
  assert.deepEqual(removed[0].targetGroups, []);
});
