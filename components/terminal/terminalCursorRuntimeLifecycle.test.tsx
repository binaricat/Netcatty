import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { useEffect, useLayoutEffect } from "react";
import { act, create } from "react-test-renderer";

import { useTerminalEffects } from "./useTerminalEffects";
import {
  applyUserCursorPreference,
  applyUserCursorWidthPreference,
  shouldApplyUserCursorPreference,
  snapshotUserCursorPreference,
} from "./runtime/cursorPreference";

const dom = new JSDOM("<!doctype html><html><body></body></html>");
Object.assign(globalThis, {
  window: dom.window,
  document: dom.window.document,
});
Object.defineProperty(globalThis, "navigator", {
  configurable: true,
  value: dom.window.navigator,
});
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
(globalThis as { ResizeObserver?: unknown }).ResizeObserver = class {
  observe() {}
  disconnect() {}
};
Object.defineProperty(dom.window.HTMLCanvasElement.prototype, "getContext", {
  configurable: true,
  value: () => null,
});

const noop = () => undefined;
type TestContext = Record<string, unknown>;
const ref = <T,>(current: T) => ({ current });

const createTerm = () => ({
  options: {
    cursorStyle: "block" as const,
    cursorBlink: true,
    cursorWidth: 2,
    fontFamily: "monospace",
    fontSize: 14,
    scrollback: 1000,
    fontWeight: 400,
    fontWeightBold: 700,
  },
  cols: 80,
  rows: 24,
  buffer: { active: { viewportY: 0 } },
  _core: { coreService: { decPrivateModes: {} as { cursorStyle?: "block" | "bar" | "underline"; cursorBlink?: boolean } } },
  write: (_data: string, callback?: () => void) => callback?.(),
  scrollToBottom: noop,
});

