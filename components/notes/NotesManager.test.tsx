import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { I18nProvider } from "../../application/i18n/I18nProvider.tsx";
import { readStoredStringValue } from "../../application/state/useStoredString.ts";
import { STORAGE_KEY_VAULT_NOTES_EDITOR_MODE } from "../../infrastructure/config/storageKeys.ts";
import type { VaultNote } from "../../types.ts";
import { TooltipProvider } from "../ui/tooltip.tsx";
import {
  clampNotesTreeWidth,
  getFallbackNoteSelectionState,
  getNoteActionTargetGroup,
  getNoteGroupSelectionState,
  getNotesGroupDropAction,
  getNoteSelectionState,
  getValidatedNoteSelectionState,
  getSelectedVaultNote,
  isNoteFolderTreeSelected,
  isNoteEditorMode,
  normalizeNoteEditorMode,
  NotesManager,
} from "./NotesManager.tsx";

const note = (overrides: Partial<VaultNote> = {}): VaultNote => ({
  id: "note-1",
  title: "Postgres failover checklist",
  content: "# Steps\n\nPromote replica",
  group: "Ops",
  createdAt: 1,
  updatedAt: 1,
  order: 1000,
  ...overrides,
});

const renderNotes = (
  notes: VaultNote[] = [note()],
  displayMode: React.ComponentProps<typeof NotesManager>["displayMode"] = "full",
  noteGroups: string[] = ["Ops"],
  openNoteId: string | null = null,
) => renderToStaticMarkup(
  <I18nProvider locale="en">
    <TooltipProvider>
      <NotesManager
        notes={notes}
        noteGroups={noteGroups}
        hosts={[]}
        onUpdateNotes={() => undefined}
        onUpdateNoteGroups={() => undefined}
        displayMode={displayMode}
        openNoteId={openNoteId}
      />
    </TooltipProvider>
  </I18nProvider>,
);

test("NotesManager renders notes tree and selected markdown editor", () => {
  const markup = renderNotes();

  assert.match(markup, /Ops/);
  assert.match(markup, /Postgres failover checklist/);
  // React.lazy may show Suspense fallback or the resolved editor depending on
  // whether a prior test already settled the MDX chunk.
  assert.ok(
    markup.includes('data-notes-editor-loading="true"')
      || markup.includes("editable markdown")
      || markup.includes("Promote replica"),
    "full mode should mount the note editor (loading fallback or resolved MDX)",
  );
});

test("NotesManager marks selected notebook rows with shared tree state", () => {
  const markup = renderNotes();

  assert.match(markup, /data-vault-tree-row="group"/);
  assert.match(markup, /data-vault-tree-row="item"/);
  assert.equal(markup.match(/data-selected="true"/g)?.length, 1);
  assert.match(markup, /data-vault-tree-row="group"[^>]*data-selected="false"/);
  assert.match(markup, /data-vault-tree-row="item"[^>]*data-selected="true"/);
});

