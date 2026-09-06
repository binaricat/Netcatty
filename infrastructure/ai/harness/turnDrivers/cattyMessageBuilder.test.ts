import assert from 'node:assert/strict';
import test from 'node:test';
import { ToolOutputStore } from '../toolOutputStore';
import {
  buildCattySdkMessages,
  createContinuationContext,
} from './cattyMessageBuilder';
import type { ChatMessage } from '../../types';
import { prepareCattyMessagesForStream } from '../cattyRuntime';

function buildHistory(messages: ChatMessage[]) {
  return buildCattySdkMessages({
    allMessages: messages,
    includeCurrentUserMessage: false,
    trimmed: '',
    continuationContext: createContinuationContext('provider-1', 'openai', 'model-1', true),
    chatSessionId: 'chat-1',
    toolOutputStore: new ToolOutputStore(),
    fieldsByMessage: new Map(),
  });
}

test('legacy reasoning parts with an rs_ item id but no encrypted content are dropped from replay', () => {
  const messages: ChatMessage[] = [{
    id: 'assistant-1',
    role: 'assistant',
    content: 'Done.',
    timestamp: 1,
    providerContinuation: {
      source: { providerConfigId: 'provider-1', providerType: 'openai', modelId: 'model-1' },
      reasoningParts: [
        {
          text: 'legacy reasoning',
          providerOptions: { openai: { itemId: 'rs_legacy' } },
        },
      ],
    },
  }];

  const sdkMessages = buildHistory(messages);

  assert.equal(sdkMessages.length, 1);
  // With the legacy reasoning part dropped, only text remains, so the
  // assistant content collapses to a plain string.
  assert.equal(sdkMessages[0].content, 'Done.');
});

test('reasoning parts with encrypted content and non-OpenAI reasoning parts survive replay', () => {
  const messages: ChatMessage[] = [{
    id: 'assistant-1',
    role: 'assistant',
    content: 'Done.',
    timestamp: 1,
    providerContinuation: {
      source: { providerConfigId: 'provider-1', providerType: 'openai', modelId: 'model-1' },
      reasoningParts: [
        {
          text: 'replayable reasoning',
          providerOptions: { openai: { itemId: 'rs_new', reasoningEncryptedContent: 'enc-abc' } },
        },
        {
          text: 'plain reasoning',
        },
      ],
    },
  }];

  const sdkMessages = buildHistory(messages);

  assert.equal(sdkMessages.length, 1);
  const content = sdkMessages[0].content;
  assert.ok(Array.isArray(content));
  assert.deepEqual(
    content.map((part) => (part as { type: string; text?: string }).text),
    ['replayable reasoning', 'plain reasoning', 'Done.'],
  );
});

test('an unreplayable reasoning item discards the whole tool-call exchange from replay', () => {
  const toolCall = { id: 'call-1', name: 'terminal_execute', arguments: { command: 'ls' } };
  const toolResult = {
    toolCallId: 'call-1',
    content: 'output',
  };
  const messages: ChatMessage[] = [
    {
      id: 'assistant-1',
      role: 'assistant',
      content: 'Running it.',
      timestamp: 1,
      providerContinuation: {
        source: { providerConfigId: 'provider-1', providerType: 'openai', modelId: 'model-1' },
        reasoningParts: [
          {
            text: 'legacy reasoning',
            providerOptions: { openai: { itemId: 'rs_legacy' } },
          },
        ],
      },
      toolCalls: [toolCall],
    },
    {
      id: 'tool-1',
      role: 'tool',
      content: '',
      timestamp: 3,
      toolResults: [toolResult],
    },
    {
      id: 'assistant-2',
      role: 'assistant',
      content: 'All done.',
      timestamp: 4,
    },
  ];

  const sdkMessages = buildHistory(messages);

  // The tool-call/tool-result exchange is discarded entirely; only the plain
  // assistant text messages survive replay.
  assert.equal(sdkMessages.length, 2);
  assert.equal(sdkMessages[0].content, 'Running it.');
  assert.equal(sdkMessages[1].content, 'All done.');

  const chatMessages = buildCattySdkMessages({
    allMessages: messages,
    includeCurrentUserMessage: false,
    trimmed: '',
    continuationContext: createContinuationContext('provider-1', 'openai', 'model-1', false),
    chatSessionId: 'chat-1',
    toolOutputStore: new ToolOutputStore(),
    fieldsByMessage: new Map(),
  });
  assert.equal(chatMessages.length, 3);
  assert.equal(chatMessages[1].role, 'tool');
});

