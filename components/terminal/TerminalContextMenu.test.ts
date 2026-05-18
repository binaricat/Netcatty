import test from "node:test";
import assert from "node:assert/strict";

import en from "../../application/i18n/locales/en.ts";
import zhCN from "../../application/i18n/locales/zh-CN.ts";
import * as terminalContextMenu from "./TerminalContextMenu.tsx";

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
