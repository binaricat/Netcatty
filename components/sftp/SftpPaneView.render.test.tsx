import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import type { SftpPane } from "../../application/state/sftp/types";
import type { SftpPaneCallbacks } from "./SftpContext";

function installSftpDom() {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    pretendToBeVisual: true,
    url: "http://localhost/",
  });
  const win = dom.window;
  const previousGlobals = new Map<string, PropertyDescriptor | undefined>();
  const installGlobal = (key: string, value: unknown) => {
    previousGlobals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, {
      configurable: true,
      writable: true,
      value,
    });
  };

  class ResizeObserverStub {
    observe() {}
    unobserve() {}
    disconnect() {}
  }

  if (!win.HTMLElement.prototype.scrollIntoView) {
    Object.defineProperty(win.HTMLElement.prototype, "scrollIntoView", {
      configurable: true,
      writable: true,
      value: () => {},
    });
  }

  installGlobal("window", win);
  installGlobal("document", win.document);
  installGlobal("navigator", win.navigator);
  installGlobal("HTMLElement", win.HTMLElement);
  installGlobal("HTMLInputElement", win.HTMLInputElement);
  installGlobal("HTMLTextAreaElement", win.HTMLTextAreaElement);
  installGlobal("Element", win.Element);
  installGlobal("SVGElement", win.SVGElement);
  installGlobal("Node", win.Node);
  installGlobal("NodeFilter", win.NodeFilter);
  installGlobal("MutationObserver", win.MutationObserver);
  installGlobal("CustomEvent", win.CustomEvent);
  installGlobal("Event", win.Event);
  installGlobal("MouseEvent", win.MouseEvent);
  installGlobal("KeyboardEvent", win.KeyboardEvent);
  installGlobal("StorageEvent", win.StorageEvent);
  installGlobal("localStorage", win.localStorage);
  installGlobal("sessionStorage", win.sessionStorage);
  installGlobal("getComputedStyle", win.getComputedStyle.bind(win));
  installGlobal("requestAnimationFrame", win.requestAnimationFrame.bind(win));
  installGlobal("cancelAnimationFrame", win.cancelAnimationFrame.bind(win));
  installGlobal("ResizeObserver", ResizeObserverStub);
  installGlobal("IS_REACT_ACT_ENVIRONMENT", true);

  return {
    dom,
    window: win,
    cleanup() {
      dom.window.close();
      for (const [key, descriptor] of previousGlobals.entries()) {
        if (descriptor) {
          Object.defineProperty(globalThis, key, descriptor);
        } else {
          Reflect.deleteProperty(globalThis, key);
        }
      }
    },
  };
}

function createNoopCallbacks(): SftpPaneCallbacks {
  const noop = () => {};
  const asyncNoop = async () => {};
  return {
    onConnect: noop,
    onDisconnect: async () => true,
    onPrepareSelection: noop,
    onNavigateTo: noop,
    onNavigateBack: noop,
    onNavigateForward: noop,
    onNavigateUp: noop,
    onRefresh: noop,
    onRefreshTab: noop,
    onSetFilenameEncoding: noop,
    onOpenEntry: noop,
    onToggleSelection: noop,
    onRangeSelect: noop,
    onClearSelection: noop,
    onSetFilter: noop,
    onCreateDirectory: asyncNoop,
    onCreateDirectoryAtPath: asyncNoop,
    onCreateFile: asyncNoop,
    onCreateFileAtPath: asyncNoop,
    onDeleteFiles: asyncNoop,
    onDeleteFilesAtPath: asyncNoop,
    onRenameFile: asyncNoop,
    onRenameFileAtPath: asyncNoop,
    onMoveEntriesToPath: asyncNoop,
    onCopyToOtherPane: noop,
    onDuplicateEntries: noop,
    onReceiveFromOtherPane: noop,
    onListDirectory: async () => [],
    onListDrives: async () => [],
  };
}