test('a Responses model switch discards a reasoning-backed tool exchange from the old source', () => {
  const messages: ChatMessage[] = [
    {
      id: 'assistant-1',
      role: 'assistant',
      content: 'Running it.',
      timestamp: 1,
      providerContinuation: {
        source: { providerConfigId: 'provider-1', providerType: 'openai', modelId: 'model-1' },
        reasoningParts: [{
          text: 'replayable only for the original model',
          providerOptions: {
            openai: { itemId: 'rs_old_model', reasoningEncryptedContent: 'enc-old-model' },
          },
        }],
      },
      toolCalls: [{ id: 'call-1', name: 'terminal_execute', arguments: { command: 'ls' } }],
    },
    {
      id: 'tool-1',
      role: 'tool',
      content: '',
      timestamp: 2,
      toolResults: [{ toolCallId: 'call-1', content: 'output' }],
    },
  ];
  const buildForModel = (usesOpenAIResponses: boolean) => buildCattySdkMessages({
    allMessages: messages,
    includeCurrentUserMessage: false,
    trimmed: '',
    continuationContext: createContinuationContext(
      'provider-1',
      'openai',
      'model-2',
      usesOpenAIResponses,
    ),
    chatSessionId: 'chat-1',
    toolOutputStore: new ToolOutputStore(),
    fieldsByMessage: new Map(),
  });

  const responsesMessages = buildForModel(true);
  assert.deepEqual(responsesMessages, [{ role: 'assistant', content: 'Running it.' }]);

  // Chat Completions does not require a Responses reasoning item alongside
  // the generic call/result pair, so keep the existing cross-model behavior.
  const chatMessages = buildForModel(false);
  assert.equal(chatMessages.length, 2);
  assert.equal(chatMessages[1].role, 'tool');
});

test('a Responses provider switch keeps a non-OpenAI reasoning tool exchange', () => {
  const messages: ChatMessage[] = [
    {
      id: 'assistant-1',
      role: 'assistant',
      content: 'Running it.',
      timestamp: 1,
      providerContinuation: {
        source: { providerConfigId: 'anthropic-1', providerType: 'anthropic', modelId: 'claude' },
        reasoningParts: [{
          text: 'prior Anthropic thinking',
          providerOptions: { anthropic: { signature: 'sig-1' } },
        }],
      },
      toolCalls: [{ id: 'call-1', name: 'terminal_execute', arguments: { command: 'ls' } }],
    },
    {
      id: 'tool-1',
      role: 'tool',
      content: '',
      timestamp: 2,
      toolResults: [{ toolCallId: 'call-1', content: 'output' }],
    },
  ];

  const sdkMessages = buildCattySdkMessages({
    allMessages: messages,
    includeCurrentUserMessage: false,
    trimmed: '',
    continuationContext: createContinuationContext('openai-1', 'openai', 'gpt-5', true),
    chatSessionId: 'chat-1',
    toolOutputStore: new ToolOutputStore(),
    fieldsByMessage: new Map(),
  });

  assert.equal(sdkMessages.length, 2);
  const assistantContent = sdkMessages[0].content;
  assert.ok(Array.isArray(assistantContent));
  assert.deepEqual(
    assistantContent.map(part => part.type),
    ['text', 'tool-call'],
  );
  assert.equal(sdkMessages[1].role, 'tool');
});

