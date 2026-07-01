function serialize(value: unknown): string {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

export function formatTerminalToolTooltip(
  toolName: string,
  args?: Record<string, unknown>,
  result?: unknown,
  isError?: boolean,
): string {
  const sections = [
    `Tool: ${toolName}`,
    args ? `Args:\n${serialize(args)}` : null,
    result ? `Result:\n${serialize(result)}` : null,
    isError ? 'Status: error' : null,
  ].filter(Boolean);

  return sections.join('\n\n');
}
