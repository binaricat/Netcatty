import type { VaultNote } from "../../domain/models";
import type { ChatMessageAttachment, UploadedFile } from "../../infrastructure/ai/types";

/** A mention stores only identity; the agent reads current content through the Vault tool. */
export function createVaultNoteAttachment(note: Pick<VaultNote, "id" | "title">): UploadedFile | null {
  // Preserve imported IDs exactly. Reject oversized IDs instead of changing their identity.
  if (!note.id.trim() || note.id.length > 200) return null;
  const title = Array.from(note.title.trim() || "Untitled note").slice(0, 120).join("");
  return {
    id: crypto.randomUUID(),
    filename: title,
    mediaType: "text/markdown",
    base64Data: "",
    dataUrl: "",
    vaultNoteId: note.id,
    vaultNoteTitle: title,
  };
}

export function isVaultNoteAttachment(
  attachment: Pick<ChatMessageAttachment | UploadedFile, "vaultNoteId">,
): boolean {
  return typeof attachment.vaultNoteId === "string" && attachment.vaultNoteId.length > 0;
}

/** JSON preserves special characters and whitespace in exact note IDs. */
export function formatVaultNoteReferences(
  attachments: Array<Pick<ChatMessageAttachment | UploadedFile, "vaultNoteId" | "vaultNoteTitle">>,
): string {
  const notes = attachments.map((attachment) => ({ noteId: attachment.vaultNoteId, title: attachment.vaultNoteTitle }));
  return `[Vault note references: ${JSON.stringify(notes)}]\nUse vault_notes_get with each exact noteId to read the latest content before summarizing or editing. If unavailable, report that instead of choosing another note.`;
}

/** Reserve at least half of external replay's 2,000 characters for the user's request. */
export function vaultNoteReferencesFit(attachments: UploadedFile[]): boolean {
  const notes = attachments.filter(isVaultNoteAttachment);
  return notes.length === 0 || formatVaultNoteReferences(notes).length <= 1000;
}
