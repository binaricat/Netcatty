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

export function createCattyRequestTooLargeRetryError(
  error: unknown,
  hadToolProgress: boolean,
): CattyRequestTooLargeRetryError {
  const message = error instanceof Error
    ? error.message
    : String(error ?? 'Request too large');
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
  const message = error instanceof Error
    ? error.message
    : String(error ?? 'Invalid signature in thinking block');
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