test("NotesManager balances folder and note tree icon sizes", () => {
  const markup = renderNotes();

  assert.match(markup, /width="16" height="16"[^>]*class="lucide lucide-folder/);
  assert.match(markup, /width="16" height="16"[^>]*class="lucide lucide-file-text/);
  assert.match(markup, /<div class="flex shrink-0 items-center[^"]*mr-1">/);
  assert.doesNotMatch(markup, /lucide lucide-file-text[^"]*mr-2/);
});

test("NotesManager gives folder and tag metadata pills the same compact style", () => {
  const markup = renderNotes([note({ tags: ["inspection"] })]);
  const document = new JSDOM(markup).window.document;
  const folderPill = document.querySelector<HTMLElement>('[data-note-metadata-pill="folder"]');
  const tagPill = document.querySelector<HTMLElement>('[data-note-metadata-pill="tag"]');
  const addTagPill = document.querySelector<HTMLElement>('[data-note-metadata-pill="add-tag"]');

  assert.ok(folderPill);
  assert.ok(tagPill);
  assert.ok(addTagPill);
  for (const className of [
    "inline-flex",
    "h-5",
    "items-center",
    "gap-1",
    "rounded-md",
    "bg-muted/70",
    "px-2",
    "text-[11px]",
    "font-medium",
    "leading-none",
  ]) {
    assert.ok(folderPill.classList.contains(className), `folder pill should include ${className}`);
    assert.ok(tagPill.classList.contains(className), `tag pill should include ${className}`);
    assert.ok(addTagPill.classList.contains(className), `add-tag pill should include ${className}`);
  }
  assert.ok(tagPill.classList.contains("text-foreground"));
  assert.ok(addTagPill.classList.contains("text-foreground"));
  assert.equal(tagPill.classList.contains("border"), false);
  assert.equal(tagPill.classList.contains("bg-primary/10"), false);
  assert.equal(folderPill.querySelector("svg")?.classList.contains("-translate-y-px"), false);
  assert.equal(tagPill.querySelector("svg")?.classList.contains("-translate-y-px"), false);
  assert.ok([...folderPill.querySelectorAll("span")].some((node) => node.classList.contains("translate-y-px")));
  assert.ok([...tagPill.querySelectorAll("span")].some((node) => node.classList.contains("translate-y-px")));
  assert.ok([...addTagPill.querySelectorAll("span")].some((node) => node.classList.contains("translate-y-px")));
});

test("NotesManager tree scroll area constrains width so titles can truncate", () => {
  const markup = renderNotes();

  // Radix ScrollArea viewport child is display:table by default; force block +
  // min-w-0 so narrowing the notes sidebar ellipsizes long titles instead of
  // clipping them. React encodes `&` / `>` in class attributes.
  assert.match(
    markup,
    /data-radix-scroll-area-viewport\](?:&gt;|>)div\]:!block/,
  );
  assert.match(
    markup,
    /data-radix-scroll-area-viewport\](?:&gt;|>)div\]:!min-w-0/,
  );
  assert.match(markup, /data-notes-drop-zone="root"/);
  assert.match(markup, /min-h-full min-w-0 space-y-1 overflow-hidden/);
  // Aside stays unclipped so the resize handle's outer half remains hit-testable;
  // truncation is enforced by the inner tree shell + ScrollArea constraints.
  assert.match(markup, /aside class="[^"]*min-w-0[^"]*flex-col bg-background/);
  assert.match(markup, /flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden/);
  assert.match(markup, /role="separator"/);
  assert.match(markup, /translate-x-1\/2 cursor-col-resize/);
});

test("clampNotesTreeWidth keeps the sidebar within the design range", () => {
  assert.equal(clampNotesTreeWidth(100), 160);
  assert.equal(clampNotesTreeWidth(300), 300);
  assert.equal(clampNotesTreeWidth(900), 520);
});

test("normalizeNoteEditorMode migrates the legacy live mode to edit", () => {
  assert.equal(normalizeNoteEditorMode("live"), "edit");
  assert.equal(isNoteEditorMode("live"), false);
  assert.equal(isNoteEditorMode("edit"), true);
  assert.equal(normalizeNoteEditorMode("preview"), "preview");
  assert.equal(normalizeNoteEditorMode("invalid"), null);
});

test("stored legacy live mode falls back to edit on the real read path", (t) => {
  const previousLocalStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (key: string) => key === STORAGE_KEY_VAULT_NOTES_EDITOR_MODE ? "live" : null,
    } as Storage,
  });
  t.after(() => {
    if (previousLocalStorage) {
      Object.defineProperty(globalThis, "localStorage", previousLocalStorage);
    } else {
      Reflect.deleteProperty(globalThis, "localStorage");
    }
  });

  assert.equal(
    readStoredStringValue(STORAGE_KEY_VAULT_NOTES_EDITOR_MODE, "edit", isNoteEditorMode),
    "edit",
  );
});

test("NotesManager selection helpers keep note and folder selection exclusive", () => {
  const notes = [note(), note({ id: "note-2", title: "Deploy", group: "Deploy" })];
  const noteSelection = getNoteSelectionState(notes[0], false);
  const sidebarNoteSelection = getNoteSelectionState(notes[0], true);
  const groupSelection = getNoteGroupSelectionState("Ops");

  assert.equal(getSelectedVaultNote(notes, "note-1")?.title, "Postgres failover checklist");
  assert.equal(getSelectedVaultNote(notes, null), null);
  assert.deepEqual(noteSelection, {
    selectedNoteId: "note-1",
    selectedGroup: null,
    overlayNoteId: null,
  });
  assert.deepEqual(sidebarNoteSelection, {
    selectedNoteId: "note-1",
    selectedGroup: null,
    overlayNoteId: "note-1",
  });
  assert.deepEqual(groupSelection, {
    selectedNoteId: null,
    selectedGroup: "Ops",
    overlayNoteId: null,
  });
  assert.equal(isNoteFolderTreeSelected("Ops", "note-1", "Ops"), false);
  assert.equal(isNoteFolderTreeSelected("Ops", null, "Ops"), true);
  assert.equal(getNoteActionTargetGroup(notes[0], "Deploy"), "Ops");
  assert.equal(getNoteActionTargetGroup(null, "Deploy"), "Deploy");
});

