import assert from 'node:assert/strict';
import test from 'node:test';
import {
  arePinnedSnippetIdsEqual,
  normalizePinnedSnippetIds,
  reorderPinnedSnippetIds,
} from './composeBarPinnedSnippets';

test('normalizePinnedSnippetIds filters non-strings, empties, and duplicates preserving order', () => {
  assert.deepEqual(
    normalizePinnedSnippetIds(['a', '', 'b', 'a', null, 42, 'c', 'b']),
    ['a', 'b', 'c'],
  );
});

test('arePinnedSnippetIdsEqual checks exact order and length', () => {
  assert.equal(arePinnedSnippetIdsEqual(['a', 'b'], ['a', 'b']), true);
  assert.equal(arePinnedSnippetIdsEqual(['a', 'b'], ['b', 'a']), false);
  assert.equal(arePinnedSnippetIdsEqual(['a'], ['a', 'b']), false);
});

test('reorderPinnedSnippetIds moves a newly pinned snippet to the front before the first chip', () => {
  assert.deepEqual(
    reorderPinnedSnippetIds(['s1', 's2', 's3', 's4'], 's4', 's1', 'before'),
    ['s4', 's1', 's2', 's3'],
  );
});

test('reorderPinnedSnippetIds moves a chip to the end after the last chip', () => {
  assert.deepEqual(
    reorderPinnedSnippetIds(['s1', 's2', 's3', 's4'], 's1', 's4', 'after'),
    ['s2', 's3', 's4', 's1'],
  );
});

test('reorderPinnedSnippetIds supports before and after placement in the middle', () => {
  assert.deepEqual(
    reorderPinnedSnippetIds(['s1', 's2', 's3', 's4'], 's4', 's2', 'before'),
    ['s1', 's4', 's2', 's3'],
  );
  assert.deepEqual(
    reorderPinnedSnippetIds(['s1', 's2', 's3', 's4'], 's1', 's3', 'after'),
    ['s2', 's3', 's1', 's4'],
  );
});

test('reorderPinnedSnippetIds infers direction when position is omitted', () => {
  assert.deepEqual(
    reorderPinnedSnippetIds(['s1', 's2', 's3', 's4'], 's4', 's1'),
    ['s4', 's1', 's2', 's3'],
  );
  assert.deepEqual(
    reorderPinnedSnippetIds(['s1', 's2', 's3', 's4'], 's1', 's4'),
    ['s2', 's3', 's4', 's1'],
  );
});

test('reorderPinnedSnippetIds handles identical, unknown, deleted, and empty IDs gracefully', () => {
  assert.deepEqual(
    reorderPinnedSnippetIds(['s1', 's2', 's3'], 's2', 's2', 'before'),
    ['s1', 's2', 's3'],
  );
  assert.deepEqual(
    reorderPinnedSnippetIds(['s1', 's2', 's3'], 'deleted-id', 's1', 'before'),
    ['s1', 's2', 's3'],
  );
  assert.deepEqual(
    reorderPinnedSnippetIds(['s1', 's2', 's3'], 's3', 'missing-target', 'after'),
    ['s1', 's2', 's3'],
  );
  assert.deepEqual(
    reorderPinnedSnippetIds([], 's1', 's2', 'before'),
    [],
  );
});

test('reorderPinnedSnippetIds leaves adjacent no-op drops unchanged', () => {
  assert.deepEqual(
    reorderPinnedSnippetIds(['s1', 's2', 's3'], 's1', 's2', 'before'),
    ['s1', 's2', 's3'],
  );
  assert.deepEqual(
    reorderPinnedSnippetIds(['s1', 's2', 's3'], 's2', 's1', 'after'),
    ['s1', 's2', 's3'],
  );
});
