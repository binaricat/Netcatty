/** @test issue #4132 — the tree's ".." row must not be offered as a Duplicate target */
import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { TreeNode } from "./SftpPaneTreeNode.tsx";
import { installDomEnvironment, createDomRenderer } from "../test-support/renderReactDom";
import { isSftpTreeParentEntry } from "./useSftpPaneTreeContextMenu.tsx";

test("only the synthetic parent row is treated as a navigation entry", () => {
  assert.equal(isSftpTreeParentEntry({ name: ".." }), true);
  assert.equal(isSftpTreeParentEntry({ name: "." }), false);
  assert.equal(isSftpTreeParentEntry({ name: "docs" }), false);
  assert.equal(isSftpTreeParentEntry({ name: "..hidden" }), false);
});

test("parent navigation cannot reopen the previous entry's shared context menu", async () => {
  const dom = installDomEnvironment();
  const renderer = await createDomRenderer(dom.document);
  const openedTargets: string[] = [];
  let contextTarget = "";
  const noop = () => {};
  const renderRow = async (name: string) => {
    const props: React.ComponentProps<typeof TreeNode> = {
      entry: { name, type: "directory", size: 0, sizeFormatted: "--", lastModified: 0, lastModifiedFormatted: "--" },
      entryPath: `/root/${name}`, depth: 0, columnTemplate: "1fr",
      visibleColumns: { name: true, modified: false, size: false, type: false, owner: false },
      isSelected: false, isExpanded: false, isLoading: false, isDragOver: false,
      onToggleExpand: noop, onNodeClick: noop, onOpenEntry: noop,
      onDragStart: noop, onDragEnd: noop, onDragOverEntry: noop, onDropEntry: noop, onDragLeaveEntry: noop,
      onContextMenu: item => { contextTarget = item.name; },
    };
    await renderer.render(React.createElement("div", {
      onContextMenu: () => { openedTargets.push(contextTarget); },
    }, React.createElement(TreeNode, props)));
    const event = new dom.window.MouseEvent("contextmenu", { bubbles: true, cancelable: true });
    await act(async () => {
      renderer.container.querySelector('[data-entry-name]')!.dispatchEvent(event);
    });
    return event;
  };
  try {
    await renderRow("photos");
    assert.deepEqual(openedTargets, ["photos"]);
    const parentEvent = await renderRow("..");
    assert.deepEqual(openedTargets, ["photos"], "parent must not reopen the stale photos menu");
    assert.equal(parentEvent.defaultPrevented, true);
    await renderRow("docs");
    assert.deepEqual(openedTargets, ["photos", "docs"], "ordinary entry menus still work");
  } finally {
    await renderer.unmount();
    dom.cleanup();
  }
});
