import assert from "node:assert/strict";
import test, { after } from "node:test";
import React from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { createEmptyPane } from "../../application/state/sftp/types";
import type { SftpFileEntry } from "../../types";
import { ContextMenuContent } from "../ui/context-menu";
import { TooltipProvider } from "../ui/tooltip";
import { installDomEnvironment } from "../test-support/renderReactDom";
import { SftpPaneFileList } from "./SftpPaneFileList";
import { useSftpPaneTreeContextMenu } from "./useSftpPaneTreeContextMenu";

const environment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
const previous = environment.IS_REACT_ACT_ENVIRONMENT;
environment.IS_REACT_ACT_ENVIRONMENT = true;
after(() => { environment.IS_REACT_ACT_ENVIRONMENT = previous; });

type MenuItem = React.ReactElement<{ children?: React.ReactNode; onClick: () => void }>;
function findMenuItem(children: React.ReactNode, label: string) {
  return React.Children.toArray(children).find((child): child is MenuItem =>
    React.isValidElement<{ children?: React.ReactNode }>(child)
    && React.Children.toArray(child.props.children).includes(label),
  );
}

const folder: SftpFileEntry = {
  name: "project",
  type: "directory",
  size: 0,
  sizeFormatted: "0 B",
  lastModified: 0,
  lastModifiedFormatted: "",
};
const file: SftpFileEntry = {
  name: "main.rs",
  type: "file",
  size: 120,
  sizeFormatted: "120 B",
  lastModified: 0,
  lastModifiedFormatted: "",
};
const parentEntry: SftpFileEntry = {
  name: "..",
  type: "directory",
  size: 0,
  sizeFormatted: "0 B",
  lastModified: 0,
  lastModifiedFormatted: "",
};

test("SFTP list context menu exposes Open in Zed for remote directories and files, and hides on local panes", async (t) => {
  const dom = installDomEnvironment();
  const noop = () => {};
  const opened: string[] = [];
  const tFn = (key: string, params?: Record<string, unknown>) =>
    key === "sftp.context.openInExternalEditor" ? `Open in ${params?.editor ?? ""}` : key;

  let props: React.ComponentProps<typeof SftpPaneFileList> = {
    t: tFn,
    pane: {
      ...createEmptyPane("pane-ext-editor"),
      connection: { id: "conn", hostId: "host", hostLabel: "Host", isLocal: false, status: "connected", currentPath: "/home/dev" },
      selectedFiles: new Set(),
      files: [folder, file],
    },
    side: "left",
    isPaneFocused: true,
    sorting: {
      sortField: "name",
      sortOrder: "asc",
      directoriesFirst: true,
      columnWidths: { name: 50, modified: 24, size: 7, type: 9, owner: 10 },
      visibleColumns: { name: true, modified: true, size: true, type: true, owner: true },
      handleSort: noop,
      handleResizeStart: noop,
      toggleColumnVisibility: noop,
      toggleDirectoriesFirst: noop,
    },
    fileListRef: { current: null },
    handleFileListScroll: noop,
    shouldVirtualize: false,
    totalHeight: 0,
    sortedDisplayFiles: [folder, file],
    isDragOverPane: false,
    draggedFiles: null,
    onRefresh: noop,
    onNavigateTo: noop,
    onClearSelection: noop,
    setShowNewFolderDialog: noop,
    setShowNewFileDialog: noop,
    getNextUntitledName: () => "",
    setNewFileName: noop,
    setFileNameError: noop,
    dragOverEntry: null,
    handleRowSelect: noop,
    handleRowOpen: noop,
    handleFileDragStart: noop,
    onDragEnd: noop,
    handleEntryDragOver: noop,
    handleRowDragLeave: noop,
    handleEntryDrop: noop,
    onCopyToOtherPane: noop,
    onMoveEntriesToPath: async () => {},
    openRenameDialog: noop,
    openDeleteConfirm: noop,
    onOpenInExternalEditor: (entry) => opened.push(entry.name),
    externalEditorLabel: "Zed",
    rowHeight: 28,
    visibleRows: [],
  };

  const render = () => React.createElement(TooltipProvider, null, React.createElement(SftpPaneFileList, props));
  let renderer!: ReactTestRenderer;
  await act(async () => { renderer = create(render()); });
  t.after(async () => {
    await act(async () => { renderer.unmount(); });
    dom.cleanup();
    environment.IS_REACT_ACT_ENVIRONMENT = true;
  });

  const actions = () => renderer.root.findAllByType(ContextMenuContent)
    .map((menu) => findMenuItem(menu.props.children, "Open in Zed"))
    .filter((item): item is MenuItem => !!item);

  assert.equal(actions().length, 2, "both remote directory and remote file should show Open in Zed");
  actions()[0].props.onClick();
  actions()[1].props.onClick();
  assert.deepEqual(opened, ["project", "main.rs"]);

  // Local pane must not show remote external editor action.
  props = { ...props, isLocal: true, pane: { ...props.pane, connection: { ...props.pane.connection!, isLocal: true } } };
  await act(async () => { renderer.update(render()); });
  assert.equal(actions().length, 0, "local pane should not expose remote external editor action");
});

