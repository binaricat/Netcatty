import type { ModelMessage } from 'ai';
import type { TokenEstimatorKind } from './types';

const CHARS_PER_TOKEN_FALLBACK = 4;
export const FULL_IMAGE_VISION_TOKENS = 1_200;
export const CROPPED_IMAGE_VISION_TOKENS = 600;

interface ContentUnits {
  chars: number;
  visionTokens: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isImageContentPart(part: Record<string, unknown>): boolean {
  if (part.type === 'image') return true;
  if (part.type === 'file') {
    const mediaType = typeof part.mediaType === 'string' ? part.mediaType.toLowerCase() : '';
    return mediaType.startsWith('image/');
  }
  return false;
}

function textHintIndicatesCrop(text: string): boolean {
  return /"crop"\s*:|\bcrop=/.test(text);
}

function collectSiblingText(parts: readonly unknown[]): string {
  let combined = '';
  for (const part of parts) {
    if (isRecord(part) && part.type === 'text' && typeof part.text === 'string') {
      combined += `${part.text}\n`;
    }
  }
  return combined;
}

function estimateImagePartTokens(
  part: Record<string, unknown>,
  siblingTextHint?: string,
): number {
  if (siblingTextHint && textHintIndicatesCrop(siblingTextHint)) {
    return CROPPED_IMAGE_VISION_TOKENS;
  }
  const filename = typeof part.filename === 'string' ? part.filename.toLowerCase() : '';
  if (filename.includes('snip') || filename.includes('crop')) {
    return CROPPED_IMAGE_VISION_TOKENS;
  }
  return FULL_IMAGE_VISION_TOKENS;
}

function estimateUnits(value: unknown, siblingTextHint?: string): ContentUnits {
  if (value == null) return { chars: 0, visionTokens: 0 };
  if (typeof value === 'string') return { chars: value.length, visionTokens: 0 };
  if (Array.isArray(value)) {
    const arrayTextHint = collectSiblingText(value) || siblingTextHint;
    let chars = 0;
    let visionTokens = 0;
    for (const item of value) {
      const units = estimateUnits(item, arrayTextHint);
      chars += units.chars;
      visionTokens += units.visionTokens;
    }
    return { chars, visionTokens };
  }
  if (isRecord(value)) {
    if (isImageContentPart(value)) {
      return {
        chars: 0,
        visionTokens: estimateImagePartTokens(value, siblingTextHint),
      };
    }
    if (value.type === 'tool-result' && isRecord(value.output) && value.output.type === 'content' && Array.isArray(value.output.value)) {
      const metaOverhead = estimateUnits({
        type: value.type,
        toolCallId: value.toolCallId,
        toolName: value.toolName,
      });
      const contentUnits = estimateUnits(value.output.value);
      return {
        chars: metaOverhead.chars + contentUnits.chars,
        visionTokens: metaOverhead.visionTokens + contentUnits.visionTokens,
      };
    }
    try {
      return { chars: JSON.stringify(value).length, visionTokens: 0 };
    } catch {
      return { chars: String(value).length, visionTokens: 0 };
    }
  }
  return { chars: String(value).length, visionTokens: 0 };
}

export function resolveEstimatorKind(providerId?: string | null): TokenEstimatorKind {
  const id = (providerId ?? '').toLowerCase();
  if (id.includes('openai') || id.includes('gpt')) return 'openai-heuristic';
  if (id.includes('anthropic') || id.includes('claude')) return 'anthropic-heuristic';
  if (id.includes('google') || id.includes('gemini')) return 'google-heuristic';
  return 'chars-div-4';
}

function applyHeuristicMultiplier(chars: number, kind: TokenEstimatorKind): number {
  if (chars <= 0) return 0;
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
  const units = estimateUnits(value);
  return applyHeuristicMultiplier(units.chars, kind) + units.visionTokens;
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
  let chars = 0;
  let visionTokens = 0;
  for (const message of input.messages) {
    const roleUnits = estimateUnits(message.role);
    const contentUnits = estimateUnits(message.content);
    chars += roleUnits.chars + contentUnits.chars;
    visionTokens += roleUnits.visionTokens + contentUnits.visionTokens;
  }
  return {
    tokens: applyHeuristicMultiplier(chars, estimatorKind) + visionTokens,
    estimatorKind,
  };
}

export function estimateModelMessagesTokens(
  messages: ModelMessage[],
  providerId?: string | null,
): number {
  return estimateModelMessagesTokensWithKind({ messages, providerId }).tokens;
}
