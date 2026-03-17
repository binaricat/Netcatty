/**
 * ACP Agent Adapter
 *
 * Bridges external agents that support the Agent Client Protocol (ACP)
 * through IPC. The main process runs `createACPProvider` + `streamText`,
 * and forwards stream events to the renderer via IPC.
 */

import type { ExternalAgentConfig } from './types';

export interface AcpAgentCallbacks {
  onTextDelta: (text: string) => void;
  onThinkingDelta: (text: string) => void;
  onThinkingDone: () => void;
  onToolCall: (toolName: string, args: Record<string, unknown>) => void;
  onToolResult: (toolCallId: string, result: string) => void;
  onStatus?: (message: string) => void;
  onError: (error: string) => void;
  onDone: () => void;
}

interface AcpBridge {
  aiAcpStream(
    requestId: string,
    chatSessionId: string,
    acpCommand: string,
    acpArgs: string[],
    prompt: string,
    cwd?: string,
    providerId?: string,
    model?: string,
    images?: ImageAttachment[],
  ): Promise<{ ok: boolean; error?: string }>;
  aiAcpCancel(requestId: string, chatSessionId?: string): Promise<{ ok: boolean }>;
  onAiAcpEvent(requestId: string, cb: (event: StreamEvent) => void): () => void;
  onAiAcpDone(requestId: string, cb: () => void): () => void;
  onAiAcpError(requestId: string, cb: (error: string) => void): () => void;
}

interface StreamEvent {
  type: string;
  [key: string]: unknown;
}

/**
 * Run an ACP agent turn.
 * Sends the prompt to the main process which runs streamText() with the ACP provider.
 * Stream events are forwarded back via IPC.
 */
export interface ImageAttachment {
  base64Data: string;
  mediaType: string;
  filename?: string;
}

export async function runAcpAgentTurn(
  bridge: Record<string, (...args: unknown[]) => unknown>,
  requestId: string,
  chatSessionId: string,
  config: ExternalAgentConfig,
  prompt: string,
  callbacks: AcpAgentCallbacks,
  signal?: AbortSignal,
  providerId?: string,
  model?: string,
  images?: ImageAttachment[],
): Promise<void> {
  const acpBridge = bridge as unknown as AcpBridge;

  if (!config.acpCommand) {
    callbacks.onError('Agent does not support ACP protocol');
    return;
  }

  const cleanupFns: (() => void)[] = [];

  // Set up event listeners before starting stream
  const unsubEvent = acpBridge.onAiAcpEvent(requestId, (event: StreamEvent) => {
    handleStreamEvent(event, callbacks);
  });
  cleanupFns.push(unsubEvent);

  const donePromise = new Promise<void>((resolve) => {
    const unsubDone = acpBridge.onAiAcpDone(requestId, () => {
      callbacks.onDone();
      resolve();
    });
    cleanupFns.push(unsubDone);

    const unsubError = acpBridge.onAiAcpError(requestId, (error: string) => {
      callbacks.onError(error);
      resolve();
    });
    cleanupFns.push(unsubError);
  });

  // Handle abort
  if (signal) {
    if (signal.aborted) {
      cleanup(cleanupFns);
      return;
    }
    const onAbort = () => {
      acpBridge.aiAcpCancel(requestId, chatSessionId).catch(() => {});
    };
    signal.addEventListener('abort', onAbort, { once: true });
    cleanupFns.push(() => signal.removeEventListener('abort', onAbort));
  }

  // Start the ACP stream in the main process
  acpBridge.aiAcpStream(
    requestId,
    chatSessionId,
    config.acpCommand,
    config.acpArgs || [],
    prompt,
    undefined, // cwd
    providerId,
    model,
    images?.length ? images : undefined,
  ).catch((err: Error) => {
    callbacks.onError(err.message);
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
function handleStreamEvent(event: StreamEvent, callbacks: AcpAgentCallbacks) {
  switch (event.type) {
    case 'text-delta': {
      const text = (event.textDelta as string) || (event.delta as string) || '';
      if (text) callbacks.onTextDelta(text);
      break;
    }
    case 'reasoning-start': {
      // Reasoning block started — nothing to render yet
      break;
    }
    case 'reasoning-delta': {
      const text = (event.delta as string) || '';
      if (text) callbacks.onThinkingDelta(text);
      break;
    }
    case 'reasoning-end': {
      callbacks.onThinkingDone();
      break;
    }
    case 'tool-call': {
      const toolName = (event.toolName as string) || 'unknown';
      const input = (event.input as Record<string, unknown>) || {};
      callbacks.onToolCall(toolName, input);
      break;
    }
    case 'tool-result': {
      const toolCallId = (event.toolCallId as string) || '';
      const output = event.output ?? event.result;
      const result = typeof output === 'string'
        ? output
        : JSON.stringify(output);
      callbacks.onToolResult(toolCallId, result);
      break;
    }
    case 'status': {
      const msg = (event.message as string) || '';
      if (msg) callbacks.onStatus?.(msg);
      break;
    }
    case 'error': {
      callbacks.onError(String(event.error || 'Unknown error'));
      break;
    }
    // step-start, step-finish, etc. — ignore silently
  }
}
