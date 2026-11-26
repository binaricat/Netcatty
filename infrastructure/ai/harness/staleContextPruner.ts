import type { ModelMessage } from 'ai';
import { redactSecretsForModel, redactSecretsInValueForModel } from './modelSecretRedaction';
import { sliceHead, sliceTail } from '../textBoundaries';

const SUPERSEDED_READ_PREFIX = '[superseded read:';
const EARLIER_TERMINAL_PREFIX = '[earlier terminal output omitted:';
const EARLIER_REMOTE_SCREEN_PREFIX = '[earlier remote desktop screenshot omitted:';
export const SYNTHETIC_REMOTE_SCREEN_MARKER = '[Captured remote desktop frame:';
export const MAX_RETAINED_REMOTE_SCREEN_IMAGES = 2;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function getToolCallMap(messages: ModelMessage[]): Map<string, { toolName: string; input: unknown }> {
  const map = new Map<string, { toolName: string; input: unknown }>();
  for (const message of messages) {
    if (message.role !== 'assistant' || !Array.isArray(message.content)) continue;
    for (const part of message.content as unknown[]) {
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
  return (message.content as unknown[]).filter((part) => {
    return isRecord(part) && part.type === 'tool-result';
  }) as Array<Record<string, unknown>>;
}

function getToolResultText(part: Record<string, unknown>): string {
  const output = part.output;
  if (isRecord(output) && output.type === 'text' && typeof output.value === 'string') {
    return output.value;
  }
  if (isRecord(output) && output.type === 'content' && Array.isArray(output.value)) {
    return output.value
      .filter((entry): entry is Record<string, unknown> => (
        isRecord(entry) && entry.type === 'text' && typeof entry.text === 'string'
      ))
      .map((entry) => entry.text as string)
      .join('\n');
  }
  if (typeof output === 'string') return output;
  return '';
}

function isImagePart(part: unknown): boolean {
  if (!isRecord(part)) return false;
  if (part.type === 'image') return true;
  if (part.type === 'file') {
    const mediaType = typeof part.mediaType === 'string' ? part.mediaType.toLowerCase() : '';
    return mediaType.startsWith('image/');
  }
  return false;
}

function toolResultHasImageContent(part: Record<string, unknown>): boolean {
  const output = part.output;
  if (!isRecord(output) || output.type !== 'content' || !Array.isArray(output.value)) {
    return false;
  }
  return output.value.some(isImagePart);
}

function isSyntheticRemoteScreenUserMessage(message: ModelMessage): boolean {
  if (message.role !== 'user' || !Array.isArray(message.content)) return false;
  const parts = message.content as unknown[];
  const hasMarker = parts.some((part) => (
    isRecord(part)
    && part.type === 'text'
    && typeof part.text === 'string'
    && part.text.startsWith(SYNTHETIC_REMOTE_SCREEN_MARKER)
  ));
  return hasMarker && parts.some(isImagePart);
}

function formatRemoteScreenOmittedPlaceholder(summarySource: string): string {
  try {
    const parsed = JSON.parse(summarySource) as Record<string, unknown>;
    const details = [
      typeof parsed.sessionId === 'string' ? `sessionId=${parsed.sessionId}` : undefined,
      parsed.capturedAt != null ? `capturedAt=${String(parsed.capturedAt)}` : undefined,
      isRecord(parsed.crop)
        ? `crop=${parsed.crop.x},${parsed.crop.y},${parsed.crop.width}x${parsed.crop.height}`
        : undefined,
    ].filter(Boolean);
    if (details.length > 0) {
      return `${EARLIER_REMOTE_SCREEN_PREFIX} ${details.join(', ')}]`;
    }
  } catch {
    // Non-JSON header text (e.g. synthetic user message) — extract inline tokens.
  }
  const sessionMatch = /\bsessionId=([^,\]]+)/.exec(summarySource);
  const capturedMatch = /\bcapturedAt=([^,\]]+)/.exec(summarySource);
  const cropMatch = /\bcrop=([^,\]]+(?:,[^,\]]+)*?)(?:,\s*capturedAt=|\])/.exec(summarySource);
  const details = [
    sessionMatch ? `sessionId=${sessionMatch[1].trim()}` : undefined,
    capturedMatch ? `capturedAt=${capturedMatch[1].trim()}` : undefined,
    cropMatch ? `crop=${cropMatch[1].trim()}` : undefined,
  ].filter(Boolean);
  return details.length > 0
    ? `${EARLIER_REMOTE_SCREEN_PREFIX} ${details.join(', ')}]`
    : `${EARLIER_REMOTE_SCREEN_PREFIX} superseded by newer captures]`;
}

