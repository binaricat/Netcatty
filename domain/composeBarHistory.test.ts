import assert from 'node:assert/strict';
import test from 'node:test';

import {
  appendComposeBarHistory,
  canNavigateComposeBarHistory,
  COMPOSE_BAR_HISTORY_MAX,
  navigateComposeBarHistory,
  normalizeComposeBarHistory,
} from './composeBarHistory';

test('appendComposeBarHistory ignores empty/whitespace-only commands', () => {
  assert.deepEqual(appendComposeBarHistory(['ls'], '   '), ['ls']);
  assert.deepEqual(appendComposeBarHistory([], ''), []);
});

test('appendComposeBarHistory appends newest entries and dedupes consecutive repeats', () => {
  assert.deepEqual(appendComposeBarHistory([], 'ls -la'), ['ls -la']);
  assert.deepEqual(appendComposeBarHistory(['ls -la'], 'ls -la'), ['ls -la']);
  assert.deepEqual(
    appendComposeBarHistory(['ls -la'], 'df -h'),
    ['ls -la', 'df -h'],
  );
});

test('appendComposeBarHistory preserves multi-line commands and caps length', () => {
  const multi = 'echo one\necho two';
  assert.deepEqual(appendComposeBarHistory(['pwd'], multi), ['pwd', multi]);

  const seeded = Array.from({ length: COMPOSE_BAR_HISTORY_MAX }, (_, i) => `cmd-${i}`);
  const next = appendComposeBarHistory(seeded, 'overflow');
  assert.equal(next.length, COMPOSE_BAR_HISTORY_MAX);
  assert.equal(next[0], 'cmd-1');
  assert.equal(next[next.length - 1], 'overflow');
});

test('normalizeComposeBarHistory keeps only non-empty strings', () => {
  assert.deepEqual(
    normalizeComposeBarHistory(['ls', '', 12, 'df', null, '  '] as unknown[]),
    ['ls', 'df'],
  );
});

test('canNavigateComposeBarHistory only steals arrows at first/last line', () => {
  const multi = 'line1\nline2\nline3';
  assert.equal(canNavigateComposeBarHistory(multi, 0, 'up'), true);
  assert.equal(canNavigateComposeBarHistory(multi, 3, 'up'), true);
  assert.equal(canNavigateComposeBarHistory(multi, 6, 'up'), false);
  assert.equal(canNavigateComposeBarHistory(multi, multi.length, 'down'), true);
  assert.equal(canNavigateComposeBarHistory(multi, 6, 'down'), false);
  assert.equal(canNavigateComposeBarHistory('single', 3, 'up'), true);
  assert.equal(canNavigateComposeBarHistory('single', 3, 'down'), true);
  assert.equal(canNavigateComposeBarHistory(multi, 0, 'up', 6), false);
});

test('navigateComposeBarHistory walks older/newer entries and restores the draft', () => {
  const entries = ['one', 'two', 'three'];

  const firstUp = navigateComposeBarHistory(
    { entries, index: entries.length, draft: '', currentValue: 'draft' },
    'up',
  );
  assert.deepEqual(firstUp, { index: 2, value: 'three', draft: 'draft' });

  const secondUp = navigateComposeBarHistory(
    { entries, index: 2, draft: 'draft', currentValue: 'three' },
    'up',
  );
  assert.deepEqual(secondUp, { index: 1, value: 'two', draft: 'draft' });

  const downToDraft = navigateComposeBarHistory(
    { entries, index: 2, draft: 'draft', currentValue: 'three' },
    'down',
  );
  assert.deepEqual(downToDraft, { index: 3, value: 'draft', draft: 'draft' });

  assert.equal(
    navigateComposeBarHistory(
      { entries, index: 0, draft: 'draft', currentValue: 'one' },
      'up',
    ),
    null,
  );
  assert.equal(
    navigateComposeBarHistory(
      { entries, index: entries.length, draft: 'draft', currentValue: 'draft' },
      'down',
    ),
    null,
  );
  assert.equal(
    navigateComposeBarHistory(
      { entries: [], index: 0, draft: '', currentValue: '' },
      'up',
    ),
    null,
  );
});
