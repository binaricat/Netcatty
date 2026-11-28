import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import React from "react";
import { act, create } from "react-test-renderer";
import { sidePanelLiveStore, SIDE_PANEL_INACTIVE_LIVE_SNAPSHOT } from "../../application/state/sidePanelLiveStore.ts";
import { createEmptyWorkspaceRoot } from "../../domain/workspace.ts";
import { renderToStaticMarkup } from "react-dom/server";

import { TerminalLayerWorkspaceSection } from "./TerminalLayerWorkspaceSection.tsx";

test("terminal pane chrome uses an inner rounded 1px border while retaining overflow clipping", () => {
  const source = readFileSync(new URL("./TerminalLayerSupport.tsx", import.meta.url), "utf8");
  const paneSource = source.slice(source.indexOf('data-section="terminal-split-pane"'), source.indexOf('TerminalPane.displayName'));
  const hostSource = paneSource.slice(0, paneSource.indexOf("<LazyLoadBoundary"));
  const strokeSource = paneSource.slice(paneSource.indexOf("{magnifiedSurfaceBounds && ("));

  assert.match(hostSource, /^\s*magnifiedSurfaceBounds && "overflow-hidden rounded-md shadow-2xl \[clip-path:inset\(0_round_0\.375rem\)\]",$/m);
  assert.match(hostSource, /style=\{style\}/);
  assert.doesNotMatch(hostSource, /\b(?:outline|outlineOffset|border|borderColor|borderWidth|borderStyle)\b/);
  assert.match(strokeSource, /aria-hidden="true"/);
  assert.match(strokeSource, /data-section="pane-magnification-stroke"/);
  assert.match(strokeSource, /className="pointer-events-none absolute inset-0 z-50"/);
  assert.match(strokeSource, /boxSizing: 'border-box'/);
  assert.match(strokeSource, /border: `1px solid \$\{sessionAppearanceTheme\.colors\.cursor\}`/);
  assert.match(strokeSource, /borderRadius: 'inherit'/);
});