function pruneExcessRemoteScreenImages(messages: ModelMessage[]): {
  messages: ModelMessage[];
  didAdjust: boolean;
} {
  type ImageSlot =
    | { kind: 'tool-result'; messageIndex: number; partIndex: number }
    | { kind: 'synthetic-user'; messageIndex: number };

  const slots: ImageSlot[] = [];
  messages.forEach((message, messageIndex) => {
    if (isSyntheticRemoteScreenUserMessage(message)) {
      slots.push({ kind: 'synthetic-user', messageIndex });
      return;
    }
    if (message.role === 'tool' && Array.isArray(message.content)) {
      (message.content as unknown[]).forEach((part, partIndex) => {
        if (isRecord(part) && part.type === 'tool-result' && toolResultHasImageContent(part)) {
          slots.push({ kind: 'tool-result', messageIndex, partIndex });
        }
      });
    }
  });

  if (slots.length <= MAX_RETAINED_REMOTE_SCREEN_IMAGES) {
    return { messages, didAdjust: false };
  }

  const slotsToPrune = slots.slice(0, slots.length - MAX_RETAINED_REMOTE_SCREEN_IMAGES);
  const toolPartsToPrune = new Map<number, Set<number>>();
  const userMessagesToPrune = new Set<number>();
  for (const slot of slotsToPrune) {
    if (slot.kind === 'synthetic-user') {
      userMessagesToPrune.add(slot.messageIndex);
    } else {
      let set = toolPartsToPrune.get(slot.messageIndex);
      if (!set) {
        set = new Set<number>();
        toolPartsToPrune.set(slot.messageIndex, set);
      }
      set.add(slot.partIndex);
    }
  }

  let didAdjust = false;
  const next = messages.map((message, messageIndex) => {
    if (userMessagesToPrune.has(messageIndex) && Array.isArray(message.content)) {
      const parts = message.content as unknown[];
      const headerText = parts
        .filter((part): part is Record<string, unknown> => (
          isRecord(part) && part.type === 'text' && typeof part.text === 'string'
        ))
        .map((part) => part.text as string)
        .join(' ');
      const placeholder = formatRemoteScreenOmittedPlaceholder(headerText);
      const nextContent = parts.map((part) => (
        isImagePart(part) ? { type: 'text', text: placeholder } : part
      ));
      didAdjust = true;
      return { ...message, content: nextContent } as ModelMessage;
    }

    const partIndices = toolPartsToPrune.get(messageIndex);
    if (partIndices && Array.isArray(message.content)) {
      const nextContent = (message.content as unknown[]).map((part, partIndex) => {
        if (!partIndices.has(partIndex) || !isRecord(part) || !isRecord(part.output) || !Array.isArray(part.output.value)) {
          return part;
        }
        const placeholder = formatRemoteScreenOmittedPlaceholder(getToolResultText(part));
        const nextValue = (part.output.value as unknown[]).map((entry) => (
          isImagePart(entry) ? { type: 'text', text: placeholder } : entry
        ));
        didAdjust = true;
        return {
          ...part,
          output: {
            ...part.output,
            value: nextValue,
          },
        };
      });
      return { ...message, content: nextContent } as ModelMessage;
    }

    return message;
  });

  return { messages: didAdjust ? next : messages, didAdjust };
}

