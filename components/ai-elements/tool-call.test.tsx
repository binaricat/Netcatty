import assert from 'node:assert/strict';
import test from 'node:test';

import { extractDisplayCommand } from './tool-call';

// Codex (SDK) emits command_execution.command as a STRING that wraps the real
// command in `<shell> -lc '<full>'`. Under Skills + CLI the real command is a
// netcatty-tool-cli call. The title must unwrap the shell layer first, else the
// outer quote leaks (the "netcatty: \"" / "netcatty: …md\"" garbage titles).

test('unwraps a /bin/zsh -lc string wrapper (codex SDK shape)', () => {
  assert.equal(
    extractDisplayCommand({ command: `/bin/zsh -lc 'echo "hi"'` }),
    'echo "hi"',
  );
});

test('codex Skills+CLI exec: unwrap shell + netcatty-cli -> remote command', () => {
  assert.equal(
    extractDisplayCommand({
      command: `/bin/zsh -lc '"/abs/netcatty-tool-cli" exec --session X -- "uptime"'`,
    }),
    'uptime',
  );
});

test('codex Skills+CLI session subcommand -> friendly title', () => {
  assert.equal(
    extractDisplayCommand({
      command: `/bin/zsh -lc '"/abs/netcatty-tool-cli" session --session X'`,
    }),
    'netcatty: inspect session',
  );
});

test('raw (unwrapped) netcatty-tool-cli exec still works', () => {
  assert.equal(
    extractDisplayCommand({ command: `"/abs/netcatty-tool-cli" exec --session X -- "uptime"` }),
    'uptime',
  );
});

test('netcatty-tool-cli env -> list sessions', () => {
  assert.equal(extractDisplayCommand({ command: 'netcatty-tool-cli env' }), 'netcatty: list sessions');
});

test('array shell-wrap shape still unwraps (regression)', () => {
  assert.equal(
    extractDisplayCommand({ command: ['zsh', '-lc', 'ls -la /tmp'] }),
    'ls -la /tmp',
  );
});

test('plain command passes through unchanged', () => {
  assert.equal(extractDisplayCommand({ command: 'ls -la /tmp' }), 'ls -la /tmp');
});

test('empty / missing args -> null', () => {
  assert.equal(extractDisplayCommand(undefined), null);
  assert.equal(extractDisplayCommand({ command: '' }), null);
});