function createTrackedPane(
  id: string,
  renderCounts: Map<string, number>,
  options: { showHiddenFiles?: boolean; selectedFile?: string } = {},
): SftpPane {
  const pane: SftpPane = {
    id,
    connection: {
      id: `conn-${id}`,
      hostId: `host-${id}`,
      hostLabel: `Host ${id}`,
      isLocal: false,
      status: "connected",
      currentPath: "/home/user",
      homeDir: "/home/user",
    },
    files: [
      {
        name: "readme.txt",
        type: "file",
        size: 42,
        sizeFormatted: "42 B",
        lastModified: 0,
        lastModifiedFormatted: "--",
      },
    ],
    loading: false,
    reconnecting: false,
    error: null,
    connectionLogs: [],
    selectedFiles: new Set(options.selectedFile ? [options.selectedFile] : []),
    filter: "",
    filenameEncoding: "auto",
    showHiddenFiles: options.showHiddenFiles ?? false,
    transferMutationToken: 0,
  };

  // SftpPaneViewInner reads pane.transferMutationToken in its render body (effect deps),
  // whereas sftpPaneViewAreEqual only compares pane by reference. Counting reads here
  // detects every SftpPaneViewInner execution without modifying production code.
  Object.defineProperty(pane, "transferMutationToken", {
    configurable: true,
    enumerable: true,
    get() {
      renderCounts.set(id, (renderCounts.get(id) ?? 0) + 1);
      return 0;
    },
  });

  return pane;
}

