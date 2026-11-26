const assert = require('node:assert/strict');
const test = require('node:test');
const { createGitBashDirectoryReader, findMsysPid, idleBashPid } = require('./gitBashDirectoryIntegration.cjs');

const shell = (pid, children = [], name = 'bash.exe') => ({ pid, name, children });

test('a Git Bash probe follows just the launcher and original idle Bash', () => {
  assert.equal(idleBashPid(shell(12, [shell(34)]), 12), 34);
  assert.equal(idleBashPid(shell(12, [shell(34, [shell(56)])]), 12), null);
  assert.equal(idleBashPid(shell(12, [shell(34, [], 'cmd.exe')]), 12), null);
  assert.equal(idleBashPid(shell(12, [shell(34)]), 56), null);
  const processes = 'PID PPID PGID WINPID TTY UID STIME COMMAND\n 812 1 812 34 cons0 197608 09:24:10 /usr/bin/bash\n';
  assert.equal(findMsysPid(processes, 34), '812');
  assert.equal(findMsysPid(processes + ' 999 812 999 54 cons0 197608 09:24:11 /usr/bin/bash\n', 34), null);
  assert.equal(findMsysPid(processes, 12), null);
  assert.equal(findMsysPid(processes.repeat(2), 34), null);
});

test('a pending probe is shared and a pre-write result cannot confirm navigation', async () => {
  const probes = [];
  const reader = createGitBashDirectoryReader(pid => new Promise(resolve => probes.push({ pid, resolve })));
  reader.setProcessId(12);
  const before = reader.read();
  assert.equal(reader.read(), before);
  await Promise.resolve();
  reader.invalidate();
  const after = reader.read();
  await Promise.resolve();
  assert.deepEqual(probes.map(probe => probe.pid), [12, 12]);
  probes[1].resolve('C:\\new');
  probes[0].resolve('C:\\old');
  assert.equal((await before).success, false);
  assert.deepEqual((await after).directoryState, {
    cwd: 'C:\\new', home: null, provider: 'FileSystem', revision: 1, shellKind: 'git-bash', pathFlavor: 'win32',
  });
});
