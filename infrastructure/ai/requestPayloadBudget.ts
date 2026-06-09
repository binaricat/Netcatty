import type { ModelMessage } from "ai";
import { findSafeCompactionSplitIndex } from "./contextCompaction";

/** Stay below typical nginx `client_max_body_size` defaults (often 1-2 MB). */
export const DEFAULT_MAX_REQUEST_PAYLOAD_BYTES = 1_500_000;
/** Per tool-result text cap before the sliding window drops older turns. */
export const DEFAULT_MAX_TOOL_RESULT_CHARS = 12_000;
/** Per plain user/assistant text cap inside a single history message. */
export const DEFAULT_MAX_MESSAGE_TEXT_CHARS = 24_000;
/** Keep this many recent messages while trimming payload size. */
export const DEFAULT_PROTECT_RECENT_PAYLOAD_MESSAGES = 8;

const TRUNCATION_MARKER = "\n\n[... output truncated for request size ...]\n\n";
const HEAD_CHARS = 800;
const TAIL_CHARS = 4_000;

export interface FitMessagesToRequestPayloadBudgetInput {
  messages: ModelMessage[];
  maxPayloadBytes?: number;
  reservedBytes?: number;
  maxToolResultChars?: number;
  maxMessageTextChars?: number;
  protectRecentMessages?: number;
  preserveLatestMessage?: boolean;
}

export interface FitMessagesToRequestPayloadBudgetResult {
  messages: ModelMessage[];
  didAdjust: boolean;
  estimatedBytes: number;
}

export function estimateUtf8Bytes(value: unknown): number {
  const text = stringifyForByteEstimate(value);
  return utf8ByteLength(text);
}

function stringifyForByteEstimate(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value ?? "");
  }
}

function utf8ByteLength(value: string | undefined): number {
  const text = value ?? "";
  if (typeof Buffer !== "undefined" && typeof Buffer.byteLength === "function") {
    return Buffer.byteLength(text, "utf8");
  }
  return new TextEncoder().encode(text).byteLength;
}

/**
 * Collapse noisy terminal/build output before measuring payload size.
 * Keeps semantics while removing repeated blank lines and long duplicate runs.
 */
export function compressVerboseText(value: string): string {
  if (!value) return value;

  let compressed = value.replace(/\r\n/g, "\n");
  compressed = compressed.replace(/\n{4,}/g, "\n\n\n");

  const lines = compressed.split("\n");
  const deduped: string[] = [];
  let repeatCount = 0;
  for (const line of lines) {
    const previous = deduped[deduped.length - 1];
    if (previous === line) {
      repeatCount += 1;
      if (repeatCount <= 2) deduped.push(line);
      continue;
    }
    repeatCount = 0;
    deduped.push(line);
  }

  return deduped.join("\n");
}

export function truncateTextWithHeadAndTail(
  value: string,
  maxChars: number,
  {
    headChars = HEAD_CHARS,
    tailChars = TAIL_CHARS,
    marker = TRUNCATION_MARKER,
  }: {
    headChars?: number;
    tailChars?: number;
    marker?: string;
  } = {},
): string {
  if (value.length <= maxChars) return value;
  if (maxChars <= marker.length + 16) {
    return value.slice(0, maxChars);
  }

  const budget = maxChars - marker.length;
  let head = Math.min(headChars, budget);
  let tail = Math.min(tailChars, Math.max(0, budget - head));
  if (head + tail > budget) {
    tail = Math.max(0, budget - head);
  }
  if (head + tail >= value.length) {
    return value.slice(0, maxChars);
  }
  if (head + tail <= 0) {
    return value.slice(0, maxChars);
  }

  return `${value.slice(0, head).trimEnd()}${marker}${value.slice(-tail).trimStart()}`;
}

