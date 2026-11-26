import test from 'node:test';
import assert from 'node:assert/strict';

import type { GroupConfig, Host, ProxyProfile } from './models.ts';
import { applyGroupDefaults } from './groupConfig.ts';
import { applyVaultHostUpdate, type VaultHostUpdatePatch } from './vaultHostCreate.ts';
import { normalizeAgentCharset, parseVaultHostResetFields } from './vaultHostConnectionSettings.ts';

const makeHost = (overrides: Partial<Host> = {}): Host => ({
  id: 'host-1', label: 'host', hostname: 'host.example.com', username: 'root', tags: [], os: 'linux',
  ...overrides,
});
const proxyProfile: ProxyProfile = {
  id: 'proxy-1', label: 'proxy', config: { type: 'socks5', host: '127.0.0.1', port: 1080 }, createdAt: 1,
};
const update = (host: Host, patch: VaultHostUpdatePatch, hosts: Host[] = [host]) => applyVaultHostUpdate(
  hosts, [], host.id, patch, { proxyProfiles: [proxyProfile] },
);
const expectOk = (result: ReturnType<typeof update>) => {
  assert.equal(result.ok, true, 'error' in result ? result.error : '');
  if (!result.ok) throw new Error('unreachable');
  return result;
};

test('vault host update sets network device connection settings', () => {
  const result = expectOk(update(makeHost(), {
    deviceType: 'network',
    charset: 'GBK',
    backspaceBehavior: 'ctrl-h',
    keepaliveInterval: '15',
  }));
  assert.equal(result.updatedHost.deviceType, 'network');
  assert.equal(result.updatedHost.charset, 'GB18030', 'GBK is saved as GB18030 like Host Details');
  assert.equal(result.updatedHost.backspaceBehavior, 'ctrl-h');
  assert.equal(result.updatedHost.keepaliveInterval, 15);
  assert.equal(result.updatedHost.keepaliveOverride, true);
  assert.deepEqual(result.warnings, []);
});

test('vault host update sets timeouts, SFTP and input settings', () => {
  const result = expectOk(update(makeHost(), {
    sshTcpConnectTimeoutSeconds: 60,
    sshAuthReadyTimeoutSeconds: '300',
    sftpSudo: 'true',
    sftpFileProtocol: 'SCP',
    sftpEncoding: 'gb18030',
    sshInputCompatibility: false,
    keepaliveCountMax: 5,
  }));
  assert.equal(result.updatedHost.sshTcpConnectTimeoutSeconds, 60);
  assert.equal(result.updatedHost.sshAuthReadyTimeoutSeconds, 300);
  assert.equal(result.updatedHost.sftpSudo, true);
  assert.equal(result.updatedHost.sftpFileProtocol, 'scp');
  assert.equal(result.updatedHost.sftpEncoding, 'gb18030');
  assert.equal(result.updatedHost.sshInputCompatibility, false);
  assert.equal(result.updatedHost.keepaliveCountMax, 5);
  assert.equal(result.updatedHost.keepaliveOverride, true);
});

test('vault host update keepaliveOverride false returns to the global keepalive settings', () => {
  const result = expectOk(update(
    makeHost({ keepaliveOverride: true, keepaliveInterval: 15, keepaliveCountMax: 5 }),
    { keepaliveOverride: 'false' },
  ));
  assert.equal(result.updatedHost.keepaliveOverride, undefined);
});

