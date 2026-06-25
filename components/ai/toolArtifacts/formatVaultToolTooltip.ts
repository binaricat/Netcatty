function stringifyToolPayload(value: unknown): string {
  if (value == null) return '';
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value) as unknown;
      if (parsed && typeof parsed === 'object') {
        return JSON.stringify(parsed, null, 2);
      }
    } catch {
      return value;
    }
    return value;
  }
  if (typeof value === 'object') {
    return JSON.stringify(value, null, 2);
  }
  return String(value);
}

export function formatVaultToolTooltip(
  toolName: string,
  args?: Record<string, unknown>,
  result?: unknown,
  isError?: boolean,
): string {
  const lines: string[] = [toolName];

  if (args && Object.keys(args).length > 0) {
    lines.push('', 'Arguments:', stringifyToolPayload(args));
  }

  if (result !== undefined) {
    lines.push('', isError ? 'Error:' : 'Result:', stringifyToolPayload(result));
  }

  return lines.join('\n');
}
