import test from "node:test";
import assert from "node:assert/strict";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";
import { TreeNode } from "./SftpPaneTreeNode.tsx";

import { SftpPaneTreeView, getSftpTreeEntryOpenAction } from "./SftpPaneTreeView.tsx";
import type { SftpFileEntry } from "../../types";
import { createEmptyPane } from "../../application/state/sftp/types";
import { sftpTreeSelectionStore } from "../../application/state/sftp/sftpTreeSelectionStore";
import { installDomEnvironment, createDomRenderer } from "../test-support/renderReactDom";

const entry = (name: string, type: SftpFileEntry["type"]): SftpFileEntry => ({
  name,
  type,
  size: 0,
  sizeFormatted: "--",
  lastModified: 0,
  lastModifiedFormatted: "--",
});

test("tree activation enters directories and keeps file opening separate", () => {
  assert.equal(getSftpTreeEntryOpenAction(entry("..", "directory")), "up");
  assert.equal(getSftpTreeEntryOpenAction(entry("docs", "directory")), "navigate");
  assert.equal(getSftpTreeEntryOpenAction(entry("notes.txt", "file")), "open");
});

test("tree double clicks open entries while the chevron only toggles expansion", async () => {
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
      onOpenEntry: (opened, path) => {
        assert.equal(opened, item);
        assert.equal(path, `/root/${item.name}`);
        calls.push("open");
      }, onContextMenu: () => calls.push("menu"),
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
    assert.deepEqual(calls, ["select", "select", "open"]);
    calls.length = 0;
    await doubleClick(container.querySelector('.lucide-chevron-right')!);
    assert.deepEqual(calls, ["toggle", "toggle"]);
    await render(entry("docs", "directory"), true);
    await doubleClick(container.querySelector('.lucide-loader-circle, .lucide-loader-2')!);
    assert.deepEqual(calls, ["select", "select"]);
    for (const item of [
      entry("..", "directory"), entry("notes.txt", "file"),
      { ...entry("linked-docs", "symlink"), linkTarget: "directory" as const },
      { ...entry("linked-file", "symlink"), linkTarget: "file" as const },
    ]) {
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

test("tree view routes double clicks to navigation and preserves selection, expansion and Enter", async () => {
  const dom = installDomEnvironment();
  const previousObserver = Object.getOwnPropertyDescriptor(globalThis, "ResizeObserver");
  Object.defineProperty(globalThis, "ResizeObserver", {
    configurable: true,
    value: class { observe() {} disconnect() {} },
  });
  dom.window.requestAnimationFrame = callback => dom.window.setTimeout(() => callback(0), 0);
  dom.window.cancelAnimationFrame = id => dom.window.clearTimeout(id);
  const renderer = await createDomRenderer(dom.document);
  const noop = () => {};
  const calls: string[] = [];
  const paneId = "tree-activation";
  const directoryLink: SftpFileEntry = { ...entry("linked-docs", "symlink"), linkTarget: "directory" };
  const fileLink: SftpFileEntry = { ...entry("linked-file", "symlink"), linkTarget: "file" };
  const files = [entry("docs", "directory"), entry("notes.txt", "file"), directoryLink, fileLink];
  let props: React.ComponentProps<typeof SftpPaneTreeView> = {
    pane: { ...createEmptyPane(paneId), files,
      connection: { id: "conn", hostId: "host", hostLabel: "Host", isLocal: false, status: "connected", currentPath: "/root" } },
    side: "left", onPrepareSelection: noop,
    onLoadChildren: async path => { calls.push(`load:${path}`); return [entry("nested", "directory")]; },
    onMoveEntriesToPath: async () => {},
    onNavigateUp: () => calls.push("up"),
    onNavigateTo: path => calls.push(`navigate:${path}`),
    onOpenEntry: (item, path) => { assert.equal(item, files.find(file => file.name === item.name)); calls.push(`open:${path}`); },
    onRefresh: noop, onDragStart: noop, onDragEnd: noop, openRenameDialog: noop, openDeleteConfirm: noop,
    onCopyToOtherPane: noop, onReceiveFromOtherPane: noop, draggedFiles: null,
    openNewFolderDialog: noop, openNewFileDialog: noop,
    sorting: { sortField: "name", sortOrder: "asc", directoriesFirst: true,
      columnWidths: { name: 50, modified: 24, size: 7, type: 9, owner: 10 },
      visibleColumns: { name: true, modified: false, size: false, type: false, owner: false },
      handleSort: noop, handleResizeStart: noop, toggleColumnVisibility: noop, toggleDirectoriesFirst: noop },
    reloadRequest: { token: 0 },
  };
  const row = (name: string) => {
    const element = renderer.container.querySelector(`[data-entry-name="${name}"]`);
    assert.ok(element, `missing row ${name}`);
    return element;
  };
  const click = async (target: Element, type = "click", detail = 1, ctrlKey = false) => {
    await act(async () => { target.dispatchEvent(new dom.window.MouseEvent(type, { bubbles: true, detail, ctrlKey })); });
  };
  const doubleClick = async (target: Element) => {
    await click(target);
    await click(target, "click", 2);
    await click(target, "dblclick", 2);
  };
  const enter = async () => {
    await act(async () => { dom.document.activeElement!.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Enter", bubbles: true })); });
  };
  try {
    await renderer.render(React.createElement(SftpPaneTreeView, props));
    await click(row("docs"));
    assert.deepEqual(calls, []);
    assert.equal(row("docs").getAttribute("data-selected"), "true");
    await click(row("notes.txt"), "click", 1, true);
    assert.equal(row("docs").getAttribute("data-selected"), "true");
    assert.equal(row("notes.txt").getAttribute("data-selected"), "true");

    await doubleClick(row("docs").querySelector("span.truncate")!);
    assert.deepEqual(calls.splice(0), ["navigate:/root/docs"]);
    assert.equal(row("docs").getAttribute("data-expanded"), "false");
    assert.equal(row("docs").getAttribute("data-selected"), "true");
    assert.equal(row("notes.txt").getAttribute("data-selected"), "false");

    await click(row("docs").querySelector(".lucide-chevron-right")!);
    assert.deepEqual(calls.splice(0), ["load:/root/docs"]);
    assert.equal(row("docs").getAttribute("data-expanded"), "true");
    row("nested");
    await doubleClick(row("docs").querySelector(".lucide-chevron-right")!);
    assert.deepEqual(calls, []);
    assert.equal(row("docs").getAttribute("data-expanded"), "true");
    assert.equal(row("docs").getAttribute("data-selected"), "true");

    await doubleClick(row("nested"));
    assert.deepEqual(calls.splice(0), ["navigate:/root/docs/nested"]);
    assert.equal(row("docs").getAttribute("data-expanded"), "true");
    await doubleClick(row("docs"));
    assert.deepEqual(calls.splice(0), ["navigate:/root/docs"]);
    assert.equal(row("docs").getAttribute("data-expanded"), "true");
    await enter();
    assert.equal(row("docs").getAttribute("data-expanded"), "false");
    await enter();
    assert.equal(row("docs").getAttribute("data-expanded"), "true");
    assert.deepEqual(calls, []);

    for (const [name, action] of [["notes.txt", "open:/root/notes.txt"], ["linked-docs", "navigate:/root/linked-docs"], ["linked-file", "open:/root/linked-file"], ["..", "up"]]) {
      await doubleClick(row(name));
      assert.deepEqual(calls.splice(0), [action]);
    }
    await click(row("notes.txt"));
    await enter();
    assert.deepEqual(calls.splice(0), ["open:/root/notes.txt"]);

    // The application commits navigation by updating the pane root. Keep its
    // existing reset behavior for cached children, expansion and selection.
    props = { ...props, pane: { ...props.pane, files: [entry("inside", "file")],
      connection: { ...props.pane.connection!, currentPath: "/root/docs" } } };
    await renderer.render(React.createElement(SftpPaneTreeView, props));
    row("inside");
    assert.equal(renderer.container.querySelector('[data-entry-name="nested"]'), null);
    assert.equal(sftpTreeSelectionStore.getPaneState(paneId).selectedPaths.size, 0);
  } finally {
    await renderer.unmount();
    sftpTreeSelectionStore.clearPane(paneId);
    if (previousObserver) Object.defineProperty(globalThis, "ResizeObserver", previousObserver);
    else Reflect.deleteProperty(globalThis, "ResizeObserver");
    dom.cleanup();
  }
});
