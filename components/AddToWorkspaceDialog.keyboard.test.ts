import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  getWorkspaceTargetRowStateClass,
  shouldToggleWorkspaceTarget,
} from './workspace/AddToWorkspaceDialog';

test('space toggles the current target when the search is empty', () => {
  assert.equal(shouldToggleWorkspaceTarget(' ', '', false, false), true);
});

test('space remains available inside a non-empty search query', () => {
  assert.equal(shouldToggleWorkspaceTarget(' ', 'database server', false, false), false);
});

test('plain Enter toggles while modified Enter remains the commit shortcut', () => {
  assert.equal(shouldToggleWorkspaceTarget('Enter', '', false, false), true);
  assert.equal(shouldToggleWorkspaceTarget('Enter', '', true, false), false);
  assert.equal(shouldToggleWorkspaceTarget('Enter', '', false, true), false);
});

test('checked targets keep a visible background after the cursor moves away', () => {
  assert.equal(getWorkspaceTargetRowStateClass(false, false), 'hover:bg-muted/50');
  assert.equal(getWorkspaceTargetRowStateClass(true, false), 'bg-primary/15');
  assert.equal(getWorkspaceTargetRowStateClass(false, true), 'bg-primary/10');
  assert.equal(getWorkspaceTargetRowStateClass(true, true), 'bg-primary/20');
});

test('clicking a target aligns the keyboard cursor with that target', () => {
  const source = readFileSync(
    new URL('./workspace/AddToWorkspaceDialog.tsx', import.meta.url),
    'utf8',
  );

  assert.match(source, /onClick=\{\(\) => handleTargetClick\(idx, LOCAL_ITEM_ID\)\}/);
  assert.match(source, /onClick=\{\(\) => handleTargetClick\(idx, host\.id\)\}/);
  assert.match(source, /handleTargetClick[\s\S]*inputRef\.current\?\.focus\(\)/);
});
