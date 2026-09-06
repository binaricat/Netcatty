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

/**
 * Aggregate cap on the decoded byte size of vault-note attachments in a single
 * draft. The per-note cap above is not enough: the AI session serializer
 * cannot drop attachments from the newest session to fit its storage budget
 * (MAX_SESSIONS_JSON_BYTES = 2 MiB), so enough mentioned notes in one chat
 * would make persistence fail permanently and the chat disappear on restart.
 * The budget counts decoded bytes, since base64 inflates the payload by ~1/3
 * when persisted (`base64Data` + `dataUrl` on the message).
 */
export const MAX_VAULT_NOTE_TOTAL_ATTACHMENT_BYTES = 768 * 1024;

/**
 * Upper bound for the note title persisted in attachment metadata
 * (`vaultNoteTitle`, and `previewText` when the body is empty). Vault title
 * normalization imposes no length limit, and the session serializer cannot
 * shrink these metadata strings to fit its storage budget, so an oversized
 * pasted or synced title must never reach the persisted message.
 */
export const MAX_VAULT_NOTE_TITLE_CHARS = 120;

/**
 * Upper bound for the note id persisted in attachment metadata
 * (`vaultNoteId`). Vault note ids are unbounded strings, and the session
 * serializer cannot shrink this field to fit its storage budget, so a
 * pasted or synced note with a multi-megabyte id must be rejected rather
 * than attached; truncating the id would break `vault_notes_get` addressing.
 */
export const MAX_VAULT_NOTE_ID_CHARS = 200;

/** Estimate the decoded byte size of a base64 payload without decoding it. */
function base64DecodedByteLength(base64: string): number {
  let chars = base64.length;
  while (chars > 0 && base64.charCodeAt(chars - 1) === 61 /* "=" padding */) chars -= 1;
  return Math.floor((chars * 3) / 4);
}

/**
 * Persisted byte cost of a vault-note attachment against the session storage
 * budget: the decoded body (persisted twice, as `base64Data` and inside
 * `dataUrl`) plus the `vaultNoteId` metadata string, which the session
 * serializer cannot shrink to fit.
 */
function vaultNoteAttachmentBudgetBytes(attachment: Pick<UploadedFile, "base64Data" | "vaultNoteId">): number {
  const idBytes = typeof attachment.vaultNoteId === "string"
    ? new TextEncoder().encode(attachment.vaultNoteId).length
    : 0;
  return base64DecodedByteLength(attachment.base64Data) + idBytes;
}

export type VaultNoteMentionStatus = "attached" | "duplicate" | "budget" | "invalid";

export type VaultNoteMentionResult = {
  /** Fresh attachment for the note; null unless `status === "attached"` or `"duplicate"`. */
  upload: UploadedFile | null;
  status: VaultNoteMentionStatus;
};

/**
 * Build the attachment for a note mention against the draft's existing
 * attachments. Re-mentioning a note is a no-op duplicate (the caller may
 * refresh the existing attachment in place), and the aggregate persisted size
 * of all draft attachments (ordinary files included — they use the same
 * `base64Data`/`dataUrl` payload shape) is capped so one chat can never
 * exceed the storage budget for persisted sessions.
 */
export function attachVaultNoteMention(
  existingAttachments: ReadonlyArray<UploadedFile>,
  note: Pick<VaultNote, "id" | "title" | "content">,
): VaultNoteMentionResult {
  // Match the raw id: `createVaultNoteAttachment` persists the original id
  // (whitespace included) in `vaultNoteId`, so the duplicate check must use
  // the same form.
  const noteId = String(note.id || "");
  const upload = createVaultNoteAttachment(note);
  if (!upload) return { upload: null, status: "invalid" };
  // Every attachment is persisted with the same `base64Data` + `dataUrl`
  // payload shape, so ordinary files count toward the budget too: ignoring
  // them would let a large plain file plus near-limit notes push the newest
  // session past MAX_SESSIONS_JSON_BYTES, making the serializer drop older
  // sessions (or the chat) after a restart.
  const usedBytes = existingAttachments.reduce(
    (total, attachment) => total + vaultNoteAttachmentBudgetBytes(attachment),
    0,
  );
  const existingDuplicate = noteId
    ? existingAttachments.find(
      (attachment) => isVaultNoteAttachment(attachment) && attachment.vaultNoteId === noteId,
    )
    : undefined;
  if (existingDuplicate) {
    // Re-mentioning a note refreshes it in place rather than appending a
    // second copy; the freed payload of the stale attachment counts against
    // the new one's budget.
    const usedWithoutDuplicate = usedBytes - vaultNoteAttachmentBudgetBytes(existingDuplicate);
    if (usedWithoutDuplicate + vaultNoteAttachmentBudgetBytes(upload) > MAX_VAULT_NOTE_TOTAL_ATTACHMENT_BYTES) {
      return { upload: null, status: "budget" };
    }
    return { upload, status: "duplicate" };
  }
  if (usedBytes + vaultNoteAttachmentBudgetBytes(upload) > MAX_VAULT_NOTE_TOTAL_ATTACHMENT_BYTES) {
    return { upload: null, status: "budget" };
  }
  return { upload, status: "attached" };
}

