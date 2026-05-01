import { createOpenAI } from '@ai-sdk/openai';
import { createAnthropic } from '@ai-sdk/anthropic';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import type { ProviderConfig } from '../types';
import {
  applyOpenAIChatContinuationToBody,
  extractProviderContinuationFromRawChunk,
  mergeProviderContinuation,
  rawOpenAIChatChunkHasToolCalls,
  type OpenAIChatAssistantFields,
} from '../providerContinuation';

export interface ProviderRequestContext {
  getOpenAIChatAssistantFields?: () => Array<OpenAIChatAssistantFields | undefined>;
}

/**
 * Bridge API subset used for SDK fetch adapter.
 */
interface BridgeAPI {
  aiFetch(
    url: string,
    method: string,
    headers: Record<string, string>,
    body?: string,
    providerId?: string,
  ): Promise<{
    ok: boolean;
    status: number;
    data: string;
    error?: string;
  }>;
  aiChatStream(
    requestId: string,
    url: string,
    headers: Record<string, string>,
    body: string,
    providerId?: string,
  ): Promise<{ ok: boolean; statusCode?: number; statusText?: string; error?: string }>;
  onAiStreamData(requestId: string, cb: (data: string) => void): () => void;
  onAiStreamEnd(requestId: string, cb: () => void): () => void;
  onAiStreamError(requestId: string, cb: (error: string) => void): () => void;
  aiChatCancel(requestId: string): Promise<boolean>;
}

function getBridge(): BridgeAPI | null {
  const w = window as unknown as { netcatty?: BridgeAPI };
  return w.netcatty ?? null;
}

/**
 * Detect whether a request is likely a streaming request.
 * AI SDK streaming requests use POST with `"stream": true` in the body.
 */
function isStreamingRequest(init?: RequestInit): boolean {
  if (!init?.body) return false;
  try {
    const bodyStr = typeof init.body === 'string' ? init.body : null;
    if (!bodyStr) return false;
    const parsed = JSON.parse(bodyStr);
    return parsed.stream === true;
  } catch {
    return false;
  }
}

function mergeOpenAIChatAssistantFields(
  current: OpenAIChatAssistantFields | undefined,
  incoming: OpenAIChatAssistantFields | undefined,
): OpenAIChatAssistantFields | undefined {
  return mergeProviderContinuation(
    { openAIChatAssistantFields: current },
    { openAIChatAssistantFields: incoming },
  )?.openAIChatAssistantFields;
}

function createOpenAIChatStreamFieldCapture(
  requestContext?: ProviderRequestContext,
): (data: string) => void {
  const assistantFields = requestContext?.getOpenAIChatAssistantFields?.();
  if (!assistantFields) return () => undefined;

  let streamFieldIndex: number | undefined;
  let pendingFields: OpenAIChatAssistantFields | undefined;

  const ensureStreamFieldSlot = (): number => {
    if (streamFieldIndex !== undefined) return streamFieldIndex;
    streamFieldIndex = assistantFields.length;
    assistantFields.push(undefined);
    return streamFieldIndex;
  };

  const flushPendingFields = (fieldIndex: number) => {
    if (!pendingFields) return;
    assistantFields[fieldIndex] = mergeOpenAIChatAssistantFields(
      assistantFields[fieldIndex],
      pendingFields,
    );
    pendingFields = undefined;
  };

  return (data: string) => {
    const continuation = extractProviderContinuationFromRawChunk(data);
    const fields = continuation?.openAIChatAssistantFields;
    if (fields) {
      pendingFields = mergeOpenAIChatAssistantFields(pendingFields, fields);
      if (streamFieldIndex !== undefined) {
        flushPendingFields(streamFieldIndex);
      }
    }

    if (rawOpenAIChatChunkHasToolCalls(data)) {
      flushPendingFields(ensureStreamFieldSlot());
    }
  };
}

/**
 * Extract headers as a plain Record<string, string> from various header formats.
 */
