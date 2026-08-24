import test from "node:test";
import assert from "node:assert/strict";

import { enTerminalMessages } from "./en/terminal";
import { esTerminalMessages } from "./es/terminal";
import { ruTerminalMessages } from "./ru/terminal";
import { zhCNTerminalMessages } from "./zh-CN/terminal";
import { zhTWTerminalMessages } from "./zh-TW/terminal";

test("terminal reconnect notices are localized in every bundled language", () => {
  const messages = [
    enTerminalMessages,
    esTerminalMessages,
    ruTerminalMessages,
    zhCNTerminalMessages,
    zhTWTerminalMessages,
  ];
  const keys = [
    "terminal.progress.enterReconnectHint",
    "terminal.progress.reconnecting",
    "terminal.progress.autoReconnectScheduled",
    "terminal.progress.autoReconnectAttempt",
  ];

  for (const locale of messages) {
    for (const key of keys) {
      assert.equal(typeof locale[key], "string", `missing ${key}`);
      assert.notEqual(locale[key]?.trim(), "", `empty ${key}`);
    }
  }
});