/**
 * Shared application-state attachment updater: select which uploads fit
 * within the aggregate attachment budget when appending to a draft. Callers
 * apply this whenever a vault-note mention is involved (the draft already
 * contains one, or the incoming uploads include one): `attachVaultNoteMention`
 * only checks the budget when a note is attached, so files appended afterwards
 * would bypass the cap and could push the persisted newest session past
 * MAX_SESSIONS_JSON_BYTES, evicting older sessions (or the chat) after a
 * restart. Ordinary-only drafts keep their uncapped behavior; ordinary files
 * still count toward the budget here and in `attachVaultNoteMention` (they use
 * the same `base64Data`/`dataUrl` payload shape). Uploads that do not fit are
 * dropped greedily in input order and returned to the caller so it can surface
 * the rejection to the user.
 */
export function appendUploadsWithinAttachmentBudget(
  existingAttachments: ReadonlyArray<UploadedFile>,
  uploads: ReadonlyArray<UploadedFile>,
): UploadedFile[] {
  let usedBytes = existingAttachments.reduce(
    (total, attachment) => total + vaultNoteAttachmentBudgetBytes(attachment),
    0,
  );
  const accepted: UploadedFile[] = [];
  for (const upload of uploads) {
    const cost = vaultNoteAttachmentBudgetBytes(upload);
    if (usedBytes + cost > MAX_VAULT_NOTE_TOTAL_ATTACHMENT_BYTES) continue;
    usedBytes += cost;
    accepted.push(upload);
  }
  return accepted;
}

/** Bound the inlined body, pointing at `vault_notes_get` when truncating. */
function boundNoteBody(content: string, noteId: string): string {
  if (content.length <= MAX_VAULT_NOTE_ATTACHMENT_CHARS) return content;
  let truncated = content.slice(0, MAX_VAULT_NOTE_ATTACHMENT_CHARS);
  // Never split a surrogate pair at the cut point.
  if (/[\uD800-\uDBFF]$/.test(truncated)) truncated = truncated.slice(0, -1);
  return `${truncated}\n\n[... Vault note truncated for size: showing ${truncated.length} of ${content.length} characters. Use vault_notes_get with noteId ${noteId} to read the full note ...]`;
}

/** Bound the persisted title metadata, never splitting a surrogate pair. */
function boundNoteTitle(title: string): string {
  // A newline in the title would split the generated `[Vault Note: ...]`
  // header across lines, so `boundPromptForExternalSdk` could neither match
  // nor restore it; flatten it to a space.
  title = title.replace(/\r?\n/g, " ");
  if (title.length <= MAX_VAULT_NOTE_TITLE_CHARS) return title;
  let truncated = title.slice(0, MAX_VAULT_NOTE_TITLE_CHARS);
  if (/[\uD800-\uDBFF]$/.test(truncated)) truncated = truncated.slice(0, -1);
  return truncated;
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
  // Keep the original id (whitespace included): `sanitizeVaultNote` preserves
  // whitespace in imported/synced note ids, and the Vault agent bridge
  // resolves `note.get`/`note.update` by exact id equality, so a trimmed id
  // in the prompt would not address the actual note entity. Validate the
  // trimmed form, but attach and reference the original id verbatim.
  const id = String(note.id || "");
  const trimmedId = id.trim();
  // An unbounded id would be persisted verbatim in `vaultNoteId` and could
  // push the newest session past its storage budget on its own; truncating
  // would break `vault_notes_get` addressing, so reject instead.
  if (!trimmedId || id.length > MAX_VAULT_NOTE_ID_CHARS) return null;
  // An id containing a newline is outside the prompt-header grammar
  // (`[Vault Note: <title> (id: <noteId>)]` is single-line), so it could
  // never be matched or restored by `boundPromptForExternalSdk`; reject it
  // like the other unaddressable id shapes.
  if (id.includes("\n")) return null;
  const title = boundNoteTitle(String(note.title || "").trim()) || "Untitled note";
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