test("NotesManager note creation, duplicate, and delete fallback selections stay exclusive", () => {
  const notes = [
    note(),
    note({ id: "note-2", title: "Deploy", group: "Deploy", order: 2000 }),
  ];
  const createdOrDuplicated = note({ id: "new-note", group: "Ops" });

  assert.deepEqual(getNoteSelectionState(createdOrDuplicated, false), {
    selectedNoteId: "new-note",
    selectedGroup: null,
    overlayNoteId: null,
  });
  assert.deepEqual(getNoteSelectionState(createdOrDuplicated, true), {
    selectedNoteId: "new-note",
    selectedGroup: null,
    overlayNoteId: "new-note",
  });
  assert.deepEqual(getFallbackNoteSelectionState(notes.slice(1), false), {
    selectedNoteId: "note-2",
    selectedGroup: null,
    overlayNoteId: null,
  });
  assert.deepEqual(getFallbackNoteSelectionState(notes.slice(1), true), {
    selectedNoteId: null,
    selectedGroup: null,
    overlayNoteId: null,
  });
});

test("NotesManager selects the first loaded note when full mode has no selection", () => {
  const notes = [
    note({ id: "note-2", title: "Loaded note", group: "Ops", order: 2000 }),
  ];

  assert.deepEqual(getValidatedNoteSelectionState(notes, null, null, false), {
    selectedNoteId: "note-2",
    selectedGroup: null,
    overlayNoteId: null,
  });
  assert.equal(getValidatedNoteSelectionState(notes, null, "Ops", false), null);
  assert.equal(getValidatedNoteSelectionState(notes, null, null, true), null);
});

test("NotesManager group drop helper separates reorder, inside, and ignored drops", () => {
  assert.equal(getNotesGroupDropAction("Ops", "Deploy", "before"), "reorder");
  assert.equal(getNotesGroupDropAction("Ops", "Deploy", "after"), "reorder");
  assert.equal(getNotesGroupDropAction("Ops", "Deploy", "inside"), "inside");
  assert.equal(getNotesGroupDropAction("Ops", "Ops", "before"), "ignore");
  assert.equal(getNotesGroupDropAction("Ops", "Ops/DB", "inside"), "ignore");
  assert.equal(getNotesGroupDropAction(null, "Deploy", "before"), "ignore");
});

test("NotesManager exposes shared tree drag targets and context menus", () => {
  const markup = renderNotes();

  assert.match(markup, /data-notes-drop-zone="root"/);
  assert.match(markup, /data-notes-drag-kind="group"/);
  assert.match(markup, /data-notes-drag-kind="note"/);
  assert.match(markup, /data-notes-context-menu="group"/);
  assert.match(markup, /data-notes-context-menu="note"/);
  assert.match(markup, /draggable="true"/);
  assert.match(markup, /data-open="false"/);
  assert.match(markup, /role="separator"/);
});

