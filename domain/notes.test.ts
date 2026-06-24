import assert from "node:assert/strict";
import test from "node:test";
import {
  buildVaultNoteFromMarkdownImport,
  deriveNoteImportTitle,
  importMarkdownFilesToVaultNotes,
  importMarkdownPayloadsToVaultNotes,
  matchesVaultNoteSearch,
  normalizeNoteGroups,
  normalizeVaultNotes,
  remapExpandedNoteGroupPaths,
  resolveMovedNoteGroupPath,
  resolveRenderedMarkdownLinkHref,
  sanitizeNoteTitle,
  sanitizeVaultNote,
} from "./notes";

test("sanitizeVaultNote supplies safe defaults", () => {
  const note = sanitizeVaultNote({ title: "  ", content: 123 as never });
  assert.equal(note.title, "");
  assert.equal(note.content, "");
  assert.equal(typeof note.id, "string");
  assert.equal(typeof note.createdAt, "number");
});

test("sanitizeNoteTitle preserves non-empty titles and allows empty titles", () => {
  assert.equal(sanitizeNoteTitle("  My note  "), "My note");
  assert.equal(sanitizeNoteTitle(""), "");
  assert.equal(sanitizeNoteTitle("   "), "");
  assert.equal(sanitizeNoteTitle(undefined), "");
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

test("deriveNoteImportTitle prefers the first markdown heading", () => {
  assert.equal(
    deriveNoteImportTitle("runbook.md", "# Failover\n\nPromote replica"),
    "Failover",
  );
  assert.equal(
    deriveNoteImportTitle("deploy-notes.markdown", "No heading here"),
    "deploy-notes",
  );
  assert.equal(
    deriveNoteImportTitle("README.txt", ""),
    "README",
  );
  assert.equal(
    deriveNoteImportTitle("script.md", "```sh\n# not a title\n```\n\n# Real Title"),
    "Real Title",
  );
  assert.equal(
    deriveNoteImportTitle("unclosed.md", "```sh\n# not a title\n\n# Also inside fence"),
    "unclosed",
  );
  assert.equal(
    deriveNoteImportTitle("preface.md", "# Real Title\n\n```sh\n# not a title"),
    "Real Title",
  );
});

test("buildVaultNoteFromMarkdownImport creates a note in the target group", () => {
  const note = buildVaultNoteFromMarkdownImport({
    fileName: "runbook.md",
    content: "# Runbook\n\nRestart sshd",
    group: "Ops",
    order: 1000,
  });

  assert.equal(note.title, "Runbook");
  assert.equal(note.content, "# Runbook\n\nRestart sshd");
  assert.equal(note.group, "Ops");
  assert.equal(note.order, 1000);
});

test("importMarkdownPayloadsToVaultNotes appends notes from pre-read payloads", () => {
  const existing = [sanitizeVaultNote({
    id: "existing",
    title: "Existing",
    content: "body",
    createdAt: 1,
    updatedAt: 1,
    order: 1000,
  })];

  const result = importMarkdownPayloadsToVaultNotes(
    [{ fileName: "imported.md", content: "# Imported\n\nBody" }],
    existing,
    "Ops",
  );

  assert.equal(result.importedCount, 1);
  assert.equal(result.notes.length, 2);
  assert.equal(result.notes[1].title, "Imported");
  assert.equal(result.notes[1].group, "Ops");
});

test("importMarkdownFilesToVaultNotes appends notes and skips unsupported files", async () => {
  const existing = [sanitizeVaultNote({
    id: "existing",
    title: "Existing",
    content: "body",
    createdAt: 1,
    updatedAt: 1,
    order: 1000,
  })];
  const files = [
    new File(["# Imported\n\nBody"], "imported.md", { type: "text/markdown" }),
    new File(["ignored"], "notes.json", { type: "application/json" }),
  ];

  const result = await importMarkdownFilesToVaultNotes(
    files,
    existing,
    "Ops",
    async (file) => file.text(),
  );

  assert.equal(result.importedCount, 1);
  assert.equal(result.skippedCount, 1);
  assert.equal(result.notes.length, 2);
  assert.equal(result.notes[1].title, "Imported");
  assert.equal(result.notes[1].group, "Ops");
});
