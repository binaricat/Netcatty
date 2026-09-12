import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  buildScriptsSidePanelRows,
  collectScriptsSidePanelPackagePaths,
} from "./ScriptsSidePanel.tsx";
import type { Snippet } from "../types";

const snippet = (overrides: Partial<Snippet>): Snippet => ({
  id: overrides.id ?? "snippet",
  label: overrides.label ?? "Snippet",
  command: overrides.command ?? "echo ok",
  package: overrides.package ?? "",
  order: overrides.order,
});

const source = readFileSync(new URL("./ScriptsSidePanel.tsx", import.meta.url), "utf8");

test("scripts side panel rows keep manual snippet order inside a package", () => {
  const rows = buildScriptsSidePanelRows({
    snippets: [
      snippet({ id: "alpha", label: "Alpha", package: "ops", order: 3000 }),
      snippet({ id: "zulu", label: "Zulu", package: "ops", order: 1000 }),
      snippet({ id: "beta", label: "Beta", package: "ops", order: 2000 }),
    ],
    packages: ["ops"],
    expandedPaths: new Set(["ops"]),
  });

  assert.deepEqual(
    rows.filter((row) => row.type === "snippet").map((row) => row.id),
    ["zulu", "beta", "alpha"],
  );
});

test("scripts side panel active tabs pair the accent background with its foreground", () => {
  assert.equal(source.match(/bg-accent text-accent-foreground/g)?.length, 2);
});

test("scripts side panel offers run-on-all-tabs for every snippet, not only automation scripts", () => {
  // Guard against re-introducing the isScriptSnippet gate on workspace run actions.
  assert.doesNotMatch(
    source,
    /onRunParallel=\{isScriptSnippet\(item\.row\.snippet\) && onRunScriptOnWorkspace/,
  );
  assert.match(source, /onRunParallel=\{onRunScriptOnWorkspace/);
  // Sequential remains script-only (mode is meaningful only for automation runs).
  assert.match(source, /onRunSequential=\{isScript && onRunScriptOnWorkspace/);
  assert.match(source, /scripts\.actions\.runOnAllTabs/);
  assert.match(source, /snippets\.action\.newPackage/);
  assert.match(source, /openPackageDialog/);
});

test("scripts side panel exposes create actions as inline toolbar icons", () => {
  assert.match(source, /snippets\.action\.newSnippet/);
  assert.match(source, /snippets\.action\.newPackage/);
  assert.match(source, /snippets\.action\.newScript/);
  assert.match(source, /openPackageDialog/);
  assert.match(source, /handleAddScript/);
  assert.doesNotMatch(source, /ChevronDown/);
  assert.doesNotMatch(source, /DropdownTrigger/);
});

test("collectScriptsSidePanelPackagePaths includes implied ancestors", () => {
  assert.deepEqual(
    collectScriptsSidePanelPackagePaths(["ops/linux"], [
      snippet({ id: "a", package: "ops/linux/disk" }),
      snippet({ id: "b", package: "" }),
    ]).sort(),
    ["ops", "ops/linux", "ops/linux/disk"],
  );
});

test("scripts side panel search is icon-toggled and expands below the toolbar", () => {
  assert.match(source, /searchExpanded/);
  assert.match(source, /setSearchExpanded/);
  assert.match(source, /max-h-0 opacity-0/);
  assert.match(source, /snippets\.searchPlaceholder/);
});

test("scripts side panel shows delete in a selection bar only when snippets are selected", () => {
  assert.match(source, /selectedSnippetIds\.size > 0/);
  assert.match(source, /snippets\.selection\.selected[\s\S]*?deleteSelectedSnippets/);
  assert.match(source, /snippets\.selection\.deleteSelected/);
  // Trash must not sit between multi-select and add on the permanent icon row.
  assert.doesNotMatch(
    source,
    /snippets\.action\.selectSnippets[\s\S]*?Trash2[\s\S]*?snippets\.action\.newSnippet/,
  );
});

test("scripts side panel toolbar exposes expand and collapse actions", () => {
  assert.match(source, /vault\.tree\.expandAll/);
  assert.match(source, /vault\.tree\.collapseAll/);
  assert.match(source, /expandAllGroups/);
  assert.match(source, /collapseAllGroups/);
  assert.match(source, /isMultiSelectMode/);
});

test("scripts side panel confirms bulk delete and routes it through the shared delete event", () => {
  // Mass-delete must confirm first (SnippetsManager parity) and must not bypass
  // AppSideEffects via onSnippetsChange filtering — that path skips host binding cleanup.
  assert.match(source, /VaultDeleteConfirmDialog/);
  assert.match(source, /snippets\.selection\.deleteConfirmTitle/);
  assert.match(source, /snippets\.selection\.deleteConfirmDesc/);
  assert.match(source, /detail:\s*\{\s*ids\s*\}/);
  assert.doesNotMatch(
    source,
    /onSnippetsChange\(snippets\.filter\(\(snippet\) => !selectedSnippetIds\.has/,
  );
});

test("scripts side panel defers bulk-delete confirm when a parent owns the dialog", () => {
  // Compact TerminalToolbar nests this panel in a Popover; the portalled confirm
  // must be owned outside that tree so focus cannot unmount the prompt.
  assert.match(source, /onBulkDeleteRequest\?:/);
  assert.match(source, /if\s*\(\s*onBulkDeleteRequest\s*\)\s*\{/);
  assert.match(source, /onBulkDeleteRequest\(ids\)/);
  assert.match(source, /!onBulkDeleteRequest/);
});

test("scripts side panel clears pending bulk delete when the panel hides", () => {
  // Returning null while isVisible is false unmounts the confirm dialog; drop
  // pending deletes so a later re-show does not resurrect a half-dismissed prompt.
  assert.match(
    source,
    /if\s*\(\s*isVisible\s*\)\s*return/,
  );
  assert.match(source, /setIsPackageDialogOpen\(\s*false\s*\)/);
  assert.match(source, /setRenamingPackagePath\(\s*''\s*\)/);
  assert.match(source, /setNewPackageName\(\s*''\s*\)/);
});

test("scripts side panel package dialog traps focus and exposes dialog close contract", () => {
  assert.match(source, /packageDialogRef/);
  assert.match(source, /data-dialog-close="true"/);
  assert.match(source, /isPackageDialogOpen/);
});

test("scripts side panel package rows wrap in a rename and delete context menu", () => {
  assert.match(source, /const PackageRow = memo/);
  assert.match(
    source,
    /data-pkg-path=\{row\.path\}[\s\S]*?<ContextMenu>[\s\S]*?<ContextMenuTrigger asChild>[\s\S]*?\{rowButton\}/,
  );
  assert.match(source, /common\.rename/);
  assert.match(source, /vault\.deleteConfirm\.packageDesc/);
  assert.match(source, /deleteSnippetPackage/);
  assert.match(source, /renameSnippetPackage/);
  assert.match(source, /SNIPPET_PACKAGE_PATH_CHANGE_EVENT/);
  assert.match(source, /detail: \{ from: renamingPackagePath, to: result\.newPath \}/);
  assert.match(source, /detail: \{ from: path, to: null \}/);
  assert.match(source, /openRenamePackageDialog/);
  assert.match(source, /requestDeletePackage/);
});

test("scripts side panel does not start a drag from a non-primary pointer", () => {
  assert.match(source, /from '\.\/ui\/primaryOnlyDrag'/);
  assert.match(source, /isNonPrimaryPointer/);
  assert.match(source, /primaryOnlyDragHandlers/);
});
