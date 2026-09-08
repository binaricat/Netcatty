import test from 'node:test';
import assert from 'node:assert/strict';

import type { Host, Identity, ManagedSource, ProxyProfile } from './models.ts';
import { applyGroupDefaults } from './groupConfig.ts';
import {
  applyVaultHostDelete,
  applyVaultHostCreates,
  applyVaultHostUpdate,
  buildVaultHostEndpointKey,
  buildVaultHostFromDraft,
  buildVaultHostMergeKey,
  buildVaultHostsFromDrafts,
  parseVaultHostDraftsInput,
  type VaultHostDraft,
  type VaultHostUpdatePatch,
} from './vaultHostCreate.ts';

test('buildVaultHostMergeKey treats group as part of session identity', () => {
  const base = {
    hostname: '10.10.10.10',
    port: 22,
    username: 'root',
    protocol: 'ssh' as const,
  };
  assert.notEqual(
    buildVaultHostMergeKey({ ...base, group: 'lan' }),
    buildVaultHostMergeKey({ ...base, group: 'lan-proxy' }),
  );
  assert.equal(
    buildVaultHostMergeKey({ ...base, group: 'lan' }),
    buildVaultHostMergeKey({ ...base, group: 'lan' }),
  );
  assert.notEqual(
    buildVaultHostMergeKey({ ...base, group: 'Prod' }),
    buildVaultHostMergeKey({ ...base, group: 'prod' }),
  );
  assert.equal(
    buildVaultHostEndpointKey({ ...base, group: 'lan' }),
    buildVaultHostEndpointKey({ ...base, group: 'lan-proxy' }),
  );
});

test('buildVaultHostFromDraft maps minimal unstructured fields to a vault host', () => {
  const built = buildVaultHostFromDraft({
    hostname: '192.168.1.10',
    username: 'ubuntu',
    label: 'prod web',
    group: 'infra/prod',
    tags: 'web, nginx',
  });

  assert.equal(built.ok, true);
  if (!built.ok) return;
  assert.equal(built.host.hostname, '192.168.1.10');
  assert.equal(built.host.username, 'ubuntu');
  assert.equal(built.host.group, 'infra/prod');
  assert.deepEqual(built.host.tags, ['web', 'nginx']);
});

test('buildVaultHostFromDraft accepts host aliases and a referenced key path', () => {
  const built = buildVaultHostFromDraft({
    name: 'prod api',
    ip: '10.0.0.10',
    username: 'deploy',
    keyPath: '~/.ssh/id_ed25519',
  });

  assert.equal(built.ok, true);
  if (!built.ok) return;
  assert.equal(built.host.label, 'prod api');
  assert.equal(built.host.hostname, '10.0.0.10');
  assert.equal(built.host.authMethod, 'key');
  assert.deepEqual(built.host.identityFilePaths, ['~/.ssh/id_ed25519']);
  assert.equal(built.host.password, undefined);
});

test('buildVaultHostFromDraft does not retain a password when saving is disabled', () => {
  const built = buildVaultHostFromDraft({
    hostname: '10.0.0.20',
    username: 'deploy',
    password: 'do-not-save',
    savePassword: 'false',
  });

  assert.equal(built.ok, true);
  if (!built.ok) return;
  assert.equal(built.host.password, undefined);
  assert.equal(built.host.savePassword, false);
});

test('buildVaultHostFromDraft rejects an invalid password-saving option', () => {
  const built = buildVaultHostFromDraft({
    hostname: '10.0.0.20',
    savePassword: 'sometimes',
  });

  assert.equal(built.ok, false);
  if (built.ok) return;
  assert.match(built.error, /true or false/i);
});

test('buildVaultHostFromDraft rejects non-integer ports instead of changing them', () => {
  for (const port of [22.9, '22.9', '22oops']) {
    const built = buildVaultHostFromDraft({ hostname: '10.0.0.20', port });

    assert.equal(built.ok, false);
    if (built.ok) continue;
    assert.match(built.error, /integer between 1 and 65535/i);
  }
});

test('buildVaultHostFromDraft rejects an unsupported protocol instead of using SSH', () => {
  const built = buildVaultHostFromDraft({ hostname: '10.0.0.20', protocol: 'ftp' });

  assert.equal(built.ok, false);
  if (built.ok) return;
  assert.match(built.error, /ssh, telnet, or local/i);
});

test('buildVaultHostFromDraft rejects hostnames containing internal whitespace', () => {
  for (const hostname of ['db prod.example.com', 'db\tprod.example.com']) {
    const built = buildVaultHostFromDraft({ hostname });

    assert.equal(built.ok, false);
    if (built.ok) continue;
    assert.match(built.error, /must not contain whitespace/i);
  }
});

test('buildVaultHostFromDraft rejects invalid host objects and optional field types', () => {
  const invalidDraft = buildVaultHostFromDraft(null as unknown as VaultHostDraft);
  const invalidKeyPath = buildVaultHostFromDraft({ hostname: 'host.example.com', keyPath: 123 });
  const invalidPassphrase = buildVaultHostFromDraft({
    hostname: 'host.example.com',
    keyPath: '~/.ssh/id_ed25519',
    passphrase: 123,
  });
  const missingKeyPath = buildVaultHostFromDraft({
    hostname: 'host.example.com',
    passphrase: 'secret',
  });

  assert.equal(invalidDraft.ok, false);
  assert.equal(invalidKeyPath.ok, false);
  assert.equal(invalidPassphrase.ok, false);
  assert.equal(missingKeyPath.ok, false);
  if (!invalidDraft.ok) assert.match(invalidDraft.error, /must be an object/i);
  if (!invalidKeyPath.ok) assert.match(invalidKeyPath.error, /keyPath must be a string/i);
  if (!invalidPassphrase.ok) assert.match(invalidPassphrase.error, /passphrase must be a string/i);
  if (!missingKeyPath.ok) assert.match(missingKeyPath.error, /keyPath is required/i);
});

test('buildVaultHostFromDraft rejects SSH config line injection', () => {
  for (const draft of [
    { hostname: 'host.example.com', username: 'root\nProxyCommand /tmp/run' },
    { hostname: 'host.example.com', keyPath: '~/.ssh/id\rProxyCommand /tmp/run' },
    { hostname: 'host.example.com\0ProxyCommand /tmp/run' },
  ]) {
    const built = buildVaultHostFromDraft(draft);
    assert.equal(built.ok, false);
    if (built.ok) continue;
    assert.match(built.error, /line breaks or null bytes/i);
  }
});

test('buildVaultHostFromDraft allows direct and Telnet usernames containing at signs', () => {
  const direct = buildVaultHostFromDraft({
    hostname: 'host.example.com',
    username: 'alice@example.com',
  });
  const telnet = buildVaultHostFromDraft({
    hostname: 'telnet.example.com',
    username: 'alice@example.com',
    protocol: 'telnet',
  });

  assert.equal(direct.ok, true);
  assert.equal(telnet.ok, true);
});

test('parseVaultHostDraftsInput accepts JSON array strings', () => {
  const parsed = parseVaultHostDraftsInput(JSON.stringify([
    { hostname: '10.0.0.1', username: 'root' },
    { hostname: '10.0.0.2', username: 'deploy', port: 2222 },
  ]));

  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.equal(parsed.drafts.length, 2);
});

test('applyVaultHostCreates writes sanitized hosts into the vault list', () => {
  const existing: Host = {
    id: 'host-1',
    label: 'db',
    hostname: '10.0.0.99',
    username: 'root',
    port: 22,
    tags: [],
    os: 'linux',
  };
  const { hosts: built } = buildVaultHostsFromDrafts([
    { hostname: '10.0.0.10', username: 'deploy', group: 'prod' },
  ]);
  const merged = applyVaultHostCreates([existing], ['legacy'], built);

  assert.equal(merged.addedCount, 1);
  assert.equal(merged.hosts.length, 2);
  assert.ok(merged.customGroups.includes('prod'));
});

