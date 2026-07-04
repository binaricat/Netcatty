import test from "node:test";
import assert from "node:assert/strict";

import en from "../../application/i18n/locales/en.ts";
import ru from "../../application/i18n/locales/ru.ts";
import zhCN from "../../application/i18n/locales/zh-CN.ts";
import { markMiddleClickContextMenuEvent } from "./runtime/middleClickBehavior.ts";
import * as terminalContextMenu from "./TerminalContextMenu.tsx";
import { shouldEnableYmodemAction } from "./TerminalView.tsx";

const shouldShowReconnectAction = (
  terminalContextMenu as {
    shouldShowReconnectAction?: (options: {
      isReconnectable?: boolean;
      onReconnect?: () => void;
    }) => boolean;
  }
).shouldShowReconnectAction;
const shouldSuppressMouseTrackingContextMenu = (
  terminalContextMenu as {
    shouldSuppressMouseTrackingContextMenu?: (options: {
      isAlternateScreen?: boolean;
      showReconnectAction?: boolean;
    }) => boolean;
  }
).shouldSuppressMouseTrackingContextMenu;
const shouldShowAddSelectionToAIContextMenuAction = (
  terminalContextMenu as {
    shouldShowAddSelectionToAIContextMenuAction?: (onAddSelectionToAI?: () => void) => boolean;
  }
).shouldShowAddSelectionToAIContextMenuAction;
const shouldShowUploadClipboardImageContextMenuAction = (
  terminalContextMenu as {
    shouldShowUploadClipboardImageContextMenuAction?: (onUploadClipboardImage?: () => void) => boolean;
  }
).shouldShowUploadClipboardImageContextMenuAction;
const shouldOpenTerminalContextMenu = (
  terminalContextMenu as {
    shouldOpenTerminalContextMenu?: (options: {
      event: { shiftKey?: boolean; nativeEvent: MouseEvent };
      rightClickBehavior?: "context-menu" | "paste" | "select-word";
      isAlternateScreen?: boolean;
      showReconnectAction?: boolean;
    }) => boolean;
  }
).shouldOpenTerminalContextMenu;
const shouldRenderTerminalContextMenuContent = (
  terminalContextMenu as {
    shouldRenderTerminalContextMenuContent?: (options: {
      isAlternateScreen?: boolean;
      showReconnectAction?: boolean;
      allowSuppressedMenuContent?: boolean;
    }) => boolean;
  }
).shouldRenderTerminalContextMenuContent;
const shouldAllowSuppressedTerminalContextMenuContent = (
  terminalContextMenu as {
    shouldAllowSuppressedTerminalContextMenuContent?: (options: {
      event: { shiftKey?: boolean; nativeEvent: MouseEvent };
      isAlternateScreen?: boolean;
      showReconnectAction?: boolean;
    }) => boolean;
  }
).shouldAllowSuppressedTerminalContextMenuContent;

test("shows reconnect only for reconnectable terminals with a handler", () => {
  assert.equal(typeof shouldShowReconnectAction, "function");
  if (typeof shouldShowReconnectAction !== "function") return;

  assert.equal(
    shouldShowReconnectAction({
      isReconnectable: true,
      onReconnect: () => {},
    }),
    true,
  );
  assert.equal(
    shouldShowReconnectAction({
      isReconnectable: false,
      onReconnect: () => {},
    }),
    false,
  );
  assert.equal(shouldShowReconnectAction({ isReconnectable: true }), false);
});

test("localizes the reconnect context menu label", () => {
  assert.equal(en["terminal.menu.reconnect"], "Reconnect");
  assert.equal(zhCN["terminal.menu.reconnect"], "重新连接");
});

test("shows add selection to AI context menu action when a handler exists", () => {
  assert.equal(typeof shouldShowAddSelectionToAIContextMenuAction, "function");
  if (typeof shouldShowAddSelectionToAIContextMenuAction !== "function") return;

  assert.equal(shouldShowAddSelectionToAIContextMenuAction(() => {}), true);
  assert.equal(shouldShowAddSelectionToAIContextMenuAction(), false);
});