test("SFTP tree context menu exposes Open in Zed for remote entries and hides on parent entry or local pane", async (t) => {
  const opened: Array<{ name: string; path: string }> = [];
  const emptyRef = { current: undefined };
  const tFn = (key: string, params?: Record<string, unknown>) =>
    key === "sftp.context.openInExternalEditor" ? `Open in ${params?.editor ?? ""}` : key;

  let props: Parameters<typeof useSftpPaneTreeContextMenu>[0] = {
    contextTarget: { entry: folder, entryPath: "/home/dev/project" },
    pane: { connection: { id: "conn", isLocal: false } },
    tRef: { current: tFn },
    onOpenFileWithSystemDefaultRef: emptyRef,
    onOpenFileWithRef: emptyRef,
    onOpenInExternalEditorRef: {
      current: (entry: SftpFileEntry, fullPath: string) => opened.push({ name: entry.name, path: fullPath }),
    },
    externalEditorLabel: "Zed",
    onEditFileRef: emptyRef,
    onDownloadFileRef: emptyRef,
    onDownloadFilesRef: emptyRef,
    entryByPathRef: { current: new Map() },
    onExtractArchiveRef: emptyRef,
    onEditPermissionsRef: emptyRef,
    onDuplicateEntriesRef: emptyRef,
    toTransferSources: () => [],
    onCreateArchiveRef: emptyRef,
    getActionPaths: (p: string) => [p],
  };

  let menu: React.ReactNode;
  function Probe() {
    menu = useSftpPaneTreeContextMenu(props);
    return null;
  }

  let renderer!: ReactTestRenderer;
  await act(async () => { renderer = create(React.createElement(Probe)); });
  t.after(async () => { await act(async () => { renderer.unmount(); }); });

  const action = () => findMenuItem((menu as React.ReactElement<{ children: React.ReactNode }>).props.children, "Open in Zed");
  assert.ok(action(), "remote folder should expose Open in Zed");
  action()!.props.onClick();
  assert.deepEqual(opened, [{ name: "project", path: "/home/dev/project" }]);

  // Remote file
  props = { ...props, contextTarget: { entry: file, entryPath: "/home/dev/project/main.rs" } };
  await act(async () => { renderer.update(React.createElement(Probe)); });
  assert.ok(action(), "remote file should expose Open in Zed");
  action()!.props.onClick();
  assert.deepEqual(opened[1], { name: "main.rs", path: "/home/dev/project/main.rs" });

  // Synthetic parent ".." row
  props = { ...props, contextTarget: { entry: parentEntry, entryPath: "/home/dev" } };
  await act(async () => { renderer.update(React.createElement(Probe)); });
  assert.equal(action(), undefined, "synthetic .. row must not expose Open in Zed");

  // Local pane
  props = { ...props, pane: { connection: { id: "local", isLocal: true } }, contextTarget: { entry: folder, entryPath: "/tmp" } };
  await act(async () => { renderer.update(React.createElement(Probe)); });
  assert.equal(action(), undefined, "local pane must not expose Open in Zed");
});
