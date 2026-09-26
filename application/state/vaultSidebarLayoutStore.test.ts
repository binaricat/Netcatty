import test from 'node:test';
import assert from 'node:assert/strict';

import {
  computeSftpViewRailOffset,
  vaultSidebarLayoutStore,
} from './vaultSidebarLayoutStore.ts';

test('computeSftpViewRailOffset offsets only when the sidebar hosts the SFTP surface', () => {
  assert.equal(
    computeSftpViewRailOffset({
      sftpInSidebar: true,
      isSftpActive: true,
      vaultRailWidth: 208,
    }),
    208,
  );
  assert.equal(
    computeSftpViewRailOffset({
      sftpInSidebar: true,
      isSftpActive: false,
      vaultRailWidth: 208,
    }),
    0,
  );
  assert.equal(
    computeSftpViewRailOffset({
      sftpInSidebar: false,
      isSftpActive: true,
      vaultRailWidth: 208,
    }),
    0,
  );
});

test('computeSftpViewRailOffset clamps negative rail widths', () => {
  assert.equal(
    computeSftpViewRailOffset({
      sftpInSidebar: true,
      isSftpActive: true,
      vaultRailWidth: -20,
    }),
    0,
  );
});

test('vaultSidebarLayoutStore dedupes identical width publishes', () => {
  const events: number[] = [];
  const unsubscribe = vaultSidebarLayoutStore.subscribe(() => {
    events.push(vaultSidebarLayoutStore.getLayoutWidth());
  });

  vaultSidebarLayoutStore.setLayoutWidth(208.4);
  vaultSidebarLayoutStore.setLayoutWidth(208.2);
  vaultSidebarLayoutStore.setLayoutWidth(0);
  vaultSidebarLayoutStore.setLayoutWidth(-5);

  assert.deepEqual(events, [208, 0]);
  unsubscribe();
});
