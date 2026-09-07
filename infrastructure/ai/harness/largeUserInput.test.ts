import assert from 'node:assert/strict';
import test from 'node:test';
import { ToolOutputStore } from './toolOutputStore';
import { fitLargeUserInputForModel } from './largeUserInput';
import {
  buildCattySdkMessages,
  createContinuationContext,
} from './turnDrivers/cattyMessageBuilder';

test('fitLargeUserInputForModel keeps both ends and stores the full prompt', () => {
  const store = new ToolOutputStore();
  const input = `START-${'middle '.repeat(8_000)}-FINAL QUESTION`;
  const fitted = fitLargeUserInputForModel(input, 'chat-1', store);

  assert.match(fitted, /^START-/);
  assert.match(fitted, /FINAL QUESTION/);
  assert.match(fitted, /handleId=tool-output-/);
  assert.ok(fitted.length < input.length);
  const handle = store.listPendingHandles('chat-1')[0];
  assert.equal(handle.fullContent, input);
});

test('fitLargeUserInputForModel reuses one stable handle across history replays', () => {
  const store = new ToolOutputStore();
  const input = `START-${'history '.repeat(8_000)}-FINAL QUESTION`;

  const firstReplay = fitLargeUserInputForModel(input, 'chat-1', store);
  const secondReplay = fitLargeUserInputForModel(input, 'chat-1', store);

  assert.equal(secondReplay, firstReplay);
  assert.equal(store.listPendingHandles('chat-1').length, 1);
});

test('a large user message remains bounded with the same handle on the next turn', () => {
  const store = new ToolOutputStore();
  const input = `START-${'history '.repeat(8_000)}-FINAL QUESTION`;
  const firstTurnContent = fitLargeUserInputForModel(input, 'chat-1', store);
  const firstHandleId = firstTurnContent.match(/handleId=(tool-output-[A-Za-z0-9-]+)/)?.[1];
  assert.ok(firstHandleId);

  const buildHistory = () => buildCattySdkMessages({
    allMessages: [{
      id: 'user-1',
      role: 'user',
      content: input,
      timestamp: 1,
    }],
    includeCurrentUserMessage: true,
    trimmed: 'continue',
    continuationContext: createContinuationContext('provider-1', 'openai', 'model-1'),
    chatSessionId: 'chat-1',
    toolOutputStore: store,
    fieldsByMessage: new Map(),
  });

  const secondTurn = buildHistory();
  const retry = buildHistory();
  const replayContent = secondTurn[0]?.content;
  const retryContent = retry[0]?.content;
  assert.ok(typeof replayContent === 'string');
  assert.ok(typeof retryContent === 'string');
  assert.equal(replayContent, retryContent);
  assert.match(replayContent, new RegExp(`handleId=${firstHandleId}`));
  assert.ok(replayContent.length < input.length);
  assert.equal(store.listPendingHandles('chat-1').length, 1);
});

test('a persisted compaction boundary replaces older history with its summary', () => {
  const store = new ToolOutputStore();
  const messages = buildCattySdkMessages({
    allMessages: [
      { id: 'old-1', role: 'user', content: 'old secret question', timestamp: 1 },
      { id: 'old-2', role: 'assistant', content: 'old answer', timestamp: 2 },
      { id: 'recent-1', role: 'user', content: 'recent question', timestamp: 3 },
    ],
    contextCompaction: {
      summary: 'The earlier question was answered.',
      compactedMessageCount: 2,
    },
    includeCurrentUserMessage: false,
    trimmed: '',
    continuationContext: createContinuationContext('provider-1', 'openai', 'model-1'),
    chatSessionId: 'chat-1',
    toolOutputStore: store,
    fieldsByMessage: new Map(),
  });

  assert.equal(messages.length, 3);
  assert.match(String(messages[0]?.content), /The earlier question was answered/);
  assert.doesNotMatch(JSON.stringify(messages), /old secret question|old answer/);
  assert.match(JSON.stringify(messages), /recent question/);
});