export function truncateModelMessageForPayload(
  message: ModelMessage,
  {
    maxToolResultChars = DEFAULT_MAX_TOOL_RESULT_CHARS,
    maxMessageTextChars = DEFAULT_MAX_MESSAGE_TEXT_CHARS,
    omitLargeAttachments = false,
    preserveContent = false,
  }: {
    maxToolResultChars?: number;
    maxMessageTextChars?: number;
    omitLargeAttachments?: boolean;
    preserveContent?: boolean;
  } = {},
): ModelMessage {
  if (preserveContent) return message;

  if (typeof message.content === "string") {
    const compressed = compressVerboseText(message.content);
    return {
      ...message,
      content: truncateTextWithHeadAndTail(compressed, maxMessageTextChars),
    };
  }

  if (!Array.isArray(message.content)) return message;

  return {
    ...message,
    content: message.content.map((part) => truncateContentPartForPayload(part, {
      maxToolResultChars,
      maxMessageTextChars,
      omitLargeAttachments,
    })),
  };
}

function truncateContentPartForPayload(
  part: unknown,
  limits: {
    maxToolResultChars: number;
    maxMessageTextChars: number;
    omitLargeAttachments: boolean;
  },
): unknown {
  if (!part || typeof part !== "object") return part;
  const record = part as Record<string, unknown>;
  const type = record.type;

  if (type === "text" && typeof record.text === "string") {
    const compressed = compressVerboseText(record.text);
    return {
      ...record,
      text: truncateTextWithHeadAndTail(compressed, limits.maxMessageTextChars),
    };
  }

  if (type === "tool-result") {
    const output = record.output;
    if (output && typeof output === "object") {
      const outputRecord = output as Record<string, unknown>;
      if (outputRecord.type === "text" && typeof outputRecord.value === "string") {
        const compressed = compressVerboseText(outputRecord.value);
        return {
          ...record,
          output: {
            ...outputRecord,
            value: truncateTextWithHeadAndTail(compressed, limits.maxToolResultChars),
          },
        };
      }
    }
  }

  if (limits.omitLargeAttachments && type === "image" && typeof record.image === "string") {
    return omittedAttachmentTextPart("image", record.image, record);
  }

  if (limits.omitLargeAttachments && type === "file" && typeof record.data === "string") {
    return omittedAttachmentTextPart("file", record.data, record);
  }

  return part;
}

function omittedAttachmentTextPart(
  label: "image" | "file",
  payload: string,
  record: Record<string, unknown>,
): { type: "text"; text: string } {
  const details = [
    typeof record.filename === "string" ? `filename=${record.filename}` : undefined,
    typeof record.mediaType === "string" ? `mediaType=${record.mediaType}` : undefined,
    `${payload.length} chars`,
  ].filter(Boolean).join(", ");

  return {
    type: "text",
    text: `[${label} attachment omitted to keep the AI request small: ${details}]`,
  };
}

