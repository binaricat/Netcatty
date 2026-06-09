import type { ChatMessageAttachment, ToolCall, ToolResult } from "../../infrastructure/ai/types";
import { isTerminalSelectionAttachment } from "../../application/state/terminalSelectionAttachment";

const MAX_ATTACHMENT_PLACEHOLDER_DETAIL_CHARS = 120;
const MAX_TOOL_COMMAND_CHARS = 220;

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
    `mediaType=${attachment.mediaType}`,
    describeAttachmentSize(attachment),
  ].filter(Boolean).join(", ");

  return `[Historical ${label} attachment omitted from replay: ${details || `attachment-${index + 1}`}]`;
}

export function buildHistoricalUserReplayContent(
  content: string,
  attachments: ChatMessageAttachment[] = [],
): string {
  const placeholders = attachments.map((attachment, index) => (
    isTerminalSelectionAttachment(attachment)
      ? formatTerminalSelectionPlaceholder(attachment, index)
      : formatAttachmentPlaceholder(attachment, index)
  ));

  if (!placeholders.length) return content;
  const attachmentBlock = placeholders.map((line) => `\n\n${line}`).join("");
  return content.trim() ? `${content}${attachmentBlock}` : placeholders.join("\n\n");
}

function getToolCommand(toolCall?: ToolCall): string | undefined {
  const args = toolCall?.arguments ?? {};
  if (typeof args.command === "string") return args.command;
  const serialized = JSON.stringify(args);
  return serialized && serialized !== "{}" ? serialized : undefined;
}

export function buildHistoricalToolResultReplayText(
  result: ToolResult,
  toolCall?: ToolCall,
): string {
  const toolName = toolCall?.name ?? "unknown";
  if (!isTerminalToolName(toolName)) {
    return result.content;
  }

  const details = [
    `toolCallId=${result.toolCallId}`,
    getToolCommand(toolCall) ? `command=${truncateInline(getToolCommand(toolCall) ?? "", MAX_TOOL_COMMAND_CHARS)}` : undefined,
    `outputChars=${result.content.length}`,
    result.isError ? "status=error" : "status=success",
  ].filter(Boolean).join(", ");

  return `[Historical terminal output omitted from replay: ${details}. Re-run terminal_execute if exact output is needed.]`;
}

function isTerminalToolName(toolName: string): boolean {
  return toolName === "terminal" || toolName === "terminal_exec" || toolName === "terminal_execute";
}
