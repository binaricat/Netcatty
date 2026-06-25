const LARGE_TERMINAL_OUTPUT_CHARS = 16_000;
const TERMINAL_PREVIEW_HEAD_LINES = 20;
const TERMINAL_PREVIEW_TAIL_LINES = 40;
const TERMINAL_PREVIEW_MAX_LINE_CHARS = 240;
const DEFAULT_READ_LENGTH = 4_000;
const MAX_READ_LENGTH = 20_000;
const MAX_HANDLE_RECORDS = 200;

export type ToolResultReadChannel = "all" | "stdout" | "stderr";

export interface TerminalExecuteResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
}

export interface TerminalToolResultMetadata {
  chatSessionId?: string | null;
  toolCallId: string;
  sessionId: string;
  command: string;
}

export interface TerminalOutputPreview {
  chars: number;
  lines: number;
  truncated: boolean;
  content: string;
}

export interface CompressedTerminalToolResult {
  type: "netcatty.terminal_execute_result";
  sessionId: string;
  command: string;
  exitCode: number | null;
  status: "success" | "failed" | "unknown";
  stdout: TerminalOutputPreview;
  stderr: TerminalOutputPreview;
  outputCompression: {
    kind: "terminal_output";
    handle: string;
    readTool: "tool_result_read";
    totalChars: number;
    totalLines: number;
    stdoutChars: number;
    stderrChars: number;
    note: string;
  };
  errorSummary?: string;
}

export interface ToolResultSlice {
  type: "netcatty.tool_result_slice";
  handle: string;
  channel: ToolResultReadChannel;
  offset: number;
  length: number;
  nextOffset: number | null;
  totalChars: number;
  content: string;
}

export interface ToolResultRepeatNotice {
  type: "netcatty.tool_result_repeat_notice";
  handle: string;
  channel: ToolResultReadChannel;
  offset: number;
  length: number;
  totalChars: number;
  message: string;
}

export interface ToolResultReadError {
  error: string;
}

interface ToolResultHandleRecord {
  handle: string;
  chatSessionId?: string | null;
  toolCallId: string;
  toolName: string;
  createdAt: number;
  stdout: string;
  stderr: string;
  combined: string;
  reads: Map<string, number>;
}

const records = new Map<string, ToolResultHandleRecord>();
let handleCounter = 0;

export function buildTerminalExecuteResultForModel(
  result: TerminalExecuteResult,
  metadata: TerminalToolResultMetadata,
): TerminalExecuteResult | CompressedTerminalToolResult {
  const totalChars = result.stdout.length + result.stderr.length;
  if (totalChars <= LARGE_TERMINAL_OUTPUT_CHARS) return result;

  const handle = createHandle(metadata.toolCallId);
  const combined = formatCombinedTerminalOutput(result);
  records.set(handle, {
    handle,
    chatSessionId: metadata.chatSessionId,
    toolCallId: metadata.toolCallId,
    toolName: "terminal_execute",
    createdAt: Date.now(),
    stdout: result.stdout,
    stderr: result.stderr,
    combined,
    reads: new Map(),
  });
  pruneOldRecords();

  const stdout = buildTerminalOutputPreview(result.stdout);
  const stderr = buildTerminalOutputPreview(result.stderr);
  const errorSummary = buildErrorSummary(result);

  return {
    type: "netcatty.terminal_execute_result",
    sessionId: metadata.sessionId,
    command: metadata.command,
    exitCode: result.exitCode,
    status: getTerminalStatus(result.exitCode),
    stdout,
    stderr,
    outputCompression: {
      kind: "terminal_output",
      handle,
      readTool: "tool_result_read",
      totalChars: combined.length,
      totalLines: countLines(combined),
      stdoutChars: result.stdout.length,
      stderrChars: result.stderr.length,
      note: "Large terminal output was compressed. Use tool_result_read with this handle, channel, offset, and length to inspect exact output slices.",
    },
    ...(errorSummary ? { errorSummary } : {}),
  };
}