test('vault host update rejects invalid connection settings', () => {
  const cases: Array<{ host?: Host; patch: VaultHostUpdatePatch; error: RegExp }> = [
    { patch: { deviceType: 'router' }, error: /deviceType must be general or network/i },
    { host: makeHost({ protocol: 'local' }), patch: { deviceType: 'network' }, error: /local shell/i },
    { patch: { sshInputCompatibility: 'maybe' }, error: /sshInputCompatibility must be true or false/i },
    { host: makeHost({ protocol: 'telnet', port: 23 }), patch: { sshInputCompatibility: true }, error: /only applies to SSH/i },
    { patch: { backspaceBehavior: 'default' }, error: /backspaceBehavior must be ctrl-h/i },
    { patch: { charset: '' }, error: /charset must be UTF-8 or GB18030/i },
    { patch: { charset: 'UTF-8\nInjected' }, error: /charset must be UTF-8 or GB18030/i },
    { patch: { charset: 'Big5' }, error: /charset must be UTF-8 or GB18030/i },
    { patch: { charset: 42 }, error: /charset must be UTF-8 or GB18030/i },
    { patch: { keepaliveOverride: 'sometimes' }, error: /keepaliveOverride must be true or false/i },
    { patch: { keepaliveOverride: false, keepaliveInterval: 10 }, error: /cannot be combined/i },
    { patch: { keepaliveInterval: 3601 }, error: /keepaliveInterval must be an integer between 0 and 3600/i },
    { patch: { keepaliveInterval: 1.5 }, error: /keepaliveInterval must be an integer/i },
    { patch: { keepaliveCountMax: 0 }, error: /keepaliveCountMax must be an integer between 1 and 100/i },
    { patch: { sshTcpConnectTimeoutSeconds: 0 }, error: /sshTcpConnectTimeoutSeconds must be an integer between 1 and 3600/i },
    { patch: { sshAuthReadyTimeoutSeconds: '' }, error: /sshAuthReadyTimeoutSeconds must be an integer/i },
    { patch: { sftpSudo: 'maybe' }, error: /sftpSudo must be true or false/i },
    { patch: { sftpFileProtocol: 'ftp' }, error: /sftpFileProtocol must be auto, sftp, or scp/i },
    { patch: { sftpEncoding: 'latin1' }, error: /sftpEncoding must be auto, utf-8, or gb18030/i },
    { patch: { authMethod: 'agent' }, error: /authMethod must be auto, password, key, or certificate/i },
    { host: makeHost({ protocol: 'telnet', port: 23 }), patch: { authMethod: 'password' }, error: /only applies to SSH/i },
    { host: makeHost({ protocol: 'local', hostname: 'localhost' }), patch: { authMethod: 'key' }, error: /only applies to SSH/i },
  ];
  for (const entry of cases) {
    const result = update(entry.host ?? makeHost(), entry.patch);
    assert.equal(result.ok, false, JSON.stringify(entry.patch));
    if (!result.ok) assert.match(result.error, entry.error);
  }
});

test('vault host update authMethod follows the Host Details selection rules', () => {
  const keyHost = makeHost({ authMethod: 'key', authPolicyVersion: 1, identityFilePaths: ['/keys/id_ed25519'] });

  const unchanged = expectOk(update(keyHost, { authMethod: 'key' }));
  assert.equal(unchanged.updatedHost.authMethod, 'key');
  assert.deepEqual(unchanged.updatedHost.identityFilePaths, ['/keys/id_ed25519']);
  assert.deepEqual(unchanged.warnings, []);

  const toPassword = expectOk(update(keyHost, { authMethod: 'password' }));
  assert.equal(toPassword.updatedHost.authMethod, 'password');
  assert.equal(toPassword.updatedHost.identityFilePaths, undefined);
  assert.match(toPassword.warnings.join('\n'), /No password is saved/);

  const toKey = expectOk(update(makeHost({ password: 'secret', authMethod: 'password', authPolicyVersion: 1 }), { authMethod: 'key' }));
  assert.equal(toKey.updatedHost.authMethod, 'key');
  assert.equal(toKey.updatedHost.password, 'secret', 'switching the method keeps the saved password');
  assert.match(toKey.warnings.join('\n'), /No key is selected/);
});

test('vault host update rejects authMethod combined with credential fields', () => {
  for (const key of ['password', 'keyPath', 'keypath', 'identityId', 'passphrase']) {
    const result = update(makeHost(), { authMethod: 'key', [key]: '' } as VaultHostUpdatePatch);
    assert.equal(result.ok, false, key);
    if (!result.ok) assert.match(result.error, new RegExp(`authMethod cannot be combined with ${key}`));
  }
});

test('vault host update resetFields lets group values apply again', () => {
  const group: Partial<GroupConfig> = {
    charset: 'GBK',
    deviceType: 'network',
    backspaceBehavior: 'ctrl-h',
    proxyConfig: { type: 'http', host: 'group-proxy.example.com', port: 3128 },
    startupCommand: 'group-start',
  };
  const result = expectOk(update(
    makeHost({
      charset: 'UTF-8',
      deviceType: 'general',
      backspaceBehavior: 'ctrl-h',
      directProxy: true,
      startupCommand: 'host-start',
    }),
    { resetFields: '["charset","deviceType","backspaceBehavior","proxy","startupCommand"]' },
  ));
  for (const key of ['charset', 'deviceType', 'backspaceBehavior', 'directProxy', 'startupCommand'] as const) {
    assert.equal(result.updatedHost[key], undefined, key);
  }
  const effective = applyGroupDefaults(result.updatedHost, group, {
    validProxyProfileIds: new Set([proxyProfile.id]), globalProxyProfileId: '',
  });
  assert.equal(effective.charset, 'GBK');
  assert.equal(effective.deviceType, 'network');
  assert.equal(effective.startupCommand, 'group-start');
  assert.equal(effective.proxyConfig?.host, 'group-proxy.example.com');
});