test('applyVaultHostUpdate changes only provided fields and adds a new group', () => {
  const existing: Host = {
    id: 'host-1',
    label: 'old label',
    hostname: '10.0.0.1',
    username: 'root',
    port: 22,
    tags: ['keep'],
    os: 'linux',
    notes: 'old notes',
  };

  const result = applyVaultHostUpdate([existing], ['legacy'], 'host-1', {
    name: 'new label',
    host: 'server.example.com',
    port: 2222,
    group: 'prod/api',
    notes: '',
  });

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.updatedHost.label, 'new label');
  assert.equal(result.updatedHost.hostname, 'server.example.com');
  assert.equal(result.updatedHost.port, 2222);
  assert.equal(result.updatedHost.username, 'root');
  assert.deepEqual(result.updatedHost.tags, ['keep']);
  assert.equal(result.updatedHost.notes, undefined);
  assert.ok(result.customGroups.includes('prod/api'));
});

test('applyVaultHostUpdate rejects non-integer ports instead of changing them', () => {
  const existing: Host = {
    id: 'host-1',
    label: 'host',
    hostname: '10.0.0.1',
    username: 'root',
    port: 22,
    tags: [],
    os: 'linux',
  };

  for (const port of [22.9, '22.9', '22oops']) {
    const result = applyVaultHostUpdate([existing], [], existing.id, { port });

    assert.equal(result.ok, false);
    if (result.ok) continue;
    assert.match(result.error, /integer between 1 and 65535/i);
  }
});

test('applyVaultHostUpdate rejects hostnames containing internal whitespace', () => {
  const existing: Host = {
    id: 'host-1',
    label: 'host',
    hostname: 'old.example.com',
    username: 'root',
    port: 22,
    tags: [],
    os: 'linux',
  };

  for (const hostname of ['db prod.example.com', 'db\tprod.example.com']) {
    const result = applyVaultHostUpdate([existing], [], existing.id, { hostname });

    assert.equal(result.ok, false);
    if (result.ok) continue;
    assert.match(result.error, /must not contain whitespace/i);
  }
});

test('applyVaultHostUpdate changes default ports when switching protocols', () => {
  const ssh: Host = {
    id: 'ssh',
    label: 'ssh',
    hostname: 'ssh.example.com',
    username: 'root',
    port: 22,
    protocol: 'ssh',
    tags: [],
    os: 'linux',
  };
  const telnet: Host = {
    ...ssh,
    id: 'telnet',
    label: 'telnet',
    port: 23,
    protocol: 'telnet',
  };
  const custom: Host = { ...ssh, id: 'custom', label: 'custom', port: 2222 };
  const serial: Host = {
    ...ssh,
    id: 'serial',
    label: 'serial',
    hostname: '/dev/ttyUSB0',
    port: 115200,
    protocol: 'serial',
    serialConfig: { path: '/dev/ttyUSB0', baudRate: 115200 },
  };

  const toTelnet = applyVaultHostUpdate([ssh], [], ssh.id, { protocol: 'telnet' });
  const toSsh = applyVaultHostUpdate([telnet], [], telnet.id, { protocol: 'ssh' });
  const keepCustom = applyVaultHostUpdate([custom], [], custom.id, { protocol: 'telnet' });
  const explicitPort = applyVaultHostUpdate([ssh], [], ssh.id, { protocol: 'telnet', port: 2323 });
  const missingNetworkHostname = applyVaultHostUpdate([serial], [], serial.id, { protocol: 'ssh' });
  const serialToSsh = applyVaultHostUpdate(
    [serial], [], serial.id, { protocol: 'ssh', hostname: 'ssh.example.com' },
  );
  const serialToTelnet = applyVaultHostUpdate(
    [serial], [], serial.id, { protocol: 'telnet', hostname: 'telnet.example.com' },
  );

  assert.equal(toTelnet.ok, true);
  assert.equal(toSsh.ok, true);
  assert.equal(keepCustom.ok, true);
  assert.equal(explicitPort.ok, true);
  assert.equal(missingNetworkHostname.ok, false);
  assert.equal(serialToSsh.ok, true);
  assert.equal(serialToTelnet.ok, true);
  if (!toTelnet.ok || !toSsh.ok || !keepCustom.ok || !explicitPort.ok || !serialToSsh.ok || !serialToTelnet.ok) return;
  assert.equal(toTelnet.updatedHost.port, 23);
  assert.equal(toSsh.updatedHost.port, 22);
  assert.equal(keepCustom.updatedHost.port, 2222);
  assert.equal(explicitPort.updatedHost.port, 2323);
  assert.equal(serialToSsh.updatedHost.port, 22);
  assert.equal(serialToTelnet.updatedHost.port, 23);
  assert.equal(serialToSsh.updatedHost.hostname, 'ssh.example.com');
  assert.equal(serialToTelnet.updatedHost.hostname, 'telnet.example.com');
  const backToSerial = applyVaultHostUpdate(
    [serialToSsh.updatedHost], [], serial.id, { protocol: 'serial' },
  );
  assert.equal(backToSerial.ok, true);
  if (backToSerial.ok) assert.equal(backToSerial.updatedHost.port, 115200);
});

test('applyVaultHostUpdate requires serial settings when switching to serial', () => {
  const ssh: Host = {
    id: 'ssh', label: 'ssh', hostname: 'ssh.example.com', username: 'root',
    port: 22, protocol: 'ssh', tags: [], os: 'linux',
  };

  const missingConfig = applyVaultHostUpdate([ssh], [], ssh.id, { protocol: 'serial' });
  assert.equal(missingConfig.ok, false);
  if (!missingConfig.ok) assert.match(missingConfig.error, /serialConfig is required/i);

  const configured = applyVaultHostUpdate([ssh], [], ssh.id, {
    protocol: 'serial',
    serialConfig: { path: '/dev/ttyUSB0', baudRate: 115200 },
  });
  assert.equal(configured.ok, true);
  if (configured.ok) {
    assert.equal(configured.updatedHost.protocol, 'serial');
    assert.equal(configured.updatedHost.port, 115200);
    assert.equal(configured.updatedHost.serialConfig?.baudRate, 115200);
  }
});

test('applyVaultHostUpdate only accepts SSH-capable jump hosts', () => {
  const target: Host = {
    id: 'target', label: 'target', hostname: 'target.example.com', username: 'root',
    port: 22, protocol: 'ssh', tags: [], os: 'linux',
  };
  const localJump: Host = {
    id: 'local', label: 'local', hostname: 'localhost', username: '',
    port: 22, protocol: 'local', tags: [], os: 'linux',
  };
  const inheritedJump: Host = {
    id: 'inherited', label: 'inherited', hostname: 'inherited.example.com', username: 'root',
    port: 22, tags: [], os: 'linux',
  };

  const localResult = applyVaultHostUpdate(
    [target, localJump], [], target.id, { jumpHostIds: [localJump.id] },
  );
  const inheritedResult = applyVaultHostUpdate(
    [target, inheritedJump], [], target.id, { jumpHostIds: [inheritedJump.id] },
    { resolveEffectiveHost: (host) => host.id === inheritedJump.id ? { ...host, protocol: 'telnet' } : host },
  );

  assert.equal(localResult.ok, false);
  if (!localResult.ok) assert.match(localResult.error, /does not support SSH jump/i);
  assert.equal(inheritedResult.ok, false);
  if (!inheritedResult.ok) assert.match(inheritedResult.error, /does not support SSH jump/i);
});

test('applyVaultHostUpdate keeps referenced jump hosts SSH-capable', () => {
  const jump: Host = {
    id: 'jump', label: 'jump', hostname: 'jump.example.com', username: 'root',
    port: 22, protocol: 'ssh', tags: [], os: 'linux',
  };
  const target: Host = {
    id: 'target', label: 'target', hostname: 'target.example.com', username: 'root',
    port: 22, protocol: 'ssh', hostChain: { hostIds: [jump.id] }, tags: [], os: 'linux',
  };

  const directResult = applyVaultHostUpdate(
    [jump, target], [], jump.id, { protocol: 'telnet' },
  );
  const inheritedResult = applyVaultHostUpdate(
    [jump, target], [], jump.id, { group: 'telnet-hosts' },
    { resolveEffectiveHost: (host) => host.group === 'telnet-hosts' ? { ...host, protocol: 'telnet' } : host },
  );
  const groupInheritedResult = applyVaultHostUpdate(
    [jump, { ...target, hostChain: undefined, group: 'prod' }],
    [],
    jump.id,
    { protocol: 'telnet' },
    {
      resolveEffectiveHost: (host) => host.group === 'prod'
        ? { ...host, hostChain: { hostIds: [jump.id] } }
        : host,
    },
  );

  assert.equal(directResult.ok, false);
  if (!directResult.ok) assert.match(directResult.error, /used as a jump host must keep an SSH/i);
  assert.equal(inheritedResult.ok, false);
  if (!inheritedResult.ok) assert.match(inheritedResult.error, /used as a jump host must keep an SSH/i);
  assert.equal(groupInheritedResult.ok, false);
  if (!groupInheritedResult.ok) assert.match(groupInheritedResult.error, /used as a jump host must keep an SSH/i);
});

