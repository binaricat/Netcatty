import assert from 'node:assert/strict';
import test from 'node:test';

import {
  armOscColorQuerySuppressionForSession,
  beginOscColorQuerySuppressionForCommand,
  beginOscColorQuerySuppressionForStartupCommand,
  endOscColorQuerySuppressionForCommand,
  isDockerLogsCommand,
  registerOscColorQuerySuppressionArmer,
  stripOscColorQueryResponses,
} from './oscColorQuerySuppression.ts';

test('Docker log color-query suppression removes only xterm color replies', () => {
  const foregroundReply = '\x1b]10;rgb:1111/2222/3333\x1b\\';
  const indexedReply = '\x1b]4;15;rgb:aaaa/bbbb/cccc\x1b\\';
  const ordinaryInput = 'echo ok\r';

  assert.equal(stripOscColorQueryResponses(foregroundReply, true), '');
  assert.equal(stripOscColorQueryResponses(indexedReply, true), '');
  assert.equal(
    stripOscColorQueryResponses(`${ordinaryInput}${foregroundReply}${indexedReply}`, true),
    ordinaryInput,
  );
  assert.equal(stripOscColorQueryResponses(foregroundReply, false), foregroundReply);
  assert.equal(stripOscColorQueryResponses('\x1b]10;#123456\x1b\\', true), '\x1b]10;#123456\x1b\\');
});

test('docker logs detection covers direct and privileged commands without matching other docker commands', () => {
  assert.equal(isDockerLogsCommand('docker logs -f api'), true);
  assert.equal(isDockerLogsCommand('docker container logs -f api'), true);
  assert.equal(isDockerLogsCommand('sudo -n docker logs --tail 200 api'), true);
  assert.equal(isDockerLogsCommand('sudo docker --host tcp://1.2.3.4:2375 container logs api'), true);
  assert.equal(isDockerLogsCommand('/usr/bin/docker --context prod logs api'), true);
  assert.equal(isDockerLogsCommand('docker exec api sh'), false);
  assert.equal(isDockerLogsCommand('docker container exec api sh'), false);
  assert.equal(isDockerLogsCommand('echo docker logs api'), false);
  assert.equal(isDockerLogsCommand('docker logs api; vim'), false);
  assert.equal(isDockerLogsCommand('docker logs api && vim'), false);
  assert.equal(isDockerLogsCommand('docker logs api | less'), false);
  assert.equal(isDockerLogsCommand('docker logs api 2>&1'), true);
  assert.equal(isDockerLogsCommand('docker logs api > logs.txt'), true);
  assert.equal(isDockerLogsCommand('docker logs api &'), false);
});

test('docker logs stays protected through prompt-like output and interrupt residue', () => {
  const state = { current: false };
  const reply = '\x1b]11;rgb:1111/2222/3333\x1b\\';
  assert.equal(stripOscColorQueryResponses(reply, state.current), reply);
  beginOscColorQuerySuppressionForCommand(state, 'docker logs -f api');
  assert.equal(stripOscColorQueryResponses(reply, state.current), '');
  // Neither prompt-shaped log lines nor Ctrl+C are safe boundaries: output
  // already in flight can still contain color queries after the interrupt.
  assert.equal(stripOscColorQueryResponses(reply, state.current), '');
  assert.equal(state.current, true);
});

test('the next trusted non-log command restores ordinary color queries', () => {
  const state = { current: true };
  beginOscColorQuerySuppressionForCommand(state, 'vim');
  assert.equal(state.current, false);
  endOscColorQuerySuppressionForCommand(state);
  assert.equal(state.current, false);
});

test('startup commands recognize saved Docker logs commands and built-in launchers', () => {
  const state = { current: false };

  beginOscColorQuerySuppressionForStartupCommand(state, 'docker logs -f api');
  assert.equal(state.current, true);

  beginOscColorQuerySuppressionForStartupCommand(state, 'vim');
  assert.equal(state.current, false);

  beginOscColorQuerySuppressionForStartupCommand(
    state,
    'generated shell wrapper',
    'dockerLogs',
  );
  assert.equal(state.current, true);
});

test('broadcast peer sessions can be armed through the suppression registry', () => {
  const peerState = { current: false };
  const popupState = { current: false };
  const unregisterPeer = registerOscColorQuerySuppressionArmer(
    'peer-session',
    (command) => beginOscColorQuerySuppressionForCommand(peerState, command),
  );
  const unregisterPopup = registerOscColorQuerySuppressionArmer(
    'peer-session',
    (command) => beginOscColorQuerySuppressionForCommand(popupState, command),
  );

  armOscColorQuerySuppressionForSession('peer-session', 'docker logs -f api');
  assert.equal(peerState.current, true);
  assert.equal(popupState.current, true);

  armOscColorQuerySuppressionForSession('peer-session', 'vim');
  assert.equal(peerState.current, true);
  assert.equal(popupState.current, true);

  unregisterPopup();
  peerState.current = false;
  popupState.current = false;
  armOscColorQuerySuppressionForSession('peer-session', 'docker logs -f api');
  assert.equal(peerState.current, true);
  assert.equal(popupState.current, false);

  unregisterPeer();
  peerState.current = false;
  armOscColorQuerySuppressionForSession('peer-session', 'docker logs -f api');
  assert.equal(peerState.current, false);
});