test('metadata-free Responses reasoning discards its paired tool exchange', () => {
  const messages: ChatMessage[] = [
    {
      id: 'assistant-1',
      role: 'assistant',
      content: 'Running it.',
      timestamp: 1,
      providerContinuation: {
        source: { providerConfigId: 'provider-1', providerType: 'openai', modelId: 'model-1' },
        reasoningParts: [{ text: 'relay reasoning without replay metadata' }],
      },
      toolCalls: [{ id: 'call-1', name: 'terminal_execute', arguments: { command: 'ls' } }],
    },
    {
      id: 'tool-1',
      role: 'tool',
      content: '',
      timestamp: 2,
      toolResults: [{ toolCallId: 'call-1', content: 'output' }],
    },
  ];

  const responsesMessages = buildHistory(messages);
  assert.deepEqual(responsesMessages, [{ role: 'assistant', content: 'Running it.' }]);

  const responsesAfterModelSwitch = buildCattySdkMessages({
    allMessages: messages,
    includeCurrentUserMessage: false,
    trimmed: '',
    continuationContext: createContinuationContext('provider-1', 'openai', 'model-2', true),
    chatSessionId: 'chat-1',
    toolOutputStore: new ToolOutputStore(),
    fieldsByMessage: new Map(),
  });
  assert.deepEqual(
    responsesAfterModelSwitch,
    [{ role: 'assistant', content: 'Running it.' }],
  );

  const chatMessages = buildCattySdkMessages({
    allMessages: messages,
    includeCurrentUserMessage: false,
    trimmed: '',
    continuationContext: createContinuationContext('provider-1', 'openai', 'model-1', false),
    chatSessionId: 'chat-1',
    toolOutputStore: new ToolOutputStore(),
    fieldsByMessage: new Map(),
  });
  assert.equal(chatMessages.length, 2);
  assert.equal(chatMessages[1].role, 'tool');
});

test('same-provider Chat to Responses switches keep the generic tool exchange', () => {
  const messages: ChatMessage[] = [
    {
      id: 'assistant-1',
      role: 'assistant',
      content: 'Running it.',
      timestamp: 1,
      providerContinuation: {
        source: { providerConfigId: 'provider-1', providerType: 'openai', modelId: 'model-1' },
        reasoningParts: [{ text: 'OpenAI Chat reasoning' }],
        openAIChatAssistantFields: { reasoning_content: 'OpenAI Chat reasoning' },
      },
      toolCalls: [{ id: 'call-1', name: 'terminal_execute', arguments: { command: 'ls' } }],
    },
    {
      id: 'tool-1',
      role: 'tool',
      content: '',
      timestamp: 2,
      toolResults: [{ toolCallId: 'call-1', content: 'output' }],
    },
  ];

  for (const modelId of ['model-1', 'model-2']) {
    const responsesMessages = buildCattySdkMessages({
      allMessages: messages,
      includeCurrentUserMessage: false,
      trimmed: '',
      continuationContext: createContinuationContext('provider-1', 'openai', modelId, true),
      chatSessionId: 'chat-1',
      toolOutputStore: new ToolOutputStore(),
      fieldsByMessage: new Map(),
    });

    assert.equal(responsesMessages.length, 2);
    const assistantContent = responsesMessages[0].content;
    assert.ok(Array.isArray(assistantContent));
    assert.deepEqual(
      assistantContent.map(part => part.type),
      ['text', 'tool-call'],
    );
    assert.equal(responsesMessages[1].role, 'tool');
  }
});

test('a durable summary survives when storage trimming shifts its boundary to zero', () => {
  const sdkMessages = buildCattySdkMessages({
    allMessages: [{
      id: 'recent-user',
      role: 'user',
      content: 'What should I do next?',
      timestamp: 1,
    }],
    contextCompaction: {
      summary: 'Earlier work completed the deployment.',
      compactedMessageCount: 0,
    },
    includeCurrentUserMessage: false,
    trimmed: '',
    continuationContext: createContinuationContext('provider-1', 'openai', 'model-1', true),
    chatSessionId: 'chat-1',
    toolOutputStore: new ToolOutputStore(),
    fieldsByMessage: new Map(),
  });

  assert.equal(sdkMessages.length, 3);
  assert.match(String(sdkMessages[0].content), /Earlier work completed the deployment/);
  assert.equal(sdkMessages[2].content, 'What should I do next?');
});

