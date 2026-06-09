import type { ChatMessage } from './types';

type ErrorInfo = NonNullable<ChatMessage['errorInfo']>;

/**
 * Extract the human-readable message from anything that might surface as an
 * error (Error instance, string, SDK error object with `.message`, etc.).
 */
function extractMessage(error: unknown): string {
  if (error instanceof Error) return error.message || '';
  if (typeof error === 'string') return error;
  if (error && typeof error === 'object' && 'message' in error) {
    const m = (error as { message: unknown }).message;
    if (typeof m === 'string') return m;
  }
  try {
    return JSON.stringify(error) ?? '';
  } catch {
    return '';
  }
}

/**
 * Pull the HTTP status code out of an error when the SDK layer attached one.
 * Vercel AI SDK's APICallError exposes `.statusCode`; some shims use
 * `.status` or `.cause.statusCode`. Falls back to parsing the message text
 * when no structured field is available.
 */
function extractStatusCode(error: unknown, message: string): number | undefined {
  if (error && typeof error === 'object') {
    const obj = error as Record<string, unknown>;
    if (typeof obj.statusCode === 'number') return obj.statusCode;
    if (typeof obj.status === 'number') return obj.status;
    if (obj.cause && typeof obj.cause === 'object') {
      const causeStatus = (obj.cause as Record<string, unknown>).statusCode;
      if (typeof causeStatus === 'number') return causeStatus;
    }
  }
  const statusPatterns = [
    /\bHTTP\s*(4\d{2}|5\d{2})\b/i,
    /\bstatus(?:Code)?\s*[:=]?\s*(4\d{2}|5\d{2})\b/i,
    /\bcode\s*[:=]\s*(4\d{2}|5\d{2})\b/i,
    /^\s*(4\d{2}|5\d{2})\b(?!\s*ms\b)/i,
  ];
  for (const pattern of statusPatterns) {
    const match = message.match(pattern);
    if (match) return Number(match[1]);
  }
  return undefined;
}

/**
 * Pull the response body out of an error object if the SDK attached it.
 * Nginx / CDN proxy error pages ship as HTML, so we can detect them here.
 */
function extractResponseBody(error: unknown): string | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const body = (error as Record<string, unknown>).responseBody;
  if (typeof body === 'string') return body;
  return undefined;
}

export function isRequestTooLargeError(error: unknown): boolean {
  const message = extractMessage(error).trim();
  const responseBody = extractResponseBody(error) ?? "";
  const combined = `${message}\n${responseBody}`;
  const statusCode = extractStatusCode(error, combined);
  return (
    statusCode === 413 ||
    /\brequest entity too large\b/i.test(combined) ||
    /\b413\b(?!\s*ms\b).*\b(payload|request|too large|entity)\b/i.test(combined)
  );
}

function looksLikeHtml(text: string): boolean {
  if (!text) return false;
  const lower = text.toLowerCase();
  const trimmedStart = lower.trimStart().slice(0, 200);
  // Start-of-body: responseBody captured verbatim by the SDK lands here.
  if (
    trimmedStart.startsWith('<!doctype html') ||
    trimmedStart.startsWith('<html') ||
    trimmedStart.startsWith('<head') ||
    trimmedStart.startsWith('<body')
  ) {
    return true;
  }
  // Embedded: some SDKs wrap the HTML body inside an error message like
  // "Parse failed: <html>...". Look for unmistakable HTML tags anywhere
  // in the text. Kept narrow to avoid flagging errors that casually
  // mention "html" as a word.
  if (
    lower.includes('<!doctype html') ||
    lower.includes('<html>') ||
    lower.includes('<html ') ||
    // Common nginx default error-page opener.
    /<center>\s*<h1>/.test(lower)
  ) {
    return true;
  }
  return false;
}

function looksLikeZodParseError(message: string): boolean {
  // Zod and Vercel AI SDK schema errors look like:
  //   Expected 'id' to be a string.
  //   Expected 'choices' to be an array.
  //   Invalid JSON response: ...
  //   Type validation failed: ...
  return (
    /\bExpected '[^']+' to be (a|an) /i.test(message) ||
    /\binvalid json response\b/i.test(message) ||
    /\btype validation failed\b/i.test(message)
  );
}

/**
 * Map an arbitrary error surface to display-safe error info shown in the
 * chat UI. Known hostile scenarios get a concrete, actionable message; the
 * raw SDK text is appended so users can still report it verbatim.
 *
 * Covers:
 *   - HTTP 413 (proxy request-size limit, e.g. nginx client_max_body_size)
 *   - HTTP 502/504 (upstream proxy failures)
 *   - HTML error page returned in place of JSON (any proxy)
 *   - Schema/parse failures ("Expected 'id' to be a string.") that typically
 *     mean the server swapped the response body for an error page
 */
export function classifyError(error: unknown): ErrorInfo {
  const rawMessage = extractMessage(error).trim() || 'Unknown error';
  const statusCode = extractStatusCode(error, rawMessage);
  const responseBody = extractResponseBody(error);

  const hasHtml =
    looksLikeHtml(rawMessage) ||
    (responseBody !== undefined && looksLikeHtml(responseBody));
  const looksLikeParseError = looksLikeZodParseError(rawMessage);

  const sanitizedRaw = sanitizeErrorMessage(rawMessage);

  if (isRequestTooLargeError(error)) {
    return {
      type: 'network',
      message:
        `Request too large (HTTP 413). The AI gateway rejected the payload — this usually means ` +
        `the request body exceeded the proxy's size limit (for example nginx \`client_max_body_size\`). ` +
        `Try sending a shorter message, fewer/smaller attachments, or raising the proxy limit.\n\n` +
        `Raw: ${sanitizedRaw}`,
      retryable: false,
    };
  }

  if (statusCode === 502 || statusCode === 503 || statusCode === 504) {
    return {
      type: 'network',
      message:
        `AI gateway error (HTTP ${statusCode}). The proxy in front of the provider returned an error — ` +
        `the upstream AI service may be unreachable or timing out.\n\n` +
        `Raw: ${sanitizedRaw}`,
      retryable: true,
    };
  }

  if (hasHtml) {
    return {
      type: 'provider',
      message:
        `The server returned an HTML error page instead of a JSON response. ` +
        `This almost always means a proxy (nginx / CDN / gateway) between you and the AI provider ` +
        `intercepted the request — commonly due to a size limit, auth failure, or the upstream service being down.\n\n` +
        `Raw: ${sanitizedRaw}`,
      retryable: false,
    };
  }

  if (looksLikeParseError) {
    return {
      type: 'provider',
      message:
        `The AI response could not be parsed as a valid chat completion. ` +
        `A proxy may have replaced or truncated the response body, or the provider returned a non-standard format. ` +
        `If you just sent a large request, check for a request-size limit on any intermediate proxy.\n\n` +
        `Raw: ${sanitizedRaw}`,
      retryable: false,
    };
  }

  return { type: 'unknown', message: sanitizedRaw, retryable: false };
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
