import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const root = new URL("..", import.meta.url);

function readProjectFile(path: string): string {
  return readFileSync(join(root.pathname, path), "utf8");
}

test("terminal side panel exposes stable custom CSS regions", () => {
  const source = readProjectFile("components/terminalLayer/TerminalLayerSidePanelSection.tsx");

  assert.match(source, /terminal-side-panel-shell/);
  assert.match(source, /terminal-side-panel-tabs/);
  assert.match(source, /terminal-side-panel-content/);
  assert.match(source, /terminal-side-panel-resizer/);
  assert.match(source, /isSidePanelOpenForCurrentTab \? 'terminal-side-panel' : undefined/);
});

test("SFTP panel exposes stable custom CSS regions", () => {
  const source = [
    readProjectFile("components/SftpSidePanel.tsx"),
    readProjectFile("components/sftp/SftpPaneView.tsx"),
    readProjectFile("components/sftp/SftpPaneToolbar.tsx"),
    readProjectFile("components/sftp/SftpPaneFileList.tsx"),
    readProjectFile("components/sftp/SftpFileRow.tsx"),
    readProjectFile("components/sftp/SftpPaneTreeView.tsx"),
    readProjectFile("components/sftp/SftpPaneTreeNode.tsx"),
    readProjectFile("components/sftp/SftpTransferQueue.tsx"),
  ].join("\n");

  [
    "terminal-sftp-panel",
    "terminal-sftp-host-header",
    "terminal-sftp-pane",
    "terminal-sftp-toolbar",
    "terminal-sftp-path",
    "terminal-sftp-filter-bar",
    "terminal-sftp-list",
    "terminal-sftp-list-header",
    "terminal-sftp-list-row",
    "terminal-sftp-tree",
    "terminal-sftp-tree-row",
    "terminal-sftp-transfer-queue",
    "terminal-sftp-transfer-queue-header",
    "terminal-sftp-transfer-list",
  ].forEach((hook) => assert.match(source, new RegExp(hook)));
});

test("terminal host tree exposes stable custom CSS regions", () => {
  const source = readProjectFile("components/terminalLayer/TerminalHostTreeSidebar.tsx");

  assert.match(source, /terminal-host-tree-sidebar-shell/);
  assert.match(source, /terminal-host-tree-sidebar/);
  assert.match(source, /terminal-host-tree-sidebar-content/);
});

test("custom CSS help lists the expanded terminal and SFTP hooks", () => {
  const source = readProjectFile("application/i18n/locales/zh-CN/core.ts");

  [
    "terminal-side-panel-tabs",
    "terminal-side-panel-content",
    "terminal-sftp-toolbar",
    "terminal-sftp-list-row",
    "terminal-sftp-tree-row",
    "terminal-sftp-transfer-queue",
    "terminal-host-tree-sidebar-content",
  ].forEach((hook) => assert.match(source, new RegExp(hook)));
});
