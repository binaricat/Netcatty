import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const source = fs.readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), "HostTreeContextMenus.tsx"),
  "utf8",
);

test("host context menu offers dual-pane SFTP without extra prop drilling", () => {
  assert.match(source, /OpenDualPaneSftpMenuItem/);
  assert.match(source, /requestOpenDualPaneSftp/);
  assert.match(source, /vault\.hosts\.openSftp/);
  assert.match(source, /useSettingsChromeStore/);
  assert.match(source, /!showSftpTab\s*\|\|\s*!canOpenDualPaneSftp/);
});
