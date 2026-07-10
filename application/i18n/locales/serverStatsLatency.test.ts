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

test("network latency is explicit in every locale and UI surface", () => {
  const labels = [
    [enTerminalMessages, enSystemManagerMessages, "Network latency"],
    [ruTerminalMessages, ruSystemManagerMessages, "Сетевая задержка"],
    [zhCNVaultMessages, zhCnSystemManagerMessages, "网络延迟"],
    [zhTWVaultMessages, zhTwSystemManagerMessages, "網路延遲"],
  ] as const;

  for (const [terminalMessages, systemManagerMessages, expected] of labels) {
    assert.equal(terminalMessages["terminal.serverStats.latency"], expected);
    assert.equal(systemManagerMessages["systemManager.overview.latency"], expected);
  }
});
