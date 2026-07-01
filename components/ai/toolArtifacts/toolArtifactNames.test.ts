import test from 'node:test';
import assert from 'node:assert/strict';

import {
  inferArtifactToolNameFromCliArgs,
  normalizeArtifactToolName,
} from './toolArtifactNames.ts';

test('normalizeArtifactToolName unwraps MCP server prefixes', () => {
  assert.equal(
    normalizeArtifactToolName('mcp__netcatty__vault_notes_create'),
    'vault_notes_create',
  );
  assert.equal(
    normalizeArtifactToolName('mcp__netcatty-remote-hosts__terminal_read_context'),
    'terminal_read_context',
  );
});

test('normalizeArtifactToolName unwraps OpenCode server prefixes', () => {
  assert.equal(
    normalizeArtifactToolName('netcatty-remote-hosts_vault_notes_get'),
    'vault_notes_get',
  );
  assert.equal(
    normalizeArtifactToolName('netcatty-remote-hosts_vault_hosts_list'),
    'vault_hosts_list',
  );
  assert.equal(
    normalizeArtifactToolName('netcatty-remote-hosts_terminal_read_context'),
    'terminal_read_context',
  );
});

test('normalizeArtifactToolName unwraps Copilot server prefixes', () => {
  assert.equal(
    normalizeArtifactToolName('netcatty-remote-hosts-vault_notes_list'),
    'vault_notes_list',
  );
  assert.equal(
    normalizeArtifactToolName('netcatty-remote-hosts-terminal_read_context'),
    'terminal_read_context',
  );
});

test('inferArtifactToolNameFromCliArgs maps Netcatty CLI artifact commands', () => {
  assert.equal(
    inferArtifactToolNameFromCliArgs({
      command: `/bin/zsh -lc '"/Applications/Netcatty.app/netcatty-tool-cli" vault host get --host-id host_1 --json'`,
    }),
    'host_get',
  );
});