test("shows upload clipboard image context menu action when a handler exists", () => {
  assert.equal(typeof shouldShowUploadClipboardImageContextMenuAction, "function");
  if (typeof shouldShowUploadClipboardImageContextMenuAction !== "function") return;

  assert.equal(shouldShowUploadClipboardImageContextMenuAction(() => {}), true);
  assert.equal(shouldShowUploadClipboardImageContextMenuAction(), false);
});

test("localizes the upload clipboard image context menu label", () => {
  const locales = { en, ru, "zh-CN": zhCN };
  const keys = [
    "terminal.menu.uploadClipboardImage",
    "terminal.clipboardImageUpload.noImage",
    "terminal.clipboardImageUpload.failed",
  ] as const;

  for (const [locale, messages] of Object.entries(locales)) {
    for (const key of keys) {
      assert.equal(
        typeof messages[key],
        "string",
        `${locale} should include ${key}`,
      );
      assert.notEqual(messages[key], "", `${locale} should not leave ${key} empty`);
      assert.notEqual(messages[key], key, `${locale} should translate ${key}`);
    }
  }

  assert.equal(en["terminal.menu.uploadClipboardImage"], "Upload clipboard image");
  assert.equal(zhCN["terminal.menu.uploadClipboardImage"], "上传剪贴板图片");
  assert.equal(ru["terminal.menu.uploadClipboardImage"], "Загрузить изображение из буфера");
});

test("localizes the YMODEM serial send actions", () => {
  assert.equal(en["terminal.menu.sendYmodem"], "Send with YMODEM");
  assert.equal(en["terminal.menu.receiveYmodem"], "Receive with YMODEM");
  assert.equal(en["terminal.toolbar.sendYmodem"], "Send with YMODEM");
  assert.equal(en["terminal.toolbar.receiveYmodem"], "Receive with YMODEM");
  assert.equal(zhCN["terminal.menu.sendYmodem"], "YMODEM 发送");
  assert.equal(zhCN["terminal.menu.receiveYmodem"], "YMODEM 接收");
  assert.equal(zhCN["terminal.toolbar.sendYmodem"], "YMODEM 发送");
  assert.equal(zhCN["terminal.toolbar.receiveYmodem"], "YMODEM 接收");
});

test("enables YMODEM action only for connected serial terminals", () => {
  const handler = () => {};

  assert.equal(shouldEnableYmodemAction({
    isSerialConnection: true,
    status: "connected",
    handleSendYmodem: handler,
  }), true);
  assert.equal(shouldEnableYmodemAction({
    isSerialConnection: true,
    status: "connected",
    handleReceiveYmodem: handler,
  }), true);
  assert.equal(shouldEnableYmodemAction({
    isSerialConnection: true,
    status: "disconnected",
    handleReceiveYmodem: handler,
  }), false);
  assert.equal(shouldEnableYmodemAction({
    isSerialConnection: true,
    status: "disconnected",
    handleSendYmodem: handler,
  }), false);
  assert.equal(shouldEnableYmodemAction({
    isSerialConnection: false,
    status: "connected",
    handleSendYmodem: handler,
  }), false);
  assert.equal(shouldEnableYmodemAction({
    isSerialConnection: true,
    status: "connected",
  }), false);
});

test("allows reconnect menu while stale mouse tracking is still active", () => {
  assert.equal(typeof shouldSuppressMouseTrackingContextMenu, "function");
  if (typeof shouldSuppressMouseTrackingContextMenu !== "function") return;

  assert.equal(
    shouldSuppressMouseTrackingContextMenu({
      isAlternateScreen: true,
      showReconnectAction: true,
    }),
    false,
  );
  assert.equal(
    shouldSuppressMouseTrackingContextMenu({
      isAlternateScreen: true,
      showReconnectAction: false,
    }),
    true,
  );
});

test("opens a middle-click menu even when right-click is configured to paste", () => {
  assert.equal(typeof shouldOpenTerminalContextMenu, "function");
  if (typeof shouldOpenTerminalContextMenu !== "function") return;

  assert.equal(
    shouldOpenTerminalContextMenu({
      event: {
        shiftKey: false,
        nativeEvent: markMiddleClickContextMenuEvent({} as MouseEvent),
      },
      rightClickBehavior: "paste",
    }),
    true,
  );

  assert.equal(
    shouldOpenTerminalContextMenu({
      event: {
        shiftKey: false,
        nativeEvent: {} as MouseEvent,
      },
      rightClickBehavior: "paste",
    }),
    false,
  );
});

