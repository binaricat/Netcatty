/** i18n keys for compaction status — resolved in useAgentCompactionUi. */
export const CATTY_COMPACTION_STATUS_KEYS = {
  preTurn: 'ai.chat.compactingContext',
  step: 'ai.chat.compactingStep',
  retry: 'ai.chat.compactionRetry',
} as const;

export type CattyCompactionStatusKey =
  typeof CATTY_COMPACTION_STATUS_KEYS[keyof typeof CATTY_COMPACTION_STATUS_KEYS];
