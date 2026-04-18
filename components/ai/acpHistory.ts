import type { ChatMessage } from "../../infrastructure/ai/types.ts";

type AcpHistoryMessage = { role: "user" | "assistant"; content: string };
type RawHistoryMessage = AcpHistoryMessage & { sourceId: string };
type DurableUserLine = {
  line: string;
  messageIndex: number;
  priority: number;
};

const MAX_RECENT_RAW_MESSAGES = 6;
const MAX_MESSAGES_TO_SCAN = 20;
const MAX_DURABLE_SCAN_MESSAGES = 200;
const MAX_COMPACT_CONTEXT_CHARS = 3000;
const MAX_RAW_MESSAGE_CHARS = 2000;
const MAX_TOOL_SUMMARY_CHARS = 500;
const MAX_DURABLE_USER_CONTEXT_CHARS = 1400;
const MAX_DURABLE_ASSISTANT_CONTEXT_CHARS = 900;
const MAX_RECENT_SUMMARY_CONTEXT_CHARS = 1200;
const MAX_DURABLE_USER_MESSAGE_CHARS = 280;
const MAX_DURABLE_ASSISTANT_MESSAGE_CHARS = 360;
const MAX_TOOL_CALL_LABEL_CHARS = 200;

type ToolCallInfo = { name: string; arguments: unknown };

const IMPORTANT_PATTERNS = [
  /不要|别|不能|不允许|必须|希望|只|最小|先|暂时|fallback|pwsh|powershell|cmd\.exe|windows|mcp|skills|cli|commit|\bpr\b|打包|内存|历史|压缩|慢/i,
  /error|failed|failure|exit code|exception|cannot|unable|timeout|crash|fallback|commit|pull request|PR #\d+/i,
];
const DURABLE_CONSTRAINT_PATTERNS = [
  /\bdo not\b|\bdon't\b|\bkeep\b|\bpreserve\b|\bavoid\b|\bonly\b|\bunchanged\b|\blocal only\b|\bwithout\b|\bleave\b/i,
  /不要|别|保留|保持|维持|不改|别改|不要改|仅限本地/i,
];
const TRIVIAL_USER_MESSAGE_PATTERNS = [
  /^(ok|okay|yes|no|thanks|thank you|continue|继续|好的|收到|行|嗯|好|继续处理|继续吧|开始吧)[.!? ]*$/i,
];
const TRIVIAL_ASSISTANT_MESSAGE_PATTERNS = [
  /^(ok|okay|understood|got it|working|proceeding|ready|ack(?: \d+)?|收到|明白|继续处理|准备实现|开始处理|处理中)[.!? ]*$/i,
];