test("opens and renders middle-click menu while alternate-screen mouse tracking suppresses right-click menus", () => {
  assert.equal(typeof shouldOpenTerminalContextMenu, "function");
  assert.equal(typeof shouldRenderTerminalContextMenuContent, "function");
  assert.equal(typeof shouldAllowSuppressedTerminalContextMenuContent, "function");
  if (
    typeof shouldOpenTerminalContextMenu !== "function" ||
    typeof shouldRenderTerminalContextMenuContent !== "function" ||
    typeof shouldAllowSuppressedTerminalContextMenuContent !== "function"
  ) {
    return;
  }

  const middleClickEvent = {
    shiftKey: false,
    nativeEvent: markMiddleClickContextMenuEvent({} as MouseEvent),
  };

  assert.equal(
    shouldOpenTerminalContextMenu({
      event: middleClickEvent,
      rightClickBehavior: "paste",
      isAlternateScreen: true,
      showReconnectAction: false,
    }),
    true,
  );
  const allowSuppressedMenuContent = shouldAllowSuppressedTerminalContextMenuContent({
    event: middleClickEvent,
    isAlternateScreen: true,
    showReconnectAction: false,
  });
  assert.equal(allowSuppressedMenuContent, true);
  assert.equal(
    shouldRenderTerminalContextMenuContent({
      isAlternateScreen: true,
      showReconnectAction: false,
      allowSuppressedMenuContent,
    }),
    true,
  );

  assert.equal(
    shouldOpenTerminalContextMenu({
      event: {
        shiftKey: false,
        nativeEvent: {} as MouseEvent,
      },
      rightClickBehavior: "context-menu",
      isAlternateScreen: true,
      showReconnectAction: false,
    }),
    false,
  );
  assert.equal(
    shouldAllowSuppressedTerminalContextMenuContent({
      event: {
        nativeEvent: {} as MouseEvent,
      },
      isAlternateScreen: true,
      showReconnectAction: false,
    }),
    false,
  );
  assert.equal(
    shouldRenderTerminalContextMenuContent({
      isAlternateScreen: true,
      showReconnectAction: false,
      allowSuppressedMenuContent: false,
    }),
    false,
  );
});

test("opens Shift right-click menu content for all right-click modes while mouse tracking suppresses unmodified menus", () => {
  assert.equal(typeof shouldOpenTerminalContextMenu, "function");
  assert.equal(typeof shouldRenderTerminalContextMenuContent, "function");
  assert.equal(typeof shouldAllowSuppressedTerminalContextMenuContent, "function");
  if (
    typeof shouldOpenTerminalContextMenu !== "function" ||
    typeof shouldRenderTerminalContextMenuContent !== "function" ||
    typeof shouldAllowSuppressedTerminalContextMenuContent !== "function"
  ) {
    return;
  }

  const event = {
    shiftKey: true,
    nativeEvent: {} as MouseEvent,
  };

  for (const rightClickBehavior of ["context-menu", "paste", "select-word"] as const) {
    assert.equal(
      shouldOpenTerminalContextMenu({
        event,
        rightClickBehavior,
        isAlternateScreen: true,
        showReconnectAction: false,
      }),
      true,
    );

    const allowSuppressedMenuContent = shouldAllowSuppressedTerminalContextMenuContent({
      event,
      isAlternateScreen: true,
      showReconnectAction: false,
    });

    assert.equal(allowSuppressedMenuContent, true);
    assert.equal(
      shouldRenderTerminalContextMenuContent({
        isAlternateScreen: true,
        showReconnectAction: false,
        allowSuppressedMenuContent,
      }),
      true,
    );
  }

  assert.equal(
    shouldOpenTerminalContextMenu({
      event: {
        nativeEvent: {} as MouseEvent,
      },
      rightClickBehavior: "context-menu",
      isAlternateScreen: true,
      showReconnectAction: false,
    }),
    false,
  );
  assert.equal(
    shouldAllowSuppressedTerminalContextMenuContent({
      event: {
        nativeEvent: {} as MouseEvent,
      },
      isAlternateScreen: true,
      showReconnectAction: false,
    }),
    false,
  );
});
