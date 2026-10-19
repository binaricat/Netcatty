import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { enMonitorMessages } from "./en/monitor";
import { esMonitorMessages } from "./es/monitor";
import { ruMonitorMessages } from "./ru/monitor";
import { zhCNMonitorMessages } from "./zh-CN/monitor";
import { zhTWMonitorMessages } from "./zh-TW/monitor";

test("monitoring UI literal message keys exist, including editor-only controls", () => {
  for (const name of ["MonitorPanels", "MonitorNavButton", "MonitorDiskUsage"]) {
    const source = readFileSync(new URL(`../../../components/vault/${name}.tsx`, import.meta.url), "utf8");
    const keys = [...source.matchAll(/\bt\("(monitor\.[^"]+)"/g)].map((match) => match[1]);
    for (const key of keys)
      assert.ok(Object.hasOwn(enMonitorMessages, key), `${name}: ${key}`);
  }
});
for (const [locale, messages] of Object.entries({
  es: esMonitorMessages,
  ru: ruMonitorMessages,
  "zh-CN": zhCNMonitorMessages,
  "zh-TW": zhTWMonitorMessages,
})) {
  test(`monitoring has translated actions, states and matching placeholders in ${locale}`, () => {
    assert.deepEqual(
      Object.keys(messages).sort(),
      Object.keys(enMonitorMessages).sort(),
    );
    for (const key of Object.keys(enMonitorMessages)) {
      const english = enMonitorMessages[key as keyof typeof enMonitorMessages];
      const translated = messages[key as keyof typeof messages];
      assert.ok(translated.trim(), key);
      assert.deepEqual(
        (translated.match(/\{\w+\}/g) ?? []).sort(),
        (english.match(/\{\w+\}/g) ?? []).sort(),
        key,
      );
    }
  });
}
