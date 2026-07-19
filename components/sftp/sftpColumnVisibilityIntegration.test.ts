import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const readSource = (fileName: string): string =>
  readFileSync(new URL(fileName, import.meta.url), 'utf8');

test('list and tree SFTP views share column visibility and keyboard-accessible menus', () => {
  const listSource = readSource('./SftpPaneFileList.tsx');
  const treeSource = readSource('./SftpPaneTreeView.tsx');
  const treeNodeSource = readSource('./SftpPaneTreeNode.tsx');
  const columnMenuSource = readSource('./SftpColumnMenuItems.tsx');

  for (const source of [listSource, treeSource]) {
    assert.match(source, /buildSftpColumnTemplate\(columnWidths, visibleColumns\)/);
    assert.match(source, /SftpColumnMenuItems/);
    assert.match(source, /isSftpColumnMenuKey/);
    assert.match(source, /tabIndex=\{0\}/);
  }

  assert.match(columnMenuSource, /ContextMenuCheckboxItem/);
  assert.match(
    listSource,
    /import\s*\{[^}]*\bContextMenuSeparator\b[^}]*\}\s*from "\.\.\/ui\/context-menu";/,
  );

  assert.match(treeNodeSource, /visibleColumns\.modified/);
  assert.match(treeNodeSource, /visibleColumns\.size/);
  assert.match(treeNodeSource, /visibleColumns\.type/);
});
