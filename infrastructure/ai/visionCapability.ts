import { readDiscoveredModelVisionSupport } from './discoveredModelMetadata';

export type VisionSupport = 'yes' | 'no' | 'unknown';

export interface VisionModelContext {
  providerId?: string | null;
  modelId?: string | null;
  /** Optional authoritative flag from discovered provider metadata. */
  supportsVision?: boolean | null;
  /** Optional raw `/models` payload entry from provider discovery. */
  discoveredModel?: Record<string, unknown> | null;
}

const THINKING_SUFFIX_PATTERN = /\/(off|low|medium|high|xhigh|max)$/i;

function normalizeModelId(raw: string): { full: string; bare: string } {
  const trimmed = raw.trim().toLowerCase();
  const withoutThinking = trimmed.replace(THINKING_SUFFIX_PATTERN, '');
  const withoutTag = withoutThinking.includes(':')
    ? withoutThinking.slice(0, withoutThinking.indexOf(':'))
    : withoutThinking;
  const slashIndex = withoutTag.lastIndexOf('/');
  const bare = slashIndex >= 0 ? withoutTag.slice(slashIndex + 1) : withoutTag;
  return { full: withoutTag, bare };
}

const KNOWN_TEXT_ONLY_PATTERNS: readonly RegExp[] = [
  /^deepseek-(chat|reasoner|coder)\b/,
  /^deepseek-r1(\b|-|$)/,
  /^deepseek-v[23](\b|-|\.)/,
  /^o1-(mini|preview)(\b|-|$)/,
  /^o3-mini(\b|-|$)/,
  /^gpt-3\.5\b/,
  /^gpt-4(-0314|-0613|-32k\b)?$/,
  /^qwen[0-9.]*-coder(\b|-|$)/,
  /^qwq(\b|-|$)/,
  /^codestral(\b|-|$)/,
  /^devstral(\b|-|$)/,
  /^llama-?3\.1(\b|-|$)/,
  /^llama-?3\.3(\b|-|$)/,
  /^mistral-large(\b|-|$)/,
  /^claude-(2(\.\d)?|instant)(\b|-|$)/,
  /^gemini-embedding(\b|-|$)/,
  /^text-embedding\b/,
];

const KNOWN_VISION_PATTERNS: readonly RegExp[] = [
  /^gpt-4o(\b|-|$)/,
  /^chatgpt-4o(\b|-|$)/,
  /^gpt-4\.[15](\b|-|$)/,
  /^gpt-4-turbo(\b|-|$)/,
  /^gpt-4-vision(\b|-|$)/,
  /^gpt-5(\b|-|\.)/,
  /^o1(\b|-pro|-202\d|$)/,
  /^o3(\b|-pro|-202\d|$)/,
  /^o4-mini(\b|-|$)/,
  /^claude-(3|4|5)(\b|-|\.)/,
  /^claude-(sonnet|opus|haiku)(\b|-|$)/,
  /^gemini-/,
  /^qwen[0-9.]*-vl(\b|-|$)/,
  /^qwen3\.[567](\b|-|$)/,
  /^qvq(\b|-|$)/,
  /^glm-4(\.\d+)?v(\b|-|$)/,
  /^kimi-k2\.5(\b|-|$)/,
  /^kimi-vl(\b|-|$)/,
  /^moonshot-v1-.*vision/,
  /^doubao-seed(\b|-|$)/,
  /^doubao-[0-9.]*-?vision(\b|-|$)/,
  /^deepseek-vl(\d|\b|-|$)/,
  /^llava(\b|-|$)/,
  /^bakllava(\b|-|$)/,
  /^llama-?3\.2-.*vision/,
  /^llama-?4(\b|-|$)/,
  /^pixtral(\b|-|$)/,
  /^internvl(\b|-|$)/,
  /^minicpm-v(\b|-|$)/,
  /^gemma-?3(\b|-|$)/,
  /^grok-(2-vision|3|4)(\b|-|$)/,
  /^nova-(lite|pro|premier)(\b|-|$)/,
  /^phi-(3\.5-vision|4-multimodal)(\b|-|$)/,
  /^mimo-vl(\b|-|$)/,
  /^step-1v(\b|-|$)/,
];

/**
 * Deterministic model-family fallback for image input support.
 *
 * Returns `'unknown'` for unrecognized/custom model IDs so users on custom
 * relays or self-hosted vision models are never hard-blocked.
 */
export function inferModelVisionSupport(
  providerId?: string | null,
  modelId?: string | null,
): VisionSupport {
  if (!modelId || typeof modelId !== 'string' || !modelId.trim()) {
    return 'unknown';
  }
  const { bare } = normalizeModelId(modelId);
  if (!bare) return 'unknown';

  // Explicit multimodal markers (e.g. deepseek-vl2, llama-3.2-vision, qwen2.5-vl)
  // take precedence over text-only family prefixes.
  if (/(^|-)vl(\d|\b|-|$)|vision|multimodal/.test(bare)) {
    return 'yes';
  }

  for (const pattern of KNOWN_TEXT_ONLY_PATTERNS) {
    if (pattern.test(bare)) return 'no';
  }

  for (const pattern of KNOWN_VISION_PATTERNS) {
    if (pattern.test(bare)) return 'yes';
  }

  // Provider-level defaults only when model name didn't match either table:
  // never hard-block unknown models on custom/openrouter/ollama/etc.
  void providerId;
  return 'unknown';
}

/**
 * Two-layer vision capability resolver:
 * 1. Authoritative discovered metadata (`supportsVision` or raw `/models` payload).
 * 2. Deterministic model-family heuristic (`inferModelVisionSupport`).
 */
export function resolveModelVisionSupport(input: VisionModelContext): VisionSupport {
  if (typeof input.supportsVision === 'boolean') {
    return input.supportsVision ? 'yes' : 'no';
  }
  if (input.discoveredModel && typeof input.discoveredModel === 'object') {
    const discovered = readDiscoveredModelVisionSupport(input.discoveredModel);
    if (typeof discovered === 'boolean') {
      return discovered ? 'yes' : 'no';
    }
  }
  return inferModelVisionSupport(input.providerId, input.modelId);
}

const VISION_UNSUPPORTED_ERROR_PATTERNS: readonly RegExp[] = [
  /does not support image/i,
  /image input(?:s)? (?:is |are )?not supported/i,
  /not a vision model/i,
  /multimodal.*not supported/i,
  /image_url.*not supported/i,
  /unsupported content type.*image/i,
  /vision.*not supported/i,
  /cannot process image/i,
];

export function isVisionUnsupportedProviderError(error: unknown): boolean {
  const message = error instanceof Error
    ? error.message
    : typeof error === 'string'
      ? error
      : error && typeof error === 'object' && 'message' in error
        ? String((error as { message?: unknown }).message ?? '')
        : '';
  if (!message) return false;
  return VISION_UNSUPPORTED_ERROR_PATTERNS.some((pattern) => pattern.test(message));
}
