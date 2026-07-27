/**
 * SDK Agent Adapter
 *
 * Bridges managed external agents through IPC. The main process runs the
 * official SDK drivers and forwards stream events to the renderer.
 */

import type {
  AgentActivity,
  AgentUsage,
  AIPermissionMode,
  AIToolIntegrationMode,
  ExternalAgentConfig,
} from './types';
import { getExternalAgentSdkBackend, getManualAgentCommand } from './managedAgents';
import { encodeSdkSessionIdentity } from './harness/sdkSessionIdentity';
import { mapSdkStreamEventToAgentEvents } from './harness/agentEventAdapter';
import { globalTraceStore } from './harness/traceStore';
import { decryptField } from '../persistence/secureFieldAdapter';

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
  onFileChange?: (activity: Extract<AgentActivity, { type: 'file_change' }>) => void;
  onWebSearch?: (activity: Extract<AgentActivity, { type: 'web_search' }>) => void;
  onPlanUpdate?: (activity: Extract<AgentActivity, { type: 'plan_update' }>) => void;
  onWarning?: (activity: Extract<AgentActivity, { type: 'warning' }>) => void;
  onUsage?: (usage: AgentUsage) => void;
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
    agentCommand?: string,
    codexRuntime?: 'sdk' | 'app-server',
    permissionMode?: AIPermissionMode,
  ): Promise<{ ok: boolean; error?: unknown }>;
  aiSdkAgentSteer?(
    requestId: string,
    chatSessionId: string,
    prompt: string,
    images: FileAttachment[] | undefined,
    clientUserMessageId: string,
  ): Promise<SdkAgentSteerResult>;
  aiSdkAgentCancel(requestId: string, chatSessionId?: string): Promise<{ ok: boolean }>;
  onAiSdkAgentEvent(requestId: string, cb: (event: StreamEvent) => void): () => void;
  onAiSdkAgentDone(requestId: string, cb: () => void): () => void;
  onAiSdkAgentError(requestId: string, cb: (error: unknown) => void): () => void;
}

export type SdkAgentSteerResult =
  | { status: 'accepted' }
  | {
      status: 'not-steerable' | 'busy' | 'inactive' | 'unsupported' | 'cancelled' | 'failed';
      message?: string;
      turnKind?: 'review' | 'compact';
    };

interface StreamEvent {
  type: string;
  [key: string]: unknown;
}

export interface FileAttachment {
  base64Data: string;
  mediaType: string;
  filename?: string;
  filePath?: string;
}

