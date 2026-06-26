import type { ModelMessage } from 'ai';

const SUPERSEDED_READ_PREFIX = '[superseded read:';
const EARLIER_TERMINAL_PREFIX = '[earlier terminal output omitted:';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function getToolCallMap(messages: ModelMessage[]): Map<string, { toolName: string; input: unknown }> {
  const map = new Map<string, { toolName: string; input: unknown }>();
  for (const message of messages) {
    if (message.role !== 'assistant' || !Array.isArray(message.content)) continue;
    for (const part of message.content) {
      if (!isRecord(part) || part.type !== 'tool-call') continue;
      const toolCallId = typeof part.toolCallId === 'string' ? part.toolCallId : '';
      const toolName = typeof part.toolName === 'string' ? part.toolName : '';
      if (toolCallId) {
        map.set(toolCallId, { toolName, input: part.input });
      }
    }
  }
  return map;
}

function getToolResultParts(message: ModelMessage): Array<Record<string, unknown>> {
  if (message.role !== 'tool' || !Array.isArray(message.content)) return [];
  return message.content.filter((part) => {
    return isRecord(part) && part.type === 'tool-result';
  }) as Array<Record<string, unknown>>;
}

function getToolResultText(part: Record<string, unknown>): string {
  const output = part.output;
  if (isRecord(output) && output.type === 'text' && typeof output.value === 'string') {
    return output.value;
  }
  if (typeof output === 'string') return output;
  return '';
}

function isCachedOrSuperseded(text: string): boolean {
  return text.includes('[cached]')
    || text.startsWith(SUPERSEDED_READ_PREFIX)
    || text.startsWith(EARLIER_TERMINAL_PREFIX);
}

function isSftpReadTool(toolName: string): boolean {
  return toolName === 'sftp_read'
    || toolName === 'sftp.read'
    || toolName === 'sftp_read_file';
}

function readFingerprint(toolName: string, args: unknown): string | null {
  if (!isRecord(args)) return null;
  if (isSftpReadTool(toolName)) {
    const path = args.path ?? args.remotePath;
    if (typeof path !== 'string') return null;
    const sessionId = args.sessionId;
    const sessionPart = typeof sessionId === 'string' ? sessionId : '';
    return `read:${sessionPart}:${path}`;
  }
  if (toolName === 'read_attachment' || toolName === 'harness.read_attachment') {
    const id = args.attachmentId ?? args.id ?? args.filename ?? args.name;
    return id != null ? `attachment:${String(id)}` : null;
  }
  return null;
}

function terminalFingerprint(toolName: string, args: unknown): string | null {
  if (toolName !== 'terminal_execute' && toolName !== 'terminal.execute') return null;
  if (!isRecord(args)) return null;
  const sessionId = args.sessionId;
  return typeof sessionId === 'string' ? `terminal:${sessionId}` : null;
}

function replaceToolResultText(part: Record<string, unknown>, text: string): Record<string, unknown> {
  const output = part.output;
  if (isRecord(output) && output.type === 'text') {
    return { ...part, output: { ...output, value: text } };
  }
  return { ...part, output: { type: 'text', value: text } };
}

function compressMessageToolResults(
  message: ModelMessage,
  updater: (toolName: string, args: unknown, text: string, isError: boolean) => string | null,
  toolCallMap: Map<string, { toolName: string; input: unknown }>,
): ModelMessage {
  const parts = getToolResultParts(message);
  if (parts.length === 0) return message;

  let changed = false;
  const nextContent = (message.content as unknown[]).map((part) => {
    if (!isRecord(part) || part.type !== 'tool-result') return part;
    const toolCallId = typeof part.toolCallId === 'string' ? part.toolCallId : '';
    const meta = toolCallMap.get(toolCallId);
    const toolName = meta?.toolName ?? (typeof part.toolName === 'string' ? part.toolName : '');
    const args = meta?.input;
    const text = getToolResultText(part);
    const isError = text.toLowerCase().includes('error') || Boolean(part.isError);
    if (isCachedOrSuperseded(text)) return part;
    const replacement = updater(toolName, args, text, isError);
    if (replacement == null || replacement === text) return part;
    changed = true;
    return replaceToolResultText(part, replacement);
  });

  return changed ? { ...message, content: nextContent as ModelMessage['content'] } : message;
}

export interface PruneStaleToolContextOptions {
  /** Omit older terminal_execute output only when context is under budget pressure. */
  pruneTerminalOutput?: boolean;
}

export function pruneStaleToolContext(
  messages: ModelMessage[],
  options: PruneStaleToolContextOptions = {},
): {
  messages: ModelMessage[];
  didAdjust: boolean;
} {
  const toolCallMap = getToolCallMap(messages);
  const latestReadByKey = new Map<string, number>();
  const terminalExecutionsBySession = new Map<string, Array<{ index: number; command?: string }>>();
  const pruneTerminalOutput = options.pruneTerminalOutput === true;

  messages.forEach((message, index) => {
    for (const part of getToolResultParts(message)) {
      const toolCallId = typeof part.toolCallId === 'string' ? part.toolCallId : '';
      const meta = toolCallMap.get(toolCallId);
      const toolName = meta?.toolName ?? (typeof part.toolName === 'string' ? part.toolName : '');
      const args = meta?.input;
      const readKey = readFingerprint(toolName, args);
      if (readKey) latestReadByKey.set(readKey, index);
      const termKey = terminalFingerprint(toolName, args);
      if (pruneTerminalOutput && termKey) {
        const callArgs = isRecord(args) ? args : {};
        const entries = terminalExecutionsBySession.get(termKey) ?? [];
        entries.push({
          index,
          command: typeof callArgs.command === 'string' ? callArgs.command : undefined,
        });
        terminalExecutionsBySession.set(termKey, entries);
      }
    }
  });

  const keepTerminalIndices = new Set<number>();
  if (pruneTerminalOutput) {
    for (const entries of terminalExecutionsBySession.values()) {
      for (const entry of entries.slice(-2)) {
        keepTerminalIndices.add(entry.index);
      }
    }
  }
  const terminalOmitByIndex = new Map<number, string>();
  if (pruneTerminalOutput) {
    for (const entries of terminalExecutionsBySession.values()) {
      for (const entry of entries) {
        if (keepTerminalIndices.has(entry.index)) continue;
        terminalOmitByIndex.set(
          entry.index,
          `${EARLIER_TERMINAL_PREFIX} command=${entry.command ?? 'unknown'}]`,
        );
      }
    }
  }

  let didAdjust = false;
  const next = messages.map((message, index) => {
    const updated = compressMessageToolResults(message, (toolName, args, text, isError) => {
      if (isError) return null;
      const readKey = readFingerprint(toolName, args);
      if (readKey) {
        const latestIndex = latestReadByKey.get(readKey);
        if (latestIndex != null && latestIndex !== index) {
          return `${SUPERSEDED_READ_PREFIX} ${readKey}]`;
        }
      }
      const termKey = terminalFingerprint(toolName, args);
      if (pruneTerminalOutput && termKey && terminalOmitByIndex.has(index)) {
        return terminalOmitByIndex.get(index)!;
      }
      return null;
    }, toolCallMap);
    if (updated !== message) didAdjust = true;
    return updated;
  });

  return { messages: next, didAdjust };
}
