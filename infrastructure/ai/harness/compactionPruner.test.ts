import assert from 'node:assert/strict';
import test from 'node:test';
import type { ModelMessage } from 'ai';
import { pruneLastModelMessage, pruneUntilFitsCompaction } from './compactionPruner.ts';

test('pruneLastModelMessage removes trailing user and assistant pair', () => {
  const messages: ModelMessage[] = [
    { role: 'user', content: 'old' },
    {
      role: 'assistant',
      content: [{
        type: 'tool-call',
        toolCallId: 'call-1',
        toolName: 'terminal_execute',
        input: { command: 'pwd' },
      }],
    },
    {
      role: 'tool',
      content: [{
        type: 'tool-result',
        toolCallId: 'call-1',
        toolName: 'terminal_execute',
        output: { type: 'text', value: '/tmp' },
      }],
    },
    { role: 'user', content: 'recent' },
    { role: 'assistant', content: 'acknowledged' },
  ];
  const pruned = pruneLastModelMessage(messages);
  assert.equal(pruned.length, 3);
  assert.equal(pruned[0]?.content, 'old');
  assert.equal(pruned.at(-1)?.role, 'tool');
});

test('pruneUntilFitsCompaction shrinks history to fit budget', () => {
  const messages: ModelMessage[] = Array.from({ length: 20 }, (_, index) => ({
    role: index % 2 === 0 ? 'user' : 'assistant',
    content: 'word '.repeat(500),
  })) as ModelMessage[];

  const pruned = pruneUntilFitsCompaction({
    messages,
    availableForInput: 2_000,
    providerId: 'openai',
  });
  assert.ok(pruned.length < messages.length);
});

test('pruneUntilFitsCompaction drops oldest messages first', () => {
  const messages: ModelMessage[] = [
    { role: 'user', content: `oldest ${'x'.repeat(5_000)}` },
    ...Array.from({ length: 16 }, (_, index) => ({
      role: index % 2 === 0 ? 'assistant' : 'user',
      content: 'middle context',
    })) as ModelMessage[],
    { role: 'user', content: 'newest goal for current task' },
    { role: 'assistant', content: 'latest reply before tail split' },
  ];

  const pruned = pruneUntilFitsCompaction({
    messages,
    availableForInput: 800,
    providerId: 'openai',
  });
  const serialized = JSON.stringify(pruned);
  assert.match(serialized, /newest goal for current task/);
  assert.doesNotMatch(serialized, /oldest/);
});