const createContext = (term: ReturnType<typeof createTerm>, terminalSettings: Record<string, unknown>) => {
  const termRef = ref<typeof term | null>(null);
  const xtermRuntimeRef = ref<unknown>(null);
  const runtime = {
    term,
    fitAddon: { fit: noop },
    serializeAddon: {},
    searchAddon: {},
    keywordHighlighter: { setRules: noop },
    cursorLineHighlighter: { setBackgroundColor: noop, setEnabled: noop },
    clearTextureAtlas: noop,
    syncFontLigatures: noop,
    ensureWebglRenderer: async () => undefined,
    dispose: noop,
  };
  const values: TestContext = {
    CONNECTION_TIMEOUT: 30_000,
    Error,
    XTERM_PERFORMANCE_CONFIG: {},
    applyUserCursorPreference,
    applyUserCursorWidthPreference,
    shouldApplyUserCursorPreference,
    snapshotUserCursorPreference,
    createXTermRuntime: () => runtime,
    terminalSettings,
    terminalSettingsRef: ref(terminalSettings),
    termRef,
    xtermRuntimeRef,
    fitAddonRef: ref(null),
    serializeAddonRef: ref(null),
    searchAddonRef: ref(null),
    hasRuntimeRef: ref(false),
    containerRef: ref(document.createElement("div")),
    host: { id: "local", protocol: "local", label: "Local", hostname: "localhost" },
    effectiveTheme: { colors: { background: "#000", foreground: "#fff", selection: "#444" } },
    effectiveFontSize: 14,
    effectiveFontWeight: 400,
    resolvedFontFamily: "monospace",
    fontFamilyId: "monospace",
    fontSize: 14,
    status: "disconnected",
    statusRef: ref("disconnected"),
    sessionId: "cursor-test",
    sessionRef: ref(null),
    isVisible: true,
    isVisibleRef: ref(true),
    isFocused: true,
    isResizing: false,
    inWorkspace: true,
    vaultInitialized: true,
    attachExistingSession: false,
    isLocalConnection: true,
    isNetworkDevice: false,
    isSerialConnection: false,
    isComposeBarOpen: false,
    isSearchOpen: false,
    pluginDecorationRules: [],
    pluginTerminalLifecycle: {},
    pluginTerminalProviderRevision: 0,
    terminalBackend: {},
    terminalOutputHistory: { clear: noop },
    connectionLogBufferRef: ref({ reset: noop }),
    terminalLogSanitizerRef: ref(null),
    terminalDataCapturedRef: ref(false),
    hasConnectedRef: ref(false),
    pendingOutputScrollRef: ref(false),
    promptLineBreakStateRef: ref(null),
    terminalCwdTracker: { getRendererCwd: () => null, setRendererCwd: () => null },
    sessionStarters: { startLocal: async () => undefined },
    auth: { setNeedsAuth: noop },
    keys: [],
    identities: [],
    serialConfig: {},
    zmodem: {},
    toast: { error: noop, success: noop },
    logger: { warn: noop, error: noop },
    t: (key: string) => key,
    safeFit: noop,
    updateStatus: noop,
    setStatus: noop,
    setError: noop,
    setProgressLogs: noop,
    setShowLogs: noop,
    setProgressValue: noop,
    setTimeLeft: noop,
    setIsCancelling: noop,
    setIsDisconnectedDialogDismissed: noop,
    setNeedsHostKeyVerification: noop,
    setPendingHostKeyInfo: noop,
    setPendingHostKeyRequestId: noop,
    setHasMouseTracking: noop,
    clearTerminalCwd: noop,
    createPromptLineBreakState: () => ({}),
    createReplaySafeTerminalLogSanitizer: () => ({}),
    captureTerminalLogData: noop,
    handleTerminalDataCaptureOnce: noop,
    finalizeTerminalLogData: noop,
    resolveHostAuth: () => ({}),
    shouldStartTerminalBackend: () => true,
    shouldEnableNativeUserInputAutoScroll: () => false,
    terminalAltKeyOptions: () => ({ macOptionIsMeta: false, altClickMovesCursor: false }),
    requestPluginTerminalProviders: noop,
    isPluginTerminalProviderAvailable: () => false,
    onTerminalFontSizeChange: noop,
    onOpenExternalError: noop,
    onCommandExecuted: noop,
    onCommandSubmitted: noop,
    onPluginRuntimeCwdChange: noop,
    onSnippetExecutorChange: noop,
    onBroadcastInterruptPriorityChange: noop,
    requestSearchFocus: noop,
  };
  const defaultRef = ref(null);
  const context = new Proxy(values, {
    get(target, property) {
      return property in target ? target[property as string] : defaultRef;
    },
  });
  return { context, termRef, xtermRuntimeRef };
};

function Harness({ context }: { context: TestContext }) {
  context.useEffect = useEffect;
  context.useLayoutEffect = useLayoutEffect;
  useTerminalEffects(context);
  return null;
}

test("first width-only update after actual runtime creation preserves an application DEC bar cursor", async () => {
  const initialSettings = { cursorShape: "block", cursorBlink: true, cursorBarWidth: 2 };
  const term = createTerm();
  const { context, termRef } = createContext(term, initialSettings);

  let renderer: ReturnType<typeof create>;
  await act(async () => {
    renderer = create(<Harness context={context} />);
    await Promise.resolve();
    await Promise.resolve();
  });

  assert.equal(termRef.current, term, "the hook must publish the created runtime term");
  term._core.coreService.decPrivateModes.cursorStyle = "bar";
  term._core.coreService.decPrivateModes.cursorBlink = true;

  const updatedSettings = { ...initialSettings, cursorBarWidth: 3 };
  context.terminalSettings = updatedSettings;
  context.terminalSettingsRef.current = updatedSettings;
  await act(async () => {
    renderer!.update(<Harness context={context} />);
    await Promise.resolve();
  });

  assert.equal(term.options.cursorWidth, 3);
  assert.equal(term._core.coreService.decPrivateModes.cursorStyle, "bar");
  assert.equal(term._core.coreService.decPrivateModes.cursorBlink, true);

  await act(async () => renderer!.unmount());
});