test("NotesManager restores and persists the note editor mode without resetting on note switch", () => {
  const source = readFileSync(new URL("./NotesManager.tsx", import.meta.url), "utf8");

  assert.match(source, /STORAGE_KEY_VAULT_NOTES_EDITOR_MODE/);
  assert.match(source, /useStoredString<NoteEditorMode>\(\s*STORAGE_KEY_VAULT_NOTES_EDITOR_MODE,\s*"edit",\s*isNoteEditorMode/s);
  assert.doesNotMatch(source, /localStorageAdapter/);
  assert.doesNotMatch(source, /setNoteEditorMode\("edit"\)/);
});

test("NotesManager renders nested notebook folders", () => {
  const markup = renderNotes([
    note({
      group: "Ops/DB/Failover",
      title: "Replica promotion",
      content: "Promote replica",
    }),
  ]);

  assert.match(markup, /Ops/);
  assert.match(markup, /DB/);
  assert.match(markup, /Failover/);
  assert.match(markup, /Replica promotion/);
});

test("NotesManager keeps saved notebook folder order", () => {
  const markup = renderNotes(
    [
      note({ id: "alpha-note", title: "Alpha note", group: "Alpha" }),
      note({ id: "beta-note", title: "Beta note", group: "Beta" }),
    ],
    "full",
    ["Beta", "Alpha"],
  );

  assert.ok(markup.indexOf("Beta") < markup.indexOf("Alpha"));
});

test("NotesManager renders empty state", () => {
  const markup = renderNotes([]);

  assert.match(markup, /No notes yet/);
  assert.match(markup, /New Note/);
  assert.match(markup, /Import Markdown/);
  assert.doesNotMatch(markup, /data-notes-drop-zone="root"/);
});

test("NotesManager exposes markdown import controls", () => {
  const source = readFileSync(new URL("./NotesManager.tsx", import.meta.url), "utf8");

  assert.match(source, /notes\.action\.importMarkdown/);
  assert.match(source, /importMarkdownPayloadsToVaultNotes/);
  assert.match(source, /accept="\.md,\.markdown,\.txt"/);
  assert.match(source, /importTargetGroupRef/);
  assert.match(source, /openImportMarkdownPicker/);
  assert.match(source, /notes\.action\.importMarkdown[\s\S]*openImportMarkdownPicker\(groupPath\)/);
  assert.match(source, /multiple/);
});

test("NotesManager exposes markdown export controls", () => {
  const source = readFileSync(new URL("./NotesManager.tsx", import.meta.url), "utf8");

  assert.match(source, /notes\.action\.exportNote/);
  assert.match(source, /notes\.action\.exportGroup/);
  assert.match(source, /notes\.action\.exportAll/);
  assert.match(source, /buildVaultNoteMarkdownExportFiles/);
  assert.match(source, /buildTextFilesZipBlob/);
  assert.match(source, /downloadNotesBlob/);
  assert.match(source, /text\/markdown;charset=utf-8/);
});

test("NotesManager shows placeholder label for notes without titles", () => {
  const markup = renderNotes([note({ title: "" })]);

  assert.match(markup, /Note title/);
});

test("NotesManager flushes drafts on pagehide/beforeunload", () => {
  const source = readFileSync(new URL("./NotesManager.tsx", import.meta.url), "utf8");
  assert.match(source, /addEventListener\("pagehide"/);
  assert.match(source, /addEventListener\("beforeunload"/);
  assert.match(source, /flushNoteDraft/);
});

test("NotesManager flushes drafts when retained mounts become inactive", () => {
  const source = readFileSync(new URL("./NotesManager.tsx", import.meta.url), "utf8");
  assert.match(source, /isActive\?: boolean/);
  assert.match(source, /if \(isActive\) return;/);
  assert.match(source, /useLayoutEffect\(\(\) => \{\s*if \(isActive\) return;/);
  assert.match(source, /visibilitychange/);
});

test("NotesManager tree rename allows clearing note titles", () => {
  const source = readFileSync(new URL("./NotesManager.tsx", import.meta.url), "utf8");
  const renameBlock = source.match(/onRenameCommit=\{\(name\) => \{[\s\S]*?\}\}/)?.[0] ?? "";

  assert.match(renameBlock, /renameNoteFromTree\(note\.id, name\)/);
  assert.doesNotMatch(renameBlock, /if \(!title\) return/);
  assert.match(source, /note\.id === noteId \? \{ \.\.\.note, title: nextTitle, updatedAt \}/);
});

test("NotesManager sidebar mode renders list without editor by default", () => {
  const markup = renderNotes([note()], "sidebar");

  assert.match(markup, /Ops/);
  assert.match(markup, /Postgres failover checklist/);
  assert.doesNotMatch(markup, /editable markdown/);
  assert.doesNotMatch(markup, /data-notes-editor-loading="true"/);
});

test("NotesManager sidebar mode opens the requested note without selecting its folder", () => {
  const markup = renderNotes(
    [
      note(),
      note({
        id: "note-2",
        title: "Deploy overlay",
        content: "Deploy overlay content",
        group: "Ops",
        order: 2000,
      }),
    ],
    "sidebar",
    ["Ops"],
    "note-2",
  );

  assert.match(markup, /Deploy overlay/);
  assert.ok(
    markup.includes('data-notes-editor-loading="true"')
      || markup.includes("Deploy overlay content")
      || markup.includes("editable markdown"),
    "openNoteId should mount the sidebar note overlay editor",
  );
  assert.equal(markup.match(/data-selected="true"/g)?.length, 1);
  assert.match(markup, /data-vault-tree-row="group"[^>]*data-selected="false"/);
  assert.match(markup, /data-vault-tree-row="item"[^>]*data-selected="true"[^>]*data-note-id="note-2"/);
});

test("NotesManager can re-open the same sidebar note when the request id changes", () => {
  const source = readFileSync(new URL("./NotesManager.tsx", import.meta.url), "utf8");

  assert.match(source, /openNoteRequestId\?: number \| null/);
  assert.match(source, /\[isSidebarMode, onOpenNoteIdHandled, openNoteId, openNoteRequestId, sortedNotes\]/);
  assert.match(source, /if \(isSidebarMode && overlayNoteView\)/);
  assert.match(source, /\[isSidebarMode, overlayNoteView\]/);
});
