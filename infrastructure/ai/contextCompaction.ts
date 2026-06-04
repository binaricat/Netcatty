import type { ModelMessage } from "ai";
import type { ProviderConfig } from "./types";

const DEFAULT_COMPACTION_RATIO = 0.85;
const TOKEN_CHARS = 4;

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
  return JSON.stringify(content, null, 2);
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
