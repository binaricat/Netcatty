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

/**
 * Upper bound for the note body inlined into an attachment. The body is
 * persisted as base64 in both `base64Data` and `dataUrl` on the message, and
 * the AI session serializer cannot shrink attachments to fit its storage
 * budget, so an unbounded note (a ~2 MB note is valid in the Vault) could
 * make the current chat fail to persist and disappear after a restart. The
 * cap keeps the persisted attachment well under that budget; the note id
 * still travels with the attachment, so the agent can read the full body
 * with `vault_notes_get` when needed.
 */
export const MAX_VAULT_NOTE_ATTACHMENT_CHARS = 200_000;

/** Bound the inlined body, pointing at `vault_notes_get` when truncating. */
function boundNoteBody(content: string, noteId: string): string {
  if (content.length <= MAX_VAULT_NOTE_ATTACHMENT_CHARS) return content;
  let truncated = content.slice(0, MAX_VAULT_NOTE_ATTACHMENT_CHARS);
  // Never split a surrogate pair at the cut point.
  if (/[\uD800-\uDBFF]$/.test(truncated)) truncated = truncated.slice(0, -1);
  return `${truncated}\n\n[... Vault note truncated for size: showing ${truncated.length} of ${content.length} characters. Use vault_notes_get with noteId ${noteId} to read the full note ...]`;
}

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
  const title = String(note.title || "").trim() || "Untitled note";
  const content = boundNoteBody(note.content ?? "", id);
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
