import {
  sanitizeRemoteDesktopActionsForAudit,
  validateAndNormalizeRemoteDesktopActions,
} from '../../../domain/remoteDesktopActionCodec';

function sanitizeArgsForTooltip(args?: Record<string, unknown>): Record<string, unknown> | undefined {
  if (!args) return undefined;
  if (!Array.isArray(args.actions)) return args;
  const parsed = validateAndNormalizeRemoteDesktopActions(args.actions);
  if (!parsed.ok) return args;
  return {
    ...args,
    actions: sanitizeRemoteDesktopActionsForAudit(parsed.actions),
  };
}

function serialize(value: unknown): string {
  if (value == null) return '';
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      if (parsed && typeof parsed === 'object') {
        return JSON.stringify(parsed, null, 2);
      }
    } catch {
      return value;
    }
    return value;
  }
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

export function formatRemoteDesktopToolTooltip(
  toolName: string,
  args?: Record<string, unknown>,
  result?: unknown,
  isError?: boolean,
): string {
  const safeArgs = sanitizeArgsForTooltip(args);
  const sections = [
    `Tool: ${toolName}`,
    safeArgs && Object.keys(safeArgs).length > 0 ? `Args:\n${serialize(safeArgs)}` : null,
    result !== undefined && result !== '' ? `Result:\n${serialize(result)}` : null,
    isError ? 'Status: error' : null,
  ].filter(Boolean);

  return sections.join('\n\n');
}