test('applyVaultHostUpdate allows reciprocal independent jump settings', () => {
  const first: Host = {
    id: 'first', label: 'first', hostname: 'first.example.com', username: 'root',
    port: 22, protocol: 'ssh', hostChain: { hostIds: ['second'] }, tags: [], os: 'linux',
  };
  const second: Host = {
    id: 'second', label: 'second', hostname: 'second.example.com', username: 'root',
    port: 22, protocol: 'ssh', tags: [], os: 'linux',
  };

  const result = applyVaultHostUpdate(
    [first, second], [], second.id, { jumpHostIds: [first.id] },
  );

  assert.equal(result.ok, true);
});

test('applyVaultHostUpdate validates jump hosts inherited from the destination group', () => {
  const jump: Host = {
    id: 'jump', label: 'jump', hostname: 'jump.example.com', username: 'root',
    port: 23, protocol: 'telnet', tags: [], os: 'linux',
  };
  const target: Host = {
    id: 'target', label: 'target', hostname: 'target.example.com', username: 'root',
    port: 22, protocol: 'ssh', tags: [], os: 'linux',
  };

  const unsupported = applyVaultHostUpdate(
    [jump, target],
    [],
    target.id,
    { group: 'unsupported-jump' },
    {
      resolveEffectiveHost: (host) => host.group === 'unsupported-jump'
        ? { ...host, hostChain: { hostIds: [jump.id] } }
        : host,
    },
  );
  const selfReference = applyVaultHostUpdate(
    [jump, target],
    [],
    target.id,
    { group: 'self-jump' },
    {
      resolveEffectiveHost: (host) => host.group === 'self-jump'
        ? { ...host, hostChain: { hostIds: [target.id] } }
        : host,
    },
  );

  assert.equal(unsupported.ok, false);
  if (!unsupported.ok) assert.match(unsupported.error, /does not support SSH jump/i);
  assert.equal(selfReference.ok, false);
  if (!selfReference.ok) assert.match(selfReference.error, /cannot use itself/i);
});

test('applyVaultHostUpdate keeps jump hosts referenced only by empty group defaults SSH-capable', () => {
  const jump: Host = {
    id: 'jump', label: 'jump', hostname: 'jump.example.com', username: 'root',
    port: 22, protocol: 'ssh', tags: [], os: 'linux',
  };

  const result = applyVaultHostUpdate(
    [jump],
    [],
    jump.id,
    { protocol: 'telnet' },
    { groupConfigs: [{ path: 'empty-group', hostChain: { hostIds: [jump.id] } }] },
  );

  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.error, /group jump host must keep an SSH/i);
});

test('applyVaultHostUpdate keeps legacy serial hosts editable without serialConfig', () => {
  const legacySerial: Host = {
    id: 'serial', label: 'Old serial', hostname: '/dev/ttyUSB0', username: '',
    port: 115200, protocol: 'serial', tags: [], os: 'linux',
  };

  const result = applyVaultHostUpdate([legacySerial], [], legacySerial.id, { label: 'Renamed serial' });

  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.updatedHost.label, 'Renamed serial');
});

test('applyVaultHostUpdate applies and clears advanced connection settings', () => {
  const host: Host = {
    id: 'host-1', label: 'host', hostname: 'host.example.com', username: 'root',
    port: 22, protocol: 'ssh', tags: [], os: 'linux',
  };
  const jump: Host = {
    id: 'jump-1', label: 'jump', hostname: 'jump.example.com', username: 'root', tags: [], os: 'linux',
  };
  const identity: Identity = {
    id: 'identity-1', label: 'deploy', username: 'deploy', authMethod: 'key', keyId: 'key-1', created: 1,
  };
  const proxyProfile: ProxyProfile = {
    id: 'proxy-1', label: 'proxy', config: { type: 'socks5', host: '127.0.0.1', port: 1080 }, createdAt: 1,
  };
  const patch: VaultHostUpdatePatch = {
    protocol: 'serial',
    identityId: identity.id,
    jumpHostIds: [jump.id],
    proxyProfileId: proxyProfile.id,
    startupCommand: 'tmux attach || tmux',
    startupCommandRunMode: 'lineDelay',
    environmentVariables: [{ name: 'APP_ENV', value: 'production' }],
    moshEnabled: false,
    moshServerPath: '/usr/local/bin/mosh-server',
    etEnabled: false,
    etPort: 2022,
    serialConfig: {
      path: '/dev/ttyUSB0', baudRate: 115200, dataBits: 8, stopBits: 1,
      parity: 'none', flowControl: 'rts/cts', localEcho: true, lineMode: false,
    },
  };

  const result = applyVaultHostUpdate(
    [host, jump], [], host.id, patch,
    { identities: [identity], proxyProfiles: [proxyProfile] },
  );
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.updatedHost.protocol, 'serial');
  assert.equal(result.updatedHost.hostname, '/dev/ttyUSB0');
  assert.equal(result.updatedHost.identityId, identity.id);
  assert.equal(result.updatedHost.username, 'deploy');
  assert.deepEqual(result.updatedHost.hostChain, { hostIds: [jump.id] });
  assert.equal(result.updatedHost.proxyProfileId, proxyProfile.id);
  assert.equal(result.updatedHost.startupCommand, 'tmux attach || tmux');
  assert.equal(result.updatedHost.startupCommandRunMode, 'lineDelay');
  assert.deepEqual(result.updatedHost.environmentVariables, [{ name: 'APP_ENV', value: 'production' }]);
  assert.equal(result.updatedHost.moshEnabled, false);
  assert.equal(result.updatedHost.moshServerPath, '/usr/local/bin/mosh-server');
  assert.equal(result.updatedHost.etEnabled, false);
  assert.equal(result.updatedHost.etPort, 2022);
  assert.deepEqual(result.updatedHost.serialConfig, {
    path: '/dev/ttyUSB0', baudRate: 115200, dataBits: 8, stopBits: 1,
    parity: 'none', flowControl: 'rts/cts', localEcho: true, lineMode: false,
  });

  const cleared = applyVaultHostUpdate([result.updatedHost, jump], [], host.id, {
    jumpHostIds: [],
    proxyProfileId: '',
    startupCommand: '',
    startupCommandRunMode: '',
    environmentVariables: {},
    moshEnabled: false,
    moshServerPath: '',
    etEnabled: false,
  }, { identities: [identity], proxyProfiles: [proxyProfile] });
  assert.equal(cleared.ok, true);
  if (!cleared.ok) return;
  assert.deepEqual(cleared.updatedHost.hostChain, { hostIds: [] });
  assert.equal(cleared.updatedHost.proxyProfileId, '');
  assert.equal(cleared.updatedHost.startupCommand, '');
  assert.equal(cleared.updatedHost.startupCommandRunMode, undefined);
  assert.deepEqual(cleared.updatedHost.environmentVariables, []);
  assert.equal(cleared.updatedHost.moshEnabled, false);
  assert.equal(cleared.updatedHost.moshServerPath, undefined);
  assert.equal(cleared.updatedHost.etEnabled, false);
});