function truncateText(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, Math.max(0, maxChars - 24)).trimEnd()}\n[truncated]`;
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function isImportantText(value: string): boolean {
  return IMPORTANT_PATTERNS.some((pattern) => pattern.test(value));
}

function isDurableConstraintText(value: string): boolean {
  return DURABLE_CONSTRAINT_PATTERNS.some((pattern) => pattern.test(value));
}

function isTrivialUserMessage(value: string): boolean {
  const normalized = normalizeWhitespace(value);
  if (isImportantText(normalized) || isDurableConstraintText(normalized)) return false;
  // Don't blanket-drop short messages — short user turns are often
  // load-bearing constraints ("Use ssh2", "中文输出", "no logs", "more
  // verbose") that the IMPORTANT/DURABLE regexes can't realistically
  // enumerate. The trivial-phrase regex already catches actual filler
  // ("ok", "yes", "thanks", "继续").
  return TRIVIAL_USER_MESSAGE_PATTERNS.some((pattern) => pattern.test(normalized));
}

function getDurableUserPriority(value: string): number {
  const normalized = normalizeWhitespace(value);
  if (isImportantText(normalized) || isDurableConstraintText(normalized)) return 2;
  return 1;
}

function isSubstantiveAssistantMessage(value: string): boolean {
  const normalized = normalizeWhitespace(value);
  if (!normalized) return false;
  // Mirror the user-side loosening: don't blanket-drop short assistant
  // messages just because they're under 40 chars or don't match the small
  // English keyword list. Short but load-bearing decisions ("Use ssh2",
  // "rebase instead", "中文输出") aren't realistically enumerable and
  // they're the exact things a later "do what you suggested" references.
  // TRIVIAL_ASSISTANT_MESSAGE_PATTERNS still catches the actual filler
  // ("ok", "ack", "got it", "明白").
  return !TRIVIAL_ASSISTANT_MESSAGE_PATTERNS.some((pattern) => pattern.test(normalized));
}

function getDurableAssistantPriority(value: string): number {
  const normalized = normalizeWhitespace(value);
  if (isImportantText(normalized)) return 2;
  return 1;
}

function appendUniqueLine(
  target: string[],
  seen: Set<string>,
  line: string,
  maxSectionChars: number,
  sectionCharsRef: { value: number },
): void {
  const normalized = normalizeWhitespace(line);
  if (!normalized || seen.has(normalized)) return;
  const nextChars = sectionCharsRef.value + normalized.length;
  if (nextChars > maxSectionChars) return;
  seen.add(normalized);
  target.push(normalized);
  sectionCharsRef.value = nextChars;
}

function summarizeToolMessage(
  message: ChatMessage,
  toolCallIndex: Map<string, ToolCallInfo>,
): string[] {
  if (!message.toolResults?.length) return [];
  return message.toolResults.map((result) => {
    const prefix = result.isError ? "Tool error" : "Tool result";
    const content = normalizeWhitespace(result.content || "");
    // Same provenance problem as the raw-window path: once a tool result
    // lands in the compact section (older than the 6-item raw window),
    // its paired assistant tool_call is almost always gone. Without the
    // call label, multiple older results collapse into indistinguishable
    // "Tool result (callN): ..." lines and follow-ups like "use the
    // resolv.conf output" can't be resolved. Inline the name+args here
    // the same way toRawHistoryMessage does.
    const callInfo = toolCallIndex.get(result.toolCallId);
    const callLabel = callInfo
      ? ` [from ${callInfo.name}(${truncateText(JSON.stringify(callInfo.arguments ?? {}), MAX_TOOL_CALL_LABEL_CHARS)})]`
      : "";
    return `${prefix}${callLabel} (${result.toolCallId}): ${truncateText(content, MAX_TOOL_SUMMARY_CHARS)}`;
  });
}

function summarizeMessage(
  message: ChatMessage,
  toolCallIndex: Map<string, ToolCallInfo>,
): string[] {
  if (message.role === "system") return [];
  if (message.role === "tool") return summarizeToolMessage(message, toolCallIndex);

  const lines: string[] = [];
  if (message.content && isImportantText(message.content)) {
    const label = message.role === "user" ? "User" : "Assistant";
    lines.push(`${label}: ${truncateText(normalizeWhitespace(message.content), MAX_TOOL_SUMMARY_CHARS)}`);
  }

  if (message.role === "assistant" && message.toolCalls?.length) {
    for (const toolCall of message.toolCalls) {
      const args = JSON.stringify(toolCall.arguments ?? {});
      const summary = `Tool call: ${toolCall.name}(${truncateText(args, 220)})`;
      if (isImportantText(summary)) lines.push(summary);
    }
  }

  return lines;
}

function summarizeDurableUserMessage(message: ChatMessage): string | null {
  if (message.role !== "user" || !message.content) return null;
  if (isTrivialUserMessage(message.content)) return null;
  return `User request: ${truncateText(normalizeWhitespace(message.content), MAX_DURABLE_USER_MESSAGE_CHARS)}`;
}

function summarizeDurableAssistantMessage(message: ChatMessage): string | null {
  if (message.role !== "assistant" || !message.content) return null;
  if (!isSubstantiveAssistantMessage(message.content)) return null;
  return `Assistant context: ${truncateText(normalizeWhitespace(message.content), MAX_DURABLE_ASSISTANT_MESSAGE_CHARS)}`;
}

function buildToolCallIndex(messages: ChatMessage[]): Map<string, ToolCallInfo> {
  const index = new Map<string, ToolCallInfo>();
  for (const message of messages) {
    if (message.role !== "assistant" || !message.toolCalls?.length) continue;
    for (const toolCall of message.toolCalls) {
      if (!toolCall.id) continue;
      index.set(toolCall.id, { name: toolCall.name, arguments: toolCall.arguments });
    }
  }
  return index;
}

function toRawHistoryMessage(
  message: ChatMessage,
  toolCallIndex: Map<string, ToolCallInfo>,
): RawHistoryMessage[] {
  if (message.role === "user") {
    return message.content
      ? [{ sourceId: message.id, role: "user", content: truncateText(message.content, MAX_RAW_MESSAGE_CHARS) }]
      : [];
  }

  if (message.role === "assistant") {
    const parts: string[] = [];
    if (message.content) parts.push(message.content);
    if (message.toolCalls?.length) {
      parts.push(...message.toolCalls.map((tc) => `Tool call: ${tc.name}(${JSON.stringify(tc.arguments ?? {})})`));
    }
    return parts.length
      ? [{ sourceId: message.id, role: "assistant", content: truncateText(parts.join("\n\n"), MAX_RAW_MESSAGE_CHARS) }]
      : [];
  }

  if (message.role === "tool" && message.toolResults?.length) {
    // Keep tool output in the recent raw window (up to MAX_RAW_MESSAGE_CHARS
    // per message, ~2000). Without this, follow-up turns after stale-session
    // recovery would only see the 500-char compact summary in
    // summarizeToolMessage, losing the actual bytes the user might reference
    // ("use that output", "what did cat show?"). ACP only supports user/
    // assistant roles, so we flatten to "assistant" — the tool results were
    // produced during the assistant's turn.
    //
    // Inline the originating tool_call's name+args. Tool calls and their
    // results live in separate messages; if the last six raw items start
    // in the middle of a tool interaction, the preceding assistant tool
    // call can be outside the window. Without the call label the result
    // is opaque bytes and "use that output" becomes ambiguous.
    const parts = message.toolResults.map((result) => {
      const prefix = result.isError ? "Tool error" : "Tool result";
      const callInfo = toolCallIndex.get(result.toolCallId);
      const callLabel = callInfo
        ? ` [from ${callInfo.name}(${truncateText(JSON.stringify(callInfo.arguments ?? {}), MAX_TOOL_CALL_LABEL_CHARS)})]`
        : "";
      return `${prefix}${callLabel} (${result.toolCallId}): ${result.content || ""}`;
    });
    return [{
      sourceId: message.id,
      role: "assistant",
      content: truncateText(parts.join("\n\n"), MAX_RAW_MESSAGE_CHARS),
    }];
  }

  return [];
}

function buildCompactContext(
  messages: ChatMessage[],
  recentRawSourceIds: Set<string>,
  toolCallIndex: Map<string, ToolCallInfo>,
): AcpHistoryMessage[] {
  const scanned = messages.slice(-MAX_MESSAGES_TO_SCAN);
  // Bound the durable-scan window too — a long-running ACP chat would
  // otherwise pay O(N) regex + sort cost on every send. 200 is enough to
  // capture durable constraints across realistically-long sessions (the
  // 99th-percentile chat is << 200 turns) while giving a constant-time
  // worst case. Constraints older than this age out of the compact
  // replay; the live ACP provider's own session history still carries
  // them when it can resume, which is the common path.
  const durableScanStart = Math.max(0, messages.length - MAX_DURABLE_SCAN_MESSAGES);
  const summaryLines: string[] = [];
  const durableUserCandidates: DurableUserLine[] = [];
  const selectedDurableUserLines: DurableUserLine[] = [];
  const durableAssistantCandidates: DurableUserLine[] = [];
  const selectedDurableAssistantLines: DurableUserLine[] = [];
  const seen = new Set<string>();
  const durableChars = { value: 0 };
  const durableAssistantChars = { value: 0 };
  const summaryChars = { value: 0 };

  for (let messageIndex = durableScanStart; messageIndex < messages.length; messageIndex += 1) {
    const message = messages[messageIndex];
    if (recentRawSourceIds.has(message.id)) continue;
    const durableUserLine = summarizeDurableUserMessage(message);
    if (durableUserLine) {
      durableUserCandidates.push({
        line: durableUserLine,
        messageIndex,
        priority: getDurableUserPriority(message.content || ""),
      });
    }
    const durableAssistantLine = summarizeDurableAssistantMessage(message);
    if (durableAssistantLine) {
      durableAssistantCandidates.push({
        line: durableAssistantLine,
        messageIndex,
        priority: getDurableAssistantPriority(message.content || ""),
      });
    }
  }

  durableUserCandidates
    .sort((left, right) => right.priority - left.priority || right.messageIndex - left.messageIndex)
    .forEach((candidate) => {
      const normalized = normalizeWhitespace(candidate.line);
      if (!normalized || seen.has(normalized)) return;
      const nextChars = durableChars.value + normalized.length;
      if (nextChars > MAX_DURABLE_USER_CONTEXT_CHARS) return;
      seen.add(normalized);
      selectedDurableUserLines.push(candidate);
      durableChars.value = nextChars;
    });

  durableAssistantCandidates
    .sort((left, right) => right.priority - left.priority || right.messageIndex - left.messageIndex)
    .forEach((candidate) => {
      const normalized = normalizeWhitespace(candidate.line);
      if (!normalized || seen.has(normalized)) return;
      const nextChars = durableAssistantChars.value + normalized.length;
      if (nextChars > MAX_DURABLE_ASSISTANT_CONTEXT_CHARS) return;
      seen.add(normalized);
      selectedDurableAssistantLines.push(candidate);
      durableAssistantChars.value = nextChars;
    });

  const durableUserLines = selectedDurableUserLines
    .sort((left, right) => left.messageIndex - right.messageIndex)
    .map((candidate) => candidate.line);
  const durableAssistantLines = selectedDurableAssistantLines
    .sort((left, right) => left.messageIndex - right.messageIndex)
    .map((candidate) => candidate.line);

  for (const line of [...durableUserLines, ...durableAssistantLines]) {
    seen.add(normalizeWhitespace(line));
  }

  // Skip messages that are already appended verbatim in the raw window —
  // otherwise the same last-6 turns get summarized here AND re-sent as
  // raw, doubling the budget cost of important user turns / large tool
  // output and crowding out older durable context the replay is meant
  // to preserve. Matches the recentRawSourceIds skip in the durable pass.
  for (const message of scanned) {
    if (recentRawSourceIds.has(message.id)) continue;
    for (const line of summarizeMessage(message, toolCallIndex)) {
      appendUniqueLine(summaryLines, seen, line, MAX_RECENT_SUMMARY_CONTEXT_CHARS, summaryChars);
    }
  }

  if (!durableUserLines.length && !durableAssistantLines.length && !summaryLines.length) return [];

  const contentLines = [
    "[Compact prior Netcatty UI context]",
    "The external ACP agent may already have its own persisted session context. Use this compact Netcatty UI context only as fallback/background, and prefer the current user request when there is any conflict.",
  ];
  if (durableUserLines.length) {
    contentLines.push("Earlier user requests that may still apply:");
    contentLines.push(...durableUserLines.map((line) => `- ${line}`));
  }
  if (durableAssistantLines.length) {
    contentLines.push("Earlier assistant context that may still matter:");
    contentLines.push(...durableAssistantLines.map((line) => `- ${line}`));
  }
  if (summaryLines.length) {
    contentLines.push("Recent noteworthy context:");
    contentLines.push(...summaryLines.map((line) => `- ${line}`));
  }

  return [{
    role: "user",
    content: truncateText(
      contentLines.join("\n"),
      MAX_COMPACT_CONTEXT_CHARS,
    ),
  }];
}

export function buildAcpHistoryMessages(messages: ChatMessage[]): AcpHistoryMessage[] {
  const toolCallIndex = buildToolCallIndex(messages);
  const rawHistory = messages
    .flatMap((message) => toRawHistoryMessage(message, toolCallIndex))
    .slice(-MAX_RECENT_RAW_MESSAGES);
  const compactContext = buildCompactContext(
    messages,
    new Set(rawHistory.map((message) => message.sourceId)),
    toolCallIndex,
  );
  const recentRaw = rawHistory.map(({ role, content }) => ({ role, content }));

  return [...compactContext, ...recentRaw];
}

export function buildAcpHistoryMessagesForBridge(
  messages: ChatMessage[],
  _existingSessionId?: string | null,
): AcpHistoryMessage[] | undefined {
  // The main process bridge only consumes this payload during stale-session
  // fallback replay, so keep it available even when a session id exists.
  const historyMessages = buildAcpHistoryMessages(messages);
  return historyMessages.length ? historyMessages : undefined;
}
