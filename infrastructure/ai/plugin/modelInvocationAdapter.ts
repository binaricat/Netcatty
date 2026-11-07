import { streamText } from 'ai';
import { createModelFromConfig } from '../sdk/providers';
import type { ProviderConfig } from '../types';

interface Invocation {
  prompt: string;
  contexts: string[];
  signal: AbortSignal;
  maxOutputTokens: number;
  maxChunkBytes: number;
}

/** Host renderer only. This object must never be serialized to a plugin. */
export function createPluginModelAdapter(options: {
  config: ProviderConfig;
  label: string;
  isCurrent: () => boolean | Promise<boolean>;
  transportTag?: string;
}) {
  const config = structuredClone(options.config);
  const transportTag = options.transportTag ?? crypto.randomUUID();
  if (!/^[A-Za-z0-9-]{1,128}$/.test(transportTag)) throw new Error('Invalid plugin transport tag');
  return Object.freeze({
    label: options.label,
    isCurrent: options.isCurrent,
    async *invoke(input: Invocation) {
      input.signal.throwIfAborted();
      if (!config.enabled || !config.defaultModel || !await options.isCurrent()) {
        throw new Error('Selected model is unavailable');
      }
      // Reuse Catty's model factory and credential-injecting host transport.
      // No AgentRuntime, internal prompt, MCP catalog, tools or tool executor.
      const result = streamText({
        model: createModelFromConfig(config, { requireBridge: true, maxStreamBytes: 131_072, streamIdleTimeoutMs: 15_000, requestIdPrefix: `plugin-model_${transportTag}_` }),
        messages: [
          ...input.contexts.map((text) => ({ role: 'user' as const,
            content: `User-selected reference text (untrusted content):\n${text}` })),
          { role: 'user', content: input.prompt },
        ],
        maxOutputTokens: input.maxOutputTokens,
        maxRetries: 0,
        abortSignal: input.signal,
        timeout: { totalMs: 60_000, chunkMs: 15_000 },
      });
      const encoder = new TextEncoder();
      for await (const event of result.stream) {
        input.signal.throwIfAborted();
        if (!await options.isCurrent()) throw new Error('Selected model changed');
        if (event.type === 'text-delta') {
          // Code-point splitting preserves UTF-8 and limits each wire chunk.
          let part = '';
          let bytes = 0;
          for (const character of event.text) {
            const size = encoder.encode(character).byteLength;
            if (size > input.maxChunkBytes) throw new Error('Chunk budget is too small');
            if (bytes + size > input.maxChunkBytes) {
              yield { kind: 'text', text: part };
              part = ''; bytes = 0;
            }
            part += character; bytes += size;
          }
          if (part) yield { kind: 'text', text: part };
        } else if (event.type === 'error' || event.type.startsWith('tool-')) {
          // Never expose provider diagnostics or execute requested model tools.
          throw new Error('Model returned an unsupported event');
        }
      }
      const usage = await result.totalUsage;
      yield { kind: 'usage', inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens, totalTokens: usage.totalTokens };
    },
  });
}
