import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { describePluginGitHubInstallError } from "../../../domain/pluginGitHubInstallError.ts";
import { SUPPORTED_UI_LOCALES } from "../../../infrastructure/config/i18n.ts";
import { getLoadedLocaleMessages, loadLocaleMessages } from "../messages.ts";
import en from "./en.ts";
import { enMonitorMessages } from "./en/monitor.ts";
import { enSystemManagerMessages } from "./en/systemManager.ts";
import { enTerminalMessages } from "./en/terminal.ts";
import es from "./es.ts";
import { esMonitorMessages } from "./es/monitor.ts";
import { esSystemManagerMessages } from "./es/systemManager.ts";
import { esTerminalMessages } from "./es/terminal.ts";
import ru from "./ru.ts";
import { ruMonitorMessages } from "./ru/monitor.ts";
import { ruSystemManagerMessages } from "./ru/systemManager.ts";
import { ruTerminalMessages } from "./ru/terminal.ts";
import zhCN from "./zh-CN.ts";
import { zhCNMonitorMessages } from "./zh-CN/monitor.ts";
import { zhCnSystemManagerMessages } from "./zh-CN/systemManager.ts";
import { zhCNVaultMessages } from "./zh-CN/vault.ts";
import zhTW from "./zh-TW.ts";
import { zhTWMonitorMessages } from "./zh-TW/monitor.ts";
import { zhTwSystemManagerMessages } from "./zh-TW/systemManager.ts";
import { zhTWVaultMessages } from "./zh-TW/vault.ts";

const ALL_LOCALES = {
  en,
  es,
  ru,
  "zh-CN": zhCN,
  "zh-TW": zhTW,
} as const;

test("disconnect confirm copy states that saved provider credentials are removed and local data stays", () => {
  const expected = [
    [en, "will be removed"],
    [es, "eliminarán"],
    [ru, "будут удалены"],
    [zhCN, "删除"],
    [zhTW, "刪除"],
  ] as const;
  for (const [messages, fragment] of expected) {
    assert.ok(
      messages["cloudSync.provider.disconnect.confirmMessage"]?.includes(fragment),
      `confirmMessage should mention credential removal: ${fragment}`,
    );
  }
  assert.match(
    en["cloudSync.provider.disconnect.confirmMessage"],
    /backup history and sync encryption password stay here/,
  );
  assert.doesNotMatch(en["cloudSync.provider.disconnect.cloudRemains"], /change.*password/);
});

test("Taiwan Traditional Chinese copy uses Taiwan terminology for HTTP MCP and OpenCode 2", () => {
  assert.match(zhTW["ai.externalMcp.http.port"], /連接埠/);
  assert.match(zhTW["ai.externalMcp.http.listenAddress"], /位址/);
  assert.match(zhTW["ai.externalMcp.http.clientHost"], /位址/);
  assert.doesNotMatch(zhTW["ai.externalMcp.http.clientHost"], /地址/);
  assert.doesNotMatch(zhTW["ai.externalMcp.http.port"], /端口/);
  assert.doesNotMatch(zhTW["ai.externalMcp.http.listenAddress"], /地址/);
  assert.match(zhTW["ai.externalMcp.http.wslHint"], /鏡像網路/);

  const opencodeKeys = [
    "ai.opencode.v2.startupTimeout",
    "ai.opencode.v2.exited",
    "ai.opencode.v2.unauthorized",
    "ai.opencode.v2.unavailable",
    "ai.opencode.v2.sessionFailed",
    "ai.opencode.v2.empty",
    "ai.opencode.v2.contextSkipped",
    "ai.opencode.v2.mcpSkipped",
  ];
  for (const key of opencodeKeys) {
    assert.notEqual(en[key], zhCN[key]);
    assert.notEqual(en[key], zhTW[key]);
    assert.notEqual(zhCN[key], zhTW[key]);
  }
  const text = opencodeKeys.map((key) => zhTW[key]).join("\n");
  assert.match(text, /終端機/);
  assert.match(text, /連線/);
  assert.match(text, /設定/);
  assert.match(text, /傳回/);
  assert.equal(text.includes("终端"), false);
  assert.equal(text.includes("连接"), false);
  assert.equal(text.includes("设置"), false);
  assert.equal(text.includes("返回"), false);
});

