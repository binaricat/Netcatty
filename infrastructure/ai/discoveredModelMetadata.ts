import { sanitizeContextWindow } from './contextCompaction';

/**
 * Read a context window from one entry of a provider `/models` payload.
 *
 * Vendors disagree on where the window lives: OpenAI-compatible lists that
 * carry it at all usually flatten it (`context_length`, `context_window`, ...),
 * while OpenCode Go nests it under `limit.context` alongside `limit.output`.
 * Keep both shapes working so discovery can show real limits for either.
 */
export function readDiscoveredModelContextWindow(
  model: Record<string, unknown>,
): number | undefined {
  const limit = model.limit && typeof model.limit === 'object'
    ? model.limit as Record<string, unknown>
    : undefined;
  return sanitizeContextWindow(
    model.context_length
      ?? model.context_window
      ?? model.contextWindow
      ?? model.context
      ?? model.max_context_tokens
      ?? limit?.context,
  );
}

function readStringArrayModalities(value: unknown): boolean | undefined {
  if (!Array.isArray(value) || value.length === 0) return undefined;
  const lower = value
    .filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0)
    .map((entry) => entry.trim().toLowerCase());
  if (lower.length === 0) return undefined;
  return lower.some((entry) => entry === 'image' || entry === 'vision' || entry === 'multimodal');
}

/**
 * Read image/vision input support from one entry of a provider `/models`
 * payload when the vendor publishes modality or capability metadata.
 *
 * Returns `undefined` when the entry does not declare vision support so
 * callers can fall back to deterministic family heuristics without falsely
 * rejecting custom relays.
 */
export function readDiscoveredModelVisionSupport(
  model: Record<string, unknown>,
): boolean | undefined {
  if (typeof model.supports_vision === 'boolean') return model.supports_vision;
  if (typeof model.supportsVision === 'boolean') return model.supportsVision;
  if (typeof model.vision === 'boolean') return model.vision;

  const directInputModalities = readStringArrayModalities(
    model.input_modalities ?? model.inputModalities,
  );
  if (directInputModalities !== undefined) return directInputModalities;

  const architecture = model.architecture && typeof model.architecture === 'object'
    ? model.architecture as Record<string, unknown>
    : undefined;
  if (architecture) {
    const archInput = readStringArrayModalities(
      architecture.input_modalities ?? architecture.inputModalities,
    );
    if (archInput !== undefined) return archInput;
    if (typeof architecture.modality === 'string' && architecture.modality.trim()) {
      const inputSide = architecture.modality.toLowerCase().split('->')[0] ?? '';
      if (inputSide.includes('image') || inputSide.includes('vision')) return true;
      if (inputSide.includes('text')) return false;
    }
  }

  const modalities = model.modalities && typeof model.modalities === 'object'
    ? model.modalities as Record<string, unknown>
    : undefined;
  if (modalities) {
    const modInput = readStringArrayModalities(modalities.input);
    if (modInput !== undefined) return modInput;
  }

  const capabilities = model.capabilities;
  if (Array.isArray(capabilities)) {
    const lower = capabilities
      .filter((entry): entry is string => typeof entry === 'string')
      .map((entry) => entry.trim().toLowerCase());
    if (lower.includes('vision') || lower.includes('image')) return true;
  } else if (capabilities && typeof capabilities === 'object') {
    const capRecord = capabilities as Record<string, unknown>;
    if (typeof capRecord.vision === 'boolean') return capRecord.vision;
    if (typeof capRecord.image === 'boolean') return capRecord.image;
    if (typeof capRecord.image_input === 'boolean') return capRecord.image_input;
  }

  return undefined;
}
