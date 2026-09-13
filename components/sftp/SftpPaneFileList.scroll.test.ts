import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { SftpPaneFileList } from './SftpPaneFileList';
import { TooltipProvider } from '../ui/tooltip';
import { installDomEnvironment } from '../test-support/renderReactDom';
import { createEmptyPane } from '../../application/state/sftp/types';

const environment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
const previous = environment.IS_REACT_ACT_ENVIRONMENT;
environment.IS_REACT_ACT_ENVIRONMENT = true;
after(() => { environment.IS_REACT_ACT_ENVIRONMENT = previous; });

test('refresh keeps scroll, while explicit sorting and filters reveal the selection', async (t) => {
  const dom = installDomEnvironment();
  t.after(() => dom.cleanup());
  let scrolls = 0;
  const container = { querySelectorAll: () => [{ dataset: { entryName: 'selected' }, scrollIntoView: () => { scrolls += 1; } }] };
  const noop = () => {};
  const selected = { name: 'selected', type: 'file' as const, size: 1, sizeFormatted: '1 B', lastModified: 0, lastModifiedFormatted: '' };
  let props: React.ComponentProps<typeof SftpPaneFileList> = {
    t: (key) => key, pane: { ...createEmptyPane('pane'), connection: { id: 'conn', hostId: 'host', hostLabel: 'Host', isLocal: false, status: 'connected', currentPath: '/browsed' }, selectedFiles: new Set(['selected']), files: [selected] },
    side: 'left', isPaneFocused: true,
    sorting: { sortField: 'name', sortOrder: 'asc', directoriesFirst: true,
      columnWidths: { name: 50, modified: 24, size: 7, type: 9, owner: 10 },
      visibleColumns: { name: true, modified: true, size: true, type: true, owner: true },
      handleSort: noop, handleResizeStart: noop, toggleColumnVisibility: noop, toggleDirectoriesFirst: noop },
    fileListRef: { current: container as unknown as HTMLDivElement },
    handleFileListScroll: noop, shouldVirtualize: false, totalHeight: 0, sortedDisplayFiles: [selected],
    isDragOverPane: false, draggedFiles: null, onRefresh: noop, onNavigateTo: noop, onClearSelection: noop,
    setShowNewFolderDialog: noop, setShowNewFileDialog: noop, getNextUntitledName: () => '', setNewFileName: noop, setFileNameError: noop,
    dragOverEntry: null, handleRowSelect: noop, handleRowOpen: noop, handleFileDragStart: noop,
    onDragEnd: noop, handleEntryDragOver: noop, handleRowDragLeave: noop, handleEntryDrop: noop,
    onCopyToOtherPane: noop, onMoveEntriesToPath: async () => {}, openRenameDialog: noop, openDeleteConfirm: noop,
    rowHeight: 28, visibleRows: [],
  };
  const render = () => React.createElement(TooltipProvider, null, React.createElement(SftpPaneFileList, props));
  let renderer: ReactTestRenderer;
  await act(async () => { renderer = create(render(), { createNodeMock: (element) => element.props['data-section'] === 'terminal-sftp-list' ? container : null }); });
  assert.equal(scrolls, 1);
  props = { ...props, pane: { ...props.pane, files: [...props.pane.files] }, sortedDisplayFiles: [...props.sortedDisplayFiles] };
  await act(async () => { renderer.update(render()); });
  assert.equal(scrolls, 1, 'refresh must not pull the viewport back to the selection');
  props = { ...props, sorting: { ...props.sorting, sortOrder: 'desc' }, sortedDisplayFiles: [...props.sortedDisplayFiles] };
  await act(async () => { renderer.update(render()); });
  assert.equal(scrolls, 2, 'sorting retains the prior reveal-selection behavior');
  props = { ...props, pane: { ...props.pane, filter: 'selected' }, sortedDisplayFiles: [...props.sortedDisplayFiles] };
  await act(async () => { renderer.update(render()); });
  assert.equal(scrolls, 3, 'filter changes retain the prior reveal-selection behavior');
  await act(async () => { renderer.unmount(); });
});
