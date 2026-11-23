import type { ModelMessage } from 'ai';

/**
 * Anthropic preserved-thinking signatures are cryptographically bound to the
 * exact conversation prefix (system + tools + every earlier messages[] entry).
 * Client-side edits that shorten tool_results, drop early turns, or inject a
 * durable summary invalidate later signatures with:
 *   "Invalid signature in thinking block. The block is bound to a different conversation."
 *
 * Anthropic allows removing thinking blocks wholesale; it forbids keeping a
 * later signed block after mutating its prefix. Strip signed reasoning parts
 * when we know the prefix mutated (#4073).
 */

type ContentPart = Extract<ModelMessage['content'], readonly unknown[]>[number];

function anthropicSignatureOf(part: ContentPart): string | undefined {
  if (!part || typeof part !== 'object') return undefined;
  if (!('type' in part) || (part as { type?: unknown }).type !== 'reasoning') return undefined;
  const providerOptions = (part as { providerOptions?: unknown }).providerOptions;
  if (!providerOptions || typeof providerOptions !== 'object') return undefined;
  const anthropic = (providerOptions as { anthropic?: unknown }).anthropic;
  if (!anthropic || typeof anthropic !== 'object') return undefined;
  const signature = (anthropic as { signature?: unknown }).signature;
  return typeof signature === 'string' && signature.length > 0 ? signature : undefined;
}

function isSignedAnthropicReasoningPart(part: ContentPart): boolean {
  return anthropicSignatureOf(part) !== undefined;
}

/**
 * Drop assistant `reasoning` parts that carry a non-empty
 * `providerOptions.anthropic.signature`. Unsigned reasoning / text / tool-call
 * parts are left alone. Does not mutate input arrays in place — returns new
 * message objects only when a message actually changes.
 */
export function stripAnthropicSignedReasoningParts(
  messages: ModelMessage[],
): { messages: ModelMessage[]; didStrip: boolean } {
  let didStrip = false;
  const next = messages.map((message) => {
    if (message.role !== 'assistant' || !Array.isArray(message.content)) {
      return message;
    }
    const content = message.content as ContentPart[];
    const filtered = content.filter((part) => !isSignedAnthropicReasoningPart(part));
    if (filtered.length === content.length) {
      return message;
    }
    didStrip = true;
    return { ...message, content: filtered } as ModelMessage;
  });
  return { messages: didStrip ? next : messages, didStrip };
}

/** True when a reasoning-like part carries a non-empty Anthropic signature. */
export function hasAnthropicThinkingSignature(part: {
  providerOptions?: { anthropic?: { signature?: unknown } } | Record<string, unknown> | undefined;
}): boolean {
  const providerOptions = part.providerOptions;
  if (!providerOptions || typeof providerOptions !== 'object') return false;
  const anthropic = (providerOptions as { anthropic?: unknown }).anthropic;
  if (!anthropic || typeof anthropic !== 'object') return false;
  const signature = (anthropic as { signature?: unknown }).signature;
  return typeof signature === 'string' && signature.length > 0;
}

/**
 * Official Anthropic allows removing thinking blocks wholesale after a prefix
 * mutate (#4073). DeepSeek's Anthropic-compatible endpoint does NOT — it
 * requires thinking blocks to accompany replayed tool calls. Return false when
 * the active provider/model looks like DeepSeek so callers keep signed thinking.
 */
export function providerAllowsAnthropicSignedThinkingRemoval(
  provider: { providerId?: string; baseURL?: string; defaultModel?: string } | null | undefined,
  modelId?: string | null,
): boolean {
  const providerId = String(provider?.providerId ?? '').toLowerCase();
  if (providerId === 'deepseek') return false;
  const baseURL = String(provider?.baseURL ?? '').toLowerCase();
  if (baseURL.includes('deepseek.com')) return false;
  const models = [modelId, provider?.defaultModel]
    .map((value) => String(value ?? '').toLowerCase())
    .filter(Boolean);
  if (models.some((value) => value.includes('deepseek'))) return false;
  return true;
}

