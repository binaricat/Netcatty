import test from "node:test";
import assert from "node:assert/strict";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";
import { TreeNode } from "./SftpPaneTreeNode.tsx";

import { getSftpTreeEntryOpenAction } from "./SftpPaneTreeView.tsx";
import type { SftpFileEntry } from "../../types";

const entry = (name: string, type: SftpFileEntry["type"]): SftpFileEntry => ({
  name,
  type,
  size: 0,
  lastModified: 0,
});

test("tree activation enters directories and keeps file opening separate", () => {
  assert.equal(getSftpTreeEntryOpenAction(entry("..", "directory")), "up");
  assert.equal(getSftpTreeEntryOpenAction(entry("docs", "directory")), "navigate");
  assert.equal(getSftpTreeEntryOpenAction(entry("notes.txt", "file")), "open");
});

test("tree double clicks preserve folder, parent, file and arrow actions", async () => {
  const dom = new JSDOM('<div id="root"></div>');
  const keys = ["window", "document", "IS_REACT_ACT_ENVIRONMENT"] as const;
  const originals = keys.map(key => Object.getOwnPropertyDescriptor(globalThis, key));
  Object.defineProperty(globalThis, "window", { configurable: true, value: dom.window });
  Object.defineProperty(globalThis, "document", { configurable: true, value: dom.window.document });
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
  const container = dom.window.document.getElementById("root")!;
  const root = createRoot(container);
  const calls: string[] = [];
  const noop = () => {};
  const render = async (item: SftpFileEntry, isLoading = false) => {
    await act(async () => root.render(React.createElement(TreeNode, {
      entry: item, entryPath: `/root/${item.name}`, depth: 0,
      columnTemplate: "1fr", visibleColumns: { name: true, modified: false, size: false, type: false, owner: false },
      isSelected: false, isExpanded: false, isLoading, isDragOver: false,
      onToggleExpand: () => calls.push("toggle"), onNodeClick: () => calls.push("select"),
      onOpenEntry: () => calls.push("open"), onContextMenu: () => calls.push("menu"),
      onDragStart: noop, onDragEnd: noop, onDragOverEntry: noop, onDropEntry: noop, onDragLeaveEntry: noop,
    })));
    calls.length = 0;
  };
  const doubleClick = async (target: Element) => {
    for (const [type, detail] of [["click", 1], ["click", 2], ["dblclick", 2]] as const) {
      await act(async () => { target.dispatchEvent(new dom.window.MouseEvent(type, { bubbles: true, detail })); });
    }
  };
  try {
    await render(entry("docs", "directory"));
    await doubleClick(container.querySelector('[data-entry-name="docs"]')!);
    assert.deepEqual(calls, ["select", "select", "toggle"]);
    calls.length = 0;
    await doubleClick(container.querySelector('.lucide-chevron-right')!);
    assert.deepEqual(calls, ["toggle", "toggle"]);
    await render(entry("docs", "directory"), true);
    await doubleClick(container.querySelector('.lucide-loader-circle, .lucide-loader-2')!);
    assert.deepEqual(calls, ["select", "select"]);
    for (const item of [entry("..", "directory"), entry("notes.txt", "file")]) {
      await render(item);
      await doubleClick(container.querySelector('[data-section]')!);
      assert.deepEqual(calls, ["select", "select", "open"]);
    }
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
    keys.forEach((key, index) => {
      const descriptor = originals[index];
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    });
  }
});