function extractHeaders(headers?: HeadersInit): Record<string, string> {
  const result: Record<string, string> = {};
  if (!headers) return result;

  if (headers instanceof Headers) {
    headers.forEach((value, key) => {
      result[key] = value;
    });
  } else if (Array.isArray(headers)) {
    for (const [key, value] of headers) {
      result[key] = value;
    }
  } else {
    Object.assign(result, headers);
  }
  return result;
}

/**
 * Create a fetch function compatible with the Vercel AI SDK that routes
 * requests through the Electron IPC bridge to avoid CORS.
 *
 * - Non-streaming requests: uses `window.netcatty.aiFetch()` and returns a `Response`.
 * - Streaming requests: uses `window.netcatty.aiChatStream()` and returns a
 *   `Response` with a `ReadableStream` body.
 * - Falls back to `globalThis.fetch` if the bridge is unavailable.
 */
/** Placeholder API key used by the renderer; main process replaces it with the real key. */
export const API_KEY_PLACEHOLDER = '__IPC_SECURED__';

function toSafeStatusText(message: string, fallback: string): string {
  const normalized = message
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!normalized) return fallback;
  const byteStringSafe = Array.from(normalized, (char) => {
    const code = char.charCodeAt(0);
    if (code < 0x20 || code === 0x7f || code > 0xff) return '?';
    return char;
  }).join('');
  return byteStringSafe.slice(0, 120) || fallback;
}

