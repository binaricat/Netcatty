import test from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { I18nProvider } from "../../application/i18n/I18nProvider.tsx";
import type { VaultNote } from "../../types.ts";
import { TooltipProvider } from "../ui/tooltip.tsx";
import {
  getFallbackNoteSelectionState,
  getNoteActionTargetGroup,
  getNoteGroupSelectionState,
  getNotesGroupDropAction,
  getNoteSelectionState,
  getSelectedVaultNote,
  isNoteFolderTreeSelected,
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
  assert.match(markup, /editable markdown/);
});

test("NotesManager marks selected notebook rows with shared tree state", () => {
  const markup = renderNotes();

  assert.match(markup, /data-vault-tree-row="group"/);
  assert.match(markup, /data-vault-tree-row="item"/);
  assert.equal(markup.match(/data-selected="true"/g)?.length, 1);
  assert.match(markup, /data-vault-tree-row="group"[^>]*data-selected="false"/);
  assert.match(markup, /data-vault-tree-row="item"[^>]*data-selected="true"/);
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
});

test("NotesManager sidebar mode renders list without editor by default", () => {
  const markup = renderNotes([note()], "sidebar");

  assert.match(markup, /Ops/);
  assert.match(markup, /Postgres failover checklist/);
  assert.doesNotMatch(markup, /editable markdown/);
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
  assert.match(markup, /editable markdown/);
  assert.equal(markup.match(/data-selected="true"/g)?.length, 1);
  assert.match(markup, /data-vault-tree-row="group"[^>]*data-selected="false"/);
  assert.match(markup, /data-vault-tree-row="item"[^>]*data-selected="true"[^>]*data-note-id="note-2"/);
});
