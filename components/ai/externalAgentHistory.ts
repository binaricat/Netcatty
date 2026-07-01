import type { ChatMessage } from '../../infrastructure/ai/types';
import {
  buildExternalBridgeContextMessages,
} from '../../infrastructure/ai/harness/externalBridgeContext';

export type ExternalAgentHistoryMessage = { role: 'user' | 'assistant'; content: string };

export function buildExternalAgentHistoryMessages(messages: ChatMessage[]): ExternalAgentHistoryMessage[] {
  return buildExternalBridgeContextMessages(messages);
}

export function buildExternalAgentHistoryMessagesForBridge(
  messages: ChatMessage[],
  _existingSessionId?: string | null,
): ExternalAgentHistoryMessage[] | undefined {
  const historyMessages = buildExternalAgentHistoryMessages(messages);
  return historyMessages.length ? historyMessages : undefined;
}
