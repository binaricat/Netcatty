import assert from 'node:assert/strict';
import test from 'node:test';

import { buildNumberShortcutTabTargets } from './tabShortcutTargets.ts';

test('number shortcut tabs include vault and sftp by default', () => {
  assert.deepEqual(
    buildNumberShortcutTabTargets({
      showSftpTab: true,
      shellOnlyTabNumberShortcuts: false,
      orderedTabs: ['session-1', 'workspace-1'],
      editorTabIds: ['editor:file-1'],
    }),
    ['vault', 'sftp', 'session-1', 'workspace-1', 'editor:file-1'],
  );
});

test('number shortcut tabs skip vault and sftp when shell-only mode is enabled', () => {
  assert.deepEqual(
    buildNumberShortcutTabTargets({
      showSftpTab: true,
      shellOnlyTabNumberShortcuts: true,
      orderedTabs: ['session-1', 'workspace-1'],
      editorTabIds: ['editor:file-1'],
    }),
    ['session-1', 'workspace-1', 'editor:file-1'],
  );
});

test('hidden sftp tab is omitted from default number shortcut targets', () => {
  assert.deepEqual(
    buildNumberShortcutTabTargets({
      showSftpTab: false,
      shellOnlyTabNumberShortcuts: false,
      orderedTabs: ['session-1'],
      editorTabIds: [],
    }),
    ['vault', 'session-1'],
  );
});