export function readToolResultHandle(args: {
  handle: string;
  chatSessionId?: string | null;
  channel?: ToolResultReadChannel;
  offset?: number;
  length?: number;
}): ToolResultSlice | ToolResultRepeatNotice | ToolResultReadError {
  const record = records.get(args.handle);
  if (!record) {
    return { error: `Tool result handle not found: ${args.handle}` };
  }
  if (record.chatSessionId && args.chatSessionId && record.chatSessionId !== args.chatSessionId) {
    return { error: "Tool result handle is not available in this chat session." };
  }

  const channel = args.channel ?? "all";
  const content = selectRecordContent(record, channel);
  const offset = clampInteger(args.offset ?? 0, 0, content.length);
  const length = clampInteger(args.length ?? DEFAULT_READ_LENGTH, 1, MAX_READ_LENGTH);
  const readKey = `${channel}:${offset}:${length}`;
  const readCount = record.reads.get(readKey) ?? 0;
  record.reads.set(readKey, readCount + 1);

  if (readCount > 0) {
    return {
      type: "netcatty.tool_result_repeat_notice",
      handle: record.handle,
      channel,
      offset,
      length,
      totalChars: content.length,
      message: "This exact tool result slice was already returned. Request a different channel, offset, or length if more detail is needed.",
    };
  }

  const slice = content.slice(offset, offset + length);
  const nextOffset = offset + slice.length < content.length ? offset + slice.length : null;
  return {
    type: "netcatty.tool_result_slice",
    handle: record.handle,
    channel,
    offset,
    length: slice.length,
    nextOffset,
    totalChars: content.length,
    content: slice,
  };
}

export function isCompressedTerminalToolResultContent(content: string): boolean {
  const parsed = parseJsonObject(content);
  return parsed?.type === "netcatty.terminal_execute_result"
    && typeof parsed.outputCompression === "object"
    && parsed.outputCompression !== null;
}

export function resetToolResultHandlesForTests(): void {
  records.clear();
  handleCounter = 0;
}

function createHandle(toolCallId: string): string {
  const safeToolCallId = toolCallId.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 32) || "tool";
  handleCounter += 1;
  return `trh_${safeToolCallId}_${Date.now().toString(36)}_${handleCounter.toString(36)}`;
}

function pruneOldRecords(): void {
  if (records.size <= MAX_HANDLE_RECORDS) return;
  const sorted = [...records.values()].sort((a, b) => a.createdAt - b.createdAt);
  for (const record of sorted.slice(0, records.size - MAX_HANDLE_RECORDS)) {
    records.delete(record.handle);
  }
}

function buildTerminalOutputPreview(value: string): TerminalOutputPreview {
  const lines = splitLines(value);
  const truncated = value.length > 0 && lines.length > TERMINAL_PREVIEW_HEAD_LINES + TERMINAL_PREVIEW_TAIL_LINES;
  const previewLines = truncated
    ? [
      ...lines.slice(0, TERMINAL_PREVIEW_HEAD_LINES),
      `[... ${Math.max(0, lines.length - TERMINAL_PREVIEW_HEAD_LINES - TERMINAL_PREVIEW_TAIL_LINES)} lines omitted; use tool_result_read for exact output ...]`,
      ...lines.slice(-TERMINAL_PREVIEW_TAIL_LINES),
    ]
    : lines;

  return {
    chars: value.length,
    lines: lines.length,
    truncated,
    content: previewLines.map(truncatePreviewLine).join("\n"),
  };
}

function buildErrorSummary(result: TerminalExecuteResult): string | undefined {
  const source = result.stderr.trim() || (result.exitCode && result.exitCode !== 0 ? result.stdout.trim() : "");
  if (!source) return undefined;
  return splitLines(source)
    .filter((line) => line.trim())
    .slice(0, 6)
    .map(truncatePreviewLine)
    .join("\n");
}

function formatCombinedTerminalOutput(result: TerminalExecuteResult): string {
  const parts: string[] = [];
  if (result.stdout) parts.push(`STDOUT:\n${result.stdout}`);
  if (result.stderr) parts.push(`STDERR:\n${result.stderr}`);
  if (result.exitCode != null) parts.push(`[exit code: ${result.exitCode}]`);
  return parts.join("\n\n");
}

function selectRecordContent(record: ToolResultHandleRecord, channel: ToolResultReadChannel): string {
  switch (channel) {
    case "stdout":
      return record.stdout;
    case "stderr":
      return record.stderr;
    default:
      return record.combined;
  }
}

function getTerminalStatus(exitCode: number | null): "success" | "failed" | "unknown" {
  if (exitCode == null || exitCode === -1) return "unknown";
  return exitCode === 0 ? "success" : "failed";
}

function splitLines(value: string): string[] {
  if (!value) return [];
  return value.replace(/\r\n/g, "\n").split("\n");
}

function countLines(value: string): number {
  return splitLines(value).length;
}

function truncatePreviewLine(line: string): string {
  if (line.length <= TERMINAL_PREVIEW_MAX_LINE_CHARS) return line;
  return `${line.slice(0, TERMINAL_PREVIEW_MAX_LINE_CHARS - 3)}...`;
}

function clampInteger(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, Math.trunc(value)));
}

function parseJsonObject(content: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(content);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}
