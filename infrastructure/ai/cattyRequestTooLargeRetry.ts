export type CattyRequestTooLargeRetryError = Error & {
  cattyHadToolProgress?: boolean;
  statusCode?: number;
  status?: number;
  responseBody?: string;
};

export type CattyAnthropicSignatureRetryError = Error & {
  cattyHadToolProgress?: boolean;
  statusCode?: number;
  status?: number;
  responseBody?: string;
};

/**
 * Mirror errorClassifier.extractMessage so plain SDK / SSE error objects
 * with a string `.message` keep that text (not `[object Object]`).
 */
function extractRetryMessage(error: unknown, fallback: string): string {
  if (error instanceof Error) return error.message || fallback;
  if (typeof error === 'string') return error;
  if (error && typeof error === 'object' && 'message' in error) {
    const m = (error as { message: unknown }).message;
    if (typeof m === 'string' && m.length > 0) return m;
  }
  return fallback;
}

export function createCattyRequestTooLargeRetryError(
  error: unknown,
  hadToolProgress: boolean,
): CattyRequestTooLargeRetryError {
  const message = extractRetryMessage(error, 'Request too large');
  const retryError = new Error(message) as CattyRequestTooLargeRetryError;
  retryError.name = 'CattyRequestTooLargeRetryError';
  retryError.cause = error;
  retryError.cattyHadToolProgress = hadToolProgress;
  retryError.statusCode = 413;
  if (error && typeof error === 'object') {
    const source = error as Record<string, unknown>;
    if (typeof source.status === 'number') retryError.status = source.status;
    if (typeof source.responseBody === 'string') retryError.responseBody = source.responseBody;
  }
  return retryError;
}

/**
 * Wrap an Anthropic thinking-signature failure so the turn-driver retry path
 * can see prior tool progress, while keeping message/body/status intact for
 * `isInvalidAnthropicThinkingSignatureError`.
 */
export function createCattyAnthropicSignatureRetryError(
  error: unknown,
  hadToolProgress: boolean,
): CattyAnthropicSignatureRetryError {
  const message = extractRetryMessage(error, 'Invalid signature in thinking block');
  const retryError = new Error(message) as CattyAnthropicSignatureRetryError;
  retryError.name = 'CattyAnthropicSignatureRetryError';
  retryError.cause = error;
  retryError.cattyHadToolProgress = hadToolProgress;
  if (error && typeof error === 'object') {
    const source = error as Record<string, unknown>;
    if (typeof source.statusCode === 'number') retryError.statusCode = source.statusCode;
    else if (typeof source.status === 'number') retryError.statusCode = source.status;
    else retryError.statusCode = 400;
    if (typeof source.status === 'number') retryError.status = source.status;
    if (typeof source.responseBody === 'string') retryError.responseBody = source.responseBody;
  } else {
    retryError.statusCode = 400;
  }
  return retryError;
}

export function hadToolProgressBeforeRequestTooLarge(error: unknown): boolean {
  return !!(
    error &&
    typeof error === 'object' &&
    (error as { cattyHadToolProgress?: boolean }).cattyHadToolProgress
  );
}