test("SftpPaneView and SftpPaneWrapper avoid re-rendering inactive tabs on focus flip, tab switch, and parent re-render", async () => {
  const env = installSftpDom();
  const { act, Profiler, useCallback, useState } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { I18nProvider } = await import("../../application/i18n/I18nProvider.tsx");
  const { TooltipProvider } = await import("../ui/tooltip.tsx");
  const { sftpFocusStore } = await import("../../application/state/sftp/sftpFocusStore.ts");
  const { SftpContextProvider, activeTabStore } = await import("./SftpContext.tsx");
  const { SftpPaneView, SftpPaneWrapper } = await import("./SftpPaneView.tsx");

  const prevLeftTab = activeTabStore.getLeftActiveTabId();
  const prevRightTab = activeTabStore.getRightActiveTabId();
  const prevFocusedSide = sftpFocusStore.getFocusedSide();

  const paneRenderCounts = new Map<string, number>();
  const wrapperRenderCounts = new Map<string, number>();
  const resetCounts = () => {
    paneRenderCounts.clear();
    wrapperRenderCounts.clear();
  };

  const leftPanes = ["L1", "L2", "L3", "L4"].map((id) =>
    createTrackedPane(id, paneRenderCounts, { selectedFile: "readme.txt" }),
  );
  const rightPanes = ["R1", "R2", "R3", "R4"].map((id) =>
    createTrackedPane(id, paneRenderCounts, { selectedFile: "readme.txt" }),
  );

  const leftCallbacks = createNoopCallbacks();
  const rightCallbacks = createNoopCallbacks();
  const dragCallbacks = { onDragStart: () => {}, onDragEnd: () => {} };
  const updateHosts = () => {};
  const hosts: never[] = [];
  const toggleCalls: Array<{ side: "left" | "right"; paneId: string }> = [];

  let forceParentRender: (() => void) | null = null;

  const Harness: React.FC = () => {
    const [, setTick] = useState(0);
    forceParentRender = () => setTick((t) => t + 1);

    const handleToggleHiddenFiles = useCallback((side: "left" | "right", paneId: string) => {
      toggleCalls.push({ side, paneId });
    }, []);

    return (
      <SftpContextProvider
        hosts={hosts}
        updateHosts={updateHosts}
        draggedFiles={null}
        dragCallbacks={dragCallbacks}
        leftCallbacks={leftCallbacks}
        rightCallbacks={rightCallbacks}
      >
        <div>
          {leftPanes.map((pane, idx) => (
            <Profiler
              key={pane.id}
              id={`wrapper-${pane.id}`}
              onRender={(id) => {
                wrapperRenderCounts.set(id, (wrapperRenderCounts.get(id) ?? 0) + 1);
              }}
            >
              <SftpPaneWrapper side="left" paneId={pane.id} isFirstPane={idx === 0}>
                <SftpPaneView
                  side="left"
                  pane={pane}
                  dialogActionScopeId="sftp-main-view"
                  sftpDefaultViewMode="list"
                  showHeader
                  showEmptyHeader={false}
                  onToggleShowHiddenFiles={handleToggleHiddenFiles}
                />
              </SftpPaneWrapper>
            </Profiler>
          ))}
          {rightPanes.map((pane, idx) => (
            <Profiler
              key={pane.id}
              id={`wrapper-${pane.id}`}
              onRender={(id) => {
                wrapperRenderCounts.set(id, (wrapperRenderCounts.get(id) ?? 0) + 1);
              }}
            >
              <SftpPaneWrapper side="right" paneId={pane.id} isFirstPane={idx === 0}>
                <SftpPaneView
                  side="right"
                  pane={pane}
                  dialogActionScopeId="sftp-main-view"
                  sftpDefaultViewMode="list"
                  showHeader
                  showEmptyHeader={false}
                  onToggleShowHiddenFiles={handleToggleHiddenFiles}
                />
              </SftpPaneWrapper>
            </Profiler>
          ))}
        </div>
      </SftpContextProvider>
    );
  };

  const rootNode = env.window.document.getElementById("root")!;
  const root = createRoot(rootNode);

  try {
    activeTabStore.setActiveTabId("left", "L1");
    activeTabStore.setActiveTabId("right", "R1");
    sftpFocusStore.setFocusedSide("left");

    await act(async () => {
      root.render(
        <I18nProvider locale="en">
          <TooltipProvider>
            <Harness />
          </TooltipProvider>
        </I18nProvider>,
      );
    });

    // (a) Clicking left <-> right triggers 0 re-renders of inactive SftpPaneViews
    resetCounts();
    await act(async () => {
      sftpFocusStore.setFocusedSide("right");
    });

    assert.ok((paneRenderCounts.get("L1") ?? 0) > 0, "active left pane L1 should re-render on focus loss");
    assert.ok((paneRenderCounts.get("R1") ?? 0) > 0, "active right pane R1 should re-render on focus gain");
    for (const inactiveId of ["L2", "L3", "L4", "R2", "R3", "R4"]) {
      assert.equal(
        paneRenderCounts.get(inactiveId) ?? 0,
        0,
        `inactive pane ${inactiveId} must not re-render on left <-> right focus flip`,
      );
      assert.equal(
        wrapperRenderCounts.get(`wrapper-${inactiveId}`) ?? 0,
        0,
        `inactive wrapper ${inactiveId} must not re-render on left <-> right focus flip`,
      );
    }

    // Flip focus back right -> left
    resetCounts();
    await act(async () => {
      sftpFocusStore.setFocusedSide("left");
    });
    assert.ok((paneRenderCounts.get("L1") ?? 0) > 0);
    assert.ok((paneRenderCounts.get("R1") ?? 0) > 0);
    for (const inactiveId of ["L2", "L3", "L4", "R2", "R3", "R4"]) {
      assert.equal(paneRenderCounts.get(inactiveId) ?? 0, 0);
    }

    // Parent re-render (e.g., magnification toggle / transfer update) triggers 0 SftpPaneView re-renders
    // because onToggleShowHiddenFiles is stable and isPaneFocused is not passed as a changing prop.
    resetCounts();
    await act(async () => {
      forceParentRender?.();
    });
    for (const id of ["L1", "L2", "L3", "L4", "R1", "R2", "R3", "R4"]) {
      assert.equal(
        paneRenderCounts.get(id) ?? 0,
        0,
        `pane ${id} must bail out via sftpPaneViewAreEqual when parent re-renders with stable props`,
      );
    }

    // (b) Switching left tab L1 -> L2 only re-renders L1 and L2 (0 re-renders for L3, L4, and right tabs)
    resetCounts();
    await act(async () => {
      activeTabStore.setActiveTabId("left", "L2");
    });
    assert.ok((paneRenderCounts.get("L1") ?? 0) > 0, "previous active tab L1 should re-render");
    assert.ok((paneRenderCounts.get("L2") ?? 0) > 0, "new active tab L2 should re-render");
    assert.ok((wrapperRenderCounts.get("wrapper-L1") ?? 0) > 0);
    assert.ok((wrapperRenderCounts.get("wrapper-L2") ?? 0) > 0);
    for (const untouchedId of ["L3", "L4", "R1", "R2", "R3", "R4"]) {
      assert.equal(
        paneRenderCounts.get(untouchedId) ?? 0,
        0,
        `untouched pane ${untouchedId} must not re-render when switching L1 -> L2`,
      );
      assert.equal(
        wrapperRenderCounts.get(`wrapper-${untouchedId}`) ?? 0,
        0,
        `untouched wrapper ${untouchedId} must not re-render when switching L1 -> L2`,
      );
    }

    // Focus flip after switching L1 -> L2: now L2 and R1 re-render, L1 (now inactive) does NOT
    resetCounts();
    await act(async () => {
      sftpFocusStore.setFocusedSide("right");
    });
    assert.ok((paneRenderCounts.get("L2") ?? 0) > 0, "newly active L2 should subscribe to focus");
    assert.ok((paneRenderCounts.get("R1") ?? 0) > 0, "active R1 should re-render on focus gain");
    for (const inactiveId of ["L1", "L3", "L4", "R2", "R3", "R4"]) {
      assert.equal(
        paneRenderCounts.get(inactiveId) ?? 0,
        0,
        `inactive pane ${inactiveId} must not re-render on focus flip after tab switch`,
      );
    }

    // (c) Hidden-file toggle works in SftpView wiring (2-arg callback receives side + pane.id)
    const paneEls = Array.from(rootNode.querySelectorAll('[data-section="terminal-sftp-pane"]')) as HTMLElement[];
    assert.equal(paneEls.length, 8);
    // Index 1 is L2, index 4 is R1
    const clickShowHidden = async (paneEl: HTMLElement) => {
      const eyeIcon = paneEl.querySelector("svg.lucide-eye, svg.lucide-eye-off");
      assert.ok(eyeIcon, "showHidden toolbar button icon should be rendered");
      const button = eyeIcon.closest("button");
      assert.ok(button, "showHidden toolbar button should exist");
      await act(async () => {
        button.click();
      });
    };
    await clickShowHidden(paneEls[1]);
    await clickShowHidden(paneEls[4]);
    assert.deepEqual(toggleCalls, [
      { side: "left", paneId: "L2" },
      { side: "right", paneId: "R1" },
    ]);
  } finally {
    await act(async () => {
      root.unmount();
    });
    activeTabStore.setActiveTabId("left", prevLeftTab);
    activeTabStore.setActiveTabId("right", prevRightTab);
    sftpFocusStore.setFocusedSide(prevFocusedSide);
    env.cleanup();
  }
});

