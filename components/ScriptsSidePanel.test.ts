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

test("scripts side panel add control is a split button with secondary create actions", () => {
  assert.match(source, /ChevronDown/);
  assert.match(source, /snippets\.action\.newScript/);
  assert.match(source, /snippets\.action\.newSnippet/);
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

test("scripts side panel toolbar exposes expand, collapse, and delete-selected actions", () => {
  assert.match(source, /vault\.tree\.expandAll/);
  assert.match(source, /vault\.tree\.collapseAll/);
  assert.match(source, /snippets\.selection\.deleteSelected/);
  assert.match(source, /expandAllGroups/);
  assert.match(source, /collapseAllGroups/);
  assert.match(source, /deleteSelectedSnippets/);
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
    /if\s*\(\s*!isVisible\s*\)\s*setPendingDeleteIds\(\s*null\s*\)/,
  );
});

test("scripts side panel package dialog traps focus and exposes dialog close contract", () => {
  assert.match(source, /packageDialogRef/);
  assert.match(source, /data-dialog-close="true"/);
  assert.match(source, /isPackageDialogOpen/);
});
