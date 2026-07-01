function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function parseJsonRecord(value: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(value) as unknown;
    return parseResultPayload(parsed);
  } catch {
    return null;
  }
}

function looksLikeJson(value: string): boolean {
  const trimmed = value.trim();
  return trimmed.startsWith('{') || trimmed.startsWith('[');
}

function unwrapMcpTextEnvelope(value: unknown): unknown {
  if (Array.isArray(value)) {
    const textPart = value.find((entry) => {
      const record = asRecord(entry);
      return record?.type === 'text' && typeof record.text === 'string';
    });
    const record = asRecord(textPart);
    return typeof record?.text === 'string' ? record.text : value;
  }

  const record = asRecord(value);
  if (record?.type === 'text' && typeof record.text === 'string') {
    return record.text;
  }
  if (Array.isArray(record?.content)) {
    return unwrapMcpTextEnvelope(record.content);
  }
  if (typeof record?.content === 'string' && looksLikeJson(record.content)) {
    return record.content;
  }
  if (typeof record?.detailedContent === 'string' && looksLikeJson(record.detailedContent)) {
    return record.detailedContent;
  }
  if (Array.isArray(record?.contents)) {
    return unwrapMcpTextEnvelope(record.contents);
  }

  return value;
}

export function parseResultPayload(result: unknown): Record<string, unknown> | null {
  if (result == null) return null;
  const unwrapped = unwrapMcpTextEnvelope(result);

  if (typeof unwrapped === 'string') {
    return parseJsonRecord(unwrapped);
  }

  return asRecord(unwrapped);
}
