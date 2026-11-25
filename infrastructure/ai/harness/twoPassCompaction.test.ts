import assert from 'node:assert/strict';
import test from 'node:test';
import type { ModelMessage } from 'ai';
import { TwoPassCompactionCache, fingerprintMessages } from './twoPassCompaction';

test('fingerprintMessages includes complete tool arguments canonically', () => {
  const a: ModelMessage[] = [{
    role: 'assistant',
    content: [{ type: 'tool-call', toolCallId: '1', toolName: 'terminal_execute', input: { b: 2, a: 1 } }],
  }];
  const reordered: ModelMessage[] = [{
    role: 'assistant',
    content: [{ type: 'tool-call', toolCallId: '1', toolName: 'terminal_execute', input: { a: 1, b: 2 } }],
  }];
  const changed: ModelMessage[] = [{
    role: 'assistant',
    content: [{ type: 'tool-call', toolCallId: '1', toolName: 'terminal_execute', input: { a: 9, b: 2 } }],
  }];

  assert.equal(fingerprintMessages(a), fingerprintMessages(reordered));
  assert.notEqual(fingerprintMessages(a), fingerprintMessages(changed));
});

test('TwoPassCompactionCache reuses only an unchanged model and prefix', async () => {
  const cache = new TwoPassCompactionCache();
  const messages = Array.from({ length: 20 }, (_, index) => ({
    role: index % 2 ? 'assistant' : 'user',
    content: `message ${index}`,
  })) as ModelMessage[];
  cache.start('chat-1', 'model-a', messages, async () => 'NOTE1');

  const hit = await cache.consume('chat-1', 'model-a', messages);
  assert.equal(hit?.note, 'NOTE1');
  assert.ok((hit?.prefixLength ?? 0) < messages.length);
  assert.equal(await cache.consume('chat-1', 'model-b', messages), undefined);
});

test('TwoPassCompactionCache deletes consumed entries so they are not retained or reused', async () => {
  const cache = new TwoPassCompactionCache();
  const messages = Array.from({ length: 20 }, (_, index) => ({
    role: index % 2 ? 'assistant' : 'user',
    content: `message ${index}`,
  })) as ModelMessage[];

  assert.equal(cache.start('chat-1', 'model-a', messages, async () => 'NOTE1'), true);
  const first = await cache.consume('chat-1', 'model-a', messages);
  assert.equal(first?.note, 'NOTE1');

  // Consumed entry is deleted immediately after awaiting, so a second consume misses
  // and a new start() can re-prime cleanly.
  assert.equal(await cache.consume('chat-1', 'model-a', messages), undefined);
  assert.equal(cache.start('chat-1', 'model-a', messages, async () => 'NOTE2'), true);
  const second = await cache.consume('chat-1', 'model-a', messages);
  assert.equal(second?.note, 'NOTE2');
});

test('TwoPassCompactionCache.consume preserves a concurrent re-prime installed while awaiting', async () => {
  const cache = new TwoPassCompactionCache();
  const messages1 = Array.from({ length: 20 }, (_, index) => ({
    role: index % 2 ? 'assistant' : 'user',
    content: `turn1-${index}`,
  })) as ModelMessage[];
  const messages2 = Array.from({ length: 24 }, (_, index) => ({
    role: index % 2 ? 'assistant' : 'user',
    content: `turn2-${index}`,
  })) as ModelMessage[];

  let resolveFirst!: (value: string) => void;
  cache.start('chat-1', 'model-a', messages1, () => new Promise<string>((resolve) => {
    resolveFirst = resolve;
  }));

  // Begin consuming entry 1 (suspends on notePromise)
  const pendingFirst = cache.consume('chat-1', 'model-a', messages1);

  // While entry 1 is awaiting, re-prime chat-1 with entry 2
  assert.equal(cache.start('chat-1', 'model-a', messages2, async () => 'NOTE2'), true);

  // Finish entry 1: must return NOTE1 and MUST NOT delete entry 2
  resolveFirst('NOTE1');
  const first = await pendingFirst;
  assert.equal(first?.note, 'NOTE1');

  const second = await cache.consume('chat-1', 'model-a', messages2);
  assert.equal(second?.note, 'NOTE2');
});

test('TwoPassCompactionCache evicts least-recently-used sessions beyond maxSessions', async () => {
  const cache = new TwoPassCompactionCache(2);
  const makeMessages = (tag: string) => Array.from({ length: 20 }, (_, index) => ({
    role: index % 2 ? 'assistant' : 'user',
    content: `${tag}-${index}`,
  })) as ModelMessage[];

  const m1 = makeMessages('s1');
  const m2 = makeMessages('s2');
  const m3 = makeMessages('s3');

  assert.equal(cache.start('s1', 'model-a', m1, async () => 'NOTE-S1'), true);
  assert.equal(cache.start('s2', 'model-a', m2, async () => 'NOTE-S2'), true);
  // Touch s1 via start() hit so s2 becomes the LRU entry
  assert.equal(cache.start('s1', 'model-a', m1, async () => 'UNUSED'), false);
  // Starting s3 evicts s2 while keeping s1 and s3
  assert.equal(cache.start('s3', 'model-a', m3, async () => 'NOTE-S3'), true);

  assert.equal(await cache.consume('s2', 'model-a', m2), undefined);
  assert.equal((await cache.consume('s1', 'model-a', m1))?.note, 'NOTE-S1');
  assert.equal((await cache.consume('s3', 'model-a', m3))?.note, 'NOTE-S3');
});
