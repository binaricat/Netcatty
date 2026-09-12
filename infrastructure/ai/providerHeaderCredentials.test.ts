import test from 'node:test';
import assert from 'node:assert/strict';
import { parseProviderHeaderRows, encryptProviderHeaders, decryptProviderHeaders } from './providerHeaderCredentials';

const encrypted = `enc:v1:${Buffer.concat([Buffer.from('v10'), Buffer.alloc(32, 1)]).toString('base64')}`;
function bridge(value: object) {
  Object.defineProperty(globalThis, 'window', { value: { netcatty: value }, configurable: true });
}

test('header rows preserve values and reject ambiguous or invalid names and values', () => {
  assert.deepEqual(parseProviderHeaderRows([{ name: ' X-Tenant ', value: ' tenant ' }, { name: '', value: '' }]), { 'X-Tenant': ' tenant ' });
  for (const rows of [
    [{ name: 'X-Tenant', value: 'a' }, { name: 'x-tenant', value: 'b' }],
    [{ name: '', value: 'secret' }], [{ name: 'Bad Name', value: 'x' }],
    [{ name: 'Content-Length', value: '1' }], [{ name: 'tRaNsFeR-EnCoDiNg', value: 'chunked' }],
    [{ name: 'X-Tenant', value: 'a\r\nb' }], [{ name: 'X-Tenant', value: '中文' }],
  ]) assert.throws(() => parseProviderHeaderRows(rows));
  assert.equal(Object.getOwnPropertyDescriptor(parseProviderHeaderRows([{ name: '__proto__', value: 'safe' }]), '__proto__')?.value, 'safe');
});

test('header values round trip using the credential bridge without plaintext persistence', async () => {
  bridge({ credentialsEncrypt: async () => encrypted, credentialsDecrypt: async (value: string) => value === encrypted ? 'secret' : value });
  const saved = await encryptProviderHeaders({ 'X-Tenant': 'secret', 'X-Empty': '' });
  assert.deepEqual(saved, { 'X-Tenant': encrypted, 'X-Empty': '' });
  assert.deepEqual(await decryptProviderHeaders(saved), { 'X-Tenant': 'secret', 'X-Empty': '' });
  assert.deepEqual(await decryptProviderHeaders({ Legacy: 'plain' }), { Legacy: 'plain' });
});

test('missing or failed encryption blocks saving; unread encrypted headers block loading', async () => {
  bridge({});
  await assert.rejects(encryptProviderHeaders({ Authorization: 'secret' }));
  await assert.rejects(decryptProviderHeaders({ Authorization: encrypted }));
  bridge({ credentialsEncrypt: async () => { throw Error('locked'); }, credentialsDecrypt: async (value: string) => value });
  await assert.rejects(encryptProviderHeaders({ Authorization: 'secret' }));
  await assert.rejects(decryptProviderHeaders({ Authorization: encrypted }));
});
