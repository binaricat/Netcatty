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
function archiveAction(children: React.ReactNode) {
  return React.Children.toArray(children).find((child): child is MenuItem =>
    React.isValidElement<{ children?: React.ReactNode }>(child)
    && React.Children.toArray(child.props.children).includes("sftp.archive.action"),
  );
}

const folder: SftpFileEntry = { name: "assets", type: "directory", size: 0, sizeFormatted: "0 B", lastModified: 0, lastModifiedFormatted: "" };
const file: SftpFileEntry = { name: "config.json", type: "file", size: 1, sizeFormatted: "1 B", lastModified: 0, lastModifiedFormatted: "" };

test("list archive menu includes files and folders and respects the clicked selection", async (t) => {
  const dom = installDomEnvironment();
  const noop = () => {};
  const captured: string[][] = [];
  let props: React.ComponentProps<typeof SftpPaneFileList> = {
    t: (key) => key,
    pane: {
      ...createEmptyPane("pane-archive"),
      connection: { id: "conn", hostId: "host", hostLabel: "Host", isLocal: false, status: "connected", currentPath: "/srv/site" },
      selectedFiles: new Set([folder.name, file.name]), files: [folder, file],
    },
    side: "left", isPaneFocused: true,
    sorting: {
      sortField: "name", sortOrder: "asc", directoriesFirst: true,
      columnWidths: { name: 50, modified: 24, size: 7, type: 9, owner: 10 },
      visibleColumns: { name: true, modified: true, size: true, type: true, owner: true },
      handleSort: noop, handleResizeStart: noop, toggleColumnVisibility: noop, toggleDirectoriesFirst: noop,
    },
    fileListRef: { current: null }, handleFileListScroll: noop,
    shouldVirtualize: false, totalHeight: 0, sortedDisplayFiles: [folder, file],
    isDragOverPane: false, draggedFiles: null, onRefresh: noop, onNavigateTo: noop, onClearSelection: noop,
    setShowNewFolderDialog: noop, setShowNewFileDialog: noop, getNextUntitledName: () => "", setNewFileName: noop, setFileNameError: noop,
    dragOverEntry: null, handleRowSelect: noop, handleRowOpen: noop, handleFileDragStart: noop,
    onDragEnd: noop, handleEntryDragOver: noop, handleRowDragLeave: noop, handleEntryDrop: noop,
    onCopyToOtherPane: noop, onMoveEntriesToPath: async () => {}, openRenameDialog: noop, openDeleteConfirm: noop,
    onCreateArchive: (paths) => { captured.push(paths); }, rowHeight: 28, visibleRows: [],
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
    .map((menu) => archiveAction(menu.props.children)).filter((item): item is MenuItem => !!item);
  assert.equal(actions().length, 2, "both a folder and a file offer compression");
  actions()[0].props.onClick();
  assert.deepEqual(captured, [["/srv/site/assets", "/srv/site/config.json"]]);
  props = { ...props, pane: { ...props.pane, selectedFiles: new Set([folder.name]) } };
  await act(async () => { renderer.update(render()); });
  actions()[1].props.onClick();
  assert.deepEqual(captured[1], ["/srv/site/config.json"], "right-clicking an unselected item does not include the previous selection");
  props = { ...props, isLocal: true, pane: { ...props.pane, connection: { ...props.pane.connection!, isLocal: true } } };
  await act(async () => { renderer.update(render()); });
  assert.equal(actions().length, 0, "remote archive commands are not exposed on a local pane");
});

test("tree archive menu passes full paths for nested multiselection and hides local and parent entries", async (t) => {
  const captured: string[][] = [];
  const selected = new Set(["/srv/site/assets", "/srv/site/assets/logo.png", "/srv/config.json"]);
  const emptyRef = { current: undefined };
  let props: Parameters<typeof useSftpPaneTreeContextMenu>[0] = {
    contextTarget: { entry: folder, entryPath: "/srv/site/assets" },
    pane: { connection: { id: "conn", isLocal: false } },
    tRef: { current: (key: string) => key },
    onOpenFileWithSystemDefaultRef: emptyRef, onOpenFileWithRef: emptyRef,
    onEditFileRef: emptyRef, onDownloadFileRef: emptyRef,
    onExtractArchiveRef: emptyRef, onEditPermissionsRef: emptyRef,
    onCreateArchiveRef: { current: (paths: string[]) => { captured.push(paths); } },
    getActionPaths: (path: string) => selected.has(path) ? [...selected] : [path],
  };
  let menu: React.ReactNode;
  function Probe() {
    menu = useSftpPaneTreeContextMenu(props);
    return null;
  }
  let renderer!: ReactTestRenderer;
  await act(async () => { renderer = create(React.createElement(Probe)); });
  t.after(async () => { await act(async () => { renderer.unmount(); }); });
  const action = () => archiveAction((menu as React.ReactElement<{ children: React.ReactNode }>).props.children);
  assert.ok(action());
  action()!.props.onClick();
  assert.deepEqual(captured[0], [...selected]);
  props = { ...props, contextTarget: { entry: file, entryPath: "/srv/unselected.json" } };
  await act(async () => { renderer.update(React.createElement(Probe)); });
  action()!.props.onClick();
  assert.deepEqual(captured[1], ["/srv/unselected.json"]);
  props = { ...props, pane: { connection: { id: "local", isLocal: true } } };
  await act(async () => { renderer.update(React.createElement(Probe)); });
  assert.equal(action(), undefined);
  props = { ...props, pane: { connection: { id: "conn", isLocal: false } }, contextTarget: { entry: { ...folder, name: ".." }, entryPath: "/srv" } };
  await act(async () => { renderer.update(React.createElement(Probe)); });
  assert.equal(action(), undefined);
});
