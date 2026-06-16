import test from 'node:test';
import assert from 'node:assert/strict';

import {
  mergeGlobalHistoryOnAppend,
  sanitizeGlobalHistoryEntries,
  shouldRecordGlobalHistoryCommand,
  toGlobalHistoryDisplayEntries,
} from './globalHistory.ts';
import { NETCATTY_AI_HISTORY_MARKER } from './remoteHistory.ts';
import { buildDockerExecShellCommand, buildDockerLogsCommand } from './systemManager/dockerShell.ts';
import { buildTmuxAttachCommand } from './systemManager/tmuxShell.ts';
import type { ShellHistoryEntry } from './models';

const baseEntry = (
  overrides: Partial<ShellHistoryEntry> & Pick<ShellHistoryEntry, 'command'>,
): ShellHistoryEntry => ({
  id: overrides.id ?? 'id-1',
  command: overrides.command,
  hostId: overrides.hostId ?? 'host-1',
  hostLabel: overrides.hostLabel ?? 'srv',
  sessionId: overrides.sessionId ?? 'sess-1',
  timestamp: overrides.timestamp ?? 1000,
});

test('shouldRecordGlobalHistoryCommand: rejects empty and AI marker commands', () => {
  assert.equal(shouldRecordGlobalHistoryCommand(''), false);
  assert.equal(shouldRecordGlobalHistoryCommand('   '), false);
  assert.equal(
    shouldRecordGlobalHistoryCommand(`echo ${NETCATTY_AI_HISTORY_MARKER}foo`),
    false,
  );
  assert.equal(shouldRecordGlobalHistoryCommand('ls -la'), true);
});

test('shouldRecordGlobalHistoryCommand: rejects Netcatty managed Docker and tmux startup commands', () => {
  assert.equal(shouldRecordGlobalHistoryCommand(buildDockerExecShellCommand('587abcdef123')), false);
  assert.equal(shouldRecordGlobalHistoryCommand(buildDockerLogsCommand('587abcdef123')), false);
  assert.equal(shouldRecordGlobalHistoryCommand(buildTmuxAttachCommand('my-session')), false);
  assert.equal(shouldRecordGlobalHistoryCommand(buildTmuxAttachCommand('my-session', 2)), false);
  assert.equal(shouldRecordGlobalHistoryCommand('docker ps -a'), true);
  assert.equal(shouldRecordGlobalHistoryCommand('docker logs -f 587abcdef123'), true);
  assert.equal(shouldRecordGlobalHistoryCommand('docker exec -it 587abcdef123 bash'), true);
  assert.equal(shouldRecordGlobalHistoryCommand('tmux attach -t my-session'), true);
});

test('mergeGlobalHistoryOnAppend: trims and prepends a new command', () => {
  const next = mergeGlobalHistoryOnAppend([], {
    command: '  pwd  ',
    hostId: 'h1',
    hostLabel: 'Host',
    sessionId: 's1',
  });
  assert.equal(next.length, 1);
  assert.equal(next[0].command, 'pwd');
});

test('sanitizeGlobalHistoryEntries: removes persisted Netcatty managed startup commands', () => {
  const entries = [
    baseEntry({ id: 'a', command: buildDockerLogsCommand('587abcdef123') }),
    baseEntry({ id: 'b', command: 'docker ps -a' }),
    baseEntry({ id: 'c', command: buildTmuxAttachCommand('my-session') }),
  ];
  const out = sanitizeGlobalHistoryEntries(entries);
  assert.deepEqual(
    out.map((entry) => entry.command),
    ['docker ps -a'],
  );
});

test('mergeGlobalHistoryOnAppend: bumps timestamp for consecutive duplicate', () => {
  const prev = [baseEntry({ id: 'a', command: 'ls', timestamp: 1000 })];
  const next = mergeGlobalHistoryOnAppend(prev, {
    command: 'ls',
    hostId: 'h2',
    hostLabel: 'Other',
    sessionId: 's2',
  });
  assert.equal(next.length, 1);
  assert.equal(next[0].id, 'a');
  assert.equal(next[0].hostLabel, 'Other');
  assert.ok(next[0].timestamp > 1000);
});

test('toGlobalHistoryDisplayEntries: maps host labels', () => {
  const out = toGlobalHistoryDisplayEntries([
    baseEntry({ command: 'htop', hostLabel: 'prod' }),
  ]);
  assert.deepEqual(out, [
    { id: 'id-1', command: 'htop', timestamp: 1000, hostLabel: 'prod' },
  ]);
});
