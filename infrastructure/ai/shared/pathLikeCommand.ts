/** True when the configured agent command looks like an explicit filesystem path. */
export function isPathLikeCommand(command: string | undefined): boolean {
  const normalized = String(command || '').trim();
  return normalized.includes('/') || normalized.includes('\\') || /^[a-z]:/i.test(normalized);
}

export function getCommandBasename(command: string | undefined): string {
  const normalized = String(command || '').trim();
  if (!normalized) return '';
  const parts = normalized.split(/[\\/]/);
  return (parts.pop() || '').toLowerCase();
}
