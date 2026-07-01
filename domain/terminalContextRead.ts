export type TerminalContextReadRange = "viewport" | "tail" | "head" | "lines";

export type TerminalContextReadSource = "live" | "snapshot";

export const TERMINAL_CONTEXT_DEFAULT_MAX_LINES = 80;
export const TERMINAL_CONTEXT_MAX_LINES = 300;

export interface TerminalContextReadRequest {
  sessionId?: string;
  range?: TerminalContextReadRange;
  startLine?: number;
  maxLines?: number;
}

export interface TerminalContextLineWindowInput {
  range?: TerminalContextReadRange;
  totalLines: number;
  viewportStartLine?: number;
  viewportEndLine?: number;
  startLine?: number;
  maxLines?: number;
}

export interface TerminalContextLineWindow {
  startLine: number;
  endLine: number;
  maxLines: number;
}

export interface TerminalContextReadResult {
  ok: true;
  sessionId: string;
  label?: string;
  range: TerminalContextReadRange;
  content: string;
  totalLines: number;
  startLine: number;
  endLine: number;
  returnedLines: number;
  hasMoreBefore: boolean;
  hasMoreAfter: boolean;
  source: TerminalContextReadSource;
  alternateScreen?: boolean;
}

export type TerminalContextReader = (
  request: TerminalContextReadRequest & { sessionId: string },
) => Promise<TerminalContextReadResult | { ok: false; error: string }>;

export interface BuildTerminalContextReadResultInput {
  sessionId: string;
  label?: string;
  fullText: string;
  range?: TerminalContextReadRange;
  startLine?: number;
  maxLines?: number;
  source: TerminalContextReadSource;
  alternateScreen?: boolean;
  viewportStartLine?: number;
  viewportEndLine?: number;
}

export interface TerminalContextSnapshotTextInput {
  scrollbackText?: string;
  viewportText?: string;
  pendingText?: string;
}

export interface TerminalContextSnapshotText {
  fullText: string;
  viewportStartLine?: number;
  viewportEndLine?: number;
}

export function normalizeTerminalContextMaxLines(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return TERMINAL_CONTEXT_DEFAULT_MAX_LINES;
  }
  return Math.min(
    TERMINAL_CONTEXT_MAX_LINES,
    Math.max(1, Math.round(value)),
  );
}

export function normalizeTerminalContextRange(value: unknown): TerminalContextReadRange {
  if (
    value === "viewport" ||
    value === "tail" ||
    value === "head" ||
    value === "lines"
  ) {
    return value;
  }
  return "viewport";
}

export function resolveTerminalContextLineWindow(
  input: TerminalContextLineWindowInput,
): TerminalContextLineWindow {
  const range = normalizeTerminalContextRange(input.range);
  const maxLines = normalizeTerminalContextMaxLines(input.maxLines);
  const totalLines = Math.max(0, Math.floor(input.totalLines));

  if (totalLines === 0) {
    return { startLine: 0, endLine: -1, maxLines };
  }

  if (range === "head") {
    return {
      startLine: 0,
      endLine: Math.min(totalLines - 1, maxLines - 1),
      maxLines,
    };
  }

  if (range === "tail") {
    return {
      startLine: Math.max(0, totalLines - maxLines),
      endLine: totalLines - 1,
      maxLines,
    };
  }

  if (range === "lines") {
    const start = clampLine(input.startLine, totalLines);
    return {
      startLine: start,
      endLine: Math.min(totalLines - 1, start + maxLines - 1),
      maxLines,
    };
  }

  const viewportStart = clampLine(input.viewportStartLine, totalLines);
  const viewportEnd = clampLine(input.viewportEndLine, totalLines);
  const rawStart = Math.min(viewportStart, viewportEnd);
  const end = Math.max(viewportStart, viewportEnd);
  const start = Math.max(rawStart, end - maxLines + 1);
  return { startLine: start, endLine: end, maxLines };
}

export function buildTerminalContextReadResult(
  input: BuildTerminalContextReadResultInput,
): TerminalContextReadResult {
  const range = normalizeTerminalContextRange(input.range);
  const lines = splitTerminalContextLines(input.fullText);
  const totalLines = lines.length;
  const window = resolveTerminalContextLineWindow({
    range,
    totalLines,
    viewportStartLine: input.viewportStartLine,
    viewportEndLine: input.viewportEndLine,
    startLine: input.startLine,
    maxLines: input.maxLines,
  });
  const selectedLines = window.endLine >= window.startLine
    ? lines.slice(window.startLine, window.endLine + 1)
    : [];

  return {
    ok: true,
    sessionId: input.sessionId,
    label: input.label,
    range,
    content: selectedLines.join("\n"),
    totalLines,
    startLine: window.startLine,
    endLine: window.endLine,
    returnedLines: selectedLines.length,
    hasMoreBefore: window.startLine > 0,
    hasMoreAfter: window.endLine >= 0 && window.endLine < totalLines - 1,
    source: input.source,
    alternateScreen: input.alternateScreen,
  };
}

export function buildTerminalContextSnapshotText(
  input: TerminalContextSnapshotTextInput,
): TerminalContextSnapshotText {
  const parts: Array<{ kind: "scrollback" | "viewport" | "pending"; text: string }> = [];
  if (input.scrollbackText) parts.push({ kind: "scrollback", text: input.scrollbackText });
  if (input.viewportText) parts.push({ kind: "viewport", text: input.viewportText });
  if (input.pendingText) parts.push({ kind: "pending", text: input.pendingText });

  let lineOffset = 0;
  let viewportStartLine: number | undefined;
  let viewportEndLine: number | undefined;
  for (const part of parts) {
    const lineCount = splitTerminalContextLines(part.text).length;
    if (part.kind === "viewport") {
      viewportStartLine = lineOffset;
      viewportEndLine = lineOffset + lineCount - 1;
    } else if (part.kind === "pending" && viewportStartLine !== undefined) {
      viewportEndLine = lineOffset + lineCount - 1;
    }
    lineOffset += lineCount;
  }

  return {
    fullText: parts.map((part) => part.text).join("\n"),
    viewportStartLine,
    viewportEndLine,
  };
}

function splitTerminalContextLines(text: string): string[] {
  if (!text) return [];
  return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
}

function clampLine(value: unknown, totalLines: number): number {
  if (totalLines <= 0) return 0;
  if (typeof value !== "number" || !Number.isFinite(value)) return 0;
  return Math.min(totalLines - 1, Math.max(0, Math.floor(value)));
}
