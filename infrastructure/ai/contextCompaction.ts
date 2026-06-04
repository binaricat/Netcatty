import type { ModelMessage } from "ai";
import type { ProviderConfig } from "./types";

const DEFAULT_COMPACTION_RATIO = 0.85;
const TOKEN_CHARS = 4;
const REDACTED_PAYLOAD_PREVIEW_CHARS = 80;

export const DEFAULT_CONTEXT_WINDOW_TOKENS = 128_000;
export const DEFAULT_PROTECT_RECENT_MESSAGES = 10;

export const CONTEXT_COMPACTION_SYSTEM_PROMPT = `You are summarizing a long Netcatty agent conversation so it can continue without exceeding the model context window.

Create a concise but complete summary that preserves:
- the user's current goal and requirements
- important decisions and constraints
- terminal hosts, paths, commands, files, errors, and results that still matter
- what has already been tried
- unresolved tasks or blockers

Do not add new advice. Only summarize what happened.`;

export interface ShouldCompactContextInput {
  promptTokens: number;
  contextWindow: number;
  thresholdRatio?: number;
}

export interface PrepareContextCompactionInput {
  messages: ModelMessage[];
  contextWindow?: number;
  reservedTokens?: number;
  thresholdRatio?: number;
  protectRecentMessages?: number;
  summarize: (messagesToSummarize: ModelMessage[]) => Promise<string>;
}

export interface PrepareContextCompactionResult {
  messages: ModelMessage[];
  summary?: string;
  didCompact: boolean;
}

export interface ResolveContextWindowInput {
  provider?: Pick<ProviderConfig, "contextWindow" | "modelContextWindows"> | null;
  modelId?: string | null;
  defaultContextWindow?: number;
}

export function shouldCompactContext({
  promptTokens,
  contextWindow,
  thresholdRatio = DEFAULT_COMPACTION_RATIO,
}: ShouldCompactContextInput): boolean {
  if (contextWindow <= 0) return false;
  return promptTokens >= contextWindow * thresholdRatio;
}

export function resolveContextWindow({
  provider,
  modelId,
  defaultContextWindow = DEFAULT_CONTEXT_WINDOW_TOKENS,
}: ResolveContextWindowInput): number {
  const manual = sanitizeContextWindow(provider?.contextWindow);
  if (manual != null) return manual;

  const discovered = modelId ? sanitizeContextWindow(provider?.modelContextWindows?.[modelId]) : null;
  if (discovered != null) return discovered;

  return defaultContextWindow;
}

export function sanitizeContextWindow(value: unknown): number | undefined {
  const num = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(num) || num <= 0) return undefined;
  return Math.max(1, Math.round(num));
}

export function estimateModelMessagesTokens(messages: ModelMessage[]): number {
  const chars = messages.reduce((total, message) => {
    return total + estimateUnknownChars(message.role) + estimateUnknownChars(message.content);
  }, 0);
  return Math.ceil(chars / TOKEN_CHARS);
}

export function estimateUnknownTokens(value: unknown): number {
  return Math.ceil(estimateUnknownChars(value) / TOKEN_CHARS);
}

export function findSafeCompactionSplitIndex(
  messages: ModelMessage[],
  protectRecentMessages = DEFAULT_PROTECT_RECENT_MESSAGES,
): number {
  let splitAt = Math.max(0, messages.length - protectRecentMessages);

  while (splitAt > 0 && startsWithToolResult(messages[splitAt])) {
    splitAt -= 1;
  }

  while (splitAt > 0 && endsWithToolCall(messages[splitAt - 1])) {
    splitAt -= 1;
  }

  return splitAt;
}

export function buildCompactedMessages({
  summary,
  recentMessages,
}: {
  summary: string;
  recentMessages: ModelMessage[];
}): ModelMessage[] {
  return [
    {
      role: "user",
      content: `[Previous conversation summary]\n\n${summary.trim()}\n\n[Continue with the recent messages below.]`,
    },
    {
      role: "assistant",
      content: "I understand the previous conversation summary and will continue from the recent messages.",
    },
    ...recentMessages,
  ];
}

export async function prepareContextCompaction({
  messages,
  contextWindow = DEFAULT_CONTEXT_WINDOW_TOKENS,
  reservedTokens = 0,
  thresholdRatio,
  protectRecentMessages = DEFAULT_PROTECT_RECENT_MESSAGES,
  summarize,
}: PrepareContextCompactionInput): Promise<PrepareContextCompactionResult> {
  const promptTokens = estimateModelMessagesTokens(messages) + Math.max(0, Math.ceil(reservedTokens));
  if (!shouldCompactContext({ promptTokens, contextWindow, thresholdRatio })) {
    return { messages, didCompact: false };
  }

  const splitAt = findSafeCompactionSplitIndex(messages, protectRecentMessages);
  const oldMessages = messages.slice(0, splitAt);
  const recentMessages = messages.slice(splitAt);
  if (oldMessages.length === 0) {
    return { messages, didCompact: false };
  }

  const summary = (await summarize(oldMessages)).trim();
  if (!summary) {
    return { messages, didCompact: false };
  }

  return {
    messages: buildCompactedMessages({ summary, recentMessages }),
    summary,
    didCompact: true,
  };
}