test('applyVaultHostUpdate rejects malformed advanced connection settings', () => {
  const host: Host = {
    id: 'host-1', label: 'host', hostname: 'host.example.com', username: 'root', tags: [], os: 'linux',
  };
  const jump: Host = {
    id: 'jump-1', label: 'jump', hostname: 'jump.example.com', username: 'root', tags: [], os: 'linux',
  };
  const cases: Array<{ patch: VaultHostUpdatePatch; error: RegExp }> = [
    { patch: { protocol: 'unknown' }, error: /protocol/i },
    { patch: { identityId: 42 }, error: /identityId must be a string/i },
    { patch: { identityId: 'missing' }, error: /Identity .* was not found/i },
    { patch: { jumpHostIds: '["jump-1"' }, error: /valid JSON array/i },
    { patch: { jumpHostIds: [host.id] }, error: /cannot use itself/i },
    { patch: { jumpHostIds: [jump.id, jump.id] }, error: /duplicates/i },
    { patch: { jumpHostIds: ['missing'] }, error: /Jump host .* was not found/i },
    { patch: { proxyProfileId: 'missing' }, error: /Proxy profile .* was not found/i },
    { patch: { startupCommand: 42 }, error: /startupCommand must be a string/i },
    { patch: { startupCommandRunMode: 'fast' }, error: /paste or lineDelay/i },
    { patch: { environmentVariables: '{' }, error: /valid JSON/i },
    { patch: { environmentVariables: [{ value: 'missing-name' }] }, error: /require name and value/i },
    { patch: { moshEnabled: 'maybe' }, error: /moshEnabled must be true or false/i },
    { patch: { etEnabled: 'maybe' }, error: /etEnabled must be true or false/i },
    { patch: { moshEnabled: true, etEnabled: true }, error: /cannot both be enabled/i },
    { patch: { protocol: 'serial', moshEnabled: true, serialConfig: { path: '/dev/ttyUSB0', baudRate: 9600 } }, error: /require the SSH protocol/i },
    { patch: { etPort: 0 }, error: /between 1 and 65535/i },
    { patch: { serialConfig: '{' }, error: /valid JSON/i },
    { patch: { serialConfig: {} }, error: /requires path and a positive baudRate/i },
    { patch: { serialConfig: { path: '/dev/ttyUSB0\nspoof', baudRate: 9600 } }, error: /line breaks or null bytes/i },
    { patch: { serialConfig: { path: '/dev/ttyUSB0', baudRate: 9600, dataBits: 9 } }, error: /dataBits/i },
    { patch: { serialConfig: { path: '/dev/ttyUSB0', baudRate: 9600, stopBits: 3 } }, error: /stopBits/i },
    { patch: { serialConfig: { path: '/dev/ttyUSB0', baudRate: 9600, parity: 'bad' } }, error: /parity/i },
    { patch: { serialConfig: { path: '/dev/ttyUSB0', baudRate: 9600, flowControl: 'bad' } }, error: /flowControl/i },
    { patch: { serialConfig: { path: '/dev/ttyUSB0', baudRate: 9600, localEcho: 'maybe' } }, error: /localEcho/i },
    { patch: { serialConfig: { path: '/dev/ttyUSB0', baudRate: 9600, lineMode: 'maybe' } }, error: /lineMode/i },
    { patch: { serialConfig: { path: '/dev/ttyUSB0', baudRate: 9600, backspaceBehavior: 'bad' } }, error: /backspaceBehavior/i },
    { patch: { serialConfig: { path: '/dev/ttyUSB0', baudRate: 9600, byteOrientedBackspace: 'maybe' } }, error: /byteOrientedBackspace/i },
  ];

  for (const entry of cases) {
    const result = applyVaultHostUpdate([host, jump], [], host.id, entry.patch, {
      identities: [], proxyProfiles: [],
    });
    assert.equal(result.ok, false, JSON.stringify(entry.patch));
    if (!result.ok) assert.match(result.error, entry.error);
  }
});

test('applyVaultHostUpdate keeps Mosh and ET mutually exclusive and clears them for other protocols', () => {
  const host: Host = {
    id: 'host-1', label: 'host', hostname: 'host.example.com', username: 'root',
    protocol: 'ssh', moshEnabled: true, tags: [], os: 'linux',
  };

  const switchedToEt = applyVaultHostUpdate([host], [], host.id, { etEnabled: true });
  assert.equal(switchedToEt.ok, true);
  if (!switchedToEt.ok) return;
  assert.equal(switchedToEt.updatedHost.moshEnabled, false);
  assert.equal(switchedToEt.updatedHost.etEnabled, true);

  const switchedToTelnet = applyVaultHostUpdate(
    [switchedToEt.updatedHost], [], host.id, { protocol: 'telnet' },
  );
  assert.equal(switchedToTelnet.ok, true);
  if (!switchedToTelnet.ok) return;
  assert.equal(switchedToTelnet.updatedHost.moshEnabled, false);
  assert.equal(switchedToTelnet.updatedHost.etEnabled, false);
});

test('applyVaultHostUpdate preserves repeated SSH mode and synchronizes serial paths both ways', () => {
  const moshHost: Host = {
    id: 'mosh-1', label: 'mosh', hostname: 'host.example.com', username: 'root',
    protocol: 'ssh', moshEnabled: true, tags: [], os: 'linux',
  };
  const repeatedSsh = applyVaultHostUpdate([moshHost], [], moshHost.id, {
    protocol: 'ssh', label: 'renamed',
  });
  assert.equal(repeatedSsh.ok, true);
  if (!repeatedSsh.ok) return;
  assert.equal(repeatedSsh.updatedHost.moshEnabled, true);

  const serialHost: Host = {
    id: 'serial-1', label: 'serial', hostname: '/dev/ttyUSB0', username: '',
    protocol: 'serial', port: 9600, serialConfig: { path: '/dev/ttyUSB0', baudRate: 9600 },
    tags: [], os: 'linux',
  };
  const updatedPath = applyVaultHostUpdate([serialHost], [], serialHost.id, {
    hostname: '/dev/ttyUSB1',
  });
  assert.equal(updatedPath.ok, true);
  if (!updatedPath.ok) return;
  assert.equal(updatedPath.updatedHost.hostname, '/dev/ttyUSB1');
  assert.equal(updatedPath.updatedHost.serialConfig?.path, '/dev/ttyUSB1');

  const conflictingPaths = applyVaultHostUpdate([serialHost], [], serialHost.id, {
    hostname: '/dev/ttyUSB1',
    serialConfig: { path: '/dev/ttyUSB2', baudRate: 9600 },
  });
  assert.equal(conflictingPaths.ok, false);
  if (!conflictingPaths.ok) assert.match(conflictingPaths.error, /must match/i);

  const retainedSerialSettings: Host = {
    ...serialHost,
    protocol: 'ssh',
    hostname: 'server.example.com',
  };
  const switchedBackToSerial = applyVaultHostUpdate(
    [retainedSerialSettings], [], retainedSerialSettings.id, { protocol: 'serial' },
  );
  assert.equal(switchedBackToSerial.ok, true);
  if (!switchedBackToSerial.ok) return;
  assert.equal(switchedBackToSerial.updatedHost.hostname, '/dev/ttyUSB0');

  const whitespacePath = applyVaultHostUpdate([serialHost], [], serialHost.id, {
    serialConfig: { path: '/tmp/serial link', baudRate: 9600 },
  });
  assert.equal(whitespacePath.ok, true);
  if (!whitespacePath.ok) return;
  assert.equal(whitespacePath.updatedHost.hostname, '/tmp/serial link');
  assert.equal(whitespacePath.updatedHost.serialConfig?.path, '/tmp/serial link');

  const hostnameOnlyWhitespacePath = applyVaultHostUpdate([serialHost], [], serialHost.id, {
    hostname: '/tmp/serial link',
  });
  assert.equal(hostnameOnlyWhitespacePath.ok, true);
  if (!hostnameOnlyWhitespacePath.ok) return;
  assert.equal(hostnameOnlyWhitespacePath.updatedHost.hostname, '/tmp/serial link');
  assert.equal(hostnameOnlyWhitespacePath.updatedHost.serialConfig?.path, '/tmp/serial link');

  const matchingWhitespacePaths = applyVaultHostUpdate([serialHost], [], serialHost.id, {
    hostname: '/tmp/serial link',
    serialConfig: { path: '/tmp/serial link', baudRate: 9600 },
  });
  assert.equal(matchingWhitespacePaths.ok, true);
  if (!matchingWhitespacePaths.ok) return;
  assert.equal(matchingWhitespacePaths.updatedHost.hostname, '/tmp/serial link');
});

test('applyVaultHostUpdate validates Mosh and ET against inherited connection settings', () => {
  const host: Host = {
    id: 'host-1', label: 'host', hostname: 'host.example.com', username: 'root',
    group: 'inherited', tags: [], os: 'linux',
  };
  const inheritedTelnet = applyVaultHostUpdate([host], [], host.id, { moshEnabled: true }, {
    resolveEffectiveHost: (candidate) => ({ ...candidate, protocol: 'telnet' }),
  });
  assert.equal(inheritedTelnet.ok, false);
  if (!inheritedTelnet.ok) assert.match(inheritedTelnet.error, /require the SSH protocol/i);

  const inheritedEt = applyVaultHostUpdate([host], [], host.id, { moshEnabled: true }, {
    resolveEffectiveHost: (candidate) => ({ ...candidate, etEnabled: true }),
  });
  assert.equal(inheritedEt.ok, false);
  if (!inheritedEt.ok) assert.match(inheritedEt.error, /cannot both be enabled/i);
});

