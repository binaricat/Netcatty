import test from 'node:test';
import assert from 'node:assert/strict';

import {
  parseBashHistory,
  parseZshHistory,
  parseFishHistory,
  parseShellHistory,
  mergeRemoteHistory,
  isNetcattyAiHistoryCommand,
  isNetcattyManagedStartupHistoryCommand,
} from './remoteHistory.ts';
import { buildDockerExecShellCommand, buildDockerLogsCommand } from './systemManager/dockerShell.ts';
import { buildTmuxAttachCommand } from './systemManager/tmuxShell.ts';

test('parseBashHistory: plain lines', () => {
  const out = parseBashHistory(['ls -la', 'cd /tmp', 'echo hi'].join('\n'));
  assert.equal(out.length, 3);
  assert.equal(out[0].command, 'ls -la');
  assert.equal(out[0].source, 'bash');
  assert.equal(out[0].timestamp, undefined);
});

test('parseBashHistory: HISTTIMEFORMAT timestamp lines', () => {
  const text = ['#1700000000', 'ls -la', '#1700000100', 'pwd'].join('\n');
  const out = parseBashHistory(text);
  assert.equal(out.length, 2);
  assert.equal(out[0].command, 'ls -la');
  assert.equal(out[0].timestamp, 1700000000000);
  assert.equal(out[1].command, 'pwd');
  assert.equal(out[1].timestamp, 1700000100000);
});

test('parseBashHistory: skips blank lines and trims', () => {
  const out = parseBashHistory('\n  ls  \n\necho hi\n');
  assert.deepEqual(
    out.map((e) => e.command),
    ['ls', 'echo hi'],
  );
});

test('parseBashHistory: groups a multi-line command between timestamp markers', () => {
  // Under HISTTIMEFORMAT + lithist, a multi-line command is stored with
  // embedded newlines; the `#epoch` markers delimit one command from the next.
  const text = [
    '#1700000000',
    'for i in 1 2 3',
    'do',
    '  echo $i',
    'done',
    '#1700000100',
    'pwd',
  ].join('\n');
  const out = parseBashHistory(text);
  assert.equal(out.length, 2);
  assert.equal(out[0].command, 'for i in 1 2 3\ndo\n  echo $i\ndone');
  assert.equal(out[0].timestamp, 1700000000000);
  assert.equal(out[1].command, 'pwd');
  assert.equal(out[1].timestamp, 1700000100000);
});

test('parseZshHistory: plain lines', () => {
  const out = parseZshHistory(['ls', 'cd /tmp'].join('\n'));
  assert.equal(out.length, 2);
  assert.equal(out[0].source, 'zsh');
  assert.equal(out[0].timestamp, undefined);
});

test('parseZshHistory: EXTENDED_HISTORY format', () => {
  const text = [': 1700000000:0;ls -la', ': 1700000100:0;pwd'].join('\n');
  const out = parseZshHistory(text);
  assert.equal(out.length, 2);
  assert.equal(out[0].command, 'ls -la');
  assert.equal(out[0].timestamp, 1700000000000);
  assert.equal(out[1].command, 'pwd');
});

test('parseZshHistory: rejoins backslash line-continuations into one command', () => {
  // zsh escapes each embedded newline with a trailing backslash. The three
  // physical lines below are a single command; `pwd` is a separate record.
  const text = [
    ': 1700000000:0;echo a\\',
    'echo b\\',
    'echo c',
    ': 1700000100:0;pwd',
  ].join('\n');
  const out = parseZshHistory(text);
  assert.equal(out.length, 2);
  assert.equal(out[0].command, 'echo a\necho b\necho c');
  assert.equal(out[0].timestamp, 1700000000000);
  assert.equal(out[1].command, 'pwd');
});

test('parseFishHistory: cmd + when records', () => {
  const text = [
    '- cmd: ls -la',
    '  when: 1700000000',
    '- cmd: pwd',
    '  when: 1700000100',
  ].join('\n');
  const out = parseFishHistory(text);
  assert.equal(out.length, 2);
  assert.equal(out[0].command, 'ls -la');
  assert.equal(out[0].source, 'fish');
  assert.equal(out[0].timestamp, 1700000000000);
  assert.equal(out[1].command, 'pwd');
  assert.equal(out[1].timestamp, 1700000100000);
});

test('parseFishHistory: unescapes \\n and \\\\, ignores paths block', () => {
  const text = [
    '- cmd: echo foo\\nbar',
    '  when: 1700000000',
    '  paths:',
    '    - /tmp',
    '- cmd: grep \\\\d file',
    '  when: 1700000100',
  ].join('\n');
  const out = parseFishHistory(text);
  assert.equal(out.length, 2);
  assert.equal(out[0].command, 'echo foo\nbar');
  assert.equal(out[1].command, 'grep \\d file');
});

test('parseFishHistory: tolerates a tail-truncated leading remnant', () => {
  // `tail` may cut mid-record: leading when/paths lines with no cmd are ignored
  const text = [
    '  when: 1699999999',
    '  paths:',
    '    - /x',
    '- cmd: whoami',
    '  when: 1700000200',
  ].join('\n');
  const out = parseFishHistory(text);
  assert.equal(out.length, 1);
  assert.equal(out[0].command, 'whoami');
  assert.equal(out[0].timestamp, 1700000200000);
});

