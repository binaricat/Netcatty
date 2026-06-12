import test from "node:test";
import assert from "node:assert/strict";

import en from "../../application/i18n/locales/en.ts";
import zhCN from "../../application/i18n/locales/zh-CN.ts";
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