test('applyVaultHostUpdate preserves serial Backspace override semantics', () => {
  for (const backspaceBehavior of ['ctrl-h', 'default', undefined] as const) {
    const host: Host = {
      id: `serial-${backspaceBehavior ?? 'inherited'}`,
      label: 'serial',
      hostname: 'serial',
      username: '',
      protocol: 'serial',
      tags: [],
      os: 'linux',
      serialConfig: {
        path: '/dev/ttyUSB0',
        baudRate: 9600,
        ...(backspaceBehavior !== undefined ? { backspaceBehavior } : {}),
      },
    };

    const updated = applyVaultHostUpdate([host], [], host.id, {
      serialConfig: { path: '/dev/ttyUSB0', baudRate: 115200 },
    });
    assert.equal(updated.ok, true);
    if (!updated.ok) continue;
    assert.equal(updated.updatedHost.serialConfig?.backspaceBehavior, backspaceBehavior);
  }
});

test('applyVaultHostUpdate preserves serial byteOrientedBackspace semantics', () => {
  for (const byteOrientedBackspace of [true, false, undefined] as const) {
    const host: Host = {
      id: `serial-${byteOrientedBackspace ?? 'inherited'}`,
      label: 'serial',
      hostname: 'serial',
      username: '',
      protocol: 'serial',
      tags: [],
      os: 'linux',
      serialConfig: {
        path: '/dev/ttyUSB0',
        baudRate: 9600,
        ...(byteOrientedBackspace !== undefined ? { byteOrientedBackspace } : {}),
      },
    };

    const updated = applyVaultHostUpdate([host], [], host.id, {
      serialConfig: { path: '/dev/ttyUSB0', baudRate: 115200 },
    });
    assert.equal(updated.ok, true);
    if (!updated.ok) continue;
    assert.equal(
      updated.updatedHost.serialConfig?.byteOrientedBackspace,
      byteOrientedBackspace,
    );
  }
});

test('applyVaultHostUpdate can switch a host to a referenced key path', () => {
  const existing: Host = {
    id: 'host-1',
    label: 'host',
    hostname: '10.0.0.1',
    username: 'root',
    port: 22,
    tags: [],
    os: 'linux',
    password: 'secret',
    authMethod: 'password',
  };

  const result = applyVaultHostUpdate([existing], [], 'host-1', {
    keyPath: '/Users/alice/.ssh/id_ed25519',
  });

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.updatedHost.authMethod, 'key');
  assert.deepEqual(result.updatedHost.identityFilePaths, ['/Users/alice/.ssh/id_ed25519']);
  assert.equal(result.updatedHost.identityId, '');
});

test('applyVaultHostUpdate parses JSON array tag strings', () => {
  const existing: Host = {
    id: 'host-1',
    label: 'host',
    hostname: '10.0.0.1',
    username: 'root',
    tags: [],
    os: 'linux',
  };

  const result = applyVaultHostUpdate([existing], [], 'host-1', {
    tags: '["prod", "api", "prod"]',
  });

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(result.updatedHost.tags, ['prod', 'api']);
});

test('applyVaultHostUpdate rejects malformed JSON tag strings', () => {
  const existing: Host = {
    id: 'host-1',
    label: 'host',
    hostname: '10.0.0.1',
    username: 'root',
    tags: ['keep'],
    os: 'linux',
  };

  const result = applyVaultHostUpdate([existing], [], 'host-1', {
    tags: '["prod"',
  });

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.match(result.error, /valid JSON array/i);
});

test('applyVaultHostUpdate rejects SSH config line injection', () => {
  const existing: Host = {
    id: 'host-1',
    label: 'host',
    hostname: 'host.example.com',
    username: 'root',
    tags: [],
    os: 'linux',
  };

  for (const patch of [
    { username: 'root\nProxyCommand /tmp/run' },
    { keyPath: '~/.ssh/id\rProxyCommand /tmp/run' },
    { hostname: 'host.example.com\0ProxyCommand /tmp/run' },
    { label: 'host\nProxyCommand /tmp/run' },
  ]) {
    const result = applyVaultHostUpdate([existing], [], existing.id, patch);
    assert.equal(result.ok, false);
    if (result.ok) continue;
    assert.match(result.error, /line breaks or null bytes/i);
  }
});

test('applyVaultHostUpdate limits SSH syntax checks to managed aliases and active jump hosts', () => {
  const managedSource: ManagedSource = {
    id: 'source-1',
    type: 'ssh_config',
    filePath: '~/.ssh/config',
    groupName: 'managed',
    lastSyncedAt: 1,
  };
  const jump: Host = {
    id: 'jump',
    label: 'jump',
    hostname: 'jump.example.com',
    username: 'root',
    tags: [],
    os: 'linux',
  };
  const managedTarget: Host = {
    id: 'target',
    label: 'target',
    hostname: 'target.example.com',
    username: 'root',
    group: 'managed',
    managedSourceId: managedSource.id,
    hostChain: { hostIds: [jump.id] },
    tags: [],
    os: 'linux',
  };
  const options = { managedSources: [managedSource] };

  const directUsername = applyVaultHostUpdate(
    [jump],
    [],
    jump.id,
    { username: 'alice@example.com' },
  );
  const encodedAlias = applyVaultHostUpdate(
    [managedTarget],
    [],
    managedTarget.id,
    { label: '*' },
    options,
  );
  const badJumpHostname = applyVaultHostUpdate(
    [jump, managedTarget],
    [],
    jump.id,
    { hostname: 'first.example.com,second.example.com' },
    options,
  );
  const badJumpUsername = applyVaultHostUpdate(
    [jump, managedTarget],
    [],
    jump.id,
    { username: 'user,attacker' },
    options,
  );
  const emailJumpUsername = applyVaultHostUpdate(
    [jump, managedTarget],
    [],
    jump.id,
    { username: 'alice@example.com' },
    options,
  );
  const optionLikeJumpHostname = applyVaultHostUpdate(
    [jump, managedTarget],
    [],
    jump.id,
    { hostname: '-oProxyCommand=run' },
    options,
  );
  const unsafeJump: Host = {
    ...jump,
    id: 'unsafe-jump',
    hostname: 'first.example.com,second.example.com',
  };
  const plainTarget: Host = {
    ...managedTarget,
    id: 'plain-target',
    group: undefined,
    managedSourceId: undefined,
    hostChain: { hostIds: [unsafeJump.id] },
  };
  const movedInWithUnsafeJump = applyVaultHostUpdate(
    [unsafeJump, plainTarget],
    [],
    plainTarget.id,
    { group: 'managed' },
    options,
  );

  assert.equal(directUsername.ok, true);
  assert.equal(encodedAlias.ok, true);
  assert.equal(badJumpHostname.ok, false);
  assert.equal(badJumpUsername.ok, false);
  assert.equal(emailJumpUsername.ok, true);
  assert.equal(optionLikeJumpHostname.ok, false);
  assert.equal(movedInWithUnsafeJump.ok, false);
  if (!directUsername.ok) return;
  assert.equal(directUsername.updatedHost.username, 'alice@example.com');
  if (!encodedAlias.ok) return;
  assert.equal(encodedAlias.updatedHost.label, '*');
});

