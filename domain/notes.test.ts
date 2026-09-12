import assert from "node:assert/strict";
import test from "node:test";
import {
  buildVaultNoteMarkdownExportFiles,
  buildVaultNoteFromMarkdownImport,
  calculateNoteStats,
  deriveNoteImportTitle,
  extractAllNoteTags,
  extractNoteHeadings,
  extractNoteSnippet,
  filterAndSortVaultNotes,
  formatMarkdownListSelection,
  formatMarkdownQuoteSelection,
  getVaultNotesForExportScope,
  importMarkdownFilesToVaultNotes,
  importMarkdownPayloadsToVaultNotes,
  matchesVaultNoteSearch,
  createVaultNoteSearchIndex,
  normalizeNoteGroups,
  normalizeVaultNotes,
  remapExpandedNoteGroupPaths,
  resolveMovedNoteGroupPath,
  resolveRenderedMarkdownLinkHref,
  sanitizeNoteExportFileNamePart,
  sanitizeNoteTitle,
  sanitizeVaultNote,
  wrapMarkdownSyntax,
} from "./notes.ts";

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

test("sanitizeNoteExportFileNamePart removes unsafe path characters", () => {
  assert.equal(sanitizeNoteExportFileNamePart("  a/b:c*  ", "note"), "a-b-c-");
  assert.equal(sanitizeNoteExportFileNamePart("a\u0001b", "note"), "a-b");
  assert.equal(sanitizeNoteExportFileNamePart("..", "note"), "note");
  assert.equal(sanitizeNoteExportFileNamePart("CON", "note"), "CON_");
  assert.equal(sanitizeNoteExportFileNamePart("CON.txt", "note"), "CON_.txt");
  assert.equal(sanitizeNoteExportFileNamePart("com1.backup.md", "note"), "com1_.backup.md");
  assert.equal(sanitizeNoteExportFileNamePart("release.CON", "note"), "release.CON");
});

test("getVaultNotesForExportScope includes only selected folder descendants", () => {
  const notes = [
    sanitizeVaultNote({ id: "n1", title: "Root", content: "root", createdAt: 1, updatedAt: 1, order: 1000 }),
    sanitizeVaultNote({ id: "n2", title: "Ops", content: "ops", group: "Ops", createdAt: 1, updatedAt: 1, order: 2000 }),
    sanitizeVaultNote({ id: "n3", title: "DB", content: "db", group: "Ops/DB", createdAt: 1, updatedAt: 1, order: 3000 }),
    sanitizeVaultNote({ id: "n4", title: "Other", content: "other", group: "Other", createdAt: 1, updatedAt: 1, order: 4000 }),
  ];

  assert.deepEqual(
    getVaultNotesForExportScope(notes, { type: "group", group: "Ops" }).map((item) => item.id),
    ["n2", "n3"],
  );
});

test("buildVaultNoteMarkdownExportFiles preserves groups and de-duplicates file names", () => {
  const notes = [
    sanitizeVaultNote({ id: "n1", title: "Runbook", content: "# One", group: "Ops/DB", createdAt: 1, updatedAt: 1, order: 1000 }),
    sanitizeVaultNote({ id: "n2", title: "Runbook", content: "# Two", group: "Ops/DB", createdAt: 1, updatedAt: 1, order: 2000 }),
    sanitizeVaultNote({ id: "n3", title: "", content: "Untitled", createdAt: 1, updatedAt: 1, order: 3000 }),
    sanitizeVaultNote({ id: "n4", title: "Outside", content: "Nope", group: "Other", createdAt: 1, updatedAt: 1, order: 4000 }),
  ];

  const files = buildVaultNoteMarkdownExportFiles(notes, { type: "group", group: "Ops" });
  assert.deepEqual(files, [
    { name: "Ops/DB/Runbook.md", content: "# One" },
    { name: "Ops/DB/Runbook-2.md", content: "# Two" },
  ]);

  assert.equal(buildVaultNoteMarkdownExportFiles(notes)[2].name, "note-3.md");
});