test('tool exchanges with replayable reasoning are kept intact', () => {
  const toolCall = { id: 'call-1', name: 'terminal_execute', arguments: { command: 'ls' } };
  const toolResult = {
    toolCallId: 'call-1',
    content: 'output',
  };
  const messages: ChatMessage[] = [
    {
      id: 'assistant-1',
      role: 'assistant',
      content: 'Running it.',
      timestamp: 1,
      providerContinuation: {
        source: { providerConfigId: 'provider-1', providerType: 'openai', modelId: 'model-1' },
        reasoningParts: [
          {
            text: 'replayable reasoning',
            providerOptions: { openai: { itemId: 'rs_new', reasoningEncryptedContent: 'enc-abc' } },
          },
        ],
      },
      toolCalls: [toolCall],
    },
    {
      id: 'tool-1',
      role: 'tool',
      content: '',
      timestamp: 3,
      toolResults: [toolResult],
    },
  ];

  const sdkMessages = buildHistory(messages);

  assert.equal(sdkMessages.length, 2);
  const assistantContent = sdkMessages[0].content;
  assert.ok(Array.isArray(assistantContent));
  assert.deepEqual(
    assistantContent.map((part) => (part as { type: string }).type),
    ['reasoning', 'text', 'tool-call'],
  );
  assert.equal(sdkMessages[1].role, 'tool');
});

test('final Responses preparation preserves encrypted reasoning for a tool exchange', () => {
  const toolCall = { id: 'call-1', name: 'terminal_execute', arguments: { command: 'ls' } };
  const messages: ChatMessage[] = [
    {
      id: 'assistant-1',
      role: 'assistant',
      content: 'Running it.',
      timestamp: 1,
      providerContinuation: {
        source: { providerConfigId: 'provider-1', providerType: 'openai', modelId: 'model-1' },
        reasoningParts: [{
          text: 'replayable reasoning',
          providerOptions: {
            openai: { itemId: 'rs_new', reasoningEncryptedContent: 'enc-abc' },
          },
        }],
      },
      toolCalls: [toolCall],
    },
    {
      id: 'tool-1',
      role: 'tool',
      content: '',
      timestamp: 2,
      toolResults: [{ toolCallId: 'call-1', content: 'output' }],
    },
  ];

  const built = buildHistory(messages);
  const prepared = prepareCattyMessagesForStream(built, { preserveReasoning: true });
  const assistantContent = prepared[0].content;
  assert.ok(Array.isArray(assistantContent));
  const reasoning = assistantContent.find(part => part.type === 'reasoning');
  assert.deepEqual(reasoning?.providerOptions?.openai, {
    itemId: 'rs_new',
    reasoningEncryptedContent: 'enc-abc',
  });

  const defaultPrepared = prepareCattyMessagesForStream(built);
  const defaultAssistantContent = defaultPrepared[0].content;
  assert.ok(Array.isArray(defaultAssistantContent));
  assert.equal(defaultAssistantContent.some(part => part.type === 'reasoning'), false);
});