test('vault host update resetFields restores inherited jump hosts, port and defaults', () => {
  const jump = makeHost({ id: 'jump-1', label: 'jump', hostname: 'jump.example.com' });
  const host = makeHost({
    port: 2222,
    hostChain: { hostIds: [] },
    environmentVariables: [],
    sshTcpConnectTimeoutSeconds: 60,
    sftpFileProtocol: 'scp',
  });
  const result = expectOk(update(host, {
    resetFields: 'port, jumpHostIds, environmentVariables, sshTcpConnectTimeoutSeconds, sftpFileProtocol',
  }, [host, jump]));
  assert.equal(result.updatedHost.port, undefined);
  assert.equal(result.updatedHost.hostChain, undefined);
  assert.equal(result.updatedHost.environmentVariables, undefined);
  assert.equal(result.updatedHost.sshTcpConnectTimeoutSeconds, undefined);
  assert.equal(result.updatedHost.sftpFileProtocol, undefined);
  const effective = applyGroupDefaults(result.updatedHost, { hostChain: { hostIds: [jump.id] }, port: 2200 });
  assert.deepEqual(effective.hostChain?.hostIds, [jump.id]);
  assert.equal(effective.port, 2200);
});

test('vault host update rejects unsafe or conflicting resetFields', () => {
  const cases: Array<{ host?: Host; patch: VaultHostUpdatePatch; error: RegExp }> = [
    { patch: { resetFields: ['password'] }, error: /cannot reset "password"/i },
    { patch: { resetFields: ['authMethod'] }, error: /cannot reset "authMethod"/i },
    { patch: { resetFields: ['sshInputCompatibility'] }, error: /cannot reset "sshInputCompatibility"/i },
    { patch: { resetFields: '[charset' }, error: /valid JSON array/i },
    { patch: { resetFields: [42] as unknown as string[] }, error: /array of field names/i },
    { patch: { resetFields: ['charset'], charset: 'GBK' }, error: /charset cannot be set and reset/i },
    { patch: { resetFields: ['proxy'], proxyProfileId: proxyProfile.id }, error: /proxyProfileId cannot be set and reset/i },
    { patch: { resetFields: ['proxy'], directProxy: true }, error: /directProxy cannot be set and reset/i },
    {
      host: makeHost({ protocol: 'serial', hostname: '/dev/ttyUSB0', port: 9600, serialConfig: { path: '/dev/ttyUSB0', baudRate: 9600 } }),
      patch: { resetFields: ['port'] },
      error: /cannot be reset on a serial host/i,
    },
  ];
  for (const entry of cases) {
    const result = update(entry.host ?? makeHost(), entry.patch);
    assert.equal(result.ok, false, JSON.stringify(entry.patch));
    if (!result.ok) assert.match(result.error, entry.error);
  }
});

test('vault host update accepts resetFields as the only field', () => {
  const result = expectOk(update(makeHost({ charset: 'GBK' }), { resetFields: ['charset'] }));
  assert.equal(result.updatedHost.charset, undefined);
});

test('normalizeAgentCharset maps names to the Host Details encodings', () => {
  for (const [input, expected] of [
    ['UTF-8', 'UTF-8'], ['utf8', 'UTF-8'], [' Utf_8 ', 'UTF-8'],
    ['GB18030', 'GB18030'], ['gbk', 'GB18030'], ['GB2312', 'GB18030'], ['cp936', 'GB18030'],
    ['Big5', undefined], ['ISO-8859-1', undefined], ['', undefined],
  ] as const) {
    assert.equal(normalizeAgentCharset(input), expected, input);
  }
});

test('parseVaultHostResetFields accepts arrays, JSON and comma-separated names without duplicates', () => {
  assert.deepEqual(parseVaultHostResetFields(['charset', 'charset']), { ok: true, fields: ['charset'] });
  assert.deepEqual(parseVaultHostResetFields('["proxy"]'), { ok: true, fields: ['proxy'] });
  assert.deepEqual(parseVaultHostResetFields(' charset , port '), { ok: true, fields: ['charset', 'port'] });
  assert.deepEqual(parseVaultHostResetFields(''), { ok: true, fields: [] });
});
