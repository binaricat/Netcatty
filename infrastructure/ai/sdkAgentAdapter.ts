/**
 * SDK Agent Adapter
 *
 * Bridges managed external agents through IPC. The main process runs the
 * official SDK drivers and forwards stream events to the renderer.
 */

import type { AIToolIntegrationMode, ExternalAgentConfig } from './types';
import { getExternalAgentSdkBackend } from './managedAgents';

export interface DefaultTargetSessionHint {
  sessionId: string;
  hostname: string;
  label: string;
  os?: string;
  username?: string;
  protocol?: string;
  shellType?: string;
  deviceType?: string;
  connected: boolean;
  source: 'scope-target' | 'only-connected-in-scope';
}

export interface SdkAgentCallbacks {
  onSessionId?: (sessionId: string) => void;
  onTextDelta: (text: string) => void;
  onThinkingDelta: (text: string) => void;
  onThinkingDone: () => void;
  onToolCall: (toolName: string, args: Record<string, unknown>, toolCallId?: string) => void;
  onToolResult: (toolCallId: string, result: string, toolName?: string) => void;
  onStatus?: (message: string) => void;
  onError: (error: string) => void;
  onDone: () => void;
}

interface SdkAgentBridge {
  aiSdkAgentStream(
    requestId: string,
    chatSessionId: string,
    sdkBackend: string,
    prompt: string,
    cwd?: string,
    providerId?: string,
    model?: string,
    existingSessionId?: string,
    historyMessages?: Array<{ role: 'user' | 'assistant'; content: string }>,
    images?: FileAttachment[],
    toolIntegrationMode?: AIToolIntegrationMode,
    defaultTargetSession?: DefaultTargetSessionHint,
    userSkillsContext?: string,
    agentEnv?: Record<string, string>,
  ): Promise<{ ok: boolean; error?: unknown }>;
  aiSdkAgentCancel(requestId: string, chatSessionId?: string): Promise<{ ok: boolean }>;
  onAiSdkAgentEvent(requestId: string, cb: (event: StreamEvent) => void): () => void;
  onAiSdkAgentDone(requestId: string, cb: () => void): () => void;
  onAiSdkAgentError(requestId: string, cb: (error: unknown) => void): () => void;
}

interface StreamEvent {
  type: string;
  [key: string]: unknown;
}

/**
 * Run one managed SDK agent turn.
 * Sends the prompt to the main process and listens for streamed events.
 * Stream events are forwarded back via IPC.
 */
export interface FileAttachment {
  base64Data: string;
  mediaType: string;
  filename?: string;
  filePath?: string;
}

function safeJsonStringify(value: unknown): string | null {
  const seen = new WeakSet<object>();
  try {
    return JSON.stringify(value, (_key, nestedValue: unknown) => {
      if (typeof nestedValue !== 'object' || nestedValue === null) {
        return nestedValue;
      }
      if (seen.has(nestedValue)) {
        return '[Circular]';
      }
      seen.add(nestedValue);
      return nestedValue;
    });
  } catch {
    return null;
  }
}

function formatSdkAgentErrorValue(error: unknown, seen = new WeakSet<object>()): string {
  if (error == null) return '';
  if (typeof error === 'string') return error;
  if (typeof error === 'number' || typeof error === 'boolean') return String(error);
  if (error instanceof Error) return error.message || error.name || '';
  if (typeof error !== 'object') return String(error);
  if (seen.has(error)) return '[Circular error]';
  seen.add(error);

  const record = error as Record<string, unknown>;
  const data = record.data as Record<string, unknown> | undefined;
  const nestedError = record.error as Record<string, unknown> | undefined;
  const candidates: unknown[] = [
    data?.message,
    data?.error,
    record.errorText,
    record.message,
    record.error,
    record.cause,
    nestedError?.message,
    record.data,
  ];

  for (const candidate of candidates) {
    const message = formatSdkAgentErrorValue(candidate, seen).trim();
    if (message && message !== '{}') {
      return message;
    }
  }

  return safeJsonStringify(error) || String(error);
}

export function formatSdkAgentErrorForDisplay(error: unknown): string {
  return formatSdkAgentErrorValue(error).trim() || 'Unknown error';
}