test('applyVaultHostUpdate clears only the local key path when another identity is selected', () => {
  const identityHost: Host = {
    id: 'identity-host',
    label: 'identity host',
    hostname: 'identity.example.com',
    username: 'root',
    tags: [],
    os: 'linux',
    identityId: 'identity-1',
    identityFilePaths: ['~/.ssh/old'],
    authMethod: 'key',
  };
  const keychainHost: Host = {
    id: 'keychain-host',
    label: 'keychain host',
    hostname: 'keychain.example.com',
    username: 'root',
    tags: [],
    os: 'linux',
    identityFileId: 'key-1',
    identityFilePaths: ['~/.ssh/old'],
    authMethod: 'key',
  };

  const identityResult = applyVaultHostUpdate([identityHost], [], identityHost.id, { keyPath: '' });
  const keychainResult = applyVaultHostUpdate([keychainHost], [], keychainHost.id, { keyPath: '' });

  assert.equal(identityResult.ok, true);
  assert.equal(keychainResult.ok, true);
  if (!identityResult.ok || !keychainResult.ok) return;
  assert.equal(identityResult.updatedHost.identityId, 'identity-1');
  assert.equal(identityResult.updatedHost.authMethod, 'key');
  assert.deepEqual(identityResult.updatedHost.identityFilePaths, []);
  assert.equal(keychainResult.updatedHost.identityFileId, 'key-1');
  assert.equal(keychainResult.updatedHost.authMethod, 'key');
  assert.deepEqual(keychainResult.updatedHost.identityFilePaths, []);
});

test('applyVaultHostUpdate resets identity-derived key auth when detaching an identity', () => {
  const host: Host = {
    id: 'host', label: 'host', hostname: 'host.example.com', username: 'deploy',
    identityId: 'identity-1', authMethod: 'key', authPolicyVersion: 1,
    useSshAgent: false, tags: [], os: 'linux',
  };

  const result = applyVaultHostUpdate([host], [], host.id, { identityId: '' });

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.updatedHost.identityId, '');
  assert.equal(result.updatedHost.authMethod, 'auto');
  assert.equal(result.updatedHost.useSshAgent, undefined);
});

test('applyVaultHostUpdate rejects saved password changes when password saving is disabled', () => {
  const existing: Host = {
    id: 'host-1',
    label: 'host',
    hostname: '10.0.0.1',
    username: 'root',
    tags: [],
    os: 'linux',
    savePassword: false,
  };

  const result = applyVaultHostUpdate([existing], [], 'host-1', {
    password: 'do-not-persist',
  });

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.match(result.error, /not to save passwords/i);
});

test('applyVaultHostUpdate respects inherited password saving opt-out', () => {
  const existing: Host = {
    id: 'host-1',
    label: 'host',
    hostname: '10.0.0.1',
    username: 'root',
    tags: [],
    os: 'linux',
  };

  const result = applyVaultHostUpdate(
    [existing],
    [],
    'host-1',
    { password: 'do-not-persist' },
    { resolveEffectiveHost: (host) => ({ ...host, savePassword: false }) },
  );

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.match(result.error, /not to save passwords/i);
});

test('applyVaultHostUpdate switches to password auth when clearing a key path', () => {
  const existing: Host = {
    id: 'host-1',
    label: 'host',
    hostname: '10.0.0.1',
    username: 'root',
    tags: [],
    os: 'linux',
    identityId: 'identity-1',
    identityFileId: 'key-1',
    identityFilePaths: ['~/.ssh/old'],
    authMethod: 'key',
  };

  const result = applyVaultHostUpdate([existing], [], 'host-1', {
    password: 'new-secret',
    keyPath: '',
  });

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.updatedHost.authMethod, 'password');
  assert.equal(result.updatedHost.password, 'new-secret');
  assert.equal(result.updatedHost.identityId, '');
  assert.equal(result.updatedHost.identityFileId, undefined);
  assert.deepEqual(result.updatedHost.identityFilePaths, []);
});

test('applyVaultHostUpdate keeps an inherited identity username when switching to password auth', () => {
  const existing: Host = {
    id: 'host-1',
    label: 'host',
    hostname: '10.0.0.1',
    username: '',
    group: 'prod',
    tags: [],
    os: 'linux',
  };
  const identity: Identity = {
    id: 'identity-1',
    label: 'shared key',
    username: 'deploy',
    authMethod: 'key',
    keyId: 'key-1',
    created: 1,
  };
  const resolveEffectiveHost = (host: Host): Host => applyGroupDefaults(host, {
    identityId: identity.id,
    username: identity.username,
    authMethod: identity.authMethod,
    identityFileId: identity.keyId,
  });

  const result = applyVaultHostUpdate(
    [existing],
    [],
    existing.id,
    { password: 'new-secret', savePassword: true, keyPath: '' },
    { identities: [identity], resolveEffectiveHost },
  );

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.updatedHost.username, 'deploy');
  assert.equal(result.updatedHost.identityId, '');
  assert.equal(result.updatedHost.authMethod, 'password');
});

test('applyVaultHostUpdate preserves key login when only the password changes', () => {
  const existing: Host = {
    id: 'host-1',
    label: 'host',
    hostname: '10.0.0.1',
    username: 'root',
    tags: [],
    os: 'linux',
    identityId: 'identity-1',
    identityFileId: 'key-1',
    identityFilePaths: ['~/.ssh/key'],
    authMethod: 'key',
  };
  const identity: Identity = {
    id: 'identity-1',
    label: 'shared key',
    username: 'root',
    authMethod: 'key',
    keyId: 'key-1',
    created: 1,
  };

  const result = applyVaultHostUpdate(
    [existing],
    [],
    existing.id,
    { password: 'new-secret' },
    { identities: [identity] },
  );

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.updatedHost.password, 'new-secret');
  assert.equal(result.updatedHost.authMethod, 'key');
  assert.equal(result.updatedHost.identityId, 'identity-1');
  assert.equal(result.updatedHost.identityFileId, 'key-1');
  assert.deepEqual(result.updatedHost.identityFilePaths, ['~/.ssh/key']);
});

test('applyVaultHostUpdate preserves an inherited key identity when the password changes', () => {
  const existing: Host = {
    id: 'host-1',
    label: 'host',
    hostname: '10.0.0.1',
    username: '',
    group: 'prod',
    tags: [],
    os: 'linux',
  };
  const identity: Identity = {
    id: 'identity-1',
    label: 'shared key',
    username: 'deploy',
    authMethod: 'key',
    keyId: 'key-1',
    created: 1,
  };
  const resolveEffectiveHost = (host: Host): Host => applyGroupDefaults(host, {
    identityId: identity.id,
    username: identity.username,
    authMethod: 'key',
    identityFileId: identity.keyId,
  });

  const updated = applyVaultHostUpdate(
    [existing],
    [],
    existing.id,
    { password: 'fallback' },
    { identities: [identity], resolveEffectiveHost },
  );
  const cleared = applyVaultHostUpdate(
    [existing],
    [],
    existing.id,
    { password: '' },
    { identities: [identity], resolveEffectiveHost },
  );
  const disabled = applyVaultHostUpdate(
    [existing],
    [],
    existing.id,
    { savePassword: 'false' },
    { identities: [identity], resolveEffectiveHost },
  );
  const changedUsername = applyVaultHostUpdate(
    [existing],
    [],
    existing.id,
    { username: 'ops', password: 'fallback' },
    { identities: [identity], resolveEffectiveHost },
  );

  assert.equal(updated.ok, true);
  assert.equal(cleared.ok, true);
  assert.equal(disabled.ok, true);
  assert.equal(changedUsername.ok, true);
  if (!updated.ok || !cleared.ok || !disabled.ok || !changedUsername.ok) return;
  assert.equal(updated.updatedHost.identityId, identity.id);
  assert.equal(resolveEffectiveHost(updated.updatedHost).authMethod, 'key');
  assert.equal(cleared.updatedHost.identityId, identity.id);
  assert.equal(resolveEffectiveHost(cleared.updatedHost).authMethod, 'key');
  assert.equal(disabled.updatedHost.identityId, identity.id);
  assert.equal(resolveEffectiveHost(disabled.updatedHost).authMethod, 'key');
  assert.equal(changedUsername.updatedHost.username, 'ops');
  assert.equal(changedUsername.updatedHost.identityId, '');
});

test('applyVaultHostUpdate detaches a password identity so the new password takes effect', () => {
  const existing: Host = {
    id: 'host-1',
    label: 'host',
    hostname: '10.0.0.1',
    username: 'root',
    tags: [],
    os: 'linux',
    identityId: 'identity-1',
  };
  const identity: Identity = {
    id: 'identity-1',
    label: 'shared password',
    username: 'deploy',
    authMethod: 'password',
    password: 'old-secret',
    created: 1,
  };

  const result = applyVaultHostUpdate(
    [existing],
    [],
    existing.id,
    { password: 'new-secret' },
    { identities: [identity] },
  );

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.updatedHost.password, 'new-secret');
  assert.equal(result.updatedHost.username, 'deploy');
  assert.equal(result.updatedHost.identityId, '');
  assert.equal(result.updatedHost.authMethod, 'password');
});

