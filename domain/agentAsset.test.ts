import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { Host } from './models';
import {
  containsRawHostSecretInput,
  maskSecretToolArgs,
  redactHostForAgent,
} from './agentAsset';

const secretHost = {
  id: 'host-1',
  label: 'prod',
  hostname: '10.0.0.1',
  username: 'root',
  password: 'ssh-password-secret',
  telnetPassword: 'telnet-password-secret',
  port: 22,
  tags: ['prod'],
  os: 'linux',
  authMethod: 'password',
  privateKey: 'legacy-private-key-secret',
  passphrase: 'legacy-passphrase-secret',
  identityFilePaths: ['/Users/me/.ssh/prod-key'],
  startupCommand: 'echo startup-secret',
  environmentVariables: [{ key: 'TOKEN', value: 'env-secret', enabled: true }],
  proxyConfig: {
    type: 'ssh',
    host: 'proxy.example.com',
    port: 22,
    username: 'proxy',
    password: 'proxy-secret',
  },
  notes: 'note contains pasted-secret',
} as Host & Record<string, unknown>;

describe('redactHostForAgent', () => {
  it('returns an allowlisted host shape without secrets or freeform notes', () => {
    const redacted = redactHostForAgent(secretHost);
    const serialized = JSON.stringify(redacted);

    assert.equal(redacted.id, 'host-1');
    assert.equal(redacted.hostname, '10.0.0.1');
    assert.equal(redacted.hasPassword, true);
    assert.equal(redacted.hasKey, true);
    assert.equal(redacted.hasNotes, true);
    assert.equal(redacted.notesLength, 'note contains pasted-secret'.length);

    assert.doesNotMatch(serialized, /ssh-password-secret/);
    assert.doesNotMatch(serialized, /telnet-password-secret/);
    assert.doesNotMatch(serialized, /legacy-private-key-secret/);
    assert.doesNotMatch(serialized, /legacy-passphrase-secret/);
    assert.doesNotMatch(serialized, /pasted-secret/);
    assert.doesNotMatch(serialized, /proxy-secret/);
    assert.doesNotMatch(serialized, /env-secret/);
    assert.doesNotMatch(serialized, /startup-secret/);
    assert.doesNotMatch(serialized, /prod-key/);
  });
});

describe('maskSecretToolArgs', () => {
  it('masks secret fields in nested JSON host creation input', () => {
    const args = {
      hosts: JSON.stringify([
        {
          hostname: 'a.example.com',
          password: 'pw-secret',
          telnetPassword: 'tn-secret',
          privateKey: 'key-secret',
          passphrase: 'phrase-secret',
        },
      ]),
    };

    assert.equal(containsRawHostSecretInput(args), true);
    const masked = maskSecretToolArgs('vault_hosts_create', args);
    const serialized = JSON.stringify(masked);
    assert.doesNotMatch(serialized, /pw-secret|tn-secret|key-secret|phrase-secret/);
    assert.match(serialized, /\[REDACTED\]/);
  });

  it('masks import text because exported host data can contain credentials', () => {
    const masked = maskSecretToolArgs('vault_hosts_import', {
      format: 'csv',
      text: 'Hostname,Password\n10.0.0.1,import-secret',
    });
    assert.doesNotMatch(JSON.stringify(masked), /import-secret/);
    assert.equal(masked.text, '[REDACTED_IMPORT_TEXT]');
  });
});
