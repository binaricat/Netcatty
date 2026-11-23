import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DEFAULT_AI_SESSION_MESSAGE_CAP,
  MAX_AI_SESSION_MESSAGE_CAP,
  MIN_AI_SESSION_MESSAGE_CAP,
  normalizeAiSessionMessageCap,
} from './aiSessionMessageCap';

test('normalizeAiSessionMessageCap keeps in-range integers untouched', () => {
  assert.equal(normalizeAiSessionMessageCap(200), 200);
  assert.equal(normalizeAiSessionMessageCap(MIN_AI_SESSION_MESSAGE_CAP), MIN_AI_SESSION_MESSAGE_CAP);
  assert.equal(normalizeAiSessionMessageCap(MAX_AI_SESSION_MESSAGE_CAP), MAX_AI_SESSION_MESSAGE_CAP);
});

test('normalizeAiSessionMessageCap clamps below the minimum and above the maximum', () => {
  assert.equal(normalizeAiSessionMessageCap(10), MIN_AI_SESSION_MESSAGE_CAP);
  assert.equal(normalizeAiSessionMessageCap(49.4), MIN_AI_SESSION_MESSAGE_CAP);
  assert.equal(normalizeAiSessionMessageCap(5000), MAX_AI_SESSION_MESSAGE_CAP);
});

test('normalizeAiSessionMessageCap rounds fractional values and rejects non-finite input', () => {
  assert.equal(normalizeAiSessionMessageCap(120.6), 121);
  assert.equal(normalizeAiSessionMessageCap(Number.NaN), DEFAULT_AI_SESSION_MESSAGE_CAP);
  assert.equal(normalizeAiSessionMessageCap(Number.POSITIVE_INFINITY), DEFAULT_AI_SESSION_MESSAGE_CAP);
  assert.equal(normalizeAiSessionMessageCap(undefined), DEFAULT_AI_SESSION_MESSAGE_CAP);
  assert.equal(normalizeAiSessionMessageCap('not-a-number'), DEFAULT_AI_SESSION_MESSAGE_CAP);
});