test("restoring terminal chrome retains its inner 1px border until surface bounds clear at any DPR", () => {
  const source = readFileSync(new URL("./TerminalLayerSupport.tsx", import.meta.url), "utf8");
  const strokeSource = source.slice(source.indexOf("{magnifiedSurfaceBounds && ("), source.indexOf('TerminalPane.displayName'));
  const condition = strokeSource.match(/^\{(\w+) && \(/);
  const styleSource = strokeSource.match(/style=\{\{([\s\S]*?)\}\}/);
  assert.ok(condition);
  assert.ok(styleSource);
  const resolveStroke = new Function(
    "isMagnified", "magnifiedSurfaceBounds", "sessionAppearanceTheme", "magnifiedDevicePixelRatio",
    `return ${condition[1]} ? ({${styleSource[1]}}) : null;`,
  );
  const bounds = { left: 0, top: 80, width: 1200, height: 800 };
  const theme = { colors: { cursor: "#0088ff" } };

  for (const dpr of [1, 1.25, 1.5, 2, 3]) {
    const magnified = resolveStroke(true, bounds, theme, dpr);
    const restoring = resolveStroke(false, bounds, theme, dpr);
    assert.deepEqual(restoring, magnified);
    assert.equal(restoring.border, `1px solid ${theme.colors.cursor}`);
    assert.equal(restoring.boxSizing, 'border-box');
    assert.equal(restoring.borderRadius, 'inherit');
    for (const isMagnified of [false, true]) {
      assert.equal(resolveStroke(isMagnified, null, theme, dpr), null);
    }
  }
});

test("magnified terminal panes snap overlay bounds to the device-pixel grid", () => {
  const source = readFileSync(new URL("./TerminalLayerSupport.tsx", import.meta.url), "utf8");
  assert.match(source, /resolvePaneMagnificationStyle\(\s*layoutStyle,\s*isMagnified && !!magnifiedSurfaceBounds,\s*magnifiedSurfaceBounds,\s*magnifiedDevicePixelRatio,\s*magnifiedSurfaceBounds\?\.layoutOrigin,\s*\)/);
  assert.match(source, /layoutOrigin: \{ left: origin\.left, top: origin\.top, width: origin\.width, height: origin\.height \}/);
  assert.match(source, /const magnifiedDevicePixelRatio = typeof window === 'undefined' \? 1 : \(window\.devicePixelRatio \|\| 1\)/);
});

test("percentage zoom entry flushes pixel geometry before applying fixed bounds", () => {
  const source = readFileSync(new URL("./TerminalLayerSupport.tsx", import.meta.url), "utf8");

  assert.match(source, /pane && pane\.style\.position !== 'fixed'/);
  assert.match(source, /Object\.values\(geometry\)\.some\(\(value\) => value\.endsWith\('%'\)\)/);
  assert.match(source, /Object\.assign\(pane\.style, resolvePaneMagnificationLayoutGeometry\(geometry, origin\)\);\s+pane\.getBoundingClientRect\(\);\s+\}\s+\}\s+setMagnifiedSurfaceBounds\(/);
});

test("terminal keyboard focus updates the pane selected for magnification", () => {
  const source = readFileSync(new URL("./TerminalLayerSupport.tsx", import.meta.url), "utf8");

  assert.match(source, /onClick=\{handlePaneClick\}/);
  assert.match(source, /onFocusCapture=\{handlePaneClick\}/);
  assert.match(source, /const isCoveredByMagnification = isVisible/);
  assert.match(source, /inert=\{isVisible && !isCoveredByMagnification \? undefined : true\}/);
});

test("closing a magnified terminal clears the overlay selection", () => {
  const source = readFileSync(new URL("../TerminalLayer.tsx", import.meta.url), "utf8");

  assert.match(source, /isPaneMagnificationSelectionValid\(current, terminalPanes, sidePanelPanes\)/);
  assert.match(source, /current\?\.target\.kind === 'terminal' && current\.target\.sessionId === sessionId/);
});

test("terminal panes expose focus mode and temporary magnification as separate actions", () => {
  const source = readFileSync(new URL("TerminalLayerSupport.tsx", import.meta.url), "utf8");

  assert.match(source, /workspaceFocusHandlersRef,\s+workspaceBroadcastHandlersRef,/);
  assert.match(source, /if \(isMagnified\) \{\s+handleTogglePaneMagnification\(\);\s+\}\s+workspaceFocusHandler\?\.\(\);/);
  assert.match(source, /onExpandToFocus=\{inActiveWorkspace && !isFocusMode \? handleExpandToFocus : undefined\}/);
  assert.match(source, /onTogglePaneMagnification=\{inActiveWorkspace && \(!isFocusMode \|\| isMagnified\) \? handleTogglePaneMagnification : undefined\}/);
});

test("focus mode cannot start temporary magnification but can restore stale magnification", () => {
  const source = readFileSync(new URL("../TerminalLayer.tsx", import.meta.url), "utf8");

  assert.match(source, /const hasCurrentMagnification = magnifiedPaneRef\.current\?\.tabId === tabId;/);
  assert.match(source, /if \(workspace\?\.viewMode === 'focus' && !hasCurrentMagnification\) return null;/);
});

test("closing a magnified terminal restores its pane instead of ending the session", () => {
  const terminalSource = readFileSync(new URL("../Terminal.tsx", import.meta.url), "utf8");
  const viewSource = readFileSync(new URL("../terminal/TerminalView.tsx", import.meta.url), "utf8");
  const toolbarSource = readFileSync(new URL("../terminal/TerminalToolbar.tsx", import.meta.url), "utf8");

  assert.match(viewSource, /renderControls\(\{ showClose: inWorkspace, restorePaneLayout: isPaneMagnified \}\)/);
  assert.match(terminalSource, /opts\?: \{ showClose\?: boolean; restorePaneLayout\?: boolean \}/);
  assert.match(terminalSource, /if \(opts\?\.restorePaneLayout\) \{\s+onTogglePaneMagnification\?\.\(\);\s+return;\s+\}/);
  assert.match(terminalSource, /closeLabel=\{t\(opts\?\.restorePaneLayout\s+\? 'terminal\.paneMagnification\.restore'\s+: 'terminal\.toolbar\.closeSession'\)\}/);
  assert.match(toolbarSource, /aria-label=\{closeLabel \?\? t\('terminal\.toolbar\.closeSession'\)\}/);
});

test("workspace section passes resolved session host ids to terminal panes", () => {
  const resolvedSessionHostIds = new Set(["session-1"]);
  let sawResolvedIds = false;

  const TerminalPanesHost = (props: { resolvedSessionHostIds?: Set<string> }) => {
    sawResolvedIds = true;
    assert.equal(props.resolvedSessionHostIds, resolvedSessionHostIds);
    assert.equal(props.resolvedSessionHostIds?.has("session-1"), true);
    return null;
  };

  const ref = { current: null };
  const noop = () => {};
  const ctx = {
    workspaceInnerRef: ref,
    workspaceOverlayRef: ref,
    draggingSessionId: null,
    isFocusMode: false,
    dropHint: null,
    setDropHint: noop,
    computeSplitHint: () => null,
    handleWorkspaceDrop: noop,
    TerminalPanesHost,
    sessions: [],
    sessionHostsMap: new Map(),
    sessionChainHostsMap: new Map(),
    sessionSudoAutofillPasswordsMap: new Map(),
    sessionSudoAutofillCandidatesMap: new Map(),
    resolvedSessionHostIds,
    workspaceById: new Map(),
    workspaceRectsById: new Map(),
    isTerminalLayerVisible: true,
    workspaceFocusHandlersRef: { current: new Map() },
    workspaceBroadcastHandlersRef: { current: new Map() },
    splitHorizontalHandlersRef: { current: new Map() },
    splitVerticalHandlersRef: { current: new Map() },
    themePreview: { targetSessionId: null, targetHostId: null, globalPreview: false, themeId: null },
    keys: [],
    identities: [],
    snippets: [],
    knownHosts: [],
    terminalFontFamilyId: "default",
    fontSize: 14,
    terminalTheme: {},
    followAppTerminalTheme: false,
    accentMode: "theme",
    customAccent: "",
    terminalSettings: {},
    hotkeyScheme: "mac",
    disableTerminalFontZoom: false,
    restoreTerminalCwd: false,
    keyBindings: [],
    resizing: null,
    isComposeBarOpen: false,
    sessionLogConfig: undefined,
    sshDebugLogsEnabled: false,
    onHotkeyAction: noop,
    handleTerminalFontSizeChange: noop,
    handleOpenSftp: noop,
    handleTerminalCwdChange: noop,
    handleTerminalTitleChange: noop,
    handleTerminalBell: noop,
    handleTerminalOutput: noop,
    handleOpenScripts: noop,
    handleOpenHistory: noop,
    handleOpenSystem: noop,
    handleOpenTheme: noop,
    handleCloseSession: noop,
    handleStatusChange: noop,
    handleSessionExit: noop,
    handleTerminalDataCapture: noop,
    handleOsDetected: noop,
    handleUpdateHost: noop,
    handleAddKnownHost: noop,
    handleCommandExecuted: noop,
    handleCommandSubmitted: noop,
    onSetWorkspaceFocusedSession: noop,
    onSplitSession: noop,
    isBroadcastEnabled: () => false,
    handleBroadcastInput: noop,
    handleBroadcastInterruptPriorityChange: noop,
    handleToggleWorkspaceComposeBar: noop,
    handleSnippetExecutorChange: noop,
    handleProgrammaticCommandLogRewriteChange: noop,
    handleAddSelectionToAI: noop,
    activeResizers: [],
    activeWorkspace: null,
    composeBarThemeColors: null,
    findSplitNode: () => null,
    focusedSessionId: null,
    handleComposeSend: noop,
    handleSnippetFromPanel: noop,
    refocusTerminalSession: noop,
    setIsComposeBarOpen: noop,
    setResizing: noop,
    TerminalComposeBar: () => null,
    Array,
    cn: (...values: unknown[]) => values.filter(Boolean).join(" "),
    onStartSessionRename: noop,
    onRemoveSessionFromWorkspace: noop,
    onReorderTabs: noop,
    onStartSessionDrag: noop,
    onEndSessionDrag: noop,
  };

  renderToStaticMarkup(React.createElement(TerminalLayerWorkspaceSection, { ctx }));

  assert.equal(sawResolvedIds, true);
});


test("empty workspace offers adding to the current workspace and hides the prompt once populated", async () => {
  const requested: string[] = [];
  const ctx = {
    TerminalPanesHost: () => null,
    activeResizers: [], keyBindings: [], hotkeyScheme: "mac", Array,
    cn: (...values: unknown[]) => values.filter(Boolean).join(" "),
    t: (key: string) => key,
    onRequestAddToWorkspace: (id: string) => requested.push(id),
  };
  const workspace = { id: "empty-one", title: "Empty", viewMode: "split" as const, root: createEmptyWorkspaceRoot() };
  const previous = sidePanelLiveStore.getSnapshot();
  let renderer: ReturnType<typeof create> | undefined;
  try {
    sidePanelLiveStore.update({ ...SIDE_PANEL_INACTIVE_LIVE_SNAPSHOT, activeWorkspace: workspace });
    await act(async () => { renderer = create(React.createElement(TerminalLayerWorkspaceSection, { ctx })); });
    assert.equal(renderer!.root.findAllByProps({ "data-section": "empty-workspace" }).length, 1);
    await act(async () => renderer!.root.findByType("button").props.onClick());
    assert.deepEqual(requested, ["empty-one"]);
    await act(async () => {
      sidePanelLiveStore.update({ ...SIDE_PANEL_INACTIVE_LIVE_SNAPSHOT, activeWorkspace: { ...workspace, id: "empty-two" } });
    });
    await act(async () => renderer!.root.findByType("button").props.onClick());
    assert.deepEqual(requested, ["empty-one", "empty-two"]);
    await act(async () => {
      sidePanelLiveStore.update({ ...SIDE_PANEL_INACTIVE_LIVE_SNAPSHOT, activeWorkspace: { ...workspace, root: { id: "pane", type: "pane", sessionId: "terminal" } } });
    });
    assert.equal(renderer!.root.findAllByProps({ "data-section": "empty-workspace" }).length, 0);
  } finally {
    await act(async () => renderer?.unmount());
    sidePanelLiveStore.update(previous);
  }
});
