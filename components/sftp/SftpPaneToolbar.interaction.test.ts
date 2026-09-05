import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";

test("inline bookmark actions navigate and confirm current-path removal", async () => {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    pretendToBeVisual: true,
    url: "http://localhost",
  });
  const window = dom.window;
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

  installGlobal("window", window);
  installGlobal("document", window.document);
  installGlobal("navigator", window.navigator);
  installGlobal("HTMLElement", window.HTMLElement);
  installGlobal("HTMLInputElement", window.HTMLInputElement);
  installGlobal("HTMLTextAreaElement", window.HTMLTextAreaElement);
  installGlobal("Element", window.Element);
  installGlobal("SVGElement", window.SVGElement);
  installGlobal("Node", window.Node);
  installGlobal("NodeFilter", window.NodeFilter);
  installGlobal("MutationObserver", window.MutationObserver);
  installGlobal("CustomEvent", window.CustomEvent);
  installGlobal("Event", window.Event);
  installGlobal("StorageEvent", window.StorageEvent);
  installGlobal("localStorage", window.localStorage);
  installGlobal("sessionStorage", window.sessionStorage);
  installGlobal("getComputedStyle", window.getComputedStyle.bind(window));
  installGlobal("requestAnimationFrame", window.requestAnimationFrame.bind(window));
  installGlobal("cancelAnimationFrame", window.cancelAnimationFrame.bind(window));
  installGlobal("ResizeObserver", ResizeObserverStub);
  installGlobal("IS_REACT_ACT_ENVIRONMENT", true);

  const { default: React, act } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { I18nProvider } = await import("../../application/i18n/I18nProvider.tsx");
  const { SftpPaneToolbar } = await import("./SftpPaneToolbar.tsx");
  const rootNode = window.document.getElementById("root");
  assert.ok(rootNode);
  const root = createRoot(rootNode);
  const navigatedPaths: string[] = [];
  const deletedBookmarkIds: string[] = [];
  let toggleBookmarkCalls = 0;
  const waitForFocusRestore = async () => {
    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 20));
    });
  };
  const setBookmarkPlacement = async (placement: "show" | "collapse") => {
    window.localStorage.setItem("netcatty_sftp_toolbar_layout_v1", JSON.stringify({
      order: ["bookmark"],
      placement: { bookmark: placement },
    }));
    await act(async () => {
      window.dispatchEvent(new window.StorageEvent("storage", {
        key: "netcatty_sftp_toolbar_layout_v1",
      }));
    });
  };
  const findRemovalDialog = () => Array.from(window.document.querySelectorAll("h2"))
    .find((heading) => heading.textContent?.trim() === "Remove bookmark")
    ?.closest<HTMLElement>('[role="dialog"]') ?? null;

  const renderToolbar = async (currentPath: string, currentPathBookmarked: boolean) => {
    await act(async () => {
      const toolbar = React.createElement(SftpPaneToolbar, {
        t: (key, params) => ({
          "sftp.bookmark.list": "Bookmarked paths",
          "sftp.bookmark.remove": "Remove bookmark",
          "sftp.bookmark.removeConfirm": `Remove bookmark ${params?.path ?? ""}?`,
          "sftp.viewMode.switchToTree": "Switch to tree view",
        }[key] ?? key),
        pane: {
          id: "pane-1",
          connection: {
            id: "conn-1",
            hostId: "host-1",
            name: "Example",
            currentPath,
            homeDir: "/home/app",
            isLocal: false,
          },
          files: [],
          loading: false,
          reconnecting: false,
          error: null,
          connectionLogs: [],
          selectedFiles: new Set(),
          filter: "",
          filenameEncoding: "auto",
          showHiddenFiles: false,
          transferMutationToken: 0,
        },
        onNavigateTo: () => {},
        onSetFilter: () => {},
        onSetFilenameEncoding: () => {},
        onRefresh: () => {},
        showFilterBar: false,
        setShowFilterBar: () => {},
        filterInputRef: { current: null },
        isEditingPath: false,
        editingPathValue: "",
        setEditingPathValue: () => {},
        setShowPathSuggestions: () => {},
        showPathSuggestions: false,
        setPathSuggestionIndex: () => {},
        pathSuggestions: [],
        pathSuggestionIndex: -1,
        pathInputRef: { current: null },
        pathDropdownRef: { current: null },
        handlePathBlur: () => {},
        handlePathKeyDown: () => {},
        handlePathDoubleClick: () => {},
        handlePathSubmit: () => {},
        getNextUntitledName: () => "untitled",
        setNewFileName: () => {},
        setFileNameError: () => {},
        setShowNewFileDialog: () => {},
        setShowNewFolderDialog: () => {},
        setNewFolderName: () => {},
        bookmarks: [
          { id: "bm-current", path: "/home/app", label: "App root" },
          { id: "bm-1", path: "/srv/www", label: "Web root" },
        ],
        isCurrentPathBookmarked: currentPathBookmarked,
        onToggleBookmark: () => {
          toggleBookmarkCalls += 1;
        },
        onAddGlobalBookmark: () => {},
        isCurrentPathGlobalBookmarked: false,
        onNavigateToBookmark: (path) => navigatedPaths.push(path),
        onDeleteBookmark: (bookmark) => deletedBookmarkIds.push(bookmark.id),
        showHiddenFiles: false,
        onToggleShowHiddenFiles: () => {},
        viewMode: "list",
        onSetViewMode: () => {},
      });
      root.render(React.createElement(I18nProvider, { locale: "en" }, toolbar));
    });
  };

  try {
    await renderToolbar("/home/app", true);

    let trigger = window.document.querySelector<HTMLButtonElement>(
      'button[aria-label="Bookmarked paths"]',
    );
    assert.ok(trigger);
    await act(async () => trigger.click());

    const bookmark = Array.from(window.document.querySelectorAll("button")).find((button) =>
      button.textContent?.includes("Web root"),
    );
    assert.ok(bookmark, "bookmark path should be visible after opening the popover");
    await act(async () => bookmark.click());

    assert.deepEqual(navigatedPaths, ["/srv/www"]);
    assert.equal(
      Array.from(window.document.querySelectorAll("button")).some((button) =>
        button.textContent?.includes("Web root"),
      ),
      false,
      "bookmark popover should close after selecting a path",
    );

    await act(async () => trigger.click());
    const removeCurrentPath = Array.from(window.document.querySelectorAll("button")).find(
      (button) => button.textContent?.trim() === "Remove bookmark",
    );
    assert.ok(removeCurrentPath, "current-path bookmark removal should be visible");
    removeCurrentPath.focus();
    await act(async () => removeCurrentPath.click());

    let dialog = findRemovalDialog();
    assert.ok(dialog, "current-path removal should open an in-app dialog");
    assert.match(dialog.textContent ?? "", /Remove bookmark \/home\/app\?/);
    assert.equal(
      Array.from(window.document.querySelectorAll("button")).some((button) =>
        button.textContent?.includes("Web root"),
      ),
      false,
      "the bookmark popover must close before the dialog opens",
    );
    assert.equal(toggleBookmarkCalls, 0, "opening the dialog must not remove the bookmark");

    const cancel = Array.from(dialog.querySelectorAll("button")).find(
      (button) => button.textContent?.trim() === "Cancel",
    );
    assert.ok(cancel);
    await setBookmarkPlacement("collapse");
    const overflowTriggerAfterLayoutChange = window.document.querySelector<HTMLButtonElement>(
      'button[data-toolbar-overflow-trigger="true"]',
    );
    assert.ok(overflowTriggerAfterLayoutChange);
    await act(async () => cancel.click());
    await waitForFocusRestore();
    assert.equal(findRemovalDialog(), null);
    assert.equal(toggleBookmarkCalls, 0, "cancelling must preserve the bookmark");
    assert.equal(
      window.document.activeElement,
      overflowTriggerAfterLayoutChange,
      "cancel should fall back to the newly mounted overflow trigger",
    );

    await setBookmarkPlacement("show");
    trigger = window.document.querySelector<HTMLButtonElement>(
      'button[aria-label="Bookmarked paths"]',
    );
    assert.ok(trigger);

    await act(async () => trigger.click());
    const removeCurrentPathAfterCancel = Array.from(
      window.document.querySelectorAll("button"),
    ).find((button) => button.textContent?.trim() === "Remove bookmark");
    assert.ok(removeCurrentPathAfterCancel);
    await act(async () => removeCurrentPathAfterCancel.click());
    dialog = findRemovalDialog();
    assert.ok(dialog, "the removal dialog should reopen after cancellation");
    await renderToolbar("/home/other", false);
    dialog = findRemovalDialog();
    assert.ok(dialog, "changing directory must not replace the pending removal target");
    assert.match(dialog.textContent ?? "", /Remove bookmark \/home\/app\?/);
    assert.doesNotMatch(dialog.textContent ?? "", /\/home\/other/);
    const confirm = Array.from(dialog.querySelectorAll("button")).find(
      (button) => button.textContent?.trim() === "Remove bookmark",
    );
    assert.ok(confirm);
    await act(async () => confirm.click());
    assert.deepEqual(deletedBookmarkIds, ["bm-current"]);
    assert.equal(toggleBookmarkCalls, 0, "confirmation must not toggle the new current path");
    assert.equal(findRemovalDialog(), null);
    await waitForFocusRestore();
    assert.equal(window.document.activeElement, trigger, "confirm should restore the bookmark trigger");

    await act(async () => trigger.click());
    const webRootRow = Array.from(
      window.document.querySelectorAll<HTMLElement>("[data-bookmark-scope]"),
    ).find((element) => element.textContent?.includes("Web root"));
    const removeWebRoot = webRootRow?.querySelector<HTMLButtonElement>(
      'button[aria-label="Remove bookmark"]',
    );
    assert.ok(removeWebRoot);
    await act(async () => removeWebRoot.click());
    dialog = findRemovalDialog();
    assert.ok(dialog, "row removal should use the shared in-app dialog");
    assert.match(dialog.textContent ?? "", /Remove bookmark \/srv\/www\?/);
    assert.equal(webRootRow.isConnected, false, "row removal must close the bookmark popover");
    const confirmWebRoot = Array.from(dialog.querySelectorAll("button")).find(
      (button) => button.textContent?.trim() === "Remove bookmark",
    );
    assert.ok(confirmWebRoot);
    await act(async () => confirmWebRoot.click());
    assert.deepEqual(deletedBookmarkIds, ["bm-current", "bm-1"]);
    await waitForFocusRestore();
    assert.equal(window.document.activeElement, trigger, "row removal should restore the bookmark trigger");

    await setBookmarkPlacement("collapse");
    const overflowTrigger = window.document.querySelector<HTMLButtonElement>(
      'button[data-toolbar-overflow-trigger="true"]',
    );
    assert.ok(overflowTrigger, "collapsed bookmark should expose the overflow trigger");
    await act(async () => overflowTrigger.click());
    const nestedBookmarkTrigger = window.document.querySelector<HTMLButtonElement>(
      'button[aria-label="Bookmarked paths"]',
    );
    assert.ok(nestedBookmarkTrigger, "overflow should expose the nested bookmark trigger");
    await act(async () => nestedBookmarkTrigger.click());
    const overflowWebRootRow = Array.from(
      window.document.querySelectorAll<HTMLElement>("[data-bookmark-scope]"),
    ).find((element) => element.textContent?.includes("Web root"));
    const removeOverflowWebRoot = overflowWebRootRow?.querySelector<HTMLButtonElement>(
      'button[aria-label="Remove bookmark"]',
    );
    assert.ok(removeOverflowWebRoot);
    removeOverflowWebRoot.focus();
    await act(async () => removeOverflowWebRoot.click());
    dialog = findRemovalDialog();
    assert.ok(dialog, "overflow row removal should open the shared dialog");
    const cancelOverflowRemoval = Array.from(dialog.querySelectorAll("button")).find(
      (button) => button.textContent?.trim() === "Cancel",
    );
    assert.ok(cancelOverflowRemoval);
    await act(async () => cancelOverflowRemoval.click());
    await waitForFocusRestore();
    assert.equal(
      window.document.activeElement,
      overflowTrigger,
      "overflow removal should restore the persistent overflow trigger",
    );
    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 300));
    });
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
    for (const [key, descriptor] of previousGlobals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete (globalThis as Record<string, unknown>)[key];
    }
  }
});
