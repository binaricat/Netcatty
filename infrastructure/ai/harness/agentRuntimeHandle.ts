import type { AISessionScope } from '../types';

/**
 * Lets startup code clean up per-chat / per-terminal agent runtime state
 * without importing the runtime itself, which pulls the Catty harness and the
 * AI SDK providers into the startup bundle. globalAgentRuntime registers here
 * when it is created; before that there is no in-memory state to clear.
 */
export interface AgentRuntimeCleanup {
  clearChatSession(chatSessionId: string): void;
  clearTerminalSession(terminalSessionId: string): void;
  getActiveScope?(chatSessionId: string): AISessionScope | undefined;
}

let registeredRuntime: AgentRuntimeCleanup | null = null;

export function registerAgentRuntimeCleanup(runtime: AgentRuntimeCleanup): void {
  registeredRuntime = runtime;
}

export function peekAgentRuntimeCleanup(): AgentRuntimeCleanup | null {
  return registeredRuntime;
}
