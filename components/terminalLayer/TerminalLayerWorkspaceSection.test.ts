import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { TerminalLayerWorkspaceSection } from "./TerminalLayerWorkspaceSection.tsx";

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
    resolvedSessionHostIds,
    workspaceById: new Map(),
    workspaceRectsById: new Map(),
    isTerminalLayerVisible: true,
    workspaceFocusHandlersRef: { current: new Map() },
    workspaceBroadcastHandlersRef: { current: new Map() },
    splitHorizontalHandlersRef: { current: new Map() },
    splitVerticalHandlersRef: { current: new Map() },
    themePreview: { targetSessionId: null, themeId: null },
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