export function fitMessagesToRequestPayloadBudget({
  messages,
  maxPayloadBytes = DEFAULT_MAX_REQUEST_PAYLOAD_BYTES,
  reservedBytes = 0,
  maxToolResultChars = DEFAULT_MAX_TOOL_RESULT_CHARS,
  maxMessageTextChars = DEFAULT_MAX_MESSAGE_TEXT_CHARS,
  protectRecentMessages = DEFAULT_PROTECT_RECENT_PAYLOAD_MESSAGES,
  preserveLatestMessage = true,
}: FitMessagesToRequestPayloadBudgetInput): FitMessagesToRequestPayloadBudgetResult {
  const budget = Math.max(0, maxPayloadBytes - Math.max(0, reservedBytes));
  if (budget === 0) {
    return { messages: [], didAdjust: messages.length > 0, estimatedBytes: 0 };
  }
  const originalBytes = estimateUtf8Bytes(messages);
  if (originalBytes <= budget) {
    return { messages, didAdjust: false, estimatedBytes: originalBytes };
  }

  const shouldPreserveMessage = (message: ModelMessage, index: number, list: ModelMessage[]) => (
    preserveLatestMessage && index === list.length - 1 && message.role === "user"
  );

  let adjusted = messages.map((message, index) => truncateModelMessageForPayload(message, {
    maxToolResultChars,
    maxMessageTextChars,
    preserveContent: shouldPreserveMessage(message, index, messages),
  }));
  let estimatedBytes = estimateUtf8Bytes(adjusted);
  let didAdjust = estimatedBytes !== originalBytes;
  if (estimatedBytes <= budget) {
    return { messages: adjusted, didAdjust, estimatedBytes };
  }

  const toolResultCaps = [
    maxToolResultChars,
    Math.floor(maxToolResultChars * 0.6),
    Math.floor(maxToolResultChars * 0.35),
    4_000,
    2_000,
    1_000,
  ];
  const messageTextCaps = [
    maxMessageTextChars,
    Math.floor(maxMessageTextChars * 0.6),
    Math.floor(maxMessageTextChars * 0.35),
    8_000,
    4_000,
    2_000,
  ];

  for (let i = 1; i < toolResultCaps.length; i += 1) {
    adjusted = adjusted.map((message, index) => truncateModelMessageForPayload(message, {
      maxToolResultChars: toolResultCaps[i],
      maxMessageTextChars: messageTextCaps[i],
      preserveContent: shouldPreserveMessage(message, index, adjusted),
    }));
    estimatedBytes = estimateUtf8Bytes(adjusted);
    didAdjust = true;
    if (estimatedBytes <= budget) {
      return { messages: adjusted, didAdjust, estimatedBytes };
    }
  }

  let working = [...adjusted];
  while (working.length > protectRecentMessages) {
    const splitAt = findSafeCompactionSplitIndex(working, protectRecentMessages);
    if (splitAt <= 0) break;
    working = working.slice(splitAt);
    estimatedBytes = estimateUtf8Bytes(working);
    didAdjust = true;
    if (estimatedBytes <= budget) {
      return { messages: working, didAdjust, estimatedBytes };
    }
  }

  const emergencyToolCap = 600;
  const emergencyTextCap = 1_200;
  working = working.map((message, index) => truncateModelMessageForPayload(message, {
    maxToolResultChars: emergencyToolCap,
    maxMessageTextChars: emergencyTextCap,
    omitLargeAttachments: true,
    preserveContent: shouldPreserveMessage(message, index, working),
  }));
  estimatedBytes = estimateUtf8Bytes(working);
  didAdjust = true;

  let emergencyProtect = Math.min(protectRecentMessages, working.length);
  while (estimatedBytes > budget && working.length > 1) {
    emergencyProtect = Math.max(1, emergencyProtect - 1);
    const splitAt = findSafeCompactionSplitIndex(working, emergencyProtect);
    if (splitAt <= 0) {
      working = working.slice(-1);
    } else {
      working = working.slice(splitAt);
    }
    working = working.map((message, index) => truncateModelMessageForPayload(message, {
      maxToolResultChars: emergencyToolCap,
      maxMessageTextChars: emergencyTextCap,
      omitLargeAttachments: true,
      preserveContent: shouldPreserveMessage(message, index, working),
    }));
    estimatedBytes = estimateUtf8Bytes(working);
  }

  let finalTextCap = emergencyTextCap;
  let finalToolCap = emergencyToolCap;
  while (estimatedBytes > budget && (finalTextCap > 32 || finalToolCap > 32)) {
    finalTextCap = Math.max(32, Math.floor(finalTextCap * 0.6));
    finalToolCap = Math.max(32, Math.floor(finalToolCap * 0.6));
    working = working.map((message) => truncateModelMessageForPayload(message, {
      maxToolResultChars: finalToolCap,
      maxMessageTextChars: finalTextCap,
      omitLargeAttachments: true,
      preserveContent: false,
    }));
    estimatedBytes = estimateUtf8Bytes(working);
  }

  return { messages: working, didAdjust, estimatedBytes };
}
