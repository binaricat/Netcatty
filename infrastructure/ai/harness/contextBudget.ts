import type { ModelMessage } from 'ai';
import {
  estimateModelMessagesTokensWithKind,
  estimateTextTokens,
  estimateUnknownTokens,
} from './tokenEstimator';

export const COMPACTION_PROMPT_RESERVE = 150;
export const AUTO_COMPACT_BUFFER_CAP = 15_000;
export const AUTO_COMPACT_BUFFER_RATIO = 0.8;
export const COMPACTION_SUMMARY_MAX_OUTPUT_TOKENS = 1600;
export const DEFAULT_MAX_OUTPUT_TOKENS = 4096;
const MIN_OUTPUT_RESERVE = 256;
const MAX_OUTPUT_SHARE_OF_WINDOW = 0.25;

export function resolveEffectiveMaxOutputTokens(
  contextWindow: number,
  maxOutputTokens: number = DEFAULT_MAX_OUTPUT_TOKENS,
): number {
  if (contextWindow <= 0) return maxOutputTokens;
  const cappedByWindow = Math.max(
    MIN_OUTPUT_RESERVE,
    Math.floor(contextWindow * MAX_OUTPUT_SHARE_OF_WINDOW),
  );
  return Math.min(maxOutputTokens, cappedByWindow);
}

export interface ComputeCompactionThresholdInput {
  contextWindow: number;
  maxOutputTokens?: number;
  compactionPromptTokens?: number;
}

export function computeCompactionBuffer(contextWindow: number, maxOutputTokens: number): number {
  const remaining = Math.max(0, contextWindow - maxOutputTokens);
  const ratioCompactionBuffer = Math.ceil((1 - AUTO_COMPACT_BUFFER_RATIO) * remaining);
  const safeCompactionBuffer = Math.max(maxOutputTokens, ratioCompactionBuffer);
  return Math.min(safeCompactionBuffer, AUTO_COMPACT_BUFFER_CAP);
}

/** Continue-style threshold: compact before the next turn would exceed the window. */
export function computeCompactionThreshold(input: ComputeCompactionThresholdInput): number {
  const maxOutputTokens = resolveEffectiveMaxOutputTokens(
    input.contextWindow,
    input.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
  );
  const compactionPromptTokens = input.compactionPromptTokens ?? COMPACTION_PROMPT_RESERVE;
  const buffer = computeCompactionBuffer(input.contextWindow, maxOutputTokens);
  const threshold = input.contextWindow - maxOutputTokens - buffer - compactionPromptTokens;
  return Math.max(1, threshold);
}

export interface ComputeTotalInputTokensInput {
  messages: ModelMessage[];
  providerId?: string | null;
  systemPrompt?: string;
  toolNames?: string[];
  reservedTokens?: number;
}

export function computeTotalInputTokens(input: ComputeTotalInputTokensInput): number {
  const messageTokens = estimateModelMessagesTokensWithKind({
    messages: input.messages,
    providerId: input.providerId,
  }).tokens;
  const systemTokens = input.systemPrompt
    ? estimateTextTokens(input.systemPrompt, input.providerId)
    : 0;
  const toolTokens = input.toolNames?.length
    ? estimateUnknownTokens({ tools: input.toolNames }, input.providerId)
    : 0;
  const reserved = Math.max(0, Math.ceil(input.reservedTokens ?? 0));
  return messageTokens + systemTokens + toolTokens + reserved;
}

export function shouldCompactByBudget(input: {
  messages: ModelMessage[];
  contextWindow: number;
  maxOutputTokens?: number;
  providerId?: string | null;
  systemPrompt?: string;
  toolNames?: string[];
  reservedTokens?: number;
  forceThreshold?: number;
}): boolean {
  const total = computeTotalInputTokens({
    messages: input.messages,
    providerId: input.providerId,
    systemPrompt: input.systemPrompt,
    toolNames: input.toolNames,
    reservedTokens: input.reservedTokens,
  });
  const threshold = input.forceThreshold ?? computeCompactionThreshold({
    contextWindow: input.contextWindow,
    maxOutputTokens: input.maxOutputTokens,
  });
  return total >= threshold;
}
