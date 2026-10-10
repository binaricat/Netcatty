import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { STORAGE_KEY_NOTES } from "../../infrastructure/config/storageKeys.ts";
import { commitVaultNotesWrite } from "./vaultNotesPersistence.ts";

test("commitVaultNotesWrite reports failure when the storage write returns false", () => {
  const writes: Array<{ key: string; value: unknown }> = [];
  const result = commitVaultNotesWrite({
    data: [{
      id: "note-1",
      title: "Draft",
      content: "body",
      createdAt: 1,
      updatedAt: 2,
    }],
    write: (key, value) => {
      writes.push({ key, value });
      return false;
    },
  });

  assert.equal(result.persisted, false);
  assert.equal(writes.length, 1);
  assert.equal(writes[0]?.key, STORAGE_KEY_NOTES);
  assert.equal(result.notes[0]?.title, "Draft");
});

test("commitVaultNotesWrite returns persisted notes when the write succeeds", () => {
  const result = commitVaultNotesWrite({
    data: [{
      id: "note-1",
      title: "Saved",
      content: "ok",
      createdAt: 1,
      updatedAt: 2,
    }],
    write: () => true,
  });

  assert.equal(result.persisted, true);
  assert.equal(result.notes[0]?.title, "Saved");
});

test("useVaultState updateNotes surfaces storage write failures", () => {
  const source = readFileSync(new URL("./useVaultState.ts", import.meta.url), "utf8");

  assert.match(source, /commitVaultNotesWrite/);
  assert.match(source, /notify\.error/);
  assert.match(source, /!persisted|persisted === false/);
  assert.match(source, /return false/);
  assert.match(source, /notesPersistFailureNotifiedAtRef/);
  assert.match(source, /10_000/);
});