test('freshly streamed reasoning fragments with a null start payload keep the tool exchange', () => {
  // Mirrors a live `@ai-sdk/openai` Responses stream (store: false): the
  // reasoning-start fragment carries only the item id with
  // `reasoningEncryptedContent: null`, deltas omit the key, and the ciphertext
  // arrives on the reasoning-end fragment. The merge keeps both fragments for
  // the same item, which must still replay.
  const toolCall = { id: 'call-1', name: 'terminal_execute', arguments: { command: 'ls' } };
  const toolResult = {
    toolCallId: 'call-1',
    content: 'output',
  };
  const messages: ChatMessage[] = [
    {
      id: 'assistant-1',
      role: 'assistant',
      content: 'Running it.',
      timestamp: 1,
      providerContinuation: {
        source: { providerConfigId: 'provider-1', providerType: 'openai', modelId: 'model-1' },
        reasoningParts: [
          {
            text: '',
            providerOptions: { openai: { itemId: 'rs_new', reasoningEncryptedContent: null } },
          },
          {
            text: 'replayable reasoning',
            providerOptions: { openai: { itemId: 'rs_new', reasoningEncryptedContent: 'enc-abc' } },
          },
        ],
      },
      toolCalls: [toolCall],
    },
    {
      id: 'tool-1',
      role: 'tool',
      content: '',
      timestamp: 3,
      toolResults: [toolResult],
    },
  ];

  const sdkMessages = buildHistory(messages);

  assert.equal(sdkMessages.length, 2);
  const assistantContent = sdkMessages[0].content;
  assert.ok(Array.isArray(assistantContent));
  // The empty ID-only start fragment is dropped from the replayed content;
  // the encrypted fragment for the same item carries the ciphertext.
  assert.deepEqual(
    assistantContent.map((part) => (part as { type: string }).type),
    ['reasoning', 'text', 'tool-call'],
  );
  assert.equal(sdkMessages[1].role, 'tool');
});

test('every text fragment of a multi-fragment replayable reasoning item is kept', () => {
  // A Responses reasoning item with several summary parts gives every
  // fragment the same item id; the ciphertext arrives only on the final
  // `output_item.done` fragment. Replayability is per item id, so all text
  // fragments of the item must survive the replay filter.
  const messages: ChatMessage[] = [{
    id: 'assistant-1',
    role: 'assistant',
    content: 'Done.',
    timestamp: 1,
    providerContinuation: {
      source: { providerConfigId: 'provider-1', providerType: 'openai', modelId: 'model-1' },
      reasoningParts: [
        {
          text: 'first summary',
          providerOptions: { openai: { itemId: 'rs_new', reasoningEncryptedContent: null } },
        },
        {
          text: 'second summary',
          providerOptions: { openai: { itemId: 'rs_new', reasoningEncryptedContent: null } },
        },
        {
          text: '',
          providerOptions: { openai: { itemId: 'rs_new', reasoningEncryptedContent: 'enc-abc' } },
        },
      ],
    },
  }];

  const sdkMessages = buildHistory(messages);

  assert.equal(sdkMessages.length, 1);
  const content = sdkMessages[0].content;
  assert.ok(Array.isArray(content));
  assert.deepEqual(
    content.map((part) => (part as { type: string; text?: string }).text),
    ['first summary', 'second summary', '', 'Done.'],
  );
});

test('an item id whose every fragment lacks ciphertext still discards the tool exchange', () => {
  const toolCall = { id: 'call-1', name: 'terminal_execute', arguments: { command: 'ls' } };
  const toolResult = {
    toolCallId: 'call-1',
    content: 'output',
  };
  const messages: ChatMessage[] = [
    {
      id: 'assistant-1',
      role: 'assistant',
      content: 'Running it.',
      timestamp: 1,
      providerContinuation: {
        source: { providerConfigId: 'provider-1', providerType: 'openai', modelId: 'model-1' },
        reasoningParts: [
          {
            text: 'legacy reasoning',
            providerOptions: { openai: { itemId: 'rs_legacy', reasoningEncryptedContent: null } },
          },
        ],
      },
      toolCalls: [toolCall],
    },
    {
      id: 'tool-1',
      role: 'tool',
      content: '',
      timestamp: 3,
      toolResults: [toolResult],
    },
  ];

  const sdkMessages = buildHistory(messages);

  assert.equal(sdkMessages.length, 1);
  assert.equal(sdkMessages[0].content, 'Running it.');
});
