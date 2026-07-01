import type { AIPermissionMode } from '../types';
import { CATTY_APPROVAL_TIMEOUT_MS } from '../shared/approvalConstants';

const THIRTY_MINUTES_MS = 30 * 60 * 1000;
const TEN_MINUTES_MS = 10 * 60 * 1000;
const TWO_MINUTES_MS = 2 * 60 * 1000;
const NINETY_SECONDS_MS = 90 * 1000;
const COMPACTION_TIMEOUT_MS = 90 * 1000;
const MAX_ABORT_TIMEOUT_MS = 2_147_483_647;

export interface BuildCattyStreamTimeoutsInput {
  permissionMode?: AIPermissionMode;
  commandTimeoutMs?: number;
  maxIterations?: number;
}

/** v7 streamText timeout profile for Catty multi-step agent turns. */
export function buildCattyStreamTimeouts(
  input: BuildCattyStreamTimeoutsInput = {},
) {
  const approvalBudgetMs = input.permissionMode === 'confirm' ? CATTY_APPROVAL_TIMEOUT_MS : 0;
  const stepCount =
    Number.isFinite(input.maxIterations) && input.maxIterations != null && input.maxIterations > 0
      ? Math.max(1, Math.floor(input.maxIterations))
      : 1;
  const commandTimeoutBudgetMs =
    Number.isFinite(input.commandTimeoutMs) && input.commandTimeoutMs > 0
      ? input.commandTimeoutMs + approvalBudgetMs + NINETY_SECONDS_MS
      : 0;
  const totalBudgetMs = Math.max(THIRTY_MINUTES_MS, commandTimeoutBudgetMs * stepCount);
  const totalMs = totalBudgetMs <= MAX_ABORT_TIMEOUT_MS ? totalBudgetMs : undefined;
  return {
    totalMs,
    stepMs: Math.max(TEN_MINUTES_MS, commandTimeoutBudgetMs),
    chunkMs: Math.max(TWO_MINUTES_MS, commandTimeoutBudgetMs),
    toolMs: Math.max(CATTY_APPROVAL_TIMEOUT_MS + NINETY_SECONDS_MS, commandTimeoutBudgetMs),
  };
}

/** Shorter timeout for LLM compaction summarize calls. */
export function buildCattyCompactionTimeout() {
  return COMPACTION_TIMEOUT_MS;
}