export async function steerSdkAgentTurn(
  bridge: unknown,
  requestId: string,
  chatSessionId: string,
  prompt: string,
  images: FileAttachment[] | undefined,
  clientUserMessageId: string,
): Promise<SdkAgentSteerResult> {
  const sdkBridge = bridge as SdkAgentBridge | null;
  if (!sdkBridge?.aiSdkAgentSteer) return { status: 'unsupported' };
  try {
    return await sdkBridge.aiSdkAgentSteer(
      requestId,
      chatSessionId,
      prompt,
      images,
      clientUserMessageId,
    );
  } catch (error) {
    return {
      status: 'failed',
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

async function buildAgentEnvWithStoredApiKey(
  sdkBackend: string,
  config: ExternalAgentConfig,
): Promise<Record<string, string> | undefined> {
  const env = { ...(config.env ?? {}) };
  if (sdkBackend === 'cursor') {
    const authMode = config.cursorAuthMode === 'cli-login' ? 'cli-login' : 'api-key';
    env.NETCATTY_CURSOR_AUTH_MODE = authMode;
    const cliBin = String(config.command || '').trim();
    if (authMode === 'cli-login') {
      if (cliBin && cliBin !== 'cursor') {
        env.NETCATTY_CURSOR_CLI_BIN = cliBin;
      }
      return Object.keys(env).length > 0 ? env : undefined;
    }
    if (config.apiKey) {
      const decrypted = await decryptField(config.apiKey).catch(() => config.apiKey);
      const apiKey = String(decrypted || '').trim();
      if (apiKey) {
        env.CURSOR_API_KEY = apiKey;
      }
    }
  }
  return Object.keys(env).length > 0 ? env : undefined;
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
  permissionMode?: AIPermissionMode,
  harnessOptions?: {
    traceSink?: (event: import('./harness/types').AgentEvent) => void;
    skipHarnessTrace?: boolean;
  },
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

  const agentEnv = await buildAgentEnvWithStoredApiKey(sdkBackend, config);
  const agentCommand = sdkBackend === 'antigravity'
    ? String(config.command || '').trim() || undefined
    : getManualAgentCommand(config);

  // Set up event listeners before starting stream
  if (!harnessOptions?.skipHarnessTrace) {
    globalTraceStore.append({
      id: `turn-start-${requestId}`,
      type: 'turn_start',
      sessionId: chatSessionId,
      chatSessionId,
      backend: 'external-sdk',
      timestamp: Date.now(),
      backendLabel: sdkBackend,
    });
  }

  const appendHarnessEvent = (event: import('./harness/types').AgentEvent) => {
    if (harnessOptions?.traceSink) {
      harnessOptions.traceSink(event);
      return;
    }
    if (!harnessOptions?.skipHarnessTrace) {
      globalTraceStore.append(event);
    }
  };

  const unsubEvent = sdkBridge.onAiSdkAgentEvent(requestId, (event: StreamEvent) => {
    for (const agentEvent of mapSdkStreamEventToAgentEvents(event, {
      sessionId: chatSessionId,
      chatSessionId,
      turnId: requestId,
    })) {
      appendHarnessEvent(agentEvent);
    }
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
    agentEnv,
    agentCommand,
    sdkBackend === 'codex' ? (config.codexRuntime ?? 'sdk') : undefined,
    permissionMode,
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
 * Handle a single stream event from the AI SDK stream.
 * Events come from `streamText().stream` in the main process.
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
    case 'file-change': {
      callbacks.onFileChange?.({
        id: (event.itemId as string) || '',
        type: 'file_change',
        status: event.status === 'failed' ? 'failed' : 'completed',
        changes: Array.isArray(event.changes)
          ? event.changes as Extract<AgentActivity, { type: 'file_change' }>['changes']
          : [],
      });
      return false;
    }
    case 'web-search': {
      callbacks.onWebSearch?.({
        id: (event.itemId as string) || '',
        type: 'web_search',
        status: event.status === 'completed' ? 'completed' : 'running',
        query: (event.query as string) || '',
      });
      return false;
    }
    case 'plan-update': {
      callbacks.onPlanUpdate?.({
        id: (event.itemId as string) || '',
        type: 'plan_update',
        status: event.status === 'completed' ? 'completed' : 'running',
        items: Array.isArray(event.items)
          ? event.items as Extract<AgentActivity, { type: 'plan_update' }>['items']
          : [],
      });
      return false;
    }
    case 'warning': {
      const message = (event.message as string) || '';
      if (message) {
        callbacks.onWarning?.({
          id: (event.itemId as string) || '',
          type: 'warning',
          status: 'completed',
          message,
        });
      }
      return false;
    }
    case 'usage': {
      const inputTokens = Number(event.inputTokens) || 0;
      const outputTokens = Number(event.outputTokens) || 0;
      callbacks.onUsage?.({
        inputTokens,
        cachedInputTokens: Number(event.cachedInputTokens) || 0,
        outputTokens,
        reasoningTokens: Number(event.reasoningTokens) || 0,
        totalTokens: Number(event.totalTokens) || inputTokens + outputTokens,
        estimated: false,
      });
      return false;
    }
    case 'status': {
      const msg = (event.message as string) || '';
      if (msg) callbacks.onStatus?.(msg);
      return false;
    }
    case 'session-id': {
      const sessionId = (event.sessionId as string) || '';
      if (sessionId) {
        callbacks.onSessionId?.(encodeSdkSessionIdentity(
          sessionId,
          event.sdkBackend as string | undefined,
          event.binPath as string | undefined,
          event.runtime === 'app-server' ? 'app-server' : 'sdk',
          event.authMode as string | undefined,
          event.cliMode as string | undefined,
        ));
      }
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
