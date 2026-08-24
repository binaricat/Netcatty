import assert from "node:assert/strict";
import test from "node:test";

import en from "./en.ts";
import ru from "./ru.ts";
import es from "./es.ts";
import zhCN from "./zh-CN.ts";
import zhTW from "./zh-TW.ts";

const KEYS = [
  "vault.hosts.selectedSummary",
  "vault.groups.selectedCount",
  "vault.groups.deleteMultiple.success",
  "vault.groups.deleteDialog.bulkTitle",
  "vault.groups.deleteDialog.bulkDesc",
  "vault.groups.deleteDialog.bulkDeleteHosts",
  "vault.import.destination.title",
  "vault.import.destination.settings",
  "vault.import.destination.done",
  "vault.import.securecrt.folder",
  "vault.import.securecrt.promptTitle",
  "vault.import.securecrt.promptDesc",
  "vault.import.progress.fileCount",
  "vault.import.progress.persistFailed",
  "vault.import.progress.rollbackFailed",
  "vault.import.sshConfig.managedDestinationHint",
] as const;

test("bulk vault import and group-selection copy exists in every locale", () => {
  for (const [locale, messages] of Object.entries({ en, ru, es, zhCN, zhTW })) {
    const missing = KEYS.filter((key) => !messages[key]);
    assert.deepEqual(missing, [], `${locale} is missing bulk vault labels`);
  }
});
