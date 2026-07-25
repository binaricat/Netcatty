import assert from 'node:assert/strict';
import test from 'node:test';

import {
  handleOscColorQueryBroadcastInputForSession,
  beginOscColorQuerySuppressionForCommand,
  beginOscColorQuerySuppressionForStartupCommand,
  consumeHibernatedBroadcastInput,
  endOscColorQuerySuppressionForCommand,
  isDockerLogsCommand,
  markOscColorQuerySuppressionEndBoundary,
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
  assert.equal(isDockerLogsCommand('cd /srv && docker logs -f api'), true);
  assert.equal(isDockerLogsCommand('cd /srv\ndocker container logs api'), true);
  assert.equal(isDockerLogsCommand('docker logs -f api;\n'), true);
  assert.equal(isDockerLogsCommand('docker logs -f api &&'), false);
  assert.equal(isDockerLogsCommand('vim && docker logs -f api'), false);
  assert.equal(isDockerLogsCommand('command cd /srv && docker logs -f api'), true);
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

test('a non-log command restores ordinary color queries only after a user interrupt boundary', () => {
  const state = { current: true };
  beginOscColorQuerySuppressionForCommand(state, 'vim');
  assert.equal(state.current, true);
  markOscColorQuerySuppressionEndBoundary(state);
  assert.equal(state.current, true);
  beginOscColorQuerySuppressionForCommand(state, 'vim');
  assert.equal(state.current, false);
  endOscColorQuerySuppressionForCommand(state);
  assert.equal(state.current, false);
});

test('startup commands recognize saved Docker logs commands and built-in launchers', () => {
  const state = { current: false };

  beginOscColorQuerySuppressionForStartupCommand(state, 'docker logs -f api');
  assert.equal(state.current, true);

  beginOscColorQuerySuppressionForStartupCommand(
    state,
    'cd /srv\ndocker logs -f api',
  );
  assert.equal(state.current, true);

  beginOscColorQuerySuppressionForStartupCommand(
    state,
    'cd "/srv/a && b" && docker logs -f api',
  );
  assert.equal(state.current, true);

  beginOscColorQuerySuppressionForStartupCommand(
    state,
    'docker logs api && echo done',
  );
  assert.equal(state.current, true);

  endOscColorQuerySuppressionForCommand(state);
  beginOscColorQuerySuppressionForStartupCommand(
    state,
    'docker logs api && echo done',
  );
  assert.equal(state.current, false);

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
    (data, command) => {
      if (data.includes('\x03')) markOscColorQuerySuppressionEndBoundary(peerState);
      if (command !== undefined) beginOscColorQuerySuppressionForCommand(peerState, command);
    },
  );
  const unregisterPopup = registerOscColorQuerySuppressionArmer(
    'peer-session',
    (data, command) => {
      if (data.includes('\x03')) markOscColorQuerySuppressionEndBoundary(popupState);
      if (command !== undefined) beginOscColorQuerySuppressionForCommand(popupState, command);
    },
  );

  handleOscColorQueryBroadcastInputForSession('peer-session', '\r', 'docker logs -f api');
  assert.equal(peerState.current, true);
  assert.equal(popupState.current, true);

  handleOscColorQueryBroadcastInputForSession('peer-session', '\x03');
  handleOscColorQueryBroadcastInputForSession('peer-session', '\r', 'vim');
  assert.equal(peerState.current, false);
  assert.equal(popupState.current, false);

  unregisterPopup();
  peerState.current = false;
  popupState.current = false;
  handleOscColorQueryBroadcastInputForSession('peer-session', '\r', 'docker logs -f api');
  assert.equal(peerState.current, true);
  assert.equal(popupState.current, false);

  unregisterPeer();
  peerState.current = false;
  handleOscColorQueryBroadcastInputForSession('peer-session', '\r', 'docker logs -f api');
  assert.equal(peerState.current, false);
});

test('hibernated broadcast input stays trusted across typed echoes until submission', () => {
  const state = { promptReady: true, line: '', tracking: false };
  for (const char of 'docker logs -f api') {
    assert.equal(consumeHibernatedBroadcastInput(state, char), false);
  }
  assert.equal(state.promptReady, true);
  assert.equal(
    consumeHibernatedBroadcastInput(state, '\r', 'docker logs -f api'),
    true,
  );
  assert.deepEqual(state, { promptReady: false, line: '', tracking: false, edited: false });
});

test('hibernated broadcast input rejects mismatched and interrupted submissions', () => {
  const state = { promptReady: true, line: '', tracking: false };
  consumeHibernatedBroadcastInput(state, 'docker ps');
  assert.equal(consumeHibernatedBroadcastInput(state, '\r', 'docker logs -f api'), false);

  state.promptReady = true;
  consumeHibernatedBroadcastInput(state, 'old\x15docker logs -f api');
  assert.equal(consumeHibernatedBroadcastInput(state, '\r', 'docker logs -f api'), true);

  state.promptReady = true;
  consumeHibernatedBroadcastInput(state, 'docker logs -f api\x03');
  assert.equal(consumeHibernatedBroadcastInput(state, '\r', 'docker logs -f api'), false);
});

test('broadcast input accepts trusted multi-line and cursor-edited submissions', () => {
  const multiline = { promptReady: true, line: '', tracking: false };
  assert.equal(consumeHibernatedBroadcastInput(
    multiline,
    'cd /srv\ndocker logs -f api\r',
    'cd /srv\ndocker logs -f api',
  ), true);

  const edited = { promptReady: true, line: '', tracking: false };
  consumeHibernatedBroadcastInput(edited, 'docker logx');
  consumeHibernatedBroadcastInput(edited, '\x1b[D\x7fs');
  assert.equal(consumeHibernatedBroadcastInput(edited, '\r', 'docker logs'), true);

  const untrusted = { promptReady: false, line: '', tracking: false };
  consumeHibernatedBroadcastInput(untrusted, 'docker logs');
  assert.equal(consumeHibernatedBroadcastInput(untrusted, '\r', 'docker logs'), false);
});

test('broadcast history navigation cannot borrow the source command identity', () => {
  const history = { promptReady: true, line: '', tracking: false };
  consumeHibernatedBroadcastInput(history, 'vim');
  consumeHibernatedBroadcastInput(history, '\x1b[A');
  assert.equal(
    consumeHibernatedBroadcastInput(history, '\r', 'docker logs -f api'),
    false,
  );

  const reverseSearch = { promptReady: true, line: '', tracking: false };
  consumeHibernatedBroadcastInput(reverseSearch, '\x12docker');
  assert.equal(
    consumeHibernatedBroadcastInput(reverseSearch, '\r', 'docker logs -f api'),
    false,
  );
});
