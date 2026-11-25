import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';
import { collectSidePanelPanes, closeSidePanelPane, type SidePanelLayout } from '../../domain/sidePanelLayout';
import {
  resolveSessionSidePanelAutoOpen,
  shouldAutoOpenSftpForHost,
} from '../../domain/terminalSidePanelAutoOpen';

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

function createStatusChangeHarness(options: {
  session: { id: string; hostId?: string; protocol?: string; autoOpenSidePanel?: 'sftp'; hostname?: string; username?: string };
  host?: { id: string; deviceType?: 'general' | 'network'; distro?: string; os?: string; autoOpenSftpPanel?: boolean; hostname?: string; username?: string; label?: string };
  terminalAutoOpen?: boolean;
  terminalAutoOpenTab?: string;
  localAutoOpen?: boolean;
  localAutoOpenTab?: string;
  sftpAutoOpenSidebar?: boolean;
  remoteSshVersion?: string;
  hasDefaultLayoutSftpPane?: boolean;
  applyWorkspaceLayoutPresetForSession?: (...args: unknown[]) => boolean;
}) {
  const statusStart = source.indexOf('const handleStatusChange = useCallback(');
  const statusEnd = source.indexOf('const handleSessionExit =', statusStart);
  const addHelper = ast.statements.find((node) => ts.isVariableStatement(node)
    && node.declarationList.declarations.some((declaration) => declaration.name.getText(ast) === 'addMountedSidePanelTabId'));
  assert.ok(addHelper && statusStart > 0 && statusEnd > statusStart);
  let mounted: string[] = [];
  let opened = new Map<string, string>();
  const statusCode = ts.transpile(`${addHelper.getText(ast)};${source.slice(statusStart, statusEnd)};handleStatusChange;`, { target: ts.ScriptTarget.ES2022 });
  const sessionHostsMap = new Map<string, unknown>();
  if (options.host) {
    sessionHostsMap.set(options.session.id, options.host);
  }
  const statusChange = vm.runInNewContext(statusCode, {
    useCallback: (callback: unknown) => callback,
    onUpdateSessionStatus: () => {},
    setSftpAuthHostBySessionId: () => {},
    sessionsRef: { current: [options.session] },
    sessionHostsMapRef: { current: sessionHostsMap },
    hostsRef: { current: options.host ? [options.host] : [] },
    sidePanelAutoOpenGenRef: { current: new Map() },
    sidePanelOpenTabsRef: { current: opened },
    sftpHostSourceSessionForTabRef: { current: new Map() },
    sftpPaneClosedTabIdsRef: { current: new Set() },
    lastSidePanelTabRef: { current: new Map() },
    terminalSidePanelAutoOpenRef: { current: options.terminalAutoOpen ?? false },
    terminalSidePanelAutoOpenTabRef: { current: options.terminalAutoOpenTab ?? 'scripts' },
    localShellSidePanelAutoOpenRef: { current: options.localAutoOpen ?? false },
    localShellSidePanelAutoOpenTabRef: { current: options.localAutoOpenTab ?? 'scripts' },
    sftpAutoOpenSidebarRef: { current: options.sftpAutoOpenSidebar ?? false },
    resolveSessionSidePanelAutoOpen,
    shouldAutoOpenSftpForHost,
    hasDefaultLayoutSftpPane: () => options.hasDefaultLayoutSftpPane ?? false,
    applyWorkspaceLayoutPresetForSession: options.applyWorkspaceLayoutPresetForSession ?? (() => false),
    terminalBackend: options.remoteSshVersion !== undefined
      ? {
        getSessionRemoteInfo: async () => ({
          success: true,
          remoteSshVersion: options.remoteSshVersion,
        }),
      }
      : {},
    setSftpHostSourceSessionForTab: () => {},
    setSftpHostForTab: () => {},
    setBrowserMountedTabIds: (update: (previous: string[]) => string[]) => { mounted = update(mounted); },
    selectSidePanelToolForTab: (tabId: string, tool: string) => { opened = new Map(opened).set(tabId, tool); },
  }) as (sessionId: string, status: string) => void;
  return {
    statusChange,
    getOpened: () => opened,
    getMounted: () => mounted,
  };
}

for (const protocol of ['local', 'ssh']) {
  test(`browser auto-open mounts content for a ${protocol} terminal`, () => {
    const harness = createStatusChangeHarness({
      session: { id: 'terminal', protocol },
      terminalAutoOpen: true,
      terminalAutoOpenTab: 'browser',
      localAutoOpen: true,
      localAutoOpenTab: 'browser',
      sftpAutoOpenSidebar: false,
    });
    harness.statusChange('terminal', 'connected');
    assert.equal(harness.getOpened().get('terminal'), 'browser');
    assert.deepEqual(Array.from(harness.getMounted()), ['terminal']);
  });
}

