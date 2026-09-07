import type { ChatMessageAttachment, UploadedFile } from "../../infrastructure/ai/types";
import {
  formatVaultNoteReferences,
  isVaultNoteAttachment,
} from "./vaultNoteAttachment";

export const TERMINAL_SELECTION_ATTACHMENT_MEDIA_TYPE = "text/plain";

const MAX_PREVIEW_CHARS = 80;

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 0x8000;

  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, i + chunkSize);
    binary += String.fromCharCode(...chunk);
  }

  return btoa(binary);
}

function base64ToText(base64Data: string): string {
  const binary = atob(base64Data);
  const bytes = new Uint8Array(binary.length);

  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }

  return new TextDecoder().decode(bytes);
}

function buildTimestamp(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate()),
    pad(date.getHours()),
    pad(date.getMinutes()),
    pad(date.getSeconds()),
  ].join("-");
}

function getPreviewText(text: string): string {
  const firstLine = text.split(/\r?\n/).find((line) => line.trim().length > 0) ?? "";
  return firstLine.length > MAX_PREVIEW_CHARS
    ? `${firstLine.slice(0, MAX_PREVIEW_CHARS - 1)}...`
    : firstLine;
}

export function createTerminalSelectionAttachment(
  selection: string,
  now: Date = new Date(),
): UploadedFile | null {
  const text = selection.trim();
  if (!text) return null;

  const base64Data = bytesToBase64(new TextEncoder().encode(text));
  const filename = `terminal-selection-${buildTimestamp(now)}.log`;

  return {
    id: crypto.randomUUID(),
    filename,
    dataUrl: `data:${TERMINAL_SELECTION_ATTACHMENT_MEDIA_TYPE};base64,${base64Data}`,
    base64Data,
    mediaType: TERMINAL_SELECTION_ATTACHMENT_MEDIA_TYPE,
    terminalSelection: true,
    previewText: getPreviewText(text),
    lineCount: text.split(/\r?\n/).length,
  };
}

export function decodeTerminalSelectionAttachment(
  attachment: Pick<UploadedFile | ChatMessageAttachment, "base64Data" | "terminalSelection">,
): string | null {
  if (!attachment.terminalSelection) return null;
  return base64ToText(attachment.base64Data);
}

export function isTerminalSelectionAttachment(
  attachment: Pick<UploadedFile | ChatMessageAttachment, "terminalSelection">,
): boolean {
  return attachment.terminalSelection === true;
}

/**
 * Attachments whose text is inlined into the prompt instead of being sent as
 * file parts: terminal selections and Vault note mentions.
 */
export function isInlineTextAttachment(
  attachment: Pick<ChatMessageAttachment | UploadedFile, "terminalSelection" | "vaultNoteId">,
): boolean {
  return isTerminalSelectionAttachment(attachment) || isVaultNoteAttachment(attachment);
}

export function buildPromptWithTerminalSelectionAttachments(
  prompt: string,
  attachments: Array<ChatMessageAttachment | UploadedFile>,
): string {
  const terminalBlocks = attachments
    .filter(isTerminalSelectionAttachment)
    .map((attachment, index) => {
      const text = decodeTerminalSelectionAttachment(attachment);
      if (!text) return null;
      const label = attachment.filename || `terminal-selection-${index + 1}.log`;
      return `\n\n[Terminal selection: ${label}]\n${text}`;
    })
    .filter((block): block is string => block !== null);

  const notes = attachments.filter(isVaultNoteAttachment);
  const noteBlocks = notes.length ? [`\n\n${formatVaultNoteReferences(notes)}`] : [];

  const blocks = [...terminalBlocks, ...noteBlocks];
  if (blocks.length === 0) return prompt;
  if (!prompt.trim()) return blocks.join("").trimStart();
  return `${prompt}${blocks.join("")}`;
}