test("buildVaultNoteMarkdownExportFiles keeps file names distinct from directory paths", () => {
  const notes = [
    sanitizeVaultNote({ id: "n1", title: "docs", content: "root", createdAt: 1, updatedAt: 1, order: 1000 }),
    sanitizeVaultNote({ id: "n2", title: "child", content: "nested", group: "DOCS.md", createdAt: 1, updatedAt: 1, order: 2000 }),
  ];

  assert.deepEqual(buildVaultNoteMarkdownExportFiles(notes), [
    { name: "docs-2.md", content: "root" },
    { name: "DOCS.md/child.md", content: "nested" },
  ]);
});

test("buildVaultNoteMarkdownExportFiles keeps sanitized group paths distinct", () => {
  const notes = [
    sanitizeVaultNote({ id: "n1", title: "US", content: "one", group: "Prod:US/Apps", createdAt: 1, updatedAt: 1, order: 1000 }),
    sanitizeVaultNote({ id: "n2", title: "US", content: "two", group: "Prod?US/Apps", createdAt: 1, updatedAt: 1, order: 2000 }),
    sanitizeVaultNote({ id: "n3", title: "EU", content: "three", group: "Prod:US/Apps?EU", createdAt: 1, updatedAt: 1, order: 3000 }),
    sanitizeVaultNote({ id: "n4", title: "EU", content: "four", group: "Prod:US/Apps:EU", createdAt: 1, updatedAt: 1, order: 4000 }),
  ];

  assert.deepEqual(buildVaultNoteMarkdownExportFiles(notes), [
    { name: "Prod-US/Apps/US.md", content: "one" },
    { name: "Prod-US-2/Apps/US.md", content: "two" },
    { name: "Prod-US/Apps-EU/EU.md", content: "three" },
    { name: "Prod-US/Apps-EU-2/EU.md", content: "four" },
  ]);
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
    deriveNoteImportTitle("tilde.md", "~~~md\n# not a title\n~~~\n\n# Tilde Fence Title"),
    "Tilde Fence Title",
  );
  assert.equal(
    deriveNoteImportTitle("long-fence.md", "````md\n# not a title\n```\nstill fenced\n````\n\n# Long Fence Title"),
    "Long Fence Title",
  );
  assert.equal(
    deriveNoteImportTitle("unclosed.md", "```sh\n# not a title\n\n# Also inside fence"),
    "unclosed",
  );
  assert.equal(
    deriveNoteImportTitle("unclosed-tilde.md", "~~~sh\n# not a title\n\n# Also inside fence"),
    "unclosed-tilde",
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

test("extractNoteHeadings extracts markdown headings ignoring code blocks", () => {
  const content = `# Title 1
Some intro text
\`\`\`ts
# Not a heading
\`\`\`
## Subtitle 1.1
### Deep section
`;
  const headings = extractNoteHeadings(content);
  assert.equal(headings.length, 3);
  assert.equal(headings[0].text, "Title 1");
  assert.equal(headings[0].level, 1);
  assert.equal(headings[1].text, "Subtitle 1.1");
  assert.equal(headings[1].level, 2);
  assert.equal(headings[2].text, "Deep section");
  assert.equal(headings[2].level, 3);
});

test("extractNoteHeadings follows rendered markdown fence and setext rules", () => {
  const content = `Setext title
============

~~~md
# Hidden in tilde fence
~~~

\`\`\`\`md
## Hidden in long fence
\`\`\`
still hidden
\`\`\`\`

    # Indented code
### Visible ###`;
  const headings = extractNoteHeadings(content);

  assert.deepEqual(
    headings.map(({ level, text, line }) => ({ level, text, line })),
    [
      { level: 1, text: "Setext title", line: 1 },
      { level: 3, text: "Visible", line: 15 },
    ],
  );
});

test("extractNoteHeadings does not turn thematic breaks after block headings into setext headings", () => {
  assert.deepEqual(
    extractNoteHeadings("# First\n---\n## Second").map(({ level, text }) => ({ level, text })),
    [
      { level: 1, text: "First" },
      { level: 2, text: "Second" },
    ],
  );
});

test("extractNoteHeadings excludes reference definitions before thematic breaks", () => {
  assert.deepEqual(
    extractNoteHeadings("[docs]: https://example.com\n---\n## Real").map(({ text }) => text),
    ["Real"],
  );
});

test("extractNoteHeadings uses the same visible text as formatted rendered headings", () => {
  assert.deepEqual(
    extractNoteHeadings("## **Bold**\n## ~~Removed~~ title\n## [Docs](https://example.com)\n## `code` &copy; more\n## <https://example.com>\n## [Reference][docs]\n\n[docs]: /url")
      .map(({ text }) => text),
    ["Bold", "Removed title", "Docs", "code © more", "https://example.com", "Reference"],
  );
});

test("extractNoteHeadings includes headings rendered inside markdown containers", () => {
  assert.deepEqual(
    extractNoteHeadings("> ## Repeat\n## Repeat\n- ### Listed").map(({ level, text }) => ({ level, text })),
    [
      { level: 2, text: "Repeat" },
      { level: 2, text: "Repeat" },
      { level: 3, text: "Listed" },
    ],
  );
});

test("extractNoteHeadings keeps complete multi-line setext heading text", () => {
  const [heading] = extractNoteHeadings("first line\nsecond line\n---");
  assert.deepEqual(
    { level: heading.level, text: heading.text, line: heading.line },
    { level: 2, text: "first line second line", line: 1 },
  );
});

test("extractNoteHeadings ignores multi-line definitions and raw HTML blocks", () => {
  assert.deepEqual(
    extractNoteHeadings('[foo]: /url\n  "title"\n---\n\n<div>\ntext\n---\n</div>\n\n## Real').map(({ text }) => text),
    ["Real"],
  );
});

test("extractNoteSnippet extracts clean plain text from markdown", () => {
  const content = `# Title
Here is **bold** text and [a link](https://example.com) and \`code\`.
- [x] Task 1
> quote text
`;
  const snippet = extractNoteSnippet(content, 100);
  assert.ok(!snippet.includes("#"));
  assert.ok(!snippet.includes("[a link]"));
  assert.ok(snippet.includes("bold"));
  assert.ok(snippet.includes("Task 1"));
});

test("extractAllNoteTags aggregates and sorts tags by frequency", () => {
  const notes = [
    sanitizeVaultNote({ tags: ["dev", "prod"] }),
    sanitizeVaultNote({ tags: ["dev", "staging"] }),
    sanitizeVaultNote({ tags: ["dev"] }),
  ];
  const tags = extractAllNoteTags(notes);
  assert.equal(tags[0].tag, "dev");
  assert.equal(tags[0].count, 3);
});

test("filterAndSortVaultNotes filters by pinned, tags, group and sorts accordingly", () => {
  const notes = [
    sanitizeVaultNote({ id: "1", title: "B Note", isPinned: false, updatedAt: 100, tags: ["ssh"] }),
    sanitizeVaultNote({ id: "2", title: "A Note", isPinned: true, updatedAt: 50, tags: ["ssh"] }),
    sanitizeVaultNote({ id: "3", title: "C Note", isPinned: false, updatedAt: 200, group: "Ops" }),
  ];

  // Pinned first
  const sorted = filterAndSortVaultNotes(notes, { sort: "updatedDesc" });
  assert.equal(sorted[0].id, "2"); // Pinned note first
  assert.equal(sorted[1].id, "3"); // 200 updatedAt
  assert.equal(sorted[2].id, "1"); // 100 updatedAt

  // Filter pinned only
  const pinnedOnly = filterAndSortVaultNotes(notes, { filterMode: "pinned" });
  assert.equal(pinnedOnly.length, 1);
  assert.equal(pinnedOnly[0].id, "2");

  // Filter by tag
  const tagFiltered = filterAndSortVaultNotes(notes, { tag: "ssh" });
  assert.equal(tagFiltered.length, 2);
});

test("calculateNoteStats calculates lines, chars, and word counts", () => {
  const content = "Hello world\n这是中文测试内容\nThird line";
  const stats = calculateNoteStats(content);
  assert.equal(stats.lines, 3);
  assert.equal(stats.chars, content.length);
  // Hello(1) + world(1) + 8 CJK chars + Third(1) + line(1) = 12
  assert.equal(stats.words, 12);
});

test("wrapMarkdownSyntax wraps or inserts markdown syntax correctly", () => {
  const base = "Hello world";
  // bold on 'world' (start 6, end 11)
  const boldRes = wrapMarkdownSyntax(base, 6, 11, "bold");
  assert.equal(boldRes.text, "Hello **world**");

  // insert table when no selection (start 0, end 0)
  const tableRes = wrapMarkdownSyntax("", 0, 0, "table");
  assert.ok(tableRes.text.includes("| Column 1 | Column 2 | Column 3 |"));

  // insert code block
  const codeRes = wrapMarkdownSyntax("", 0, 0, "codeblock");
  assert.ok(codeRes.text.includes("```bash"));
  assert.equal(codeRes.selectionStart, "\n```bash\n".length);
  assert.equal(codeRes.selectionEnd, "\n```bash\n".length);

  // insert math block
  const mathRes = wrapMarkdownSyntax("", 0, 0, "math");
  assert.ok(mathRes.text.includes("```latex"));
  assert.equal(mathRes.selectionStart, "\n```latex\n".length);
  assert.equal(mathRes.selectionEnd, "\n```latex\n".length);

  const selectedCodeRes = wrapMarkdownSyntax("echo ok", 0, 7, "codeblock");
  assert.equal(
    selectedCodeRes.text.slice(selectedCodeRes.selectionStart, selectedCodeRes.selectionEnd),
    "echo ok",
  );

  const selectedMathRes = wrapMarkdownSyntax("x^2", 0, 3, "math");
  assert.equal(
    selectedMathRes.text.slice(selectedMathRes.selectionStart, selectedMathRes.selectionEnd),
    "x^2",
  );

  const bulletRes = wrapMarkdownSyntax("one\ntwo", 0, 7, "bullet");
  assert.equal(bulletRes.text, "\n- one\n- two\n");
  assert.equal(
    bulletRes.text.slice(bulletRes.selectionStart, bulletRes.selectionEnd),
    "one\n- two",
  );

  const numberRes = wrapMarkdownSyntax("one\ntwo", 0, 7, "number");
  assert.equal(numberRes.text, "\n1. one\n2. two\n");
  assert.equal(
    numberRes.text.slice(numberRes.selectionStart, numberRes.selectionEnd),
    "one\n2. two",
  );

  const taskRes = wrapMarkdownSyntax("one\ntwo", 0, 7, "task");
  assert.equal(taskRes.text, "\n- [ ] one\n- [ ] two\n");
  assert.equal(
    taskRes.text.slice(taskRes.selectionStart, taskRes.selectionEnd),
    "one\n- [ ] two",
  );

  const quoteRes = wrapMarkdownSyntax("one\n\ntwo", 0, 8, "quote");
  assert.equal(quoteRes.text, "\n> one\n>\n> two\n");
  assert.equal(
    quoteRes.text.slice(quoteRes.selectionStart, quoteRes.selectionEnd),
    "one\n>\n> two",
  );

  const trailingNewlineQuoteRes = wrapMarkdownSyntax("one\ntwo\nthree", 0, 8, "quote");
  assert.equal(trailingNewlineQuoteRes.text, "\n> one\n> two\n>\nthree");
  assert.equal(
    trailingNewlineQuoteRes.text.slice(
      trailingNewlineQuoteRes.selectionStart,
      trailingNewlineQuoteRes.selectionEnd,
    ),
    "one\n> two",
  );

  const leadingNewlineQuoteRes = wrapMarkdownSyntax("\none", 0, 4, "quote");
  assert.equal(leadingNewlineQuoteRes.text, "\n>\n> one\n");
  assert.equal(
    leadingNewlineQuoteRes.text.slice(
      leadingNewlineQuoteRes.selectionStart,
      leadingNewlineQuoteRes.selectionEnd,
    ),
    "one",
  );

  const newlineOnlyQuoteRes = wrapMarkdownSyntax("\n", 0, 1, "quote");
  assert.equal(newlineOnlyQuoteRes.text, "\n> Quote\n");
  assert.equal(
    newlineOnlyQuoteRes.text.slice(newlineOnlyQuoteRes.selectionStart, newlineOnlyQuoteRes.selectionEnd),
    "Quote",
  );

  const trailingNewlineBulletRes = wrapMarkdownSyntax("one\ntwo\nthree", 0, 8, "bullet");
  assert.equal(trailingNewlineBulletRes.text, "\n- one\n- two\n\nthree");
  assert.equal(
    trailingNewlineBulletRes.text.slice(
      trailingNewlineBulletRes.selectionStart,
      trailingNewlineBulletRes.selectionEnd,
    ),
    "one\n- two",
  );
  assert.doesNotMatch(
    wrapMarkdownSyntax("one\ntwo\nthree", 0, 8, "number").text,
    /^3\.\s*$/m,
  );
  assert.doesNotMatch(
    wrapMarkdownSyntax("one\ntwo\nthree", 0, 8, "task").text,
    /^- \[ \]\s*$/m,
  );

  const blankLinesNumberRes = wrapMarkdownSyntax("one\n\ntwo\n\n\nthree", 0, 11, "number");
  assert.equal(blankLinesNumberRes.text, "\n1. one\n\n2. two\n\n\n\nthree");
  assert.equal(
    blankLinesNumberRes.text.slice(
      blankLinesNumberRes.selectionStart,
      blankLinesNumberRes.selectionEnd,
    ),
    "one\n\n2. two",
  );

  for (const action of ["bullet", "number", "task"] as const) {
    const newlineOnlyRes = wrapMarkdownSyntax("\n", 0, 1, action);
    const expected = action === "bullet" ? "- List item" : action === "number" ? "1. List item" : "- [ ] Task";
    assert.equal(newlineOnlyRes.text, `\n${expected}\n`);
    assert.equal(
      newlineOnlyRes.text.slice(newlineOnlyRes.selectionStart, newlineOnlyRes.selectionEnd),
      action === "task" ? "Task" : "List item",
    );
  }
});

test("formatMarkdownListSelection prefixes every non-empty selected line", () => {
  assert.equal(formatMarkdownListSelection("one\ntwo", "bullet"), "- one\n- two");
  assert.equal(formatMarkdownListSelection("one\n\ntwo", "number"), "1. one\n\n2. two");
  assert.equal(formatMarkdownListSelection("one\ntwo", "task"), "- [ ] one\n- [ ] two");
});

test("formatMarkdownQuoteSelection prefixes every selected line", () => {
  assert.equal(formatMarkdownQuoteSelection("one\n\ntwo"), "> one\n>\n> two");
});

test("note mention index preserves search fields, entity identity and edited snapshots", () => {
  const notes = [
    { id: "a", title: "Same", content: "Alpha body", group: "Production", tags: ["API"], createdAt: 1, updatedAt: 1 },
    { id: "b", title: "Same", content: "Beta body", createdAt: 1, updatedAt: 1 },
  ];
  const search = createVaultNoteSearchIndex(notes);
  for (const query of ["", " SAME ", "ALPHA", "beta", "production", "api", "missing", "same alpha"]) {
    assert.deepEqual(search(query), notes.filter((note) => matchesVaultNoteSearch(note, query)));
  }
  assert.equal(search("beta")[0], notes[1]);
  const edited = [{ ...notes[0], content: "Replacement" }, notes[1]];
  assert.deepEqual(createVaultNoteSearchIndex(edited)("alpha"), []);
  assert.equal(createVaultNoteSearchIndex(edited)("replacement")[0], edited[0]);
});
