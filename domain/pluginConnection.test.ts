import assert from 'node:assert/strict';
import test from 'node:test';

import {
  isBuiltInHostProtocol,
  isPluginCredentialCatalogEntryAvailable,
  isSafePluginAuthenticationUrl,
  pluginProtocolForProvider,
  sanitizePluginConnection,
  stripBuiltInConnectionFieldsForPluginHost,
} from './pluginConnection.ts';
import type { Host } from './models';

test('plugin connection profiles preserve opaque configuration when their provider is absent', () => {
  const providerId = 'com.example.transport.connection';
  const configuration = { endpoint: 'example', nested: { mode: 'safe' }, ports: [22, 443] };
  const result = sanitizePluginConnection({
    providerId,
    configuration,
    authenticationProviderId: 'com.example.transport.authentication',
    credentialId: 'credential-reference-1234',
  }, pluginProtocolForProvider(providerId));
  assert.deepEqual(result, {
    providerId,
    configuration,
    authenticationProviderId: 'com.example.transport.authentication',
    credentialId: 'credential-reference-1234',
  });
  assert.notEqual(result?.configuration, configuration);
});

test('plugin connection profiles fail closed on protocol ownership mismatches and unsafe JSON', () => {
  const providerId = 'com.example.transport.connection';
  assert.equal(sanitizePluginConnection({ providerId, configuration: {} }, 'plugin:other.plugin.connection'), undefined);
  assert.equal(sanitizePluginConnection({ providerId, configuration: { value: Number.NaN } }, pluginProtocolForProvider(providerId)), undefined);
  assert.equal(sanitizePluginConnection({ providerId, configuration: { constructor: 'spoof' } }, pluginProtocolForProvider(providerId)), undefined);
});

test('plugin connection profiles preserve explicit null configuration', () => {
  const providerId = 'com.example.transport.connection';
  assert.deepEqual(
    sanitizePluginConnection(
      { providerId, configuration: null },
      pluginProtocolForProvider(providerId),
    ),
    { providerId, configuration: null },
  );
});

test('plugin credentials are selectable only after secure catalog publication', () => {
  const credentialId = 'credential-reference-0001';
  const published = new Set([credentialId]);
  assert.equal(isPluginCredentialCatalogEntryAvailable(credentialId, 'secret', published), true);
  assert.equal(isPluginCredentialCatalogEntryAvailable(credentialId, 'secret', new Set()), false);
  assert.equal(
    isPluginCredentialCatalogEntryAvailable(credentialId, 'enc:v1:djEwdGVzdAAAAAAAAAAAAAAAAA==', published),
    false,
  );
  assert.equal(
    isPluginCredentialCatalogEntryAvailable(credentialId, 'x'.repeat((64 * 1024) + 1), published),
    false,
  );
});

test('plugin hosts drop a built-in TOTP secret the plugin UI cannot manage', () => {
  const totp = { uri: 'otpauth://totp/Example:root?secret=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ' };
  const base = {
    id: 'host-1',
    label: 'Host',
    hostname: 'host.test',
    username: 'root',
    tags: [],
    os: 'linux',
    password: 'secret',
    requiresMfa: true,
    totp,
  } as Host;
  const pluginHost = stripBuiltInConnectionFieldsForPluginHost({
    ...base,
    protocol: pluginProtocolForProvider('com.example.transport.connection'),
  });
  assert.equal(pluginHost.totp, undefined);
  assert.equal(pluginHost.password, undefined);
  assert.equal(pluginHost.requiresMfa, undefined);
  assert.equal(pluginHost.hostname, 'host.test');
  assert.equal(stripBuiltInConnectionFieldsForPluginHost({ ...base, protocol: 'ssh' }).totp, totp);
});

test('plugin authentication URLs require HTTPS except for loopback HTTP callbacks', () => {
  assert.equal(isSafePluginAuthenticationUrl('https://login.example.com/authorize'), true);
  assert.equal(isSafePluginAuthenticationUrl('http://localhost:44123/callback'), true);
  assert.equal(isSafePluginAuthenticationUrl('http://127.0.0.1:44123/callback'), true);
  assert.equal(isSafePluginAuthenticationUrl('http://[::1]:44123/callback'), true);
  assert.equal(isSafePluginAuthenticationUrl('http://login.example.com/authorize'), false);
  assert.equal(isSafePluginAuthenticationUrl('https://user:password@login.example.com/authorize'), false);
  assert.equal(isSafePluginAuthenticationUrl('javascript:alert(1)'), false);
});

test('built-in protocols include vnc/rdp and plugin hosts strip rdpConfig/vncConfig', () => {
  assert.equal(isBuiltInHostProtocol('vnc'), true);
  assert.equal(isBuiltInHostProtocol('rdp'), true);
  const pluginHost = stripBuiltInConnectionFieldsForPluginHost({
    id: 'host-rd',
    label: 'Desktop',
    hostname: 'host.test',
    username: 'admin',
    tags: [],
    os: 'windows',
    protocol: pluginProtocolForProvider('com.example.transport.connection'),
    rdpConfig: { port: 3389, domain: 'CORP' },
    vncConfig: { port: 5900, viewOnly: true },
  });
  assert.equal(pluginHost.rdpConfig, undefined);
  assert.equal(pluginHost.vncConfig, undefined);
});
