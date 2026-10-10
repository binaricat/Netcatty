import { normalizeVaultNotes } from "../../domain/notes";
import type { VaultNote } from "../../domain/models";
import { STORAGE_KEY_NOTES } from "../../infrastructure/config/storageKeys";

export type VaultNotesWriteResult = {
  notes: VaultNote[];
  persisted: boolean;
};

/**
 * Normalize and attempt to persist vault notes. Callers must check `persisted`
 * before treating the update as durable (QuotaExceededError returns false).
 */
export function commitVaultNotesWrite(input: {
  data: Partial<VaultNote>[];
  write: (key: string, value: VaultNote[]) => boolean;
}): VaultNotesWriteResult {
  const notes = normalizeVaultNotes(input.data);
  const persisted = input.write(STORAGE_KEY_NOTES, notes);
  return { notes, persisted };
}
