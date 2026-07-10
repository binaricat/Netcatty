import test from "node:test";
import assert from "node:assert/strict";

import { enTerminalMessages } from "./en/terminal";
import { zhCNVaultMessages } from "./zh-CN/vault";
import { zhTWVaultMessages } from "./zh-TW/vault";

test("server stats response time is not labeled as generic network latency", () => {
  assert.equal(
    enTerminalMessages["terminal.serverStats.latency"],
    "SSH stats response time",
  );
  assert.equal(
    zhCNVaultMessages["terminal.serverStats.latency"],
    "SSH 统计响应时间",
  );
  assert.equal(
    zhTWVaultMessages["terminal.serverStats.latency"],
    "SSH 統計回應時間",
  );
});
