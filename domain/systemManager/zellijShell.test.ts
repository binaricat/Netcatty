import assert from 'node:assert/strict';
import test from 'node:test';
import { buildZellijAttachCommand } from './zellijShell';
import { buildTmuxAttachCommand } from './tmuxShell';

test('buildZellijAttachCommand attaches to an existing session', () => {
  const command = buildZellijAttachCommand('work');
  assert.ok(command.endsWith("exec zellij attach 'work'"));
});

test('buildZellijAttachCommand -c creates the session when missing', () => {
  const command = buildZellijAttachCommand('new one', { create: true });
  assert.ok(command.endsWith("exec zellij attach -c 'new one'"));
});

test('buildZellijAttachCommand wraps the attach in sudo for another user', () => {
  const command = buildZellijAttachCommand('work', { targetUser: 'alice' });
  assert.ok(command.endsWith("exec sudo -u 'alice' zellij attach 'work'"));
});

test('buildZellijAttachCommand clears startup output before attaching', () => {
  assert.ok(buildZellijAttachCommand('work').startsWith("printf '\\033[H\\033[2J\\033[3J';"));
});

test('buildTmuxAttachCommand wraps the attach in sudo for another user', () => {
  assert.ok(buildTmuxAttachCommand('work').endsWith("exec tmux attach -t 'work'"));
  assert.ok(buildTmuxAttachCommand('work', 2).endsWith("exec tmux attach -t 'work':2"));
  assert.ok(buildTmuxAttachCommand('work', undefined, 'alice').endsWith("exec sudo -u 'alice' tmux attach -t 'work'"));
});
