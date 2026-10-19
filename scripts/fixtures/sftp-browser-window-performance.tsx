import React, { Profiler, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { SftpPaneFileList } from '../../components/sftp/SftpPaneFileList';
import { SftpPaneTreeView } from '../../components/sftp/SftpPaneTreeView';
import { useSftpPaneVirtualList } from '../../components/sftp/hooks/useSftpPaneVirtualList';
import { useSftpPaneFiles } from '../../components/sftp/hooks/useSftpPaneFiles';
import { useSftpPaneSorting } from '../../application/state/sftp/useSftpPaneSorting';
import { I18nProvider } from '../../application/i18n/I18nProvider';
import { TooltipProvider } from '../../components/ui/tooltip';
import type { SftpFileEntry } from '../../types';
import type { SftpPane } from '../../application/state/sftp/types';
import type { SftpListDensity } from '../../domain/sftpListDensity';

const query = new URLSearchParams(location.search);
const count = Number(query.get('count') || 5000);
const initiallyHidden = query.has('hidden');
const initiallyTree = query.has('tree');
const file = (name: string): SftpFileEntry => ({ name, type: 'file', size: 1024, sizeFormatted: '1 KB', lastModified: 0, lastModifiedFormatted: '--' });
const files = [{ ...file('folder'), type: 'directory' as const }, ...Array.from({ length: count }, (_, index) => file(`file-${String(index).padStart(6, '0')}.txt`))];
const noop = () => {};
const pane: SftpPane = { id: 'fixture', connection: { id: 'remote', hostId: 'fixture', hostLabel: 'Fixture', isLocal: false, status: 'connected', currentPath: '/fixture' }, files, loading: false, reconnecting: false, error: null, connectionLogs: [], selectedFiles: new Set(), filter: '', filenameEncoding: 'auto', showHiddenFiles: true, transferMutationToken: 0 };
const result = { count, commits: [] as { phase: string; rows: number }[], timings: [] as { phase: string; ms: number }[], selected: '', opened: [] as string[], loads: [] as string[] };
let phase = `${initiallyTree ? 'tree' : 'list'}:first`;
const rows = () => document.querySelectorAll('[data-sftp-row], [data-section="terminal-sftp-tree-row"]').length;
const record = () => result.commits.push({ phase, rows: rows() });
const measure = (name: string, action: () => void) => { phase = name; const started = performance.now(); flushSync(action); result.timings.push({ phase, ms: performance.now() - started }); };
function List({ active, density, selected, select, entries }: { entries: SftpFileEntry[]; active: boolean; density: SftpListDensity; selected: Set<string>; select: (name: string) => void }) {
  const sorting = useSftpPaneSorting();
  const { sortedDisplayFiles } = useSftpPaneFiles({ files: entries, filter: '', connection: pane.connection, showHiddenFiles: true, enableListView: true, ...sorting });
  const virtual = useSftpPaneVirtualList({ isActive: active, sortedDisplayFiles, layoutKey: density });
  return <SftpPaneFileList t={key => key} pane={{ ...pane, files: entries, selectedFiles: selected }} side="left" isPaneFocused={active} sorting={sorting} sortedDisplayFiles={sortedDisplayFiles} listDensity={density} {...virtual}
    isDragOverPane={false} draggedFiles={null} dragOverEntry={null} onRefresh={noop} onNavigateTo={noop} onClearSelection={() => select('')}
    setShowNewFolderDialog={noop} setShowNewFileDialog={noop} getNextUntitledName={() => ''} setNewFileName={noop} setFileNameError={noop}
    handleRowSelect={entry => select(entry.name)} handleRowOpen={entry => result.opened.push(entry.name)} handleFileDragStart={noop} onDragEnd={noop}
    handleEntryDragOver={noop} handleRowDragLeave={noop} handleEntryDrop={noop} onCopyToOtherPane={noop} onMoveEntriesToPath={async () => {}} openRenameDialog={noop} openDeleteConfirm={noop} />;
}
function Tree({ entries }: { entries: SftpFileEntry[] }) {
  const sorting = useSftpPaneSorting();
  return <SftpPaneTreeView pane={{ ...pane, files: entries }} side="left" sorting={sorting} draggedFiles={null} reloadRequest={{ token: 0 }}
    onPrepareSelection={noop} onLoadChildren={async path => { result.loads.push(path); return [file('nested-child.txt')]; }} onMoveEntriesToPath={async () => {}}
    onNavigateUp={noop} onNavigateTo={noop} onRefresh={noop} onOpenEntry={entry => result.opened.push(entry.name)} onDragStart={noop} onDragEnd={noop}
    openRenameDialog={noop} openDeleteConfirm={noop} onCopyToOtherPane={noop} onReceiveFromOtherPane={noop} openNewFolderDialog={noop} openNewFileDialog={noop} />;
}
function App() {
  const [active, setActive] = useState(!initiallyHidden);
  const [tree, setTree] = useState(initiallyTree);
  const [density, setDensity] = useState<SftpListDensity>('comfortable');
  const [entries, setEntries] = useState(files);
  const [selected, setSelected] = useState(new Set<string>());
  const select = (name: string) => { result.selected = name; setSelected(new Set(name ? [name] : [])); };
  return <I18nProvider locale="en"><TooltipProvider><div className="flex h-full w-full flex-col bg-background text-foreground">
    <div className="flex shrink-0 gap-4 p-2"><button id="visibility" onClick={() => measure(`${tree ? 'tree' : 'list'}:${active ? 'hide' : 'restore'}`, () => setActive(!active))}>Hide / restore</button>
      <button id="view" onClick={() => measure('tree:first', () => { setTree(!tree); setActive(true); })}>List / tree</button>
      <button id="density" onClick={() => measure('list:density', () => setDensity(density === 'comfortable' ? 'compact' : 'comfortable'))}>Density</button>
      <button id="shrink" onClick={() => measure(`${tree ? 'tree' : 'list'}:shrink-hidden`, () => setEntries(files.slice(0, tree ? 61 : 101)))}>Refresh smaller listing</button></div>
    <div id="pane" className="min-h-0 flex-1 flex-col" style={{ display: active ? 'flex' : 'none' }}><Profiler id="pane" onRender={record}>
      {tree ? <Tree entries={entries} /> : <List entries={entries} active={active} density={density} selected={selected} select={select} />}
    </Profiler></div>
  </div></TooltipProvider></I18nProvider>;
}
const root = createRoot(document.getElementById('root')!);
measure(phase, () => root.render(<App />));
Object.assign(window, { sftpWindowAudit: result, sftpWindowRows: rows });
