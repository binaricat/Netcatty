import assert from 'node:assert/strict';
import test from 'node:test';

import {
  getSidePanelLiveSnapshot,
  sidePanelLiveStore,
  SIDE_PANEL_INACTIVE_LIVE_SNAPSHOT,
} from './sidePanelLiveStore.ts';

test('sidePanelLiveStore skips notify when snapshot is unchanged', () => {
  let notifications = 0;
  const unsubscribe = sidePanelLiveStore.subscribe(() => {
    notifications += 1;
  });

  const snapshot = {
    ...SIDE_PANEL_INACTIVE_LIVE_SNAPSHOT,
    activeTerminalCwd: '/tmp',
  };
  sidePanelLiveStore.update(snapshot);
  sidePanelLiveStore.update({ ...snapshot });
  unsubscribe();

  assert.equal(notifications, 1);
});

test('getSidePanelLiveSnapshot returns inactive snapshot when disabled', () => {
  sidePanelLiveStore.update({
    ...SIDE_PANEL_INACTIVE_LIVE_SNAPSHOT,
    activeTerminalCwd: '/var/log',
  });

  assert.equal(getSidePanelLiveSnapshot(false), SIDE_PANEL_INACTIVE_LIVE_SNAPSHOT);
  assert.equal(getSidePanelLiveSnapshot(true).activeTerminalCwd, '/var/log');
});
