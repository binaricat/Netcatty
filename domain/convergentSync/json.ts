import type { JsonValue } from './types';

export function isJsonValue(value: unknown): value is JsonValue {
  if (
    value === null
    || typeof value === 'string'
    || typeof value === 'boolean'
  ) {
    return true;
  }
  if (typeof value === 'number') return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJsonValue);
  if (!value || typeof value !== 'object') return false;
  return Object.values(value).every(isJsonValue);
}

export function cloneJson<T extends JsonValue>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((item) => cloneJson(item)) as T;
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, nested]) => [key, cloneJson(nested)]),
    ) as T;
  }
  return value;
}

export function canonicalizeJson<T extends JsonValue>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((item) => canonicalizeJson(item)) as T;
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonicalizeJson(value[key])]),
    ) as T;
  }
  return value;
}

export function canonicalJsonString(value: JsonValue): string {
  return JSON.stringify(canonicalizeJson(value));
}

export function jsonValuesEqual(left: JsonValue, right: JsonValue): boolean {
  return canonicalJsonString(left) === canonicalJsonString(right);
}