test("monitoring UI literal message keys exist and all monitor locales stay at parity", () => {
  for (const name of ["MonitorPanels", "MonitorNavButton", "MonitorDiskUsage"]) {
    const source = readFileSync(new URL(`../../../components/vault/${name}.tsx`, import.meta.url), "utf8");
    const keys = [...source.matchAll(/\bt\("(monitor\.[^"]+)"/g)].map((match) => match[1]);
    for (const key of keys) {
      assert.ok(Object.hasOwn(enMonitorMessages, key), `${name}: ${key}`);
    }
  }
  for (const [locale, messages] of Object.entries({
    es: esMonitorMessages,
    ru: ruMonitorMessages,
    "zh-CN": zhCNMonitorMessages,
    "zh-TW": zhTWMonitorMessages,
  })) {
    assert.deepEqual(Object.keys(messages).sort(), Object.keys(enMonitorMessages).sort(), locale);
  }
});

test("GitHub plugin install copy is complete in every supported locale and error presentation maps statuses", async () => {
  const keys = Object.keys(en).filter((key) => key.startsWith("settings.plugins.github."));
  assert.ok(keys.length > 30);
  for (const { id } of SUPPORTED_UI_LOCALES) {
    await loadLocaleMessages(id);
    const messages = getLoadedLocaleMessages(id)!;
    for (const key of keys) {
      assert.ok(messages[key]?.trim(), `${id}: ${key}`);
    }
  }

  const expired = describePluginGitHubInstallError(
    "Error invoking remote method 'plugins:github:install': Error: GitHub package preview expired. Download and review it again",
  );
  assert.equal(expired.key, "settings.plugins.github.error.expired");
  assert.equal(expired.details, null);
  assert.deepEqual(describePluginGitHubInstallError("GitHub download failed (HTTP 503)").values, { status: "503" });
  const validator = "manifest version must be a semantic version";
  assert.equal(describePluginGitHubInstallError(validator).details, validator);
  assert.equal(describePluginGitHubInstallError(validator).key, "settings.plugins.github.error.failed");
  assert.equal(
    describePluginGitHubInstallError("Plugin is incompatible: engine version").key,
    "settings.plugins.github.error.incompatible",
  );
});

test("SSH network latency wording stays aligned between terminal and system manager surfaces", () => {
  const surfaces = [
    [enTerminalMessages, enSystemManagerMessages],
    [ruTerminalMessages, ruSystemManagerMessages],
    [esTerminalMessages, esSystemManagerMessages],
    [zhCNVaultMessages, zhCnSystemManagerMessages],
    [zhTWVaultMessages, zhTwSystemManagerMessages],
  ] as const;

  for (const [terminalMessages, systemManagerMessages] of surfaces) {
    assert.ok(terminalMessages["terminal.serverStats.latency"]);
    assert.equal(
      terminalMessages["terminal.serverStats.latency"],
      systemManagerMessages["systemManager.overview.latency"],
    );
  }
});

test("English snippet bulk-delete copy stays entity-neutral and grammatical for one item", () => {
  assert.equal(
    en["snippets.selection.deleteConfirmTitle"].replace("{count}", "1"),
    "Delete selected items (1)?",
  );
  assert.equal(
    en["snippets.selection.deleteSuccess"].replace("{count}", "1"),
    "Deleted selected items: 1.",
  );
});

test("inline image settings copy is translated rather than left in English", () => {
  const translatedKeys = [
    "settings.terminal.section.inlineImages",
    "settings.terminal.inlineImages.enabled",
    "settings.terminal.inlineImages.enabled.desc",
    "settings.terminal.inlineImages.kitty",
    "settings.terminal.inlineImages.kitty.desc",
    "settings.terminal.inlineImages.sixel.desc",
    "settings.terminal.inlineImages.iip",
    "settings.terminal.inlineImages.iip.desc",
    "settings.terminal.inlineImages.storageLimit",
    "settings.terminal.inlineImages.storageLimit.desc",
    "settings.terminal.inlineImages.maxMegapixels",
    "settings.terminal.inlineImages.maxMegapixels.desc",
    "settings.terminal.inlineImages.sequenceLimit",
    "settings.terminal.inlineImages.sequenceLimit.desc",
    "settings.terminal.inlineImages.hibernateNote",
  ];

  for (const [locale, messages] of Object.entries(ALL_LOCALES)) {
    if (locale === "en") continue;
    const untranslated = translatedKeys.filter((key) => messages[key] === en[key]);
    assert.deepEqual(untranslated, [], `${locale} still uses the English string`);
  }
});

test("removed session log rememberApplication key stays absent across locales", () => {
  for (const [locale, messages] of Object.entries(ALL_LOCALES)) {
    assert.equal(
      messages["terminal.toolbar.sessionLog.rememberApplication"],
      undefined,
      `${locale} should not reintroduce removed rememberApplication key`,
    );
  }
});

test("managed group delete warning mentions SSH config backup in every locale", () => {
  const backupMarkers = ["备份", "備份", "copia de seguridad", "резервную копию", "Back up"];
  for (const [locale, messages] of Object.entries(ALL_LOCALES)) {
    const text = messages["vault.groups.deleteDialog.managedWarning"] ?? "";
    assert.match(text, /SSH/, `${locale} warning should reference the SSH config file`);
    assert.ok(
      backupMarkers.some((marker) => text.includes(marker)),
      `${locale} warning should tell the user to back up the file`,
    );
  }
});
