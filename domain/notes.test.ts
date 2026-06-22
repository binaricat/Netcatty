import assert from "node:assert/strict";
import test from "node:test";
import {
  matchesVaultNoteSearch,
  normalizeNoteGroups,
  normalizeVaultNotes,
  remapExpandedNoteGroupPaths,
  resolveMovedNoteGroupPath,
  resolveRenderedMarkdownLinkHref,
  sanitizeVaultNote,
} from "./notes";

test("sanitizeVaultNote supplies safe defaults", () => {
  const note = sanitizeVaultNote({ title: "  ", content: 123 as never });
  assert.equal(note.title, "Untitled note");
  assert.equal(note.content, "");
  assert.equal(typeof note.id, "string");
  assert.equal(typeof note.createdAt, "number");
});

test("normalizeVaultNotes trims group and de-duplicates tags", () => {
  const notes = normalizeVaultNotes([
    {
      id: "n1",
      title: " Runbook ",
      content: "body",
      group: " Ops ",
      tags: ["db", "db", " psql "],
      createdAt: 1,
      updatedAt: 2,
    },
  ]);

  assert.equal(notes[0].title, "Runbook");
  assert.equal(notes[0].group, "Ops");
  assert.deepEqual(notes[0].tags, ["db", "psql"]);
});

test("normalizeNoteGroups trims and de-duplicates groups", () => {
  assert.deepEqual(normalizeNoteGroups([" Ops ", "Ops", "", 1]), ["Ops"]);
});

test("resolveMovedNoteGroupPath avoids merging with an existing target folder", () => {
  assert.equal(
    resolveMovedNoteGroupPath("Archive/DB", "Ops", [
      "Ops",
      "Ops/DB",
      "Archive/DB",
      "Archive/DB/Runbooks",
    ]),
    "Ops/DB 2",
  );
});

test("resolveMovedNoteGroupPath normalizes existing paths before detecting conflicts", () => {
  assert.equal(
    resolveMovedNoteGroupPath("Archive/DB", "Ops", [
      "Ops",
      "Ops / DB",
      "Archive/DB",
    ]),
    "Ops/DB 2",
  );
});

test("resolveMovedNoteGroupPath rejects moving a folder into itself", () => {
  assert.equal(
    resolveMovedNoteGroupPath("Ops", "Ops/DB", ["Ops", "Ops/DB"]),
    null,
  );
});

test("remapExpandedNoteGroupPaths preserves expanded descendants after folder moves", () => {
  assert.deepEqual(
    [...remapExpandedNoteGroupPaths(
      new Set(["Archive", "Archive/DB", "Archive/DB/Runbooks", "Ops"]),
      "Archive/DB",
      "Ops/DB 2",
    )].sort(),
    ["Archive", "Ops", "Ops/DB 2", "Ops/DB 2/Runbooks"],
  );
});

test("matchesVaultNoteSearch checks title, body, tags, group, and linked hosts", () => {
  const note = sanitizeVaultNote({
    id: "n1",
    title: "Failover",
    content: "Promote replica",
    group: "Ops",
    tags: ["postgres"],
    linkedHostIds: ["h1"],
    createdAt: 1,
    updatedAt: 1,
  });
  const hosts = [{ id: "h1", label: "db-prod", hostname: "10.0.0.5" }] as never;

  assert.equal(matchesVaultNoteSearch(note, "postgres", hosts), true);
  assert.equal(matchesVaultNoteSearch(note, "db-prod", hosts), true);
  assert.equal(matchesVaultNoteSearch(note, "missing", hosts), false);
});

test("resolveRenderedMarkdownLinkHref recovers ssh links sanitized by the editor DOM", () => {
  assert.equal(
    resolveRenderedMarkdownLinkHref(
      "Open [10.2.0.32](ssh://10.2.0.32) from notes",
      "10.2.0.32",
      "about:blank",
    ),
    "ssh://10.2.0.32",
  );
});

test("resolveRenderedMarkdownLinkHref keeps normal rendered links unchanged", () => {
  assert.equal(
    resolveRenderedMarkdownLinkHref(
      "[Example](https://example.com)",
      "Example",
      "https://example.com/",
    ),
    "https://example.com/",
  );
});

test("resolveRenderedMarkdownLinkHref avoids guessing duplicate labels", () => {
  assert.equal(
    resolveRenderedMarkdownLinkHref(
      "[host](ssh://10.0.0.1) [host](ssh://10.0.0.2)",
      "host",
      "about:blank",
    ),
    "about:blank",
  );
});
