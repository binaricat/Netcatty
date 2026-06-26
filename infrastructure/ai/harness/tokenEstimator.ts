import type { ModelMessage } from 'ai';
import type { TokenEstimatorKind } from './types';

const CHARS_PER_TOKEN_FALLBACK = 4;

function estimateChars(value: unknown): number {
  if (value == null) return 0;
  if (typeof value === 'string') return value.length;
  if (Array.isArray(value)) {
    return value.reduce((sum, item) => sum + estimateChars(item), 0);
  }
  if (typeof value === 'object') {
    try {
      return JSON.stringify(value).length;
    } catch {
      return String(value).length;
    }
  }
  return String(value).length;
}

export function resolveEstimatorKind(providerId?: string | null): TokenEstimatorKind {
  const id = (providerId ?? '').toLowerCase();
  if (id.includes('openai') || id.includes('gpt')) return 'openai-heuristic';
  if (id.includes('anthropic') || id.includes('claude')) return 'anthropic-heuristic';
  if (id.includes('google') || id.includes('gemini')) return 'google-heuristic';
  return 'chars-div-4';
}

function applyHeuristicMultiplier(chars: number, kind: TokenEstimatorKind): number {
  switch (kind) {
    case 'openai-heuristic':
      return Math.ceil(chars / 3.5);
    case 'anthropic-heuristic':
      return Math.ceil(chars / 3.2);
    case 'google-heuristic':
      return Math.ceil(chars / 3.8);
    default:
      return Math.ceil(chars / CHARS_PER_TOKEN_FALLBACK);
  }
}

export function estimateTextTokens(text: string, providerId?: string | null): number {
  const kind = resolveEstimatorKind(providerId);
  return applyHeuristicMultiplier(text.length, kind);
}

export function estimateUnknownTokens(value: unknown, providerId?: string | null): number {
  const kind = resolveEstimatorKind(providerId);
  return applyHeuristicMultiplier(estimateChars(value), kind);
}

export interface EstimateModelMessagesTokensInput {
  messages: ModelMessage[];
  providerId?: string | null;
}

export interface EstimateModelMessagesTokensResult {
  tokens: number;
  estimatorKind: TokenEstimatorKind;
}

export function estimateModelMessagesTokensWithKind(
  input: EstimateModelMessagesTokensInput,
): EstimateModelMessagesTokensResult {
  const estimatorKind = resolveEstimatorKind(input.providerId);
  const chars = input.messages.reduce((total, message) => {
    return total + estimateChars(message.role) + estimateChars(message.content);
  }, 0);
  return {
    tokens: applyHeuristicMultiplier(chars, estimatorKind),
    estimatorKind,
  };
}

export function estimateModelMessagesTokens(
  messages: ModelMessage[],
  providerId?: string | null,
): number {
  return estimateModelMessagesTokensWithKind({ messages, providerId }).tokens;
}