test('real pane props publish late-mounted selection targets only for the effective input owner', async () => {
  const { usePluginTerminalSelection } = await import('../../application/state/usePluginTerminalSelection');
  const { getTerminalPaneRenderSnapshot, parseTerminalPaneRenderSnapshot, resolveTerminalPaneInputProps } = await import('../terminalPaneVisibility');
  const workspace = (id: string, viewMode: 'focus' | 'split'): import('../../types').Workspace => ({
    id, title: id, viewMode, focusedSessionId: `${id}-a`, root: { id: `${id}-root`, type: 'split', direction: 'vertical',
      children: ['a', 'b'].map((suffix) => ({ id: `${id}-${suffix}`, type: 'pane', sessionId: `${id}-${suffix}` })) },
  });
  const workspaceById = new Map([['focus', workspace('focus', 'focus')], ['split', workspace('split', 'split')]]);
  const cases = [
    { activeTabId: 'solo', sessionId: 'solo', eligible: true },
    { activeTabId: 'solo', sessionId: 'other', eligible: false },
    { activeTabId: 'focus', sessionId: 'focus-a', sessionWorkspaceId: 'focus', eligible: true },
    { activeTabId: 'focus', sessionId: 'focus-b', sessionWorkspaceId: 'focus', eligible: false },
    { activeTabId: 'split', sessionId: 'split-a', sessionWorkspaceId: 'split', eligible: true },
    { activeTabId: 'split', sessionId: 'split-b', sessionWorkspaceId: 'split', eligible: false },
    { activeTabId: 'solo', sessionId: 'split-a', sessionWorkspaceId: 'split', eligible: false },
    { activeTabId: 'solo', sessionId: 'solo', isTerminalLayerVisible: false, eligible: false },
  ];
  const previous = Object.getOwnPropertyDescriptor(window, 'netcatty');
  const targets: Array<{ sessionId: string | null }> = [];
  Object.defineProperty(window, 'netcatty', { configurable: true, value: {
    async setPluginTerminalTarget(target: { sessionId: string | null }) { targets.push(target); return true; },
  } });
  try {
    for (const item of cases) {
      targets.length = 0;
      const inputProps = resolveTerminalPaneInputProps(parseTerminalPaneRenderSnapshot(getTerminalPaneRenderSnapshot({
        ...item, workspaceById, isTerminalLayerVisible: item.isTerminalLayerVisible ?? true,
      })));
      const element = document.createElement('div'); document.body.append(element);
      const term = Object.assign(createTerm(), { element });
      const { context, termRef } = createContext(term, { cursorShape: 'block' });
      function SelectionHarness() {
        usePluginTerminalSelection(item.sessionId, () => ({ sessionId: item.sessionId, term: termRef.current as never,
          bootEpoch: 1, visible: inputProps.isVisible, isFocusedPane: inputProps.isFocusedPane,
          connected: true, sensitive: false, normalize: false, label: 'Synthetic mount' }), JSON.stringify(inputProps));
        context.useEffect = useEffect; context.useLayoutEffect = useLayoutEffect;
        useTerminalEffects(context);
        return null;
      }
      let renderer: ReturnType<typeof create> | undefined;
      try {
        await act(async () => { renderer = create(<SelectionHarness />); await Promise.resolve(); await Promise.resolve(); });
        assert.equal(termRef.current, term);
        assert.equal(targets.some((target) => target.sessionId === item.sessionId), item.eligible,
          `${item.activeTabId}/${item.sessionId}: publication must follow real pane ownership after late assignment`);
      } finally {
        await act(async () => renderer?.unmount());
        assert.equal(targets.at(-1)?.sessionId, null);
        element.remove();
      }
    }
  } finally {
    if (previous) Object.defineProperty(window, 'netcatty', previous); else Reflect.deleteProperty(window, 'netcatty');
  }
});
