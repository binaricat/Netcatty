import assert from "node:assert/strict";
import test from "node:test";

import type { VaultNote } from "./models.ts";
import { normalizeVaultNotes } from "./notes.ts";
import { rebasePendingVaultNotes } from "./vaultNotesReconciliation.ts";

const note = (id: string, content: string, extra: Partial<VaultNote> = {}) =>
  normalizeVaultNotes([{ id, title: id, content, createdAt: 1, updatedAt: 1, order: 0, ...extra }])[0];

test("pending notes retain both conflicting versions without choosing by timestamp", () => {
  const base = [note("a", "base")];
  const ours = [note("a", "local", { updatedAt: 1000 })];
  const theirs = [note("a", "remote", { updatedAt: 2, tags: ["external"], group: "folder" })];
  const merged = rebasePendingVaultNotes({ base, ours, theirs });
  assert.deepEqual(merged[0], ours[0]);
  assert.equal(merged.length, 2);
  assert.notEqual(merged[1].id, "a");
  assert.equal(merged[1].title, "a (conflict copy)");
  assert.equal(merged[1].content, "remote");
  assert.deepEqual(merged[1].tags, ["external"]);
  assert.equal(merged[1].group, "folder");
  assert.equal(merged[1].updatedAt, 2);
  assert.deepEqual(rebasePendingVaultNotes({ base: theirs, ours: merged, theirs }), merged,
    "repeated delivery keeps the same copy ID");
});

test("pending note edits preserve unrelated external updates, additions and deletions", () => {
  const base = [note("a", "base"), note("b", "base"), note("c", "base")];
  const ours = [note("a", "local"), base[1], base[2], note("d", "local addition")];
  const theirs = [base[0], note("b", "remote"), note("e", "remote addition")];
  const result = rebasePendingVaultNotes({ base, ours, theirs });
  assert.deepEqual(result.map(({ id, content }) => [id, content]), [
    ["a", "local"], ["b", "remote"], ["d", "local addition"], ["e", "remote addition"],
  ]);
});

test("conflicting delete/edit keeps the surviving content; uncontested deletes stay deleted", () => {
  const base = [note("a", "base")];
  const edited = [note("a", "changed")];
  assert.deepEqual(rebasePendingVaultNotes({ base, ours: [], theirs: edited }), edited);
  assert.deepEqual(rebasePendingVaultNotes({ base, ours: edited, theirs: [] }), edited);
  assert.deepEqual(rebasePendingVaultNotes({ base, ours: [], theirs: base }), []);
  assert.deepEqual(rebasePendingVaultNotes({ base, ours: base, theirs: [] }), []);
});

test("equal local and remote notes do not produce a conflict copy", () => {
  const base = [note("a", "base")];
  const edited = [note("a", "same")];
  assert.deepEqual(rebasePendingVaultNotes({ base, ours: edited, theirs: edited }), edited);
  assert.deepEqual(rebasePendingVaultNotes({ base: [], ours: edited, theirs: edited }), edited);
});
