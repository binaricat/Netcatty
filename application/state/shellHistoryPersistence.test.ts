import test from 'node:test';
import assert from 'node:assert/strict';

import { buildDockerLogsCommand } from '../../domain/systemManager/dockerShell.ts';
import { loadSanitizedShellHistory } from './shellHistoryPersistence.ts';
import type { ShellHistoryEntry } from '../../domain/models.ts';

const entry = (id: string, command: string): ShellHistoryEntry => ({
  id,
  command,
  hostId: 'host-1',
  hostLabel: 'Host',
  sessionId: 'session-1',
  timestamp: 1000,
});

test('loadSanitizedShellHistory removes persisted managed startup commands and writes back cleaned history', () => {
  const stored = [
    entry('managed', buildDockerLogsCommand('587abcdef123')),
    entry('user', 'docker ps -a'),
  ];
  let written: ShellHistoryEntry[] | null = null;

  const loaded = loadSanitizedShellHistory({
    read: () => stored,
    write: (_key, value) => {
      written = value;
      return true;
    },
  });

  assert.deepEqual(
    loaded?.map((item) => item.command),
    ['docker ps -a'],
  );
  assert.deepEqual(written, loaded);
});

test('loadSanitizedShellHistory does not write when persisted history is already clean', () => {
  const stored = [entry('user', 'docker ps -a')];
  let writeCount = 0;

  const loaded = loadSanitizedShellHistory({
    read: () => stored,
    write: () => {
      writeCount += 1;
      return true;
    },
  });

  assert.deepEqual(loaded, stored);
  assert.equal(writeCount, 0);
});