function isToolResultError(part: Record<string, unknown>, text: string): boolean {
  if (part.isError === true) return true;
  if (text.toLowerCase().includes('error')) return true;
  return isToolResultErrorOutput(part.output);
}

function isToolResultErrorOutput(output: unknown): boolean {
  if (output == null) return false;
  if (typeof output === 'object') {
    const obj = output as Record<string, unknown>;
    if ('error' in obj && typeof obj.error === 'string') return true;
    if ('ok' in obj && obj.ok === false) return true;
    if (obj.type === 'json' || obj.type === 'object') {
      return isToolResultErrorOutput(obj.value);
    }
  }
  if (typeof output === 'string') {
    try {
      const parsed = JSON.parse(output) as Record<string, unknown>;
      if ('error' in parsed && typeof parsed.error === 'string') return true;
      if ('ok' in parsed && parsed.ok === false) return true;
    } catch {
      return false;
    }
  }
  return false;
}

function isCachedOrSuperseded(text: string): boolean {
  return text.includes('[cached]')
    || text.startsWith(SUPERSEDED_READ_PREFIX)
    || text.startsWith(EARLIER_TERMINAL_PREFIX)
    || text.includes(EARLIER_REMOTE_SCREEN_PREFIX);
}

function isSftpReadTool(toolName: string): boolean {
  return toolName === 'sftp_read'
    || toolName === 'sftp.read'
    || toolName === 'sftp_read_file';
}

function isSafeReadOnlyToolName(toolName: string): boolean {
  const segments = toolName.toLowerCase().split(/[._-]+/);
  const readMarkers = new Set(['read', 'get', 'list', 'search', 'fetch', 'inspect', 'status', 'info', 'poll']);
  const writeMarkers = new Set([
    'write', 'set', 'update', 'create', 'delete', 'remove', 'start', 'stop', 'close',
    'execute', 'exec', 'run', 'upload', 'download', 'move', 'copy', 'rename', 'kill',
  ]);
  return segments.some(segment => readMarkers.has(segment))
    && !segments.some(segment => writeMarkers.has(segment));
}

function readFingerprint(toolName: string, args: unknown): string | null {
  if (!isRecord(args)) return null;
  if (toolName === 'terminal_poll' || toolName === 'terminal.poll') {
    const jobId = args.jobId;
    if (typeof jobId !== 'string') return null;
    return `terminal-poll:${jobId}:${String(args.offset ?? 0)}`;
  }
  if (toolName === 'terminal_read_context' || toolName === 'terminal.read_context') {
    const sessionId = args.sessionId;
    if (typeof sessionId !== 'string') return null;
    return [
      'terminal-context',
      sessionId,
      String(args.range ?? 'viewport'),
      String(args.startLine ?? ''),
      String(args.maxLines ?? ''),
    ].join(':');
  }
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

function redactToolCallInputs(message: ModelMessage, chatSessionId?: string): ModelMessage {
  if (message.role !== 'assistant' || !Array.isArray(message.content)) return message;
  let changed = false;
  const content = (message.content as unknown[]).map(part => {
    if (!isRecord(part) || part.type !== 'tool-call' || !('input' in part)) return part;
    const redacted = redactSecretsInValueForModel(part.input, chatSessionId);
    if (JSON.stringify(redacted) === JSON.stringify(part.input)) return part;
    changed = true;
    return { ...part, input: redacted };
  });
  return changed ? ({ ...message, content } as ModelMessage) : message;
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
    const isError = isToolResultError(part, text);
    if (isCachedOrSuperseded(text)) return part;
    const replacement = updater(toolName, args, text, isError);
    if (replacement == null || replacement === text) return part;
    changed = true;
    return replaceToolResultText(part, replacement);
  });

  return changed ? ({ ...message, content: nextContent } as ModelMessage) : message;
}

export interface PruneStaleToolContextOptions {
  chatSessionId?: string;
  /** Supersede stale reads and omit older terminal output only under context budget pressure. */
  underBudgetPressure?: boolean;
}

