import assert from 'node:assert/strict';
import test from 'node:test';
import { findMatchEndingAfter } from './useOutputTriggers.ts';

test('findMatchEndingAfter skips stale overlap matches and finds current output', () => {
  const text = 'NETCATTY_TRIGGER_PROBE old\r\nprompt# NETCATTY_TRIGGER_PROBE: command not found\r\n';
  const minEndOffset = 'NETCATTY_TRIGGER_PROBE old\r\n'.length;
  const match = findMatchEndingAfter(text, 'NETCATTY_TRIGGER_PROBE', minEndOffset);
  assert.deepEqual(match, {
    value: 'NETCATTY_TRIGGER_PROBE',
    endOffset: 'NETCATTY_TRIGGER_PROBE old\r\nprompt# NETCATTY_TRIGGER_PROBE'.length,
  });
});

test('findMatchEndingAfter supports regex patterns', () => {
  const text = 'old done\r\nservice ready: 200\r\n';
  const minEndOffset = 'old done\r\n'.length;
  const match = findMatchEndingAfter(text, 'ready:\\s+\\d+', minEndOffset);
  assert.deepEqual(match, {
    value: 'ready: 200',
    endOffset: 'old done\r\nservice ready: 200'.length,
  });
});

test('findMatchEndingAfter returns null when matches are only stale', () => {
  const text = 'NETCATTY_TRIGGER_PROBE old\r\nnew output\r\n';
  const minEndOffset = 'NETCATTY_TRIGGER_PROBE old\r\n'.length;
  assert.equal(findMatchEndingAfter(text, 'NETCATTY_TRIGGER_PROBE', minEndOffset), null);
});
