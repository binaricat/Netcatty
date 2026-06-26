import { useCallback, useEffect, useState } from 'react';
import type { CompactionTrace } from '../../../infrastructure/ai/harness/types';
import { getAgentRuntime } from '../../../infrastructure/ai/harness/globalAgentRuntime';
import { CATTY_COMPACTION_STATUS_KEYS } from '../../../infrastructure/ai/harness/compactionStatusKeys';
import type { ChatMessage } from '../../../infrastructure/ai/types';
import { latestAISessionsSnapshot } from '../../../application/state/aiStateSnapshots';

export interface CompactionUiHint {
  trace: CompactionTrace;
  sessionId: string;
}

function statusKeyForTrigger(trigger: CompactionTrace['trigger']): string {
  switch (trigger) {
    case 'step':
      return CATTY_COMPACTION_STATUS_KEYS.step;
    case '413-retry':
      return CATTY_COMPACTION_STATUS_KEYS.retry;
    default:
      return CATTY_COMPACTION_STATUS_KEYS.preTurn;
  }
}

export function useAgentCompactionUi(
  updateLastMessage: (sessionId: string, updater: (msg: ChatMessage) => ChatMessage) => void,
  updateMessageById: (sessionId: string, messageId: string, updater: (msg: ChatMessage) => ChatMessage) => void,
  translate: (key: string, params?: Record<string, string | number>) => string,
): CompactionUiHint | null {
  const [hint, setHint] = useState<CompactionUiHint | null>(null);

  const applyStatusText = useCallback((sessionId: string, statusText: string) => {
    const session = latestAISessionsSnapshot?.find(entry => entry.id === sessionId);
    if (session) {
      for (let i = session.messages.length - 1; i >= 0; i -= 1) {
        const message = session.messages[i];
        if (message?.role === 'assistant') {
          updateMessageById(sessionId, message.id, msg => ({ ...msg, statusText }));
          return;
        }
      }
    }
    updateLastMessage(sessionId, msg => ({ ...msg, statusText }));
  }, [updateLastMessage, updateMessageById]);

  useEffect(() => {
    const unsubscribe = getAgentRuntime().subscribe((event) => {
      if (event.type !== 'compaction') return;
      const sessionId = event.chatSessionId ?? event.sessionId;
      setHint({ trace: event.trace, sessionId });
      const statusKey = statusKeyForTrigger(event.trace.trigger);
      applyStatusText(sessionId, translate(statusKey));
    });
    return unsubscribe;
  }, [applyStatusText, translate]);

  return hint;
}

export function formatCompactionBanner(
  trace: CompactionTrace,
  translate: (key: string, params?: Record<string, string | number>) => string,
): string {
  const beforeK = Math.round(trace.estimatedTokensBefore / 1000);
  const afterK = Math.round(trace.estimatedTokensAfter / 1000);
  return translate('ai.chat.compactionBanner', { before: beforeK, after: afterK });
}

export function resolveCompactionStatusText(
  statusText: string | undefined,
  translate: (key: string) => string,
): string | undefined {
  if (!statusText) return undefined;
  if (statusText.startsWith('ai.')) return translate(statusText);
  return statusText;
}
