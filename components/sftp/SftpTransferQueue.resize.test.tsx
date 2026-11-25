import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
import type { TransferTask } from "../../types";

function setupDom() {
  const dom = new JSDOM("<!doctype html><html><body><div id=\"root\"></div></body></html>", {
    pretendToBeVisual: true,
    url: "http://localhost",
  });
  const previous = new Map<string, PropertyDescriptor | undefined>();
  const install = (key: string, value: unknown) => {
    previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  };
  for (const key of [
    "window",
    "document",
    "navigator",
    "HTMLElement",
    "Element",
    "Node",
    "MutationObserver",
    "CustomEvent",
    "Event",
    "MouseEvent",
    "StorageEvent",
    "DOMException",
  ]) {
    install(key, key === "window" ? dom.window : dom.window[key as keyof typeof dom.window]);
  }
  install("localStorage", dom.window.localStorage);
  install("getComputedStyle", dom.window.getComputedStyle.bind(dom.window));
  install(
    "requestAnimationFrame",
    (cb: FrameRequestCallback) => setTimeout(() => cb(Date.now()), 0) as unknown as number,
  );
  install("cancelAnimationFrame", (id: number) => clearTimeout(id));
  install(
    "ResizeObserver",
    class ResizeObserver {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  install("IS_REACT_ACT_ENVIRONMENT", true);

  return {
    dom,
    cleanup() {
      dom.window.close();
      for (const [key, descriptor] of previous) {
        if (descriptor) {
          Object.defineProperty(globalThis, key, descriptor);
        } else {
          Reflect.deleteProperty(globalThis, key);
        }
      }
    },
  };
}

const makeTask = (id: string): TransferTask => ({
  id,
  fileName: `${id}.bin`,
  sourcePath: `/src/${id}.bin`,
  targetPath: `/dst/${id}.bin`,
  sourceConnectionId: "local",
  targetConnectionId: "remote-1",
  direction: "upload",
  status: "transferring",
  totalBytes: 1024,
  transferredBytes: 512,
  speed: 128,
  startTime: 1000,
  isDirectory: false,
});

test("SftpTransferQueue attaches 0 idle window listeners, preserves unrelated body styles on mouseup, and does not rebind on mousemove", async () => {
  const env = setupDom();
  const { act } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { I18nProvider } = await import("../../application/i18n/I18nProvider");
  const { TooltipProvider } = await import("../ui/tooltip");
  const { SftpTransferQueue } = await import("./SftpTransferQueue");

  let mouseMoveAdds = 0;
  let mouseMoveRemoves = 0;
  let mouseUpAdds = 0;
  let mouseUpRemoves = 0;
  const origAdd = window.addEventListener.bind(window);
  const origRemove = window.removeEventListener.bind(window);
  window.addEventListener = ((type: string, listener: EventListenerOrEventListenerObject, options?: boolean | AddEventListenerOptions) => {
    if (type === "mousemove") mouseMoveAdds += 1;
    if (type === "mouseup") mouseUpAdds += 1;
    return origAdd(type, listener, options);
  }) as typeof window.addEventListener;
  window.removeEventListener = ((type: string, listener: EventListenerOrEventListenerObject, options?: boolean | EventListenerOptions) => {
    if (type === "mousemove") mouseMoveRemoves += 1;
    if (type === "mouseup") mouseUpRemoves += 1;
    return origRemove(type, listener, options);
  }) as typeof window.removeEventListener;

  const task = makeTask("t1");
  const sftp = {
    transfers: [task],
    activeTransfersCount: 1,
    clearCompletedTransfers: () => {},
  } as unknown as Parameters<typeof SftpTransferQueue>[0]["sftp"];

  const root = createRoot(document.getElementById("root")!);
  try {
    await act(async () => {
      root.render(
        <I18nProvider locale="en">
          <TooltipProvider>
            <SftpTransferQueue sftp={sftp} visibleTransfers={[task]} allTransfers={[task]} />
          </TooltipProvider>
        </I18nProvider>,
      );
    });

    // Zero window mousemove/mouseup listeners while idle.
    assert.equal(mouseMoveAdds, 0);
    assert.equal(mouseUpAdds, 0);

    // Non-drag global mouseup must NOT clobber document.body.style owned by another drag.
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    await act(async () => {
      window.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    });
    assert.equal(document.body.style.cursor, "col-resize");
    assert.equal(document.body.style.userSelect, "none");
    document.body.style.cursor = "";
    document.body.style.userSelect = "";

    // Start dragging the panel resize handle.
    const handle = document.querySelector(".cursor-row-resize") as HTMLElement;
    assert.ok(handle, "expected panel resize handle");
    await act(async () => {
      handle.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, clientY: 300 }));
    });
    const mouseUpAddsAfterStart = mouseUpAdds;
    const mouseUpRemovesAfterStart = mouseUpRemoves;
    assert.equal(mouseMoveAdds, 1);
    assert.ok(mouseUpAddsAfterStart >= 1);
    assert.equal(document.body.style.cursor, "row-resize");
    assert.equal(document.body.style.userSelect, "none");

    // Dragging across multiple pixels must NOT rebind window listeners or wipe body cursor.
    await act(async () => {
      window.dispatchEvent(new MouseEvent("mousemove", { bubbles: true, clientY: 280 }));
    });
    await act(async () => {
      window.dispatchEvent(new MouseEvent("mousemove", { bubbles: true, clientY: 260 }));
    });
    assert.equal(mouseMoveAdds, 1);
    assert.equal(mouseMoveRemoves, 0);
    assert.equal(mouseUpAdds, mouseUpAddsAfterStart);
    assert.equal(mouseUpRemoves, mouseUpRemovesAfterStart);
    assert.equal(document.body.style.cursor, "row-resize");

    // Ending drag removes listeners and resets body styles.
    await act(async () => {
      window.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    });
    assert.equal(mouseMoveRemoves, 1);
    assert.ok(mouseUpRemoves >= mouseUpRemovesAfterStart + 1);
    assert.equal(document.body.style.cursor, "");
    assert.equal(document.body.style.userSelect, "");

    // Unmounting mid-drag removes listeners and resets body styles.
    await act(async () => {
      handle.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, clientY: 250 }));
    });
    const mouseUpRemovesBeforeUnmount = mouseUpRemoves;
    assert.equal(mouseMoveAdds, 2);
    assert.equal(document.body.style.cursor, "row-resize");

    await act(async () => {
      root.unmount();
    });
    assert.equal(mouseMoveRemoves, 2);
    assert.ok(mouseUpRemoves >= mouseUpRemovesBeforeUnmount + 1);
    assert.equal(document.body.style.cursor, "");
    assert.equal(document.body.style.userSelect, "");
  } finally {
    window.addEventListener = origAdd;
    window.removeEventListener = origRemove;
    env.cleanup();
  }
});

