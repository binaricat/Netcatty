/**
 * Vault → Notes mention attachments for the AI composer.
 *
 * Selecting a note from the "Mention Note" picker attaches the note as an
 * inline text attachment: the full markdown content is decoded into the prompt
 * (like terminal selections), and the note id travels with the attachment so
 * the agent can address the exact note entity (e.g. for vault_notes_update)
 * even when several notes share the same title.
 */
import type { VaultNote } from "../../domain/models";
import type { ChatMessageAttachment, UploadedFile } from "../../infrastructure/ai/types";

import { base64ToText, bytesToBase64, getPreviewText } from "./terminalSelectionAttachment";

export const VAULT_NOTE_ATTACHMENT_MEDIA_TYPE = "text/markdown";

/** Strip path separators, control characters and quotes so a note title is a safe attachment filename. */
function sanitizeNoteFilename(title: string): string {
  const cleaned = title
    .replace(/[/\\<>:"|?*]/g, " ")
    .trim()
    .slice(0, 80);
  return cleaned.length > 0 ? cleaned : "note";
}

export function createVaultNoteAttachment(note: Pick<VaultNote, "id" | "title" | "content">): UploadedFile | null {
  const id = String(note.id || "").trim();
  if (!id) return null;
  const content = note.content ?? "";
  const title = String(note.title || "").trim() || "Untitled note";
  const base64Data = bytesToBase64(new TextEncoder().encode(content));
  const filename = `${sanitizeNoteFilename(title)}.md`;

  return {
    id: crypto.randomUUID(),
    filename,
    dataUrl: `data:${VAULT_NOTE_ATTACHMENT_MEDIA_TYPE};base64,${base64Data}`,
    base64Data,
    mediaType: VAULT_NOTE_ATTACHMENT_MEDIA_TYPE,
    vaultNoteId: id,
    vaultNoteTitle: title,
    previewText: getPreviewText(content) || title,
    lineCount: content.split(/\r?\n/).length,
  };
}

export function isVaultNoteAttachment(
  attachment: Pick<ChatMessageAttachment | UploadedFile, "vaultNoteId">,
): boolean {
  return typeof attachment.vaultNoteId === "string" && attachment.vaultNoteId.length > 0;
}

export function decodeVaultNoteAttachment(
  attachment: Pick<ChatMessageAttachment | UploadedFile, "base64Data" | "vaultNoteId">,
): string | null {
  if (!isVaultNoteAttachment(attachment)) return null;
  return base64ToText(attachment.base64Data);
}
