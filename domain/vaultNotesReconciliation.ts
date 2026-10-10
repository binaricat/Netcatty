import type { VaultNote } from "./models.ts";
import { normalizeVaultNotes } from "./notes.ts";
import { getNextVaultOrder } from "./vaultOrder.ts";

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
