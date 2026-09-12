import assert from "node:assert/strict";
import test from "node:test";

import zhCN from "../application/i18n/locales/zh-CN.ts";
import { filterSettingsSearchCatalog } from "./settingsSearch.ts";
import { SETTINGS_SEARCH_CATALOG } from "./settingsSearchCatalog.ts";

const EN: Record<string, string> = {
  "settings.tab.application": "Application",
  "settings.tab.appearance": "Appearance",
  "settings.tab.terminal": "Terminal",
  "settings.tab.shortcuts": "Shortcuts",
  "settings.tab.sftpFileAssociations": "SFTP",
  "settings.tab.ai": "AI",
  "settings.tab.syncCloud": "Sync & Cloud",
  "settings.tab.system": "System",
  "settings.tab.plugins": "Plugins",
  "settings.appearance.theme": "Theme",
  "settings.appearance.uiTheme": "UI theme",
  "settings.terminal.behavior.copyOnSelect": "Copy on select",
  "settings.terminal.behavior.copyOnSelect.desc": "Copy selected text automatically",
  "settings.terminal.behavior.disconnectedNotice": "When a connection disconnects",
  "settings.terminal.behavior.disconnectedNotice.desc": "Show a terminal notice or dialog",
  "settings.terminal.section.behavior": "Behavior",
  "settings.system.networkProxy.mode": "Proxy mode",
  "settings.system.networkProxy.description": "HTTP(S) proxy for cloud sync and AI",
  "settings.system.networkProxy.title": "Network Proxy",
  "settings.appLock.title": "App Lock",
  "settings.appLock.description": "Require a local lock password when Netcatty opens",
  "ai.safety.permissionMode": "Permission mode",
  "ai.safety.permissionMode.description": "Control tool approvals",
  "ai.safety.title": "Safety",
  "cloudSync.localBackups.title": "Local backups",
  "cloudSync.localBackups.desc": "Keep offline snapshots",
};

const ZH: Record<string, string> = {
  ...EN,
  "settings.appearance.theme": "主题",
  "settings.terminal.behavior.copyOnSelect": "选中即复制",
  "settings.terminal.behavior.disconnectedNotice": "连接断开时",
  "settings.terminal.behavior.disconnectedNotice.desc": "在终端内显示简短提示，或使用完整弹窗",
  "settings.system.networkProxy.mode": "代理模式",
  "settings.system.networkProxy.title": "网络代理",
  "settings.appLock.title": "应用锁定",
  "settings.appLock.description": "在 Netcatty 打开、长时间无操作或手动锁定后，要求输入本地锁定密码。",
  "ai.safety.permissionMode": "权限模式",
};

const tEn = (key: string) => EN[key] ?? key;
const tZh = (key: string) => ZH[key] ?? key;

test("settings search catalog has unique ids", () => {
  const ids = SETTINGS_SEARCH_CATALOG.map((entry) => entry.id);
  assert.equal(new Set(ids).size, ids.length);
});

test("filterSettingsSearchCatalog matches English labels", () => {
  const hits = filterSettingsSearchCatalog("copy on select", tEn);
  assert.ok(hits.some((hit) => hit.entry.id === "terminal-copy-on-select"));
});

test("settings search finds the disconnected notice preference", () => {
  const byEnglish = filterSettingsSearchCatalog("connection disconnects", tEn);
  assert.ok(byEnglish.some((hit) => hit.entry.id === "terminal-disconnected-notice"));

  const byChinese = filterSettingsSearchCatalog("断开连接", tZh);
  assert.ok(byChinese.some((hit) => hit.entry.id === "terminal-disconnected-notice"));

  const byPopupAlias = filterSettingsSearchCatalog("弹窗提醒", tZh);
  assert.ok(byPopupAlias.some((hit) => hit.entry.id === "terminal-disconnected-notice"));
});

test("filterSettingsSearchCatalog matches Chinese labels and pinyin", () => {
  const byLabel = filterSettingsSearchCatalog("主题", tZh);
  assert.ok(byLabel.some((hit) => hit.entry.id === "appearance-theme"));

  const byPinyin = filterSettingsSearchCatalog("zhuti", tZh);
  assert.ok(byPinyin.some((hit) => hit.entry.id === "appearance-theme"));
});

test("filterSettingsSearchCatalog matches keywords and tab labels", () => {
  const proxyHits = filterSettingsSearchCatalog("proxy", tEn);
  assert.ok(proxyHits.some((hit) => hit.entry.id === "system-network-proxy-mode"));

  const syncHits = filterSettingsSearchCatalog("backup", tEn);
  assert.ok(syncHits.some((hit) => hit.entry.id === "sync-local-backups"));
});

test("filterSettingsSearchCatalog matches App Lock by title and aliases", () => {
  const byEnglish = filterSettingsSearchCatalog("app lock", tEn);
  assert.ok(byEnglish.some((hit) => hit.entry.id === "system-app-lock"));

  const byChineseTitle = filterSettingsSearchCatalog("应用锁定", tZh);
  assert.ok(byChineseTitle.some((hit) => hit.entry.id === "system-app-lock"));

  // Users commonly search the shorter "应用锁" alias rather than "应用锁定".
  const byChineseAlias = filterSettingsSearchCatalog("应用锁", tZh);
  assert.ok(byChineseAlias.some((hit) => hit.entry.id === "system-app-lock"));

  const byTimeout = filterSettingsSearchCatalog("无操作", tZh);
  assert.ok(byTimeout.some((hit) => hit.entry.id === "system-app-lock"));
});

test("settings search finds App Lock from the zh-CN locale", () => {
  const t = (key: string) => zhCN[key] ?? key;
  const hits = filterSettingsSearchCatalog("应用锁", t);
  assert.ok(hits.some((hit) => hit.entry.id === "system-app-lock"));
});

test("filterSettingsSearchCatalog can exclude plugins tab", () => {
  const hits = filterSettingsSearchCatalog("plugin", tEn, { includePlugins: false });
  assert.equal(hits.some((hit) => hit.entry.tab === "plugins"), false);
});

test("AI safety entries retain aiSubTab for navigation", () => {
  const hits = filterSettingsSearchCatalog("permission", tEn);
  const safety = hits.find((hit) => hit.entry.id === "ai-safety-permission-mode");
  assert.ok(safety);
  assert.equal(safety?.entry.aiSubTab, "safety");
});

test("Sync status entries retain syncSubTab for navigation", () => {
  const hits = filterSettingsSearchCatalog("backup", tEn);
  const backups = hits.find((hit) => hit.entry.id === "sync-local-backups");
  assert.ok(backups);
  assert.equal(backups?.entry.syncSubTab, "status");
});