test("SftpPaneView preserves null activeTabId fallbacks and SftpSidePanel 0-arg hidden-file toggle + explicit focus", async () => {
  const env = installSftpDom();
  const { act, useState } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { I18nProvider } = await import("../../application/i18n/I18nProvider.tsx");
  const { TooltipProvider } = await import("../ui/tooltip.tsx");
  const { sftpFocusStore } = await import("../../application/state/sftp/sftpFocusStore.ts");
  const { SftpContextProvider, activeTabStore, useIsSftpPaneActive } = await import("./SftpContext.tsx");
  const { SftpPaneView, SftpPaneWrapper } = await import("./SftpPaneView.tsx");

  const prevLeftTab = activeTabStore.getLeftActiveTabId();
  const prevRightTab = activeTabStore.getRightActiveTabId();
  const prevFocusedSide = sftpFocusStore.getFocusedSide();

  const paneRenderCounts = new Map<string, number>();
  const sidePanelPane = createTrackedPane("side-1", paneRenderCounts);
  const callbacks = createNoopCallbacks();
  const dragCallbacks = { onDragStart: () => {}, onDragEnd: () => {} };
  const sidePanelToggles: string[] = [];

  let setHasPaneFocus: ((focused: boolean) => void) | null = null;
  let observedNullFallbacks = { wrapperFirst: false, wrapperSecond: true, paneView: false, forced: false };

  const Probe: React.FC = () => {
    const wrapperFirst = useIsSftpPaneActive("left", "p1", true);
    const wrapperSecond = useIsSftpPaneActive("left", "p2", false);
    const paneView = useIsSftpPaneActive("left", "p2", true);
    const forced = useIsSftpPaneActive("left", "side-1", false, true);
    observedNullFallbacks = { wrapperFirst, wrapperSecond, paneView, forced };
    return null;
  };

  const SidePanelHarness: React.FC = () => {
    const [hasPaneFocus, setFocused] = useState(false);
    setHasPaneFocus = setFocused;

    return (
      <I18nProvider locale="en">
        <TooltipProvider>
          <SftpContextProvider
            hosts={[]}
            updateHosts={() => {}}
            draggedFiles={null}
            dragCallbacks={dragCallbacks}
            leftCallbacks={callbacks}
            rightCallbacks={callbacks}
          >
            <Probe />
            <div data-test="wrappers">
              <SftpPaneWrapper side="left" paneId="p1" isFirstPane={true}>
                <span>first</span>
              </SftpPaneWrapper>
              <SftpPaneWrapper side="left" paneId="p2" isFirstPane={false}>
                <span>second</span>
              </SftpPaneWrapper>
            </div>
            <div data-test="side-panel">
              <SftpPaneView
                side="left"
                pane={sidePanelPane}
                dialogActionScopeId="side-panel-scope"
                isPaneFocused={hasPaneFocus}
                sftpDefaultViewMode="list"
                showHeader
                showEmptyHeader
                forceActive
                onToggleShowHiddenFiles={() => sidePanelToggles.push(sidePanelPane.id)}
              />
            </div>
          </SftpContextProvider>
        </TooltipProvider>
      </I18nProvider>
    );
  };

  const rootNode = env.window.document.getElementById("root")!;
  const root = createRoot(rootNode);

  try {
    activeTabStore.setActiveTabId("left", null);
    sftpFocusStore.setFocusedSide("left");

    await act(async () => {
      root.render(<SidePanelHarness />);
    });

    // Null activeTabId fallbacks match original semantics:
    // SftpPaneWrapper uses isFirstPane; SftpPaneViewInner uses true; forceActive is always true.
    assert.deepEqual(observedNullFallbacks, {
      wrapperFirst: true,
      wrapperSecond: false,
      paneView: true,
      forced: true,
    });

    const wrappersContainer = rootNode.querySelector('[data-test="wrappers"]')!;
    const wrapperDivs = Array.from(wrappersContainer.children) as HTMLElement[];
    assert.equal(wrapperDivs[0].style.visibility, "");
    assert.equal(wrapperDivs[1].style.visibility, "hidden");

    // Shared activeTabStore and sftpFocusStore changes must NOT re-render SftpSidePanel's
    // forceActive + explicit isPaneFocused SftpPaneView.
    paneRenderCounts.clear();
    await act(async () => {
      activeTabStore.setActiveTabId("left", "some-other-tab");
      sftpFocusStore.setFocusedSide("right");
    });
    assert.equal(
      paneRenderCounts.get("side-1") ?? 0,
      0,
      "SftpSidePanel pane with forceActive + explicit isPaneFocused must not re-render on shared store changes",
    );

    // Explicit isPaneFocused prop change DOES re-render SftpSidePanel's SftpPaneView
    paneRenderCounts.clear();
    await act(async () => {
      setHasPaneFocus?.(true);
    });
    assert.ok((paneRenderCounts.get("side-1") ?? 0) > 0, "explicit isPaneFocused change must re-render pane");

    // 0-arg onToggleShowHiddenFiles callback (SftpSidePanel pattern) still fires
    const sidePanelEl = rootNode.querySelector<HTMLElement>('[data-test="side-panel"]')!;
    const eyeIcon = sidePanelEl.querySelector("svg.lucide-eye, svg.lucide-eye-off");
    assert.ok(eyeIcon);
    const button = eyeIcon.closest("button");
    assert.ok(button);
    await act(async () => {
      button.click();
    });
    assert.deepEqual(sidePanelToggles, ["side-1"]);
  } finally {
    await act(async () => {
      root.unmount();
    });
    activeTabStore.setActiveTabId("left", prevLeftTab);
    activeTabStore.setActiveTabId("right", prevRightTab);
    sftpFocusStore.setFocusedSide(prevFocusedSide);
    env.cleanup();
  }
});
