import test from "node:test";
import assert from "node:assert/strict";

import { enSystemManagerMessages } from "./en/systemManager";
import { enTerminalMessages } from "./en/terminal";
import { ruSystemManagerMessages } from "./ru/systemManager";
import { ruTerminalMessages } from "./ru/terminal";
import { zhCnSystemManagerMessages } from "./zh-CN/systemManager";
import { zhCNVaultMessages } from "./zh-CN/vault";
import { zhTwSystemManagerMessages } from "./zh-TW/systemManager";
import { zhTWVaultMessages } from "./zh-TW/vault";

test("SSH stats response time is explicit in every locale and UI surface", () => {
  const labels = [
    [enTerminalMessages, enSystemManagerMessages, "SSH stats response time"],
    [ruTerminalMessages, ruSystemManagerMessages, "Время ответа статистики SSH"],
    [zhCNVaultMessages, zhCnSystemManagerMessages, "SSH 统计响应时间"],
    [zhTWVaultMessages, zhTwSystemManagerMessages, "SSH 統計回應時間"],
  ] as const;

  for (const [terminalMessages, systemManagerMessages, expected] of labels) {
    assert.equal(terminalMessages["terminal.serverStats.latency"], expected);
    assert.equal(systemManagerMessages["systemManager.overview.latency"], expected);
  }
});