test('applyVaultHostUpdate detaches a password identity when clearing the password', () => {
  const existing: Host = {
    id: 'host-1',
    label: 'host',
    hostname: '10.0.0.1',
    username: 'root',
    tags: [],
    os: 'linux',
    identityId: 'identity-1',
  };
  const identity: Identity = {
    id: 'identity-1',
    label: 'shared password',
    username: 'deploy',
    authMethod: 'password',
    password: 'old-secret',
    created: 1,
  };

  const result = applyVaultHostUpdate(
    [existing],
    [],
    existing.id,
    { password: '' },
    { identities: [identity] },
  );

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.updatedHost.password, undefined);
  assert.equal(result.updatedHost.savePassword, false);
  assert.equal(result.updatedHost.username, 'deploy');
  assert.equal(result.updatedHost.identityId, '');
  assert.equal(result.updatedHost.authMethod, 'password');
});

test('applyVaultHostUpdate detaches a password identity when disabling saved passwords', () => {
  const existing: Host = {
    id: 'host-1',
    label: 'host',
    hostname: '10.0.0.1',
    username: 'root',
    tags: [],
    os: 'linux',
    identityId: 'identity-1',
  };
  const identity: Identity = {
    id: 'identity-1',
    label: 'shared password',
    username: 'deploy',
    authMethod: 'password',
    password: 'old-secret',
    created: 1,
  };

  const result = applyVaultHostUpdate(
    [existing],
    [],
    existing.id,
    { savePassword: 'false' },
    { identities: [identity] },
  );

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.updatedHost.password, undefined);
  assert.equal(result.updatedHost.savePassword, false);
  assert.equal(result.updatedHost.username, 'deploy');
  assert.equal(result.updatedHost.identityId, '');
  assert.equal(result.updatedHost.authMethod, 'password');
});

test('applyVaultHostUpdate can re-enable saved passwords after clearing one', () => {
  const existing: Host = {
    id: 'host-1',
    label: 'host',
    hostname: '10.0.0.1',
    username: 'root',
    tags: [],
    os: 'linux',
    password: 'old-secret',
  };

  const cleared = applyVaultHostUpdate([existing], [], existing.id, { password: '' });
  assert.equal(cleared.ok, true);
  if (!cleared.ok) return;
  const restored = applyVaultHostUpdate([cleared.updatedHost], [], existing.id, {
    password: 'new-secret',
    savePassword: 'true',
  });

  assert.equal(restored.ok, true);
  if (!restored.ok) return;
  assert.equal(restored.updatedHost.password, 'new-secret');
  assert.equal(restored.updatedHost.savePassword, true);
});

test('applyVaultHostUpdate detaches direct and inherited identities when changing username', () => {
  const identity: Identity = {
    id: 'identity-1',
    label: 'shared key',
    username: 'old-user',
    authMethod: 'key',
    keyId: 'key-1',
    created: 1,
  };
  const directIdentityHost: Host = {
    id: 'direct-host',
    label: 'direct host',
    hostname: 'direct.example.com',
    username: 'old-user',
    tags: [],
    os: 'linux',
    identityId: 'identity-1',
  };
  const inheritedIdentityHost: Host = {
    id: 'inherited-host',
    label: 'inherited host',
    hostname: 'inherited.example.com',
    username: 'old-user',
    tags: [],
    os: 'linux',
  };

  const directResult = applyVaultHostUpdate(
    [directIdentityHost],
    [],
    directIdentityHost.id,
    { username: 'new-user' },
    { identities: [identity] },
  );
  const inheritedResult = applyVaultHostUpdate(
    [inheritedIdentityHost],
    [],
    inheritedIdentityHost.id,
    { username: 'new-user' },
    {
      identities: [identity],
      resolveEffectiveHost: (host) => ({ ...host, identityId: identity.id }),
    },
  );

  assert.equal(directResult.ok, true);
  assert.equal(inheritedResult.ok, true);
  if (!directResult.ok || !inheritedResult.ok) return;
  assert.equal(directResult.updatedHost.username, 'new-user');
  assert.equal(directResult.updatedHost.identityId, '');
  assert.equal(directResult.updatedHost.identityFileId, identity.keyId);
  assert.equal(directResult.updatedHost.authMethod, 'key');
  assert.equal(inheritedResult.updatedHost.username, 'new-user');
  assert.equal(inheritedResult.updatedHost.identityId, '');
  assert.equal(inheritedResult.updatedHost.identityFileId, identity.keyId);
  assert.equal(inheritedResult.updatedHost.authMethod, 'key');
});

test('applyVaultHostUpdate keeps inherited key auth across sequential password and username updates', () => {
  const identity: Identity = {
    id: 'identity-1',
    label: 'shared key',
    username: 'deploy',
    authMethod: 'key',
    keyId: 'key-1',
    created: 1,
  };
  const existing: Host = {
    id: 'host-1',
    label: 'host',
    hostname: 'host.example.com',
    username: '',
    group: 'prod',
    tags: [],
    os: 'linux',
  };
  const resolveEffectiveHost = (host: Host): Host => applyGroupDefaults(host, {
    identityId: identity.id,
    username: identity.username,
    authMethod: identity.authMethod,
    identityFileId: identity.keyId,
  });

  const first = applyVaultHostUpdate(
    [existing],
    [],
    existing.id,
    { password: 'fallback-one' },
    { identities: [identity], resolveEffectiveHost },
  );
  assert.equal(first.ok, true);
  if (!first.ok) return;
  const second = applyVaultHostUpdate(
    [first.updatedHost],
    [],
    existing.id,
    { username: 'ops', password: 'fallback-two' },
    { identities: [identity], resolveEffectiveHost },
  );

  assert.equal(second.ok, true);
  if (!second.ok) return;
  assert.equal(second.updatedHost.username, 'ops');
  assert.equal(second.updatedHost.identityId, '');
  assert.equal(second.updatedHost.identityFileId, identity.keyId);
  assert.equal(second.updatedHost.authMethod, 'key');
});

test('applyVaultHostUpdate preserves a password identity credential when changing username', () => {
  const identity: Identity = {
    id: 'identity-1',
    label: 'shared password',
    username: 'deploy',
    authMethod: 'password',
    password: 'shared-secret',
    created: 1,
  };
  const existing: Host = {
    id: 'host-1',
    label: 'host',
    hostname: 'host.example.com',
    username: 'deploy',
    identityId: identity.id,
    tags: [],
    os: 'linux',
  };

  const result = applyVaultHostUpdate(
    [existing],
    [],
    existing.id,
    { username: 'ops' },
    { identities: [identity] },
  );

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.updatedHost.username, 'ops');
  assert.equal(result.updatedHost.identityId, '');
  assert.equal(result.updatedHost.password, identity.password);
  assert.equal(result.updatedHost.authMethod, 'password');
});

test('applyVaultHostUpdate keeps password prompts when changing username without saving the password', () => {
  const identity: Identity = {
    id: 'identity-1',
    label: 'shared password',
    username: 'deploy',
    authMethod: 'password',
    password: 'shared-secret',
    created: 1,
  };
  const existing: Host = {
    id: 'host-1',
    label: 'host',
    hostname: 'host.example.com',
    username: 'deploy',
    identityId: identity.id,
    tags: [],
    os: 'linux',
  };

  const result = applyVaultHostUpdate(
    [existing],
    [],
    existing.id,
    { username: 'ops', savePassword: false },
    { identities: [identity] },
  );

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.updatedHost.username, 'ops');
  assert.equal(result.updatedHost.identityId, '');
  assert.equal(result.updatedHost.password, undefined);
  assert.equal(result.updatedHost.savePassword, false);
  assert.equal(result.updatedHost.authMethod, 'password');
});

