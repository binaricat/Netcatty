import type { ChatMessage } from './types';

/**
 * Classifies a raw error string into structured error info for display.
 */
export function classifyError(error: string): NonNullable<ChatMessage['errorInfo']> {
  const lower = error.toLowerCase();

  // Network errors
  if (lower.includes('econnrefused') || lower.includes('enotfound') || lower.includes('enetunreach') || lower.includes('fetch failed') || lower.includes('network')) {
    return { type: 'network', message: 'Network connection failed. Please check your internet connection and API endpoint.', retryable: true };
  }

  // Timeout
  if (lower.includes('timeout') || lower.includes('timed out') || lower.includes('econnreset') || lower.includes('socket hang up')) {
    return { type: 'timeout', message: 'Request timed out. The server may be overloaded or unreachable.', retryable: true };
  }

  // Auth errors
  if (lower.includes('401') || lower.includes('403') || lower.includes('unauthorized') || lower.includes('invalid api key') || lower.includes('authentication')) {
    return { type: 'auth', message: 'Authentication failed. Please check your API key in Settings \u2192 AI.', retryable: false };
  }

  // Rate limit
  if (lower.includes('429') || lower.includes('rate limit') || lower.includes('too many requests')) {
    return { type: 'provider', message: 'Rate limit exceeded. Please wait a moment before retrying.', retryable: true };
  }

  // Provider errors (5xx)
  if (/\b5\d{2}\b/.test(error) || lower.includes('server error') || lower.includes('internal error')) {
    return { type: 'provider', message: sanitizeErrorMessage(error), retryable: true };
  }

  // Model not found
  if (lower.includes('model not found') || lower.includes('does not exist') || lower.includes('404')) {
    return { type: 'provider', message: 'Model not found. Please check your model selection in Settings \u2192 AI.', retryable: false };
  }

  // Command blocked
  if (lower.includes('blocked by safety')) {
    return { type: 'agent', message: sanitizeErrorMessage(error), retryable: false };
  }

  return { type: 'unknown', message: sanitizeErrorMessage(error), retryable: true };
}

const MAX_ERROR_MESSAGE_LENGTH = 500;

/**
 * Sanitize an error message before displaying it to the user.
 * Strips file paths, URLs with credentials, and truncates long messages.
 */
export function sanitizeErrorMessage(msg: string): string {
  let sanitized = msg;

  // Strip file system paths (Unix and Windows)
  sanitized = sanitized.replace(/(?:\/Users\/|\/home\/|\/tmp\/|\/var\/|[A-Z]:\\)[^\s"'`,;)}\]>]*/gi, '<path>');

  // Strip URLs containing API keys or tokens in query params
  sanitized = sanitized.replace(/https?:\/\/[^\s"']*[?&](key|token|api_key|apikey|secret|access_token|auth)=[^\s"'&]*/gi, '<url-redacted>');

  // Truncate overly long messages
  if (sanitized.length > MAX_ERROR_MESSAGE_LENGTH) {
    sanitized = sanitized.slice(0, MAX_ERROR_MESSAGE_LENGTH) + '...';
  }

  return sanitized;
}
