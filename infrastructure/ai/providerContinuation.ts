export type ProviderContinuationJSONValue =
  | string
  | number
  | boolean
  | null
  | ProviderContinuationJSONValue[]
  | { [key: string]: ProviderContinuationJSONValue };

export type ProviderContinuationOptions = Record<string, Record<string, ProviderContinuationJSONValue>>;

export interface ProviderContinuationReasoningPart {
  text: string;
  providerOptions?: ProviderContinuationOptions;
}

export interface ProviderContinuation {
  reasoningParts?: ProviderContinuationReasoningPart[];
  openAIChatAssistantFields?: Record<string, unknown>;
}

export type OpenAIChatAssistantFields = Record<string, unknown>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseRawValue(rawValue: unknown): unknown {
  if (typeof rawValue !== 'string') return rawValue;
  try {
    return JSON.parse(rawValue);
  } catch {
    return rawValue;
  }
}

function toContinuationJSONValue(value: unknown): ProviderContinuationJSONValue | undefined {
  if (value === null) return null;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }
  if (Array.isArray(value)) {
    const values: ProviderContinuationJSONValue[] = [];
    for (const item of value) {
      const converted = toContinuationJSONValue(item);
      if (converted !== undefined) values.push(converted);
    }
    return values;
  }
  if (isRecord(value)) {
    const converted: { [key: string]: ProviderContinuationJSONValue } = {};
    for (const [key, item] of Object.entries(value)) {
      const convertedItem = toContinuationJSONValue(item);
      if (convertedItem !== undefined) converted[key] = convertedItem;
    }
    return converted;
  }
  return undefined;
}

export function normalizeProviderContinuationOptions(value: unknown): ProviderContinuationOptions | undefined {
  if (!isRecord(value)) return undefined;
  const options: ProviderContinuationOptions = {};
  for (const [provider, providerOptions] of Object.entries(value)) {
    if (!isRecord(providerOptions)) continue;
    const normalizedProviderOptions: Record<string, ProviderContinuationJSONValue> = {};
    for (const [key, optionValue] of Object.entries(providerOptions)) {
      const normalizedValue = toContinuationJSONValue(optionValue);
      if (normalizedValue !== undefined) normalizedProviderOptions[key] = normalizedValue;
    }
    if (Object.keys(normalizedProviderOptions).length) {
      options[provider] = normalizedProviderOptions;
    }
  }
  return Object.keys(options).length ? options : undefined;
}

function cloneProviderOptions(options: ProviderContinuationOptions | undefined): ProviderContinuationOptions | undefined {
  if (!options) return undefined;
  const cloned: ProviderContinuationOptions = {};
  for (const [provider, providerOptions] of Object.entries(options)) {
    cloned[provider] = { ...providerOptions };
  }
  return cloned;
}

function cloneReasoningPart(part: ProviderContinuationReasoningPart): ProviderContinuationReasoningPart {
  return {
    text: part.text,
    ...(part.providerOptions ? { providerOptions: cloneProviderOptions(part.providerOptions) } : {}),
  };
}

function mergeProviderOptions(
  current: ProviderContinuationOptions | undefined,
  incoming: ProviderContinuationOptions | undefined,
): ProviderContinuationOptions | undefined {
  if (!current && !incoming) return undefined;
  const merged: ProviderContinuationOptions = cloneProviderOptions(current) ?? {};
  for (const [provider, providerOptions] of Object.entries(incoming ?? {})) {
    merged[provider] = {
      ...(isRecord(merged[provider]) ? merged[provider] : {}),
      ...providerOptions,
    };
  }
  return Object.keys(merged).length ? merged : undefined;
}

function mergeAssistantFields(
  current: Record<string, unknown> | undefined,
  incoming: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!current && !incoming) return undefined;
  const merged: Record<string, unknown> = { ...(current ?? {}) };
  for (const [key, value] of Object.entries(incoming ?? {})) {
    if (value === undefined) continue;
    const previous = merged[key];
    merged[key] = typeof previous === 'string' && typeof value === 'string'
      ? previous + value
      : value;
  }
  return Object.keys(merged).length ? merged : undefined;
}

function providerOptionsKey(options: ProviderContinuationOptions | undefined): string {
  return JSON.stringify(options ?? {});
}

