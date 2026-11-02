/**
 * UTF-16 safe string slicing for text that reaches a model request.
 *
 * `String.prototype.slice` counts code units, so a cut can split an emoji or
 * other astral character into a lone surrogate. JSON.stringify escapes that as
 * `\udXXX`, and strict providers (serde_json based, e.g. DeepSeek) reject the
 * whole request body with "lone leading surrogate in hex escape".
 */

const LONE_SURROGATE_PATTERN = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g;

function isHighSurrogate(value: number): boolean {
  return value >= 0xd800 && value <= 0xdbff;
}

function isLowSurrogate(value: number): boolean {
  return value >= 0xdc00 && value <= 0xdfff;
}

/** Clamp [start, end) and move each edge off the middle of a surrogate pair. */
export function safeSliceBounds(value: string, requestedStart: number, requestedEnd: number): [number, number] {
  let start = Math.min(value.length, Math.max(0, requestedStart));
  let end = Math.min(value.length, Math.max(start, requestedEnd));
  if (start > 0 && start < value.length && isLowSurrogate(value.charCodeAt(start))) {
    start -= 1;
  }
  if (end > start && end < value.length && isHighSurrogate(value.charCodeAt(end - 1))) {
    end -= 1;
  }
  return [start, end];
}

/** At most `maxChars` leading code units, never ending inside a surrogate pair. */
export function sliceHead(value: string, maxChars: number): string {
  if (maxChars <= 0) return '';
  if (value.length <= maxChars) return value;
  const end = isHighSurrogate(value.charCodeAt(maxChars - 1)) ? maxChars - 1 : maxChars;
  return value.slice(0, end);
}

/** At most `maxChars` trailing code units, never starting inside a surrogate pair. */
export function sliceTail(value: string, maxChars: number): string {
  if (maxChars <= 0) return '';
  if (value.length <= maxChars) return value;
  const start = value.length - maxChars;
  return value.slice(isLowSurrogate(value.charCodeAt(start)) ? start + 1 : start);
}

/** Replace lone surrogates with U+FFFD so the string serializes as valid JSON text. */
export function toWellFormedText(value: string): string {
  LONE_SURROGATE_PATTERN.lastIndex = 0;
  if (!LONE_SURROGATE_PATTERN.test(value)) return value;
  LONE_SURROGATE_PATTERN.lastIndex = 0;
  return value.replace(LONE_SURROGATE_PATTERN, '\ufffd');
}

/**
 * Apply {@link toWellFormedText} to every string inside plain objects and
 * arrays. Unchanged subtrees keep their identity; binary values and class
 * instances are left alone.
 */
export function toWellFormedValue<T>(value: T): T {
  if (typeof value === 'string') return toWellFormedText(value) as T;
  if (Array.isArray(value)) {
    let changed = false;
    const next = value.map((entry) => {
      const fitted = toWellFormedValue(entry);
      if (fitted !== entry) changed = true;
      return fitted;
    });
    return (changed ? next : value) as T;
  }
  if (!value || typeof value !== 'object') return value;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return value;
  let changed = false;
  // Keep the source prototype and define own properties: plain assignment of
  // an own `__proto__` key (e.g. from JSON.parse) would hit the inherited
  // setter, dropping the field and swapping the clone's prototype.
  const next = Object.create(prototype) as Record<string, unknown>;
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    const fitted = toWellFormedValue(entry);
    if (fitted !== entry) changed = true;
    Object.defineProperty(next, key, { value: fitted, enumerable: true, writable: true, configurable: true });
  }
  return (changed ? next : value) as T;
}