test('applyVaultHostUpdate does not copy an inherited identity password when saving is disabled', () => {
  const identity: Identity = {
    id: 'identity-1',
    label: 'shared password',
    username: 'deploy',
    authMethod: 'password',
    password: 'shared-secret',
    created: 1,
  };
  const existing: Host = {
    id: 'host-1',
    label: 'host',
    hostname: 'host.example.com',
    username: '',
    group: 'locked',
    tags: [],
    os: 'linux',
  };
  const resolveEffectiveHost = (host: Host): Host => applyGroupDefaults(host, {
    identityId: identity.id,
    username: identity.username,
    authMethod: identity.authMethod,
    savePassword: false,
  });

  const result = applyVaultHostUpdate(
    [existing],
    [],
    existing.id,
    { username: 'ops' },
    { identities: [identity], resolveEffectiveHost },
  );

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.updatedHost.username, 'ops');
  assert.equal(result.updatedHost.identityId, '');
  assert.equal(result.updatedHost.password, undefined);
  assert.equal(result.updatedHost.authMethod, 'password');
});

test('applyVaultHostUpdate validates passwords against the destination group', () => {
  const existing: Host = {
    id: 'host-1',
    label: 'host',
    hostname: '10.0.0.1',
    username: 'root',
    group: 'open',
    tags: [],
    os: 'linux',
  };
  const resolveEffectiveHost = (host: Host): Host => applyGroupDefaults(
    host,
    host.group === 'locked' ? { savePassword: false } : { savePassword: true },
  );

  const blocked = applyVaultHostUpdate(
    [existing],
    [],
    existing.id,
    { group: 'locked', password: 'must-not-save' },
    { resolveEffectiveHost },
  );
  const allowed = applyVaultHostUpdate(
    [{ ...existing, group: 'locked' }],
    [],
    existing.id,
    { group: 'open', password: 'allowed' },
    { resolveEffectiveHost },
  );

  assert.equal(blocked.ok, false);
  assert.equal(allowed.ok, true);
  if (!allowed.ok) return;
  assert.equal(allowed.updatedHost.group, 'open');
  assert.equal(allowed.updatedHost.password, 'allowed');
});

test('applyVaultHostUpdate explicitly blocks an inherited password after clearing it', () => {
  const existing: Host = {
    id: 'host-1',
    label: 'host',
    hostname: '10.0.0.1',
    username: 'root',
    group: 'prod',
    tags: [],
    os: 'linux',
  };
  const resolveEffectiveHost = (host: Host): Host => applyGroupDefaults(host, {
    password: 'group-secret',
    savePassword: true,
    authMethod: 'password',
  });

  const result = applyVaultHostUpdate(
    [existing],
    [],
    existing.id,
    { password: '' },
    { resolveEffectiveHost },
  );

  assert.equal(result.ok, true);
  if (!result.ok) return;
  const effectiveAfter = resolveEffectiveHost(result.updatedHost);
  assert.equal(result.updatedHost.savePassword, false);
  assert.equal(effectiveAfter.password, undefined);
  assert.equal(effectiveAfter.savePassword, false);
});

test('applyVaultHostUpdate explicitly blocks an inherited key path after clearing it', () => {
  const existing: Host = {
    id: 'host-1',
    label: 'host',
    hostname: '10.0.0.1',
    username: 'root',
    group: 'prod',
    tags: [],
    os: 'linux',
  };
  const resolveEffectiveHost = (host: Host): Host => applyGroupDefaults(host, {
    identityFilePaths: ['~/.ssh/group-key'],
    authMethod: 'key',
  });

  const result = applyVaultHostUpdate(
    [existing],
    [],
    existing.id,
    { keyPath: '' },
    { resolveEffectiveHost },
  );

  assert.equal(result.ok, true);
  if (!result.ok) return;
  const effectiveAfter = resolveEffectiveHost(result.updatedHost);
  assert.deepEqual(result.updatedHost.identityFilePaths, []);
  assert.deepEqual(effectiveAfter.identityFilePaths, []);
  assert.equal(effectiveAfter.authMethod, 'auto');
});

test('applyVaultHostUpdate keeps managed-source ownership aligned with group and protocol', () => {
  const managedSource: ManagedSource = {
    id: 'source-1',
    type: 'ssh_config',
    filePath: '~/.ssh/config',
    groupName: 'managed',
    lastSyncedAt: 1,
  };
  const managedHost: Host = {
    id: 'managed-host',
    label: 'managed host',
    hostname: 'managed.example.com',
    username: 'root',
    group: 'managed',
    tags: [],
    os: 'linux',
    protocol: 'ssh',
    managedSourceId: managedSource.id,
  };
  const regularHost: Host = {
    id: 'regular-host',
    label: 'regular host',
    hostname: 'regular.example.com',
    username: 'root',
    tags: [],
    os: 'linux',
    protocol: 'ssh',
  };
  const options = { managedSources: [managedSource] };

  const movedOut = applyVaultHostUpdate(
    [managedHost],
    [],
    managedHost.id,
    { group: '' },
    options,
  );
  const movedIn = applyVaultHostUpdate(
    [regularHost],
    [],
    regularHost.id,
    { group: 'managed/child' },
    options,
  );
  const changedProtocol = applyVaultHostUpdate(
    [managedHost],
    [],
    managedHost.id,
    { protocol: 'telnet' },
    options,
  );
  const changedNotes = applyVaultHostUpdate(
    [managedHost],
    [],
    managedHost.id,
    { notes: 'keep the display name' },
    options,
  );
  const renamed = applyVaultHostUpdate(
    [managedHost],
    [],
    managedHost.id,
    { label: 'new managed name' },
    options,
  );

  assert.equal(movedOut.ok, true);
  assert.equal(movedIn.ok, true);
  assert.equal(changedProtocol.ok, true);
  assert.equal(changedNotes.ok, true);
  assert.equal(renamed.ok, true);
  if (!movedOut.ok || !movedIn.ok || !changedProtocol.ok || !changedNotes.ok || !renamed.ok) return;
  assert.equal(movedOut.updatedHost.managedSourceId, undefined);
  assert.equal(movedIn.updatedHost.managedSourceId, managedSource.id);
  assert.equal(movedIn.updatedHost.label, 'regularhost');
  assert.equal(changedProtocol.updatedHost.managedSourceId, undefined);
  assert.equal(changedNotes.updatedHost.label, 'managed host');
  assert.equal(renamed.updatedHost.label, 'newmanagedname');
});

test('applyVaultHostDelete removes only the requested host', () => {
  const hosts: Host[] = [
    { id: 'host-1', label: 'one', hostname: 'one', username: 'root', tags: [], os: 'linux' },
    { id: 'host-2', label: 'two', hostname: 'two', username: 'root', tags: [], os: 'linux' },
  ];

  const result = applyVaultHostDelete(hosts, 'host-1');
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.deletedHost.id, 'host-1');
  assert.deepEqual(result.hosts.map((host) => host.id), ['host-2']);
});

test('applyVaultHostDelete keeps jump hosts that are still referenced', () => {
  const jump: Host = {
    id: 'jump', label: 'jump', hostname: 'jump.example.com', username: 'root',
    port: 22, protocol: 'ssh', tags: [], os: 'linux',
  };
  const directTarget: Host = {
    id: 'direct', label: 'direct', hostname: 'direct.example.com', username: 'root',
    port: 22, protocol: 'ssh', hostChain: { hostIds: [jump.id] }, tags: [], os: 'linux',
  };
  const inheritedTarget: Host = {
    id: 'inherited', label: 'inherited', hostname: 'inherited.example.com', username: 'root',
    port: 22, protocol: 'ssh', group: 'prod', tags: [], os: 'linux',
  };

  const directResult = applyVaultHostDelete([jump, directTarget], jump.id);
  const inheritedResult = applyVaultHostDelete(
    [jump, inheritedTarget],
    jump.id,
    (host) => host.group === 'prod'
      ? { ...host, hostChain: { hostIds: [jump.id] } }
      : host,
  );

  assert.equal(directResult.ok, false);
  if (!directResult.ok) assert.match(directResult.error, /still used as a jump host/i);
  assert.equal(inheritedResult.ok, false);
  if (!inheritedResult.ok) assert.match(inheritedResult.error, /still used as a jump host/i);
});

test('applyVaultHostDelete keeps jump hosts referenced by empty group defaults', () => {
  const jump: Host = {
    id: 'jump', label: 'jump', hostname: 'jump.example.com', username: 'root',
    port: 22, protocol: 'ssh', tags: [], os: 'linux',
  };

  const result = applyVaultHostDelete(
    [jump],
    jump.id,
    undefined,
    [{ path: 'empty-group', hostChain: { hostIds: [jump.id] } }],
  );

  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.error, /still used as a group jump host/i);
});
