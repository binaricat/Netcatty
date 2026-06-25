import { clearAllPendingApprovals } from '../shared/approvalGate';
import { globalTraceStore } from './traceStore';
import type { AgentBackend } from './types';

export type StopAgentTurnReason = 'user' | 'slash';

export interface AgentStopBridge {
  aiCattyCancelExec?(chatSessionId: string): Promise<unknown>;
  aiSdkAgentCancel?(requestId: string, chatSessionId?: string): Promise<{ ok: boolean; error?: string }>;
  aiSetChatSessionCancelled?(chatSessionId: string, cancelled?: boolean): Promise<{ ok: boolean; error?: string }>;
}

export interface StopAgentTurnParams {
  chatSessionId: string;
  abortController?: AbortController | null;
  bridge?: AgentStopBridge | null;
  reason?: StopAgentTurnReason;
  backend?: AgentBackend;
}

let stopEventCounter = 0;

function nextStopEventId(): string {
  stopEventCounter += 1;
  return `turn-end-${Date.now()}-${stopEventCounter}`;
}

/**
 * Unified stop entry for Catty, external SDK, and MCP tool surfaces.
 */
export async function stopAgentTurn({
  chatSessionId,
  abortController,
  bridge,
  reason = 'user',
  backend = 'catty',
}: StopAgentTurnParams): Promise<void> {
  abortController?.abort();
  clearAllPendingApprovals(chatSessionId);

  const tasks: Array<Promise<unknown>> = [];
  if (bridge?.aiCattyCancelExec) {
    tasks.push(bridge.aiCattyCancelExec(chatSessionId).catch(() => {}));
  }
  if (bridge?.aiSdkAgentCancel) {
    tasks.push(bridge.aiSdkAgentCancel('', chatSessionId).catch(() => {}));
  }
  if (bridge?.aiSetChatSessionCancelled) {
    tasks.push(bridge.aiSetChatSessionCancelled(chatSessionId, true).catch(() => {}));
  }
  await Promise.all(tasks);

  globalTraceStore.append({
    id: nextStopEventId(),
    type: 'turn_end',
    sessionId: chatSessionId,
    chatSessionId,
    backend,
    timestamp: Date.now(),
    reason: 'aborted',
    ...(reason === 'slash' ? { backendLabel: 'slash-stop' } : {}),
  });
}

/**
 * Clear the main-process cancelled flag when a new agent turn begins.
 */
export async function clearChatSessionCancelled(
  chatSessionId: string,
  bridge?: AgentStopBridge | null,
): Promise<void> {
  await bridge?.aiSetChatSessionCancelled?.(chatSessionId, false).catch(() => {});
}
