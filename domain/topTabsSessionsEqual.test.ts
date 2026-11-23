import assert from 'node:assert/strict';
import test from 'node:test';

import type { TerminalSession } from './models.ts';
import { topTabsSessionsEqual } from './topTabsSessionsEqual.ts';

const session = (overrides: Partial<TerminalSession> = {}): TerminalSession => ({
  id: 's1',
  hostId: 'h1',
  hostLabel: 'jumpserver',
  hostname: 'jump.example.com',
  username: 'root',
  status: 'connected',
  protocol: 'ssh',
  ...overrides,
});

test('topTabsSessionsEqual ignores promptHostname-only presentation updates', () => {
  assert.equal(
    topTabsSessionsEqual(
      [session({ promptHostname: '10.1.64.1' })],
      [session({ promptHostname: '10.1.64.2' })],
    ),
    true,
  );
});
