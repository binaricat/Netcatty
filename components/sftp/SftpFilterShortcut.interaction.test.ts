import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";

import type { SftpStateApi } from "../../application/state/useSftpState.ts";
import type { HotkeyScheme, KeyBinding } from "../../domain/models/keyBindings.ts";

test("Ctrl+F opens and refocuses the active SFTP pane filter without handling inactive panes", async () => {
  const dom = new JSDOM(
    '<!doctype html><html><body><div id="root"></div><textarea id="terminal-focus" class="xterm"></textarea></body></html>',
    { pretendToBeVisual: true, url: "http://localhost" },
  );
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
  installGlobal("KeyboardEvent", window.KeyboardEvent);
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
  const { DEFAULT_KEY_BINDINGS } = await import("../../domain/models/keyBindings.ts");
  const { sftpFocusStore } = await import("../../application/state/sftp/sftpFocusStore.ts");
  const { useSftpKeyboardShortcuts } = await import("./hooks/useSftpKeyboardShortcuts.ts");
  const { SftpPaneToolbar } = await import("./SftpPaneToolbar.tsx");

  const pane = {
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
    selectedFiles: new Set<string>(),
    filter: "",
    filenameEncoding: "auto" as const,
    showHiddenFiles: false,
    transferMutationToken: 0,
  };

  const Harness = ({
    isActive,
    hotkeyScheme = "pc",
    keyBindings = DEFAULT_KEY_BINDINGS,
  }: {
    isActive: boolean;
    hotkeyScheme?: HotkeyScheme;
    keyBindings?: KeyBinding[];
  }) => {
    const [showFilterBar, setShowFilterBar] = React.useState(false);
    const filterInputRef = React.useRef<HTMLInputElement>(null);
    const sftpRef = React.useRef({
      leftTabs: { tabs: [pane], activeTabId: pane.id },
      rightTabs: { tabs: [], activeTabId: null },
    } as unknown as SftpStateApi);

    useSftpKeyboardShortcuts({
      keyBindings,
      hotkeyScheme,
      sftpRef,
      dialogActionScopeId: "test-scope",
      isActive,
    });

    return React.createElement(
      React.Fragment,
      null,
      React.createElement("button", { id: "sftp-focus-target" }, "files"),
      React.createElement(
        "div",
        { "data-section": "terminal-sftp-path" },
        React.createElement("input", { id: "sftp-path-input", defaultValue: "/home/app" }),
      ),
      React.createElement(SftpPaneToolbar, {
        t: (key: string) => ({
          "sftp.filter": "Filter files",
          "sftp.filter.placeholder": "Filter files",
          "sftp.viewMode.switchToTree": "Switch to tree view",
          "sftp.bookmark.add": "Bookmark current path",
          "common.refresh": "Refresh",
          "common.close": "Close",
        }[key] ?? key),
        pane,
        onNavigateTo: () => {},
        onSetFilter: () => {},
        onSetFilenameEncoding: () => {},
        onRefresh: () => {},
        showFilterBar,
        setShowFilterBar,
        filterInputRef,
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
        bookmarks: [],
        isCurrentPathBookmarked: false,
        onToggleBookmark: () => {},
        onAddGlobalBookmark: () => {},
        isCurrentPathGlobalBookmarked: false,
        onNavigateToBookmark: () => {},
        onDeleteBookmark: () => {},
        showHiddenFiles: false,
        onToggleShowHiddenFiles: () => {},
        viewMode: "list",
        onSetViewMode: () => {},
      }),
    );
  };

  const rootNode = window.document.getElementById("root");
  assert.ok(rootNode);
  const root = createRoot(rootNode);
  const pressShortcut = async (
    target: Element,
    init: Pick<KeyboardEventInit, "key" | "code" | "ctrlKey" | "metaKey">,
  ) => {
    const event = new window.KeyboardEvent("keydown", {
      ...init,
      bubbles: true,
      cancelable: true,
    });
    await act(async () => {
      target.dispatchEvent(event);
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });
    return event;
  };
  const pressCtrlF = (target: Element) => pressShortcut(target, {
    key: "f",
    code: "KeyF",
    ctrlKey: true,
    metaKey: false,
  });

  try {
    sftpFocusStore.setFocusedSide("left");
    await act(async () => root.render(React.createElement(Harness, { isActive: true })));

    const sftpTarget = window.document.getElementById("sftp-focus-target");
    assert.ok(sftpTarget);
    sftpTarget.focus();
    const activeSftpEvent = await pressCtrlF(sftpTarget);
    assert.equal(activeSftpEvent.defaultPrevented, true, "active SFTP should consume its search shortcut");

    const filterInput = window.document.querySelector<HTMLInputElement>(
      '[data-section="terminal-sftp-filter-bar"] input',
    );
    assert.ok(filterInput, "Ctrl+F should open the SFTP filter bar");
    assert.equal(window.document.activeElement, filterInput, "Ctrl+F should focus the SFTP filter input");

    assert.equal((await pressCtrlF(filterInput)).defaultPrevented, true);
    assert.equal(window.document.activeElement, filterInput, "Ctrl+F in the filter should keep it focused");

    sftpTarget.focus();
    await pressCtrlF(sftpTarget);
    assert.equal(window.document.activeElement, filterInput, "repeated Ctrl+F should refocus the open filter");

    const closeButton = window.document.querySelector<HTMLButtonElement>(
      '[data-section="terminal-sftp-filter-bar"] button',
    );
    assert.ok(closeButton);
    await act(async () => closeButton.click());
    assert.equal(
      window.document.querySelector('[data-section="terminal-sftp-filter-bar"]'),
      null,
      "the filter should close normally",
    );

    const pathInput = window.document.getElementById("sftp-path-input");
    assert.ok(pathInput);
    pathInput.focus();
    assert.equal((await pressCtrlF(pathInput)).defaultPrevented, true);
    const reopenedFilterInput = window.document.querySelector<HTMLInputElement>(
      '[data-section="terminal-sftp-filter-bar"] input',
    );
    assert.ok(reopenedFilterInput, "Ctrl+F should reopen the filter after it was closed");
    assert.equal(
      window.document.activeElement,
      reopenedFilterInput,
      "a reopened filter should receive focus",
    );

    const reopenedCloseButton = window.document.querySelector<HTMLButtonElement>(
      '[data-section="terminal-sftp-filter-bar"] button',
    );
    assert.ok(reopenedCloseButton);
    await act(async () => reopenedCloseButton.click());

    const terminalTarget = window.document.getElementById("terminal-focus");
    assert.ok(terminalTarget);
    terminalTarget.focus();
    let terminalReceiverCalled = false;
    let terminalReceiverSawPrevented = false;
    const terminalReceiver = (event: KeyboardEvent) => {
      terminalReceiverCalled = true;
      terminalReceiverSawPrevented = event.defaultPrevented;
    };
    window.addEventListener("keydown", terminalReceiver);
    const staleActiveSftpEvent = await pressCtrlF(terminalTarget);
    assert.equal(staleActiveSftpEvent.defaultPrevented, false, "SFTP must not intercept terminal input");
    assert.equal(
      window.document.querySelector('[data-section="terminal-sftp-filter-bar"]'),
      null,
      "terminal input must not reopen the SFTP filter when SFTP focus state is stale",
    );
    assert.equal(terminalReceiverCalled, true, "terminal listeners should receive Ctrl+F with stale SFTP focus");
    assert.equal(terminalReceiverSawPrevented, false);
    terminalReceiverCalled = false;
    terminalReceiverSawPrevented = false;

    await act(async () => root.render(React.createElement(Harness, { isActive: false })));
    const inactiveSftpEvent = await pressCtrlF(terminalTarget);
    window.removeEventListener("keydown", terminalReceiver);
    assert.equal(
      window.document.querySelector('[data-section="terminal-sftp-filter-bar"]'),
      null,
      "an inactive SFTP pane must not consume terminal Ctrl+F",
    );
    assert.equal(inactiveSftpEvent.defaultPrevented, false, "inactive SFTP must not prevent terminal Ctrl+F");
    assert.equal(terminalReceiverCalled, true, "terminal listeners should still receive Ctrl+F");
    assert.equal(terminalReceiverSawPrevented, false, "terminal listeners should receive an unhandled Ctrl+F");

    const customKeyBindings = DEFAULT_KEY_BINDINGS.map((binding) => (
      binding.action === "searchTerminal" ? { ...binding, pc: "Ctrl + G" } : binding
    ));
    await act(async () => root.render(React.createElement(Harness, {
      isActive: true,
      keyBindings: customKeyBindings,
    })));
    sftpTarget.focus();
    assert.equal((await pressCtrlF(sftpTarget)).defaultPrevented, false);
    assert.equal(window.document.querySelector('[data-section="terminal-sftp-filter-bar"]'), null);
    assert.equal((await pressShortcut(sftpTarget, {
      key: "g",
      code: "KeyG",
      ctrlKey: true,
      metaKey: false,
    })).defaultPrevented, true, "the configured PC search shortcut should open the filter");
    assert.ok(window.document.querySelector('[data-section="terminal-sftp-filter-bar"]'));

    await act(async () => root.render(React.createElement(Harness, {
      isActive: true,
      hotkeyScheme: "disabled",
    })));
    const disabledCloseButton = window.document.querySelector<HTMLButtonElement>(
      '[data-section="terminal-sftp-filter-bar"] button',
    );
    assert.ok(disabledCloseButton);
    await act(async () => disabledCloseButton.click());
    assert.equal((await pressCtrlF(sftpTarget)).defaultPrevented, false);
    assert.equal(window.document.querySelector('[data-section="terminal-sftp-filter-bar"]'), null);

    await act(async () => root.render(React.createElement(Harness, {
      isActive: true,
      hotkeyScheme: "mac",
    })));
    assert.equal((await pressShortcut(sftpTarget, {
      key: "f",
      code: "KeyF",
      ctrlKey: false,
      metaKey: true,
    })).defaultPrevented, true, "the configured Mac search shortcut should open the filter");
    assert.ok(window.document.querySelector('[data-section="terminal-sftp-filter-bar"]'));
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
    for (const [key, descriptor] of previousGlobals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete (globalThis as Record<string, unknown>)[key];
    }
  }
});
