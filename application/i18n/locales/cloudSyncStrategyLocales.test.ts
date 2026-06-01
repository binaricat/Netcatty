import test from "node:test";
import assert from "node:assert/strict";

import en from "../locales/en.ts";
import ru from "../locales/ru.ts";
import zhCN from "../locales/zh-CN.ts";

const strategyKeys = [
  "cloudSync.strategy.title",
  "cloudSync.strategy.desc",
  "cloudSync.strategy.smartMerge",
  "cloudSync.strategy.smartMergeDesc",
  "cloudSync.strategy.preferCloud",
  "cloudSync.strategy.preferCloudDesc",
  "cloudSync.strategy.preferLocal",
  "cloudSync.strategy.preferLocalDesc",
] as const;

test("cloud sync strategy copy exists in every bundled locale", () => {
  for (const [locale, messages] of Object.entries({ en, ru, zhCN })) {
    for (const key of strategyKeys) {
      assert.equal(
        typeof messages[key],
        "string",
        `${locale} is missing ${key}`,
      );
      assert.notEqual(messages[key], "", `${locale} has empty ${key}`);
    }
  }
});