export function formatMessagesForCompaction(messages: ModelMessage[]): string {
  return messages
    .map((message, index) => {
      return `<message index="${index + 1}" role="${escapeXml(String(message.role))}">\n${escapeXml(formatMessageContent(message.content))}\n</message>`;
    })
    .join("\n\n");
}

export function keepRecentContextMessages(
  messages: ModelMessage[],
  protectRecentMessages = DEFAULT_PROTECT_RECENT_MESSAGES,
): ModelMessage[] {
  const splitAt = findSafeCompactionSplitIndex(messages, protectRecentMessages);
  return messages.slice(splitAt);
}

function estimateUnknownChars(value: unknown): number {
  if (value == null) return 0;
  if (typeof value === "string") return value.length;
  if (typeof value === "number" || typeof value === "boolean") return String(value).length;
  if (Array.isArray(value)) return value.reduce((total, part) => total + estimateUnknownChars(part), 0);
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    let total = 0;
    for (const [key, entry] of Object.entries(record)) {
      total += key.length + estimateUnknownChars(entry);
    }
    return total;
  }
  return String(value).length;
}

function startsWithToolResult(message: ModelMessage | undefined): boolean {
  if (!message || message.role !== "tool") return false;
  if (!Array.isArray(message.content)) return true;
  return message.content.some((part) => {
    return part && typeof part === "object" && (part as { type?: string }).type === "tool-result";
  });
}

function endsWithToolCall(message: ModelMessage | undefined): boolean {
  if (!message || message.role !== "assistant" || !Array.isArray(message.content)) return false;
  return message.content.some((part) => {
    return part && typeof part === "object" && (part as { type?: string }).type === "tool-call";
  });
}

function formatMessageContent(content: ModelMessage["content"]): string {
  if (typeof content === "string") return content;
  return JSON.stringify(sanitizeContentForCompaction(content), null, 2);
}

function sanitizeContentForCompaction(content: Exclude<ModelMessage["content"], string>): unknown {
  if (!Array.isArray(content)) return sanitizeUnknownForCompaction(content);
  return content.map((part) => sanitizeContentPartForCompaction(part));
}

function sanitizeContentPartForCompaction(part: unknown): unknown {
  if (!isRecord(part)) return sanitizeUnknownForCompaction(part);

  if (part.type === "image") {
    const sanitized = sanitizeRecordForCompaction(part);
    return {
      ...sanitized,
      image: describeRedactedPayload(part.image, {
        label: "image",
        mediaType: typeof part.mediaType === "string" ? part.mediaType : undefined,
      }),
    };
  }

  if (part.type === "file") {
    const sanitized = sanitizeRecordForCompaction(part);
    return {
      ...sanitized,
      data: describeRedactedPayload(part.data, {
        label: "file",
        mediaType: typeof part.mediaType === "string" ? part.mediaType : undefined,
        filename: typeof part.filename === "string" ? part.filename : undefined,
      }),
    };
  }

  return sanitizeUnknownForCompaction(part);
}

function sanitizeRecordForCompaction(value: Record<string, unknown>): Record<string, unknown> {
  const sanitized: Record<string, unknown> = {};
  for (const [entryKey, entryValue] of Object.entries(value)) {
    sanitized[entryKey] = sanitizeUnknownForCompaction(entryValue, entryKey);
  }
  return sanitized;
}

function sanitizeUnknownForCompaction(value: unknown, key?: string): unknown {
  if (value == null) return value;
  if (typeof value === "string") {
    if (key === "base64Data" || key === "dataUrl" || key === "file_data") {
      return describeRedactedPayload(value, { label: key });
    }
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (value instanceof URL) return value.toString();
  if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) {
    return describeRedactedPayload(value, { label: key ?? "binary" });
  }
  if (Array.isArray(value)) return value.map((part) => sanitizeUnknownForCompaction(part));
  if (isRecord(value)) return sanitizeRecordForCompaction(value);
  return String(value);
}

function describeRedactedPayload(
  value: unknown,
  {
    label,
    filename,
    mediaType,
  }: {
    label: string;
    filename?: string;
    mediaType?: string;
  },
): string {
  const details = [
    filename ? `filename=${filename}` : undefined,
    mediaType ? `mediaType=${mediaType}` : undefined,
    describePayloadSize(value),
    typeof value === "string" ? describeStringPreview(value) : undefined,
  ].filter(Boolean);

  return `[redacted ${label} payload${details.length ? `: ${details.join(", ")}` : ""}]`;
}

function describePayloadSize(value: unknown): string {
  if (typeof value === "string") return `${value.length} chars`;
  if (value instanceof ArrayBuffer) return `${value.byteLength} bytes`;
  if (ArrayBuffer.isView(value)) return `${value.byteLength} bytes`;
  if (value instanceof URL) return "url";
  return typeof value;
}

function describeStringPreview(value: string): string | undefined {
  if (!value.startsWith("data:")) return undefined;
  const commaIndex = value.indexOf(",");
  const header = commaIndex >= 0 ? value.slice(0, commaIndex) : value.slice(0, REDACTED_PAYLOAD_PREVIEW_CHARS);
  return `source=${header.slice(0, REDACTED_PAYLOAD_PREVIEW_CHARS)}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
