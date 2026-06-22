import test from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { I18nProvider } from "../../application/i18n/I18nProvider.tsx";
import type { VaultNote } from "../../types.ts";
import { TooltipProvider } from "../ui/tooltip.tsx";
import { NotesManager } from "./NotesManager.tsx";

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
  assert.match(markup, /data-selected="true"/);
});

test("NotesManager exposes shared tree drag targets and context menus", () => {
  const markup = renderNotes();

  assert.match(markup, /data-notes-drop-zone="root"/);
  assert.match(markup, /data-notes-drag-kind="group"/);
  assert.match(markup, /data-notes-drag-kind="note"/);
  assert.match(markup, /data-notes-context-menu="group"/);
  assert.match(markup, /data-notes-context-menu="note"/);
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
