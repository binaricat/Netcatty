import test from 'node:test';
import assert from 'node:assert/strict';

import { buildDockerExecShellCommand, buildDockerLogsCommand } from './dockerShell.ts';

test('buildDockerExecShellCommand probes plain Docker before sudo fallback', () => {
  const command = buildDockerExecShellCommand('587abcdef123');

  assert.match(command, /^sh -c /);
  assert.match(command, /printf .*\\033\[H\\033\[2J\\033\[3J/);
  assert.match(command, /docker inspect 587abcdef123/);
  assert.match(command, /exec docker exec -it 587abcdef123/);
  assert.match(command, /exec sudo docker exec -it 587abcdef123/);
  assert.match(command, /permission\\ denied.*docker.sock.*docker.sock.*permission\\ denied/);
  assert.doesNotMatch(command, /sudo -S/);
  assert.equal(command.includes('\n'), false);
});

test('buildDockerLogsCommand probes plain Docker before sudo fallback', () => {
  const command = buildDockerLogsCommand('587abcdef123');

  assert.match(command, /^sh -c /);
  assert.match(command, /printf .*\\033\[H\\033\[2J\\033\[3J/);
  assert.match(command, /docker inspect 587abcdef123/);
  assert.match(command, /exec docker logs -f --tail 200 587abcdef123/);
  assert.match(command, /exec sudo docker logs -f --tail 200 587abcdef123/);
  assert.match(command, /permission\\ denied.*docker.sock.*docker.sock.*permission\\ denied/);
  assert.doesNotMatch(command, /sudo -S/);
  assert.equal(command.includes('\n'), false);
});