test("SftpPaneView clears sftpKeyboardSelectionStore entry for pane on unmount", async () => {
  const env = setupDom();
  const { act } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { I18nProvider } = await import("../../application/i18n/I18nProvider");
  const { TooltipProvider } = await import("../ui/tooltip");
  const { SftpContextProvider } = await import("./SftpContext");
  const { SftpPaneView } = await import("./SftpPaneView");
  const { sftpKeyboardSelectionStore } = await import("./hooks/useSftpKeyboardShortcuts");

  const paneId = `pane-kb-clear-${Date.now()}`;
  sftpKeyboardSelectionStore.set(paneId, 4, 7);
  assert.deepEqual(sftpKeyboardSelectionStore.get(paneId), { anchor: 4, focus: 7 });

  const pane = {
    id: paneId,
    connection: null,
    selectedFiles: new Set<string>(),
    filter: "",
    files: [],
    loading: false,
    reconnecting: false,
    error: null,
    transferMutationToken: 0,
  };
  const noop = () => {};
  const asyncNoop = async () => {};
  const paneCallbacks = {
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

  const root = createRoot(document.getElementById("root")!);
  try {
    await act(async () => {
      root.render(
        <I18nProvider locale="en">
          <TooltipProvider>
            <SftpContextProvider
              hosts={[]}
              updateHosts={noop}
              draggedFiles={null}
              dragCallbacks={{ onDragStart: noop, onDragEnd: noop }}
              leftCallbacks={paneCallbacks}
              rightCallbacks={paneCallbacks}
            >
              <SftpPaneView
                side="left"
                pane={pane as never}
                showHeader={false}
                showEmptyHeader={false}
                sftpDefaultViewMode="list"
                onToggleShowHiddenFiles={noop}
                isPaneFocused={true}
                forceActive={true}
                dialogActionScopeId="sftp-view"
              />
            </SftpContextProvider>
          </TooltipProvider>
        </I18nProvider>,
      );
    });

    // Still present while mounted
    assert.deepEqual(sftpKeyboardSelectionStore.get(paneId), { anchor: 4, focus: 7 });

    // Cleared on unmount
    await act(async () => {
      root.unmount();
    });
    assert.deepEqual(sftpKeyboardSelectionStore.get(paneId), { anchor: 0, focus: 0 });
  } finally {
    sftpKeyboardSelectionStore.clear(paneId);
    env.cleanup();
  }

  // Also assert source-level regression guard in SftpPaneView.tsx
  const paneViewSource = readFileSync(new URL("./SftpPaneView.tsx", import.meta.url), "utf8");
  assert.match(paneViewSource, /sftpKeyboardSelectionStore\.clear\(pane\.id\)/);
});
