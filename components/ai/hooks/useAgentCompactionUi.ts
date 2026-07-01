import { useEffect, useState } from 'react';
import type { ContextPrepareTrigger } from '../../../infrastructure/ai/harness/types';
import { getAgentRuntime } from '../../../infrastructure/ai/harness/globalAgentRuntime';
import { CATTY_COMPACTION_STATUS_KEYS } from '../../../infrastructure/ai/harness/compactionStatusKeys';

export interface ActiveCompactionUi {
  sessionId: string;
  trigger: ContextPrepareTrigger;
}

function statusKeyForTrigger(trigger: ContextPrepareTrigger): string {
  switch (trigger) {
    case 'step':
      return CATTY_COMPACTION_STATUS_KEYS.step;
    case '413-retry':
      return CATTY_COMPACTION_STATUS_KEYS.retry;
    default:
      return CATTY_COMPACTION_STATUS_KEYS.preTurn;
  }
}

export function useAgentCompactionUi(): ActiveCompactionUi | null {
  const [active, setActive] = useState<ActiveCompactionUi | null>(null);

  useEffect(() => {
    const unsubscribe = getAgentRuntime().subscribe((event) => {
      const sessionId = event.chatSessionId ?? event.sessionId;
      if (event.type === 'compaction_start') {
        setActive({ sessionId, trigger: event.trigger });
        return;
      }
      if (event.type === 'compaction' || event.type === 'turn_end') {
        setActive((prev) => (prev?.sessionId === sessionId ? null : prev));
      }
    });
    return unsubscribe;
  }, []);

  return active;
}

export function compactionStatusText(
  trigger: ContextPrepareTrigger,
  translate: (key: string, params?: Record<string, string | number>) => string,
): string {
  return translate(statusKeyForTrigger(trigger));
}

export function resolveCompactionStatusText(
  statusText: string | undefined,
  translate: (key: string) => string,
): string | undefined {
  if (!statusText) return undefined;
  if (statusText.startsWith('ai.')) return translate(statusText);
  return statusText;
}
