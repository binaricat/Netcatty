import type { ChatMessage, ChatMessageAttachment, ToolCall, ToolResult } from "../../infrastructure/ai/types";
import { isTerminalSelectionAttachment } from "../../application/state/terminalSelectionAttachment";
import { formatVaultNoteReferences, isVaultNoteAttachment } from "../../application/state/vaultNoteAttachment";
import { redactSecretsForModel } from "../../infrastructure/ai/harness/modelSecretRedaction";

const MAX_ATTACHMENT_PLACEHOLDER_DETAIL_CHARS = 120;
const MAX_TOOL_COMMAND_CHARS = 220;
const MAX_HISTORICAL_TERMINAL_OUTPUT_CHARS = 4_000;
const HISTORICAL_TERMINAL_OUTPUT_HEAD_CHARS = 2_800;

function truncateInline(value: string, maxChars: number): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, Math.max(0, maxChars - 3)).trimEnd()}...`;
}

function describeAttachmentSize(attachment: ChatMessageAttachment): string {
  return `${attachment.base64Data.length} base64 chars`;
}

function formatTerminalSelectionPlaceholder(
  attachment: ChatMessageAttachment,
  index: number,
): string {
  const details = [
    `filename=${attachment.filename || `terminal-selection-${index + 1}.log`}`,
    attachment.lineCount != null ? `lines=${attachment.lineCount}` : undefined,
    attachment.previewText ? `preview=${truncateInline(attachment.previewText, MAX_ATTACHMENT_PLACEHOLDER_DETAIL_CHARS)}` : undefined,
    describeAttachmentSize(attachment),
  ].filter(Boolean).join(", ");

  return `[Historical terminal selection omitted from replay: ${details}]`;
}

function formatAttachmentPlaceholder(
  attachment: ChatMessageAttachment,
  index: number,
): string {
  const label = attachment.mediaType.startsWith("image/") ? "image" : "file";
  const details = [
    attachment.filename ? `filename=${attachment.filename}` : undefined,
    attachment.filePath ? `path=${attachment.filePath}` : undefined,
    `mediaType=${attachment.mediaType}`,
    describeAttachmentSize(attachment),
  ].filter(Boolean).join(", ");

  return `[Historical ${label} attachment omitted from replay: ${details || `attachment-${index + 1}`}]`;
}

export function buildHistoricalUserReplayContent(
  content: string,
  attachments: ChatMessageAttachment[] = [],
): string {
  if (!attachments.length) return content;
  // Keep note identities ahead of prose so bounded external history retains them.
  const notes = attachments.filter(isVaultNoteAttachment);
  const placeholders = attachments.filter((attachment) => !isVaultNoteAttachment(attachment))
    .map((attachment, index) => (
      isTerminalSelectionAttachment(attachment)
        ? formatTerminalSelectionPlaceholder(attachment, index)
        : formatAttachmentPlaceholder(attachment, index)
    ));

  const attachmentBlock = placeholders.map((line) => `\n\n${line}`).join("");
  const body = content.trim() ? `${content}${attachmentBlock}` : placeholders.join("\n\n");
  return notes.length ? [formatVaultNoteReferences(notes), body].filter(Boolean).join("\n\n") : body;
}

function getToolCommand(toolCall?: ToolCall): string | undefined {
  const args = toolCall?.arguments ?? {};
  if (typeof args.command === "string") return args.command;
  const serialized = JSON.stringify(args);
  return serialized && serialized !== "{}" ? serialized : undefined;
}

function fitHistoricalTerminalOutput(content: string): string {
  const safeContent = redactSecretsForModel(content);
  if (safeContent.length <= MAX_HISTORICAL_TERMINAL_OUTPUT_CHARS) return safeContent;
  const marker = "\n\n[... historical terminal output shortened for replay ...]\n\n";
  const tailChars = Math.max(
    0,
    MAX_HISTORICAL_TERMINAL_OUTPUT_CHARS - HISTORICAL_TERMINAL_OUTPUT_HEAD_CHARS - marker.length,
  );
  return `${safeContent.slice(0, HISTORICAL_TERMINAL_OUTPUT_HEAD_CHARS)}${marker}${safeContent.slice(-tailChars)}`;
}

function findOutputHandleId(content: string): string | undefined {
  return content.match(/\bhandleId=(tool-output-[A-Za-z0-9-]+)/)?.[1];
}

export function buildHistoricalToolReplayMaps(messages: ChatMessage[]): {
  resolvedToolCallsByAssistant: Map<ChatMessage, Set<ToolCall>>;
  toolCallByToolResult: Map<ToolResult, ToolCall>;
} {
  const resolvedToolCallsByAssistant = new Map<ChatMessage, Set<ToolCall>>();
  const toolCallByToolResult = new Map<ToolResult, ToolCall>();
  const pendingToolCalls: Array<{ message: ChatMessage; toolCall: ToolCall }> = [];

  for (const message of messages) {
    if (message.role === "assistant" && message.toolCalls?.length) {
      for (const toolCall of message.toolCalls) {
        pendingToolCalls.push({ message, toolCall });
      }
      continue;
    }

    if (message.role !== "tool" || !message.toolResults?.length) continue;

    for (const result of message.toolResults) {
      const pendingIndex = findLastIndex(
        pendingToolCalls,
        ({ toolCall }) => toolCall.id === result.toolCallId,
      );
      if (pendingIndex < 0) continue;

      const [paired] = pendingToolCalls.splice(pendingIndex, 1);
      toolCallByToolResult.set(result, paired.toolCall);

      const resolved = resolvedToolCallsByAssistant.get(paired.message) ?? new Set<ToolCall>();
      resolved.add(paired.toolCall);
      resolvedToolCallsByAssistant.set(paired.message, resolved);
    }
  }

  return { resolvedToolCallsByAssistant, toolCallByToolResult };
}

function findLastIndex<T>(items: T[], predicate: (item: T) => boolean): number {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    if (predicate(items[index])) return index;
  }
  return -1;
}

export function buildHistoricalToolResultReplayText(
  result: ToolResult,
  toolCall?: ToolCall,
  {
    preserveTerminalOutput = false,
  }: {
    preserveTerminalOutput?: boolean;
  } = {},
): string {
  const toolName = toolCall?.name ?? "unknown";
  if (!isTerminalToolName(toolName) || preserveTerminalOutput) {
    return result.content;
  }

  const details = [
    `toolCallId=${result.toolCallId}`,
    getToolCommand(toolCall) ? `command=${truncateInline(redactSecretsForModel(getToolCommand(toolCall) ?? ""), MAX_TOOL_COMMAND_CHARS)}` : undefined,
    `outputChars=${result.content.length}`,
    result.isError ? "status=error" : "status=success",
  ].filter(Boolean).join(", ");

  const fittedOutput = fitHistoricalTerminalOutput(result.content);
  const handleId = findOutputHandleId(fittedOutput);
  const jobId = typeof toolCall?.arguments?.jobId === "string"
    ? toolCall.arguments.jobId
    : undefined;
  const recovery = handleId
    ? `Use tool_output_read with handleId=${handleId} for omitted details.`
    : jobId
      ? `Poll the existing jobId=${jobId} if it is still running and more detail is needed.`
      : "Only the bounded historical output below is available.";

  return [
    `[Historical terminal output omitted from replay beyond the bounded evidence below: ${details}. This tool call already completed; do not execute the command again. ${recovery}]`,
    fittedOutput || "[No terminal output was returned.]",
  ].join("\n");
}

function isTerminalToolName(toolName: string): boolean {
  return toolName === "terminal"
    || toolName === "terminal_exec"
    || toolName === "terminal_execute"
    || toolName === "terminal_start"
    || toolName === "terminal_poll"
    || toolName === "terminal_read_context";
}
