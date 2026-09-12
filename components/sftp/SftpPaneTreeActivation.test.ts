import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import { getSftpTreeEntryOpenAction } from "./SftpPaneTreeView.tsx";
import type { SftpFileEntry } from "../../types";

const entry = (name: string, type: SftpFileEntry["type"]): SftpFileEntry => ({
  name,
  type,
  size: 0,
  lastModified: 0,
});

test("tree activation enters directories and keeps file opening separate", () => {
  assert.equal(getSftpTreeEntryOpenAction(entry("..", "directory")), "up");
  assert.equal(getSftpTreeEntryOpenAction(entry("docs", "directory")), "navigate");
  assert.equal(getSftpTreeEntryOpenAction(entry("notes.txt", "file")), "open");
});

test("tree row double click routes through the open action", () => {
  const source = fs.readFileSync(new URL("./SftpPaneTreeNode.tsx", import.meta.url), "utf8");
  assert.match(source, /onDoubleClick=\{\(\) => onOpenEntry\(entry, entryPath\)\}/);
});