export function createBridgeFetchForSDK(
  providerId?: string,
  requestContext?: ProviderRequestContext,
): typeof globalThis.fetch {
  return async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const bridge = getBridge();
    if (!bridge) {
      return globalThis.fetch(input, init);
    }

    // Resolve URL string
    let url: string;
    let resolvedInit = init;

    if (input instanceof Request) {
      url = input.url;
      // Merge Request properties with init overrides
      if (!resolvedInit) {
        resolvedInit = {
          method: input.method,
          headers: extractHeaders(input.headers),
          body: input.body ? await new Response(input.body).text() : undefined,
        };
      }
    } else {
      url = input instanceof URL ? input.toString() : input;
    }

    const method = resolvedInit?.method || 'GET';
    const headers = extractHeaders(resolvedInit?.headers);
    const body =
      resolvedInit?.body != null ? String(resolvedInit.body) : undefined;
    const requestBody = body != null
      ? applyOpenAIChatContinuationToBody(
          body,
          requestContext?.getOpenAIChatAssistantFields?.() ?? [],
        )
      : undefined;

    // Streaming path
    if (isStreamingRequest(resolvedInit)) {
      const requestId = `sdk_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      const captureOpenAIChatFields = createOpenAIChatStreamFieldCapture(requestContext);

      // Set up IPC event listeners BEFORE starting the stream to avoid
      // missing early events.
      const encoder = new TextEncoder();
      let streamController: ReadableStreamDefaultController<Uint8Array>;
      let cleanedUp = false;

      const unsubData = bridge.onAiStreamData(requestId, (data: string) => {
        captureOpenAIChatFields(data);
        // Re-wrap as SSE so the SDK can parse it
        streamController?.enqueue(encoder.encode(`data: ${data}\n\n`));
      });
      const unsubEnd = bridge.onAiStreamEnd(requestId, () => {
        try { streamController?.close(); } catch { /* already closed */ }
        cleanup();
      });
      const unsubError = bridge.onAiStreamError(
        requestId,
        (error: string) => {
          try { streamController?.error(new Error(error)); } catch { /* already errored */ }
          cleanup();
        },
      );

      const cleanup = () => {
        if (cleanedUp) return;
        cleanedUp = true;
        unsubData();
        unsubEnd();
        unsubError();
      };

      // Handle abort
      if (resolvedInit?.signal) {
        resolvedInit.signal.addEventListener(
          'abort',
          () => {
            bridge.aiChatCancel(requestId).catch(() => {});
            try { streamController?.error(new DOMException('Aborted', 'AbortError')); } catch { /* already errored */ }
            cleanup();
          },
          { once: true },
        );
      }

      // Start the stream — resolves once HTTP response headers arrive,
      // returning the real status code.
      const result = await bridge.aiChatStream(
        requestId,
        url,
        headers,
        requestBody || '',
        providerId,
      );

      if (!result.ok) {
        cleanup();
        const errorMessage = result.error || 'Stream request failed';
        const jsonBody = JSON.stringify({ error: { message: errorMessage } });
        return new Response(jsonBody, {
          status: 502,
          statusText: toSafeStatusText(errorMessage, 'Bad Gateway'),
          headers: { 'content-type': 'application/json' },
        });
      }

      // If the server returned a non-2xx status, return the error details
      // as a JSON body in OpenAI-compatible format so the AI SDK's
      // failedResponseHandler can extract the message properly.
      // Also set a safe ASCII statusText as fallback for non-OpenAI SDK providers.
      const statusCode = result.statusCode ?? 200;
      if (statusCode < 200 || statusCode >= 300) {
        cleanup();
        const errorDetail = result.statusText || `HTTP ${statusCode}`;
        const jsonBody = JSON.stringify({ error: { message: errorDetail } });
        return new Response(jsonBody, {
          status: statusCode,
          statusText: toSafeStatusText(errorDetail, `Error ${statusCode}`),
          headers: { 'content-type': 'application/json' },
        });
      }

      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          streamController = controller;
        },
      });

      return new Response(stream, {
        status: statusCode,
        statusText: result.statusText ?? 'OK',
        headers: { 'content-type': 'text/event-stream' },
      });
    }

    // Non-streaming path
    const result = await bridge.aiFetch(url, method, headers, requestBody, providerId);

    return new Response(result.data, {
      status: result.status,
      statusText: result.ok ? 'OK' : 'Error',
      headers: { 'content-type': 'application/json' },
    });
  };
}

/**
 * Create a Vercel AI SDK model instance from a ProviderConfig.
 *
 * API keys are NOT sent to the SDK in plaintext. Instead, a placeholder
 * token is used so the SDK builds proper auth headers, and the main
 * process replaces the placeholder with the real decrypted key before
 * making the HTTP request.
 */
export function createModelFromConfig(
  config: ProviderConfig,
  requestContext?: ProviderRequestContext,
) {
  // Use placeholder API key — the main process will inject the real key
  const safeApiKey = config.apiKey ? API_KEY_PLACEHOLDER : undefined;
  const customFetch = createBridgeFetchForSDK(config.id, requestContext);
  const modelId = config.defaultModel || '';

  switch (config.providerId) {
    case 'openai':
      // Use .chat() to force Chat Completions API (not Responses API)
      return createOpenAI({
        apiKey: safeApiKey,
        baseURL: config.baseURL,
        fetch: customFetch,
      }).chat(modelId);

    case 'anthropic':
      return createAnthropic({
        apiKey: safeApiKey,
        baseURL: config.baseURL,
        fetch: customFetch,
      })(modelId);

    case 'google':
      return createGoogleGenerativeAI({
        apiKey: safeApiKey,
        baseURL: config.baseURL,
        fetch: customFetch,
      })(modelId);

    case 'ollama':
      // Ollama uses OpenAI-compatible Chat Completions API
      return createOpenAI({
        apiKey: 'ollama',
        baseURL: config.baseURL || 'http://localhost:11434/v1',
        fetch: customFetch,
      }).chat(modelId);

    case 'openrouter':
      // OpenRouter uses OpenAI-compatible Chat Completions API
      return createOpenAI({
        apiKey: safeApiKey,
        baseURL: config.baseURL || 'https://openrouter.ai/api/v1',
        fetch: customFetch,
      }).chat(modelId);

    case 'custom':
      // Custom providers use OpenAI-compatible Chat Completions API
      return createOpenAI({
        apiKey: safeApiKey,
        baseURL: config.baseURL,
        fetch: customFetch,
      }).chat(modelId);

    default: {
      const _exhaustive: never = config.providerId;
      throw new Error(`Unsupported provider: ${_exhaustive}`);
    }
  }
}