function canMergeReasoningPart(
  current: ProviderContinuationReasoningPart,
  incoming: ProviderContinuationReasoningPart,
): boolean {
  if (!incoming.text) return true;
  return providerOptionsKey(current.providerOptions) === providerOptionsKey(incoming.providerOptions);
}

function appendReasoningParts(
  current: ProviderContinuationReasoningPart[] | undefined,
  incoming: ProviderContinuationReasoningPart[] | undefined,
): ProviderContinuationReasoningPart[] | undefined {
  const merged = (current ?? []).map(cloneReasoningPart);

  for (const part of incoming ?? []) {
    if (!part.text && !part.providerOptions) continue;
    const normalizedPart = cloneReasoningPart(part);
    const last = merged.at(-1);
    if (last && canMergeReasoningPart(last, normalizedPart)) {
      last.text += normalizedPart.text;
      const providerOptions = mergeProviderOptions(last.providerOptions, normalizedPart.providerOptions);
      if (providerOptions) {
        last.providerOptions = providerOptions;
      } else {
        delete last.providerOptions;
      }
      continue;
    }
    merged.push(normalizedPart);
  }

  return merged.length ? merged : undefined;
}

export function mergeProviderContinuation(
  current?: ProviderContinuation | null,
  incoming?: ProviderContinuation | null,
): ProviderContinuation | undefined {
  const reasoningParts = appendReasoningParts(current?.reasoningParts, incoming?.reasoningParts);
  const openAIChatAssistantFields = mergeAssistantFields(
    current?.openAIChatAssistantFields,
    incoming?.openAIChatAssistantFields,
  );

  if (!reasoningParts && !openAIChatAssistantFields) return undefined;
  return {
    ...(reasoningParts ? { reasoningParts } : {}),
    ...(openAIChatAssistantFields ? { openAIChatAssistantFields } : {}),
  };
}

export function extractProviderContinuationFromRawChunk(rawValue: unknown): ProviderContinuation | undefined {
  const parsed = parseRawValue(rawValue);
  if (!isRecord(parsed) || !Array.isArray(parsed.choices)) return undefined;

  let reasoningContent = '';
  for (const choice of parsed.choices) {
    if (!isRecord(choice)) continue;
    const delta = isRecord(choice.delta) ? choice.delta : undefined;
    const message = isRecord(choice.message) ? choice.message : undefined;
    const rawReasoning = delta?.reasoning_content ?? message?.reasoning_content;
    if (typeof rawReasoning === 'string' && rawReasoning) {
      reasoningContent += rawReasoning;
    }
  }

  if (!reasoningContent) return undefined;
  return {
    reasoningParts: [{ text: reasoningContent }],
    openAIChatAssistantFields: { reasoning_content: reasoningContent },
  };
}

function hasToolCalls(message: Record<string, unknown>): boolean {
  return Array.isArray(message.tool_calls) && message.tool_calls.length > 0;
}

function compactAssistantFields(fields: OpenAIChatAssistantFields | undefined): OpenAIChatAssistantFields | undefined {
  const compacted: OpenAIChatAssistantFields = {};
  for (const [key, value] of Object.entries(fields ?? {})) {
    if (value === undefined || value === null || value === '') continue;
    compacted[key] = value;
  }
  return Object.keys(compacted).length ? compacted : undefined;
}

export function applyOpenAIChatContinuationToBody(
  body: string,
  assistantFieldsByToolCallMessage: Array<OpenAIChatAssistantFields | undefined>,
): string {
  if (!assistantFieldsByToolCallMessage.length) return body;

  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return body;
  }

  if (!isRecord(parsed) || !Array.isArray(parsed.messages)) return body;

  let fieldIndex = 0;
  let changed = false;
  const messages = parsed.messages.map((message) => {
    if (!isRecord(message) || message.role !== 'assistant' || !hasToolCalls(message)) {
      return message;
    }

    const fields = compactAssistantFields(assistantFieldsByToolCallMessage[fieldIndex]);
    fieldIndex += 1;
    if (!fields) return message;

    changed = true;
    return {
      ...message,
      ...mergeAssistantFields(message, fields),
    };
  });

  if (!changed) return body;
  return JSON.stringify({ ...parsed, messages });
}
