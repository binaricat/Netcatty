import type { AIPermissionMode } from '../types';
import { CATTY_APPROVAL_TIMEOUT_MS } from '../shared/approvalConstants';

const THIRTY_MINUTES_MS = 30 * 60 * 1000;
const TEN_MINUTES_MS = 10 * 60 * 1000;
const TWO_MINUTES_MS = 2 * 60 * 1000;
const NINETY_SECONDS_MS = 90 * 1000;
const COMPACTION_TIMEOUT_MS = 90 * 1000;

export interface BuildCattyStreamTimeoutsInput {
  permissionMode?: AIPermissionMode;
}

/** v7 streamText timeout profile for Catty multi-step agent turns. */
export function buildCattyStreamTimeouts(
  _input: BuildCattyStreamTimeoutsInput = {},
) {
  return {
    totalMs: THIRTY_MINUTES_MS,
    stepMs: TEN_MINUTES_MS,
    chunkMs: TWO_MINUTES_MS,
    toolMs: CATTY_APPROVAL_TIMEOUT_MS + NINETY_SECONDS_MS,
  };
}

/** Shorter timeout for LLM compaction summarize calls. */
export function buildCattyCompactionTimeout() {
  return COMPACTION_TIMEOUT_MS;
}
