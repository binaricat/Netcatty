import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';
import { collectSidePanelPanes, closeSidePanelPane, type SidePanelLayout } from '../../domain/sidePanelLayout';
import { resolveSessionSidePanelAutoOpen } from '../../domain/terminalSidePanelAutoOpen';

const source = readFileSync(new URL('../TerminalLayer.tsx', import.meta.url), 'utf8');
const start = source.indexOf('const handleCloseSidePanelPane = useCallback(');
const end = source.indexOf('const handleResizeSidePanelSplit =', start);
assert.ok(start > 0 && end > start);
const ast = ts.createSourceFile('TerminalLayer.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const helper = ast.statements.find((node) => ts.isVariableStatement(node)
  && node.declarationList.declarations.some((declaration) => declaration.name.getText(ast) === 'removeMountedSidePanelTabId'));
assert.ok(helper);
const code = ts.transpile(`${helper.getText(ast)};${source.slice(start, end)};handleCloseSidePanelPane;`, { target: ts.ScriptTarget.ES2022 });

function closePane(tool: 'browser' | 'notes') {
  const layout: SidePanelLayout = { focusedPaneId: 'browser-pane', root: {
    type: 'split', id: 'split', direction: 'horizontal', sizes: [0.5, 0.5], children: [
      { type: 'pane', id: 'browser-pane', tool: 'browser' },
      { type: 'pane', id: 'notes-pane', tool: 'notes' },
    ],
  } };
  const layouts = new Map([['terminal', layout]]);
  let mounted = ['terminal', 'other-terminal'];
  const close = vm.runInNewContext(code, {
    useCallback: (callback: unknown) => callback,
    activeTabIdRef: { current: 'terminal' }, sidePanelLayoutsRef: { current: layouts },
    collectSidePanelPanes,
    setMagnifiedPane: () => {},
    closeSidePanelPaneForTab: (tabId: string, paneId: string) => {
      const next = closeSidePanelPane(layouts.get(tabId)!, paneId);
      assert.ok(next);
      layouts.set(tabId, next);
      return false;
    },
    handleCloseSidePanel: () => { throw new Error('the sibling pane must remain open'); },
    setBrowserMountedTabIds: (update: (previous: string[]) => string[]) => { mounted = update(mounted); },
    shouldMarkSftpPaneClosed: () => false,
  }) as (paneId: string) => void;
  close(`${tool}-pane`);
  return { mounted, tools: collectSidePanelPanes(layouts.get('terminal')!.root).map((pane) => pane.tool) };
}

test('closing a browser split pane releases only that terminal browser', () => {
  const result = closePane('browser');
  assert.deepEqual(result.mounted, ['other-terminal']);
  assert.deepEqual(result.tools, ['notes']);
});

test('closing a sibling pane keeps the browser mounted', () => {
  const result = closePane('notes');
  assert.deepEqual(result.mounted, ['terminal', 'other-terminal']);
  assert.deepEqual(result.tools, ['browser']);
});

for (const protocol of ['local', 'ssh']) {
  test(`browser auto-open mounts content for a ${protocol} terminal`, () => {
    const statusStart = source.indexOf('const handleStatusChange = useCallback(');
    const statusEnd = source.indexOf('const handleSessionExit =', statusStart);
    const addHelper = ast.statements.find((node) => ts.isVariableStatement(node)
      && node.declarationList.declarations.some((declaration) => declaration.name.getText(ast) === 'addMountedSidePanelTabId'));
    assert.ok(addHelper && statusStart > 0 && statusEnd > statusStart);
    let mounted: string[] = [];
    let opened = new Map<string, string>();
    const statusCode = ts.transpile(`${addHelper.getText(ast)};${source.slice(statusStart, statusEnd)};handleStatusChange;`, { target: ts.ScriptTarget.ES2022 });
    const statusChange = vm.runInNewContext(statusCode, {
      useCallback: (callback: unknown) => callback,
      onUpdateSessionStatus: () => {},
      setSftpAuthHostBySessionId: () => {},
      sessionsRef: { current: [{ id: 'terminal', protocol }] },
      sidePanelOpenTabsRef: { current: opened },
      sftpHostSourceSessionForTabRef: { current: new Map() },
      lastSidePanelTabRef: { current: new Map() },
      terminalSidePanelAutoOpenRef: { current: true },
      terminalSidePanelAutoOpenTabRef: { current: 'browser' },
      localShellSidePanelAutoOpenRef: { current: true },
      localShellSidePanelAutoOpenTabRef: { current: 'browser' },
      sftpAutoOpenSidebarRef: { current: false },
      resolveSessionSidePanelAutoOpen,
      applyWorkspaceLayoutPresetForSession: () => false,
      setBrowserMountedTabIds: (update: (previous: string[]) => string[]) => { mounted = update(mounted); },
      setSidePanelOpenTabs: (update: (previous: Map<string, string>) => Map<string, string>) => { opened = update(opened); },
    }) as (sessionId: string, status: string) => void;
    statusChange('terminal', 'connected');
    assert.equal(opened.get('terminal'), 'browser');
    assert.deepEqual(Array.from(mounted), ['terminal']);
  });
}

test('host-only browser requests skip hidden and unsupported sessions', () => {
  const requestStart = source.indexOf('useEffect(() => subscribeHostBrowserPanelRequests(');
  const requestEnd = source.indexOf('useEffect(() => {', requestStart);
  assert.ok(requestStart > 0 && requestEnd > requestStart);
  const requestCode = ts.transpile(source.slice(requestStart, requestEnd), { target: ts.ScriptTarget.ES2022 });
  const hidden = { id: 'hidden', hostId: 'host', hiddenFromTabs: true };
  const unsupported = { id: 'telnet', hostId: 'host', protocol: 'telnet' };
  const visible = { id: 'visible', hostId: 'host' };
  for (const sessions of [[hidden, unsupported, visible], [hidden, unsupported]]) {
    let active: string | undefined;
    let mounted: string[] = [];
    let opened = new Map<string, string>();
    vm.runInNewContext(requestCode, {
      useEffect: (callback: () => void) => callback(),
      subscribeHostBrowserPanelRequests: (callback: (request: unknown) => void) => callback({ host: { id: 'host' } }),
      sessionsRef: { current: sessions },
      activeTabStore: { setActiveTabId: (tabId: string) => { active = tabId; } },
      onConnectToHost: () => 'new-visible',
      addMountedSidePanelTabId: (previous: string[], tabId: string) => [...previous, tabId],
      setBrowserMountedTabIds: (update: (previous: string[]) => string[]) => { mounted = update(mounted); },
      setSidePanelOpenTabs: (update: (previous: Map<string, string>) => Map<string, string>) => { opened = update(opened); },
    });
    const expected = sessions.includes(visible) ? 'visible' : 'new-visible';
    assert.deepEqual(mounted, [expected]);
    assert.equal(opened.get(expected), 'browser');
    assert.notEqual(active, 'hidden');
  }
});
