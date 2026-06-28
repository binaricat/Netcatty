import assert from 'node:assert/strict';
import test from 'node:test';
import { formatLastSync, formatSyncDateTime } from './sync';

test('formatSyncDateTime renders yyyymmdd hhmm', () => {
  const timestamp = new Date(2025, 5, 28, 14, 30, 0).getTime();
  assert.equal(formatSyncDateTime(timestamp), '20250628 1430');
});

test('formatLastSync uses compact datetime for older timestamps', () => {
  const twoHoursAgo = Date.now() - 2 * 60 * 60 * 1000;
  const formatted = formatLastSync(twoHoursAgo);
  assert.match(formatted, /^\d{8} \d{4}$/);
});
