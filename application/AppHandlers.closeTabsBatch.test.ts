import assert from 'node:assert/strict';
import test from 'node:test';

import { closeTabsBatchImpl } from './app/AppHandlers.ts';

test('batch tab close removes standalone sessions in one state update', async () => {
  const closedSessionBatches: string[][] = [];
  const probedSessionBatches: string[][] = [];
  const closeTabsInFlightRef = { current: false };
  const sessions = [
    { id: 's1', protocol: 'ssh' },
    { id: 's2', protocol: 'ssh' },
    { id: 's3', protocol: 'ssh' },
  ];

  await closeTabsBatchImpl(
    () => ({
      closeLogView: () => {},
      closeSessions: (sessionIds: string[]) => closedSessionBatches.push(sessionIds),
      closeTabsInFlightRef,
      closeWorkspace: () => {},
      confirmIfBusyLocalTerminal: async (sessionIds: string[]) => {
        probedSessionBatches.push(sessionIds);
        return true;
      },
      logViews: [],
      sessions,
      workspaces: [],
    }),
    ['s1', 's2', 's3'],
  );

  assert.deepEqual(probedSessionBatches, [['s1', 's2', 's3']]);
  assert.deepEqual(closedSessionBatches, [['s1', 's2', 's3']]);
  assert.equal(closeTabsInFlightRef.current, false);
});
