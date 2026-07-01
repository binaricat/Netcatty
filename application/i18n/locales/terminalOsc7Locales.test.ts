import test from "node:test";
import assert from "node:assert/strict";

import en from "./en.ts";
import ru from "./ru.ts";
import zhCN from "./zh-CN.ts";

const osc7Keys = [
  "terminal.toolbar.configureOsc7",
  "terminal.osc7Setup.title",
  "terminal.osc7Setup.desc",
  "terminal.osc7Setup.targets",
  "terminal.osc7Setup.command",
  "terminal.osc7Setup.run",
  "terminal.osc7Setup.running",
  "terminal.osc7Setup.configured",
  "terminal.osc7Setup.failed",
  "terminal.osc7Setup.sent",
] as const;

test("OSC 7 setup copy exists in every bundled locale", () => {
  for (const [locale, messages] of Object.entries({ en, ru, zhCN })) {
    for (const key of osc7Keys) {
      assert.equal(typeof messages[key], "string", `${locale} is missing ${key}`);
      assert.notEqual(messages[key], "", `${locale} has empty ${key}`);
    }
  }
});