test('SFTP auto-open skips network devices by default but keeps regular hosts and explicit opt-in', async () => {
  const linux = createStatusChangeHarness({
    session: { id: 'linux-1', hostId: 'h-linux', protocol: 'ssh', hostname: '10.0.0.1', username: 'root' },
    host: { id: 'h-linux', os: 'linux', distro: 'ubuntu', hostname: '10.0.0.1', username: 'root', label: 'Linux' },
    sftpAutoOpenSidebar: true,
    remoteSshVersion: 'SSH-2.0-OpenSSH_9.6',
  });
  linux.statusChange('linux-1', 'connected');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(linux.getOpened().get('linux-1'), 'sftp');

  const networkMode = createStatusChangeHarness({
    session: { id: 'sw-1', hostId: 'h-sw', protocol: 'ssh', hostname: '10.0.0.2', username: 'admin' },
    host: { id: 'h-sw', deviceType: 'network', os: 'linux', hostname: '10.0.0.2', username: 'admin', label: 'Switch' },
    sftpAutoOpenSidebar: true,
  });
  networkMode.statusChange('sw-1', 'connected');
  assert.equal(networkMode.getOpened().has('sw-1'), false);

  const detectedVendorDistro = createStatusChangeHarness({
    session: { id: 'sw-2', hostId: 'h-hw', protocol: 'ssh', hostname: '10.0.0.3', username: 'admin' },
    host: { id: 'h-hw', distro: 'huawei', os: 'linux', hostname: '10.0.0.3', username: 'admin', label: 'Huawei' },
    terminalAutoOpen: true,
    terminalAutoOpenTab: 'sftp',
    sftpAutoOpenSidebar: true,
  });
  detectedVendorDistro.statusChange('sw-2', 'connected');
  assert.equal(detectedVendorDistro.getOpened().has('sw-2'), false);

  const firstConnectCiscoBanner = createStatusChangeHarness({
    session: { id: 'sw-3', hostId: 'h-cisco', protocol: 'ssh', hostname: '10.0.0.4', username: 'admin' },
    host: { id: 'h-cisco', os: 'linux', hostname: '10.0.0.4', username: 'admin', label: 'New Switch' },
    sftpAutoOpenSidebar: true,
    remoteSshVersion: 'SSH-2.0-Cisco-1.25',
  });
  firstConnectCiscoBanner.statusChange('sw-3', 'connected');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(firstConnectCiscoBanner.getOpened().has('sw-3'), false);

  const explicitNetworkOptIn = createStatusChangeHarness({
    session: { id: 'sw-4', hostId: 'h-optin', protocol: 'ssh', hostname: '10.0.0.5', username: 'admin' },
    host: { id: 'h-optin', deviceType: 'network', autoOpenSftpPanel: true, hostname: '10.0.0.5', username: 'admin', label: 'Opt-in Switch' },
    sftpAutoOpenSidebar: false,
  });
  explicitNetworkOptIn.statusChange('sw-4', 'connected');
  assert.equal(explicitNetworkOptIn.getOpened().get('sw-4'), 'sftp');

  // Disconnecting while banner lookup is in flight cancels stale SFTP auto-open
  const disconnectedDuringLookup = createStatusChangeHarness({
    session: { id: 'linux-disc', hostId: 'h-linux', protocol: 'ssh', hostname: '10.0.0.6', username: 'root' },
    host: { id: 'h-linux', os: 'linux', distro: 'ubuntu', hostname: '10.0.0.6', username: 'root', label: 'Linux' },
    sftpAutoOpenSidebar: true,
    remoteSshVersion: 'SSH-2.0-OpenSSH_9.6',
  });
  disconnectedDuringLookup.statusChange('linux-disc', 'connected');
  disconnectedDuringLookup.statusChange('linux-disc', 'disconnected');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(disconnectedDuringLookup.getOpened().has('linux-disc'), false);
});

test('manual SFTP context-menu trigger stays available for network devices in TerminalView', () => {
  const terminalViewSource = readFileSync(new URL('../terminal/TerminalView.tsx', import.meta.url), 'utf8');
  assert.match(
    terminalViewSource,
    /onOpenSftp=\{status === "connected" && !isSerialConnection && !host\?\.id\?\.startsWith\("serial-"\) && !isPluginHostProtocol\(host\?\.protocol\) \? ctx\.handleOpenSFTP : undefined\}/,
  );
});

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
      selectSidePanelToolForTab: (tabId: string, tool: string) => { opened = new Map(opened).set(tabId, tool); },
    });
    const expected = sessions.includes(visible) ? 'visible' : 'new-visible';
    assert.deepEqual(mounted, [expected]);
    assert.equal(opened.get(expected), 'browser');
    assert.notEqual(active, 'hidden');
  }
});