test('parseShellHistory: dispatches by source', () => {
  assert.equal(parseShellHistory('bash', 'ls')[0].source, 'bash');
  assert.equal(parseShellHistory('zsh', 'ls')[0].source, 'zsh');
  assert.equal(parseShellHistory('fish', '- cmd: ls')[0].source, 'fish');
});

test('mergeRemoteHistory: dedupes keeping most recent occurrence', () => {
  const a = parseBashHistory(['ls', 'pwd', 'ls'].join('\n'));
  const b = parseZshHistory([': 1700000000:0;ls', ': 1700000100:0;whoami'].join('\n'));
  const merged = mergeRemoteHistory([a, b]);
  const commands = merged.map((e) => e.command);
  // Newest-first, unique
  assert.deepEqual(commands, ['whoami', 'ls', 'pwd']);
});

test('mergeRemoteHistory: caps to max', () => {
  const entries = Array.from({ length: 50 }, (_, i) => `cmd-${i}`).join('\n');
  const merged = mergeRemoteHistory([parseBashHistory(entries)], 10);
  assert.equal(merged.length, 10);
  // Newest-first means cmd-49 comes first
  assert.equal(merged[0].command, 'cmd-49');
});

test('mergeRemoteHistory: orders by real timestamp, not concatenation order', () => {
  // The zsh command (ts 200) is newer than the fish command (ts 100), even
  // though fish is concatenated last. Newest-first must rank zsh first.
  const zsh = parseZshHistory(': 1700000200:0;zsh-newer');
  const fish = parseFishHistory(['- cmd: fish-older', '  when: 1700000100'].join('\n'));
  const merged = mergeRemoteHistory([zsh, fish]);
  assert.deepEqual(
    merged.map((e) => e.command),
    ['zsh-newer', 'fish-older'],
  );
});

test('mergeRemoteHistory: timestamped entries rank above untimestamped ones', () => {
  const bash = parseBashHistory(['plain-a', 'plain-b'].join('\n')); // no timestamps
  const zsh = parseZshHistory(': 1700000000:0;timed'); // carries a timestamp
  const merged = mergeRemoteHistory([bash, zsh]);
  // The timed entry wins; untimestamped entries keep file order (newest last).
  assert.deepEqual(
    merged.map((e) => e.command),
    ['timed', 'plain-b', 'plain-a'],
  );
});

test('isNetcattyAiHistoryCommand: detects AI PTY marker lines', () => {
  assert.equal(
    isNetcattyAiHistoryCommand('__NCMCP_abc123=0; ls -la'),
    true,
  );
  assert.equal(
    isNetcattyAiHistoryCommand('/opt/frp/frps.toml__NCMCP_mp56jbh6_3e30833'),
    true,
  );
  assert.equal(isNetcattyAiHistoryCommand('ls -la'), false);
  assert.equal(isNetcattyAiHistoryCommand('grep NCMCP log.txt'), false);
});

test('isNetcattyManagedStartupHistoryCommand: detects Docker and tmux terminal launch commands', () => {
  assert.equal(isNetcattyManagedStartupHistoryCommand(buildDockerExecShellCommand('587abcdef123')), true);
  assert.equal(isNetcattyManagedStartupHistoryCommand(buildDockerLogsCommand('587abcdef123')), true);
  assert.equal(isNetcattyManagedStartupHistoryCommand(buildTmuxAttachCommand('my-session')), true);
  assert.equal(isNetcattyManagedStartupHistoryCommand(buildTmuxAttachCommand('my-session', 2)), true);
  assert.equal(isNetcattyManagedStartupHistoryCommand('docker ps -a'), false);
  assert.equal(isNetcattyManagedStartupHistoryCommand('docker logs -f 587abcdef123'), false);
  assert.equal(isNetcattyManagedStartupHistoryCommand('docker exec -it 587abcdef123 bash'), false);
  assert.equal(isNetcattyManagedStartupHistoryCommand('tmux attach -t my-session'), false);
});

test('mergeRemoteHistory: drops Netcatty AI PTY history lines', () => {
  const lists = [
    parseBashHistory(
      ['ls -la', '__NCMCP_abc=0; pwd', 'git status'].join('\n'),
    ),
  ];
  const merged = mergeRemoteHistory(lists);
  assert.deepEqual(
    merged.map((e) => e.command),
    ['git status', 'ls -la'],
  );
});

test('mergeRemoteHistory: drops Netcatty managed Docker and tmux startup lines', () => {
  const lists = [
    parseBashHistory(
      [
        'docker ps -a',
        buildDockerLogsCommand('587abcdef123'),
        buildTmuxAttachCommand('my-session'),
        'history',
      ].join('\n'),
    ),
  ];
  const merged = mergeRemoteHistory(lists);
  assert.deepEqual(
    merged.map((e) => e.command),
    ['history', 'docker ps -a'],
  );
});

test('mergeRemoteHistory: drops Netcatty managed startup lines from zsh and fish history', () => {
  const zsh = parseZshHistory(
    [
      ': 1700000000:0;git status',
      `: 1700000100:0;${buildDockerExecShellCommand('587abcdef123')}`,
    ].join('\n'),
  );
  const fish = parseFishHistory(
    [
      '- cmd: docker ps -a',
      '  when: 1700000200',
      `- cmd: ${buildTmuxAttachCommand('my-session')}`,
      '  when: 1700000300',
    ].join('\n'),
  );

  const merged = mergeRemoteHistory([zsh, fish]);
  assert.deepEqual(
    merged.map((e) => e.command),
    ['docker ps -a', 'git status'],
  );
});
