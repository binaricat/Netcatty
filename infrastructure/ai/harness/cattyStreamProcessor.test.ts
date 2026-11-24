import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { MockLanguageModelV4, simulateReadableStream } from 'ai/test';
import { processCattyStream, shouldEmitAgentEventsForStreamChunk, exhaustedStepBudget } from './turnDrivers/cattyStreamProcessor';
import { createInitialCattyRuntimeContext } from './cattyRuntimeContext';
import { nextStepBudgetAction } from './turnDrivers/cattyTurnDriver';
import type { ChatMessage } from '../types';

describe('nextStepBudgetAction', () => {
  it('finishes a round the model ended on its own', () => {
    assert.equal(nextStepBudgetAction(false, 0), 'done');
    assert.equal(nextStepBudgetAction(undefined, 2), 'done');
  });

  it('resumes a step-budget pause until the resume budget is spent', () => {
    assert.equal(nextStepBudgetAction(true, 0, 3), 'resume');
    assert.equal(nextStepBudgetAction(true, 2, 3), 'resume');
  });

  it('pauses with a notice once the resume budget is spent', () => {
    assert.equal(nextStepBudgetAction(true, 3, 3), 'pause');
    assert.equal(nextStepBudgetAction(true, 4, 3), 'pause');
  });
});

describe('exhaustedStepBudget', () => {
  it('treats a full step window that still wanted tools as a pause', () => {
    assert.equal(exhaustedStepBudget(20, 20, 'tool-calls'), true);
    assert.equal(exhaustedStepBudget(25, 20, 'tool-calls'), true);
  });

  it('does not resume when the model finished on its own', () => {
    assert.equal(exhaustedStepBudget(20, 20, 'stop'), false);
    assert.equal(exhaustedStepBudget(20, 20, 'length'), false);
    assert.equal(exhaustedStepBudget(20, 20, undefined), false);
  });

  it('does not resume before the budget is spent', () => {
    assert.equal(exhaustedStepBudget(19, 20, 'tool-calls'), false);
  });
});

describe('shouldEmitAgentEventsForStreamChunk', () => {
  it('suppresses trace events for SDK internal stream-state errors', () => {
    assert.equal(
      shouldEmitAgentEventsForStreamChunk({
        type: 'error',
        error: new Error('reasoning part abc not found'),
      }),
      false,
    );
  });

  it('still emits trace events for real stream errors', () => {
    assert.equal(
      shouldEmitAgentEventsForStreamChunk({
        type: 'error',
        error: new Error('Provider returned HTTP 500'),
      }),
      true,
    );
    assert.equal(
      shouldEmitAgentEventsForStreamChunk({ type: 'text-delta', text: 'hi' }),
      true,
    );
  });
});

describe('processCattyStream reasoning continuation', () => {
  it('persists reasoning encrypted content delivered on reasoning-end', async () => {
    const model = new MockLanguageModelV4({
      doStream: async () => ({
        stream: simulateReadableStream({
          chunks: [
            { type: 'stream-start', warnings: [] },
            {
              type: 'reasoning-start',
              id: 'r1',
              providerMetadata: { openai: { itemId: 'rs_1' } },
            },
            {
              type: 'reasoning-delta',
              id: 'r1',
              delta: 'thinking',
              providerMetadata: { openai: { itemId: 'rs_1' } },
            },
            {
              type: 'reasoning-end',
              id: 'r1',
              providerMetadata: {
                openai: { itemId: 'rs_1', reasoningEncryptedContent: 'enc-abc' },
              },
            },
            {
              type: 'finish',
              finishReason: { unified: 'stop', raw: undefined },
              usage: {
                inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
                outputTokens: { total: 1, text: 1, reasoning: undefined },
              },
            },
          ],
        }),
      }),
    });

    const messages = new Map<string, ChatMessage>();
    messages.set('assistant-1', {
      id: 'assistant-1',
      role: 'assistant',
      content: '',
      timestamp: 0,
    });
    const ui = {
      addMessageToSession: (sessionId: string, message: ChatMessage) => {
        messages.set(message.id, message);
      },
      updateMessageById: (sessionId: string, messageId: string, updater: (msg: ChatMessage) => ChatMessage) => {
        const message = messages.get(messageId);
        if (message) messages.set(messageId, updater(message));
      },
    };

    await processCattyStream({
      streamSessionId: 'session-1',
      model,
      systemPrompt: 'test',
      toolsBundle: { tools: {}, toolsContext: {} },
      sdkMessages: [{ role: 'user', content: 'hello' }],
      signal: new AbortController().signal,
      currentAssistantMsgId: 'assistant-1',
      maxIterations: 1,
      runtimeContext: createInitialCattyRuntimeContext({
        chatSessionId: 'session-1',
        turnId: 'turn-1',
        permissionMode: 'auto',
        scopeType: 'terminal',
      }),
      ui,
    });

    const continuation = messages.get('assistant-1')?.providerContinuation;
    const encryptedContent = continuation?.reasoningParts?.at(-1)?.providerOptions?.openai
      ?.reasoningEncryptedContent;
    assert.equal(encryptedContent, 'enc-abc');
    assert.match(continuation?.reasoningParts?.map(part => part.text).join('') ?? '', /thinking/);
  });
});
