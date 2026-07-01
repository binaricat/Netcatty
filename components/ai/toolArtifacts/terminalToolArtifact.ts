import { normalizeArtifactToolName } from './toolArtifactNames';
import { parseResultPayload } from './toolArtifactResultPayload';

export type TerminalToolArtifact =
  | {
      kind: 'terminal.context';
      sessionId: string;
      label?: string;
      range: string;
      totalLines: number;
      startLine: number;
      endLine: number;
      returnedLines: number;
      hasMoreBefore: boolean;
      hasMoreAfter: boolean;
      source?: string;
      preview: string;
    }
  | {
      kind: 'error';
      message: string;
    };

const TERMINAL_ARTIFACT_TOOL_NAMES = new Set([
  'terminal_read_context',
]);

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function readNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function readBoolean(value: unknown): boolean {
  return value === true;
}

export function parseTerminalToolArtifact(
  toolName: string,
  result: unknown,
): TerminalToolArtifact | null {
  const normalizedToolName = normalizeArtifactToolName(toolName);
  if (!normalizedToolName || !TERMINAL_ARTIFACT_TOOL_NAMES.has(normalizedToolName)) return null;

  const payload = parseResultPayload(result);
  if (!payload) return null;

  if (payload.ok === false || payload.isError === true || typeof payload.error === 'string') {
    return {
      kind: 'error',
      message: readString(payload.error) ?? 'Terminal context read failed.',
    };
  }

  const sessionId = readString(payload.sessionId);
  const content = typeof payload.content === 'string' ? payload.content : '';
  const totalLines = readNumber(payload.totalLines);
  const startLine = readNumber(payload.startLine);
  const endLine = readNumber(payload.endLine);
  const returnedLines = readNumber(payload.returnedLines);
  if (!sessionId || totalLines == null || startLine == null || endLine == null || returnedLines == null) {
    return null;
  }

  return {
    kind: 'terminal.context',
    sessionId,
    label: readString(payload.label),
    range: readString(payload.range) ?? 'viewport',
    totalLines,
    startLine,
    endLine,
    returnedLines,
    hasMoreBefore: readBoolean(payload.hasMoreBefore),
    hasMoreAfter: readBoolean(payload.hasMoreAfter),
    source: readString(payload.source),
    preview: content.split('\n').slice(0, 6).join('\n'),
  };
}
