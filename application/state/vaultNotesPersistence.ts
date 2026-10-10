import { normalizeVaultNotes } from "../../domain/notes";
import type { VaultNote } from "../../domain/models";
import { STORAGE_KEY_NOTES } from "../../infrastructure/config/storageKeys";
import { getNextVaultOrder } from "../../domain/vaultOrder";

/** Reconcile a pending local write with the last observed storage snapshot.
 * Keep conflicting remote content as an ordinary, exportable note; timestamps
 * are compared only for equality, never used to decide which writer wins.
 */
export function rebasePendingVaultNotes(input: {
  base: VaultNote[];
  ours: VaultNote[];
  theirs: VaultNote[];
}): VaultNote[] {
  const base = new Map(input.base.map(note => [note.id, note]));
  const ours = new Map(input.ours.map(note => [note.id, note]));
  const theirs = new Map(input.theirs.map(note => [note.id, note]));
  const same = (a: VaultNote | undefined, b: VaultNote | undefined) =>
    JSON.stringify(a) === JSON.stringify(b);
  const notes: VaultNote[] = [];
  const copies: VaultNote[] = [];
  let copyOrder = getNextVaultOrder([...input.ours, ...input.theirs]);
  for (const id of new Set([...ours.keys(), ...theirs.keys()])) {
    const ancestor = base.get(id);
    const local = ours.get(id);
    const remote = theirs.get(id);
    if (same(local, ancestor)) {
      if (remote) notes.push(remote);
    } else if (same(remote, ancestor) || same(local, remote)) {
      if (local) notes.push(local);
    } else {
      if (local) notes.push(local);
      if (remote) {
        // A concurrent delete must not discard the surviving edited content.
        if (!local) notes.push(remote);
        else copies.push({ ...remote, id: crypto.randomUUID(), title: `${remote.title} (conflict copy)`, order: copyOrder++ });
      }
    }
  }
  return normalizeVaultNotes([...notes, ...copies]);
}

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
