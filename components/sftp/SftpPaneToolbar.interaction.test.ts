import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";

test("selecting an inline SFTP bookmark closes its popover", async () => {
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
  const { SftpPaneToolbar } = await import("./SftpPaneToolbar.tsx");
  const rootNode = window.document.getElementById("root");
  assert.ok(rootNode);
  const root = createRoot(rootNode);
  const navigatedPaths: string[] = [];

  try {
    await act(async () => {
      root.render(
        React.createElement(SftpPaneToolbar, {
          t: (key) => ({
            "sftp.bookmark.list": "Bookmarked paths",
            "sftp.bookmark.remove": "Remove bookmark",
            "sftp.viewMode.switchToTree": "Switch to tree view",
          }[key] ?? key),
          pane: {
            id: "pane-1",
            connection: {
              id: "conn-1",
              hostId: "host-1",
              name: "Example",
              currentPath: "/home/app",
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
          bookmarks: [{ id: "bm-1", path: "/srv/www", label: "Web root" }],
          isCurrentPathBookmarked: false,
          onToggleBookmark: () => {},
          onAddGlobalBookmark: () => {},
          isCurrentPathGlobalBookmarked: false,
          onNavigateToBookmark: (path) => navigatedPaths.push(path),
          onDeleteBookmark: () => {},
          showHiddenFiles: false,
          onToggleShowHiddenFiles: () => {},
          viewMode: "list",
          onSetViewMode: () => {},
        }),
      );
    });

    const trigger = window.document.querySelector<HTMLButtonElement>(
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
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
    for (const [key, descriptor] of previousGlobals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete (globalThis as Record<string, unknown>)[key];
    }
  }
});