export async function runSdkAgentTurn(
  bridge: Record<string, (...args: unknown[]) => unknown>,
  requestId: string,
  chatSessionId: string,
  config: ExternalAgentConfig,
  prompt: string,
  callbacks: SdkAgentCallbacks,
  signal?: AbortSignal,
  providerId?: string,
  model?: string,
  existingSessionId?: string,
  historyMessages?: Array<{ role: 'user' | 'assistant'; content: string }>,
  images?: FileAttachment[],
  toolIntegrationMode?: AIToolIntegrationMode,
  defaultTargetSession?: DefaultTargetSessionHint,
  userSkillsContext?: string,
): Promise<void> {
  const sdkBridge = bridge as unknown as SdkAgentBridge;
  const sdkBackend = getExternalAgentSdkBackend(config);

  if (!sdkBackend) {
    callbacks.onError('Agent has no SDK backend configured');
    return;
  }

  const cleanupFns: (() => void)[] = [];
  let settled = false;
  let resolveDone: () => void = () => {};
  const donePromise = new Promise<void>((resolve) => {
    resolveDone = resolve;
  });
  const settle = (fn?: () => void) => {
    if (settled) return false;
    settled = true;
    fn?.();
    resolveDone();
    return true;
  };

  // Set up event listeners before starting stream
  const unsubEvent = sdkBridge.onAiSdkAgentEvent(requestId, (event: StreamEvent) => {
    const streamFailed = handleStreamEvent(event, callbacks);
    if (streamFailed) {
      settle();
    }
  });
  cleanupFns.push(unsubEvent);

  const unsubDone = sdkBridge.onAiSdkAgentDone(requestId, () => {
    settle(() => {
      callbacks.onDone();
    });
  });
  cleanupFns.push(unsubDone);

  const unsubError = sdkBridge.onAiSdkAgentError(requestId, (error: unknown) => {
    settle(() => {
      callbacks.onError(formatSdkAgentErrorForDisplay(error));
    });
  });
  cleanupFns.push(unsubError);

  // Handle abort
  if (signal) {
    if (signal.aborted) {
      cleanup(cleanupFns);
      return;
    }
    const onAbort = () => {
      if (!settle()) {
        return;
      }
      sdkBridge.aiSdkAgentCancel(requestId, chatSessionId).catch(() => {});
    };
    signal.addEventListener('abort', onAbort, { once: true });
    cleanupFns.push(() => signal.removeEventListener('abort', onAbort));
  }

  // Start the SDK stream in the main process
  void sdkBridge.aiSdkAgentStream(
    requestId,
    chatSessionId,
    sdkBackend,
    prompt,
    undefined, // cwd
    providerId,
    model,
    existingSessionId,
    historyMessages,
    images?.length ? images : undefined,
    toolIntegrationMode,
    defaultTargetSession,
    userSkillsContext,
    config.env,
  ).then((result) => {
    if (result?.ok === false) {
      settle(() => {
        callbacks.onError(
          result.error == null
            ? 'Failed to start SDK agent stream'
            : formatSdkAgentErrorForDisplay(result.error),
        );
      });
    }
  }).catch((err: unknown) => {
    settle(() => {
      callbacks.onError(formatSdkAgentErrorForDisplay(err));
    });
  }).finally(() => {
    if (settled) {
      cleanup(cleanupFns);
    }
  });

  // Wait for done or error
  await donePromise;
  cleanup(cleanupFns);
}

function cleanup(fns: (() => void)[]) {
  for (const fn of fns) {
    try { fn(); } catch { /* */ }
  }
}

/**
 * Handle a single stream event from the AI SDK fullStream.
 * Events come from `streamText().fullStream` in the main process.
 */
function handleStreamEvent(event: StreamEvent, callbacks: SdkAgentCallbacks): boolean {
  switch (event.type) {
    case 'text-delta': {
      const text = (event.textDelta as string) || (event.delta as string) || '';
      if (text) callbacks.onTextDelta(text);
      return false;
    }
    case 'reasoning-start': {
      // Reasoning block started — nothing to render yet
      return false;
    }
    case 'reasoning-delta': {
      const text = (event.delta as string) || '';
      if (text) callbacks.onThinkingDelta(text);
      return false;
    }
    case 'reasoning-end': {
      callbacks.onThinkingDone();
      return false;
    }
    case 'tool-call': {
      const toolName = (event.toolName as string) || 'unknown';
      // The Electron bridge emits tool args as `args` (see sdk/emit.cjs
      // toolCall), while direct AI SDK paths use `input`. Read both so
      // either source works.
      const input =
        (event.input as Record<string, unknown>) ||
        (event.args as Record<string, unknown>) ||
        {};
      const toolCallId = (event.toolCallId as string) || undefined;
      callbacks.onToolCall(toolName, input, toolCallId);
      return false;
    }
    case 'tool-result': {
      const toolCallId = (event.toolCallId as string) || '';
      const toolName = (event.toolName as string) || undefined;
      const output = event.output ?? event.result;
      const result = typeof output === 'string'
        ? output
        : JSON.stringify(output);
      callbacks.onToolResult(toolCallId, result, toolName);
      return false;
    }
    case 'status': {
      const msg = (event.message as string) || '';
      if (msg) callbacks.onStatus?.(msg);
      return false;
    }
    case 'session-id': {
      const sessionId = (event.sessionId as string) || '';
      if (sessionId) callbacks.onSessionId?.(sessionId);
      return false;
    }
    case 'error': {
      callbacks.onError(formatSdkAgentErrorForDisplay(event.error));
      return true;
    }
    // step-start, step-finish, etc. — ignore silently
    default:
      return false;
  }
}