export function pruneStaleToolContext(
  messages: ModelMessage[],
  options: PruneStaleToolContextOptions = {},
): {
  messages: ModelMessage[];
  didAdjust: boolean;
} {
  // Unconditionally enforce the rolling 2-frame cap on remote desktop screen
  // captures so multi-step VNC/RDP sessions never accumulate unbounded images.
  const screenPruned = pruneExcessRemoteScreenImages(messages);
  const workingMessages = screenPruned.messages;

  const toolCallMap = getToolCallMap(workingMessages);
  const latestReadByKey = new Map<string, number>();
  const terminalExecutionsBySession = new Map<string, Array<{ index: number; command?: string }>>();
  const underBudgetPressure = options.underBudgetPressure === true;
  const userTurnsAfter = new Array<number>(workingMessages.length).fill(0);
  let laterUserTurns = 0;
  for (let index = workingMessages.length - 1; index >= 0; index -= 1) {
    userTurnsAfter[index] = laterUserTurns;
    if (workingMessages[index].role === 'user') laterUserTurns += 1;
  }

  workingMessages.forEach((message, index) => {
    for (const part of getToolResultParts(message)) {
      const toolCallId = typeof part.toolCallId === 'string' ? part.toolCallId : '';
      const meta = toolCallMap.get(toolCallId);
      const toolName = meta?.toolName ?? (typeof part.toolName === 'string' ? part.toolName : '');
      const args = meta?.input;
      const readKey = readFingerprint(toolName, args);
      if (readKey) {
        const text = getToolResultText(part);
        const isError = isToolResultError(part, text);
        if (!isError) {
          latestReadByKey.set(readKey, index);
        }
      }
      const termKey = terminalFingerprint(toolName, args);
      if (underBudgetPressure && termKey) {
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
  if (underBudgetPressure) {
    for (const entries of terminalExecutionsBySession.values()) {
      for (const entry of entries.slice(-2)) {
        keepTerminalIndices.add(entry.index);
      }
    }
  }
  const terminalOmitByIndex = new Map<number, string>();
  if (underBudgetPressure) {
    for (const entries of terminalExecutionsBySession.values()) {
      for (const entry of entries) {
        if (keepTerminalIndices.has(entry.index)) continue;
        terminalOmitByIndex.set(
          entry.index,
          `${EARLIER_TERMINAL_PREFIX} command=${redactSecretsForModel(entry.command ?? 'unknown', options.chatSessionId)}]`,
        );
      }
    }
  }

  let didAdjust = screenPruned.didAdjust;
  const next = workingMessages.map((message, index) => {
    const redactedMessage = redactToolCallInputs(message, options.chatSessionId);
    const updated = compressMessageToolResults(redactedMessage, (toolName, args, text, isError) => {
      if (isError) return null;
      const readKey = readFingerprint(toolName, args);
      if (underBudgetPressure && readKey) {
        const latestIndex = latestReadByKey.get(readKey);
        if (latestIndex != null && latestIndex !== index) {
          return `${SUPERSEDED_READ_PREFIX} ${readKey}]`;
        }
      }
      const termKey = terminalFingerprint(toolName, args);
      if (underBudgetPressure && termKey && terminalOmitByIndex.has(index)) {
        return terminalOmitByIndex.get(index)!;
      }
      if (underBudgetPressure) {
        const age = userTurnsAfter[index];
        if (age > 10 && !isError && isSafeReadOnlyToolName(toolName)) {
          return `[older tool result omitted: tool=${toolName || 'unknown'}, chars=${text.length}]`;
        }
        if (age >= 3 && text.length > 4_000) {
          return `${sliceHead(text, 1_500)}\n\n[... tool result shortened: ${text.length - 3_000} chars omitted ...]\n\n${sliceTail(text, 1_500)}`;
        }
      }
      return null;
    }, toolCallMap);
    if (updated !== message) didAdjust = true;
    return updated;
  });

  return { messages: next, didAdjust };
}
