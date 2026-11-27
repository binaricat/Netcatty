import assert from 'node:assert/strict';
import test from 'node:test';
import {
  clearAllKnownRemoteDesktopCerts,
  getKnownRemoteDesktopCert,
  getKnownRemoteDesktopFingerprints,
  getRemoteDesktopCertKey,
  listKnownRemoteDesktopCerts,
  normalizeCertFingerprint,
  parseRemoteDesktopCertKey,
  readKnownRemoteDesktopCerts,
  removeKnownRemoteDesktopCert,
  removeKnownRemoteDesktopCertByKey,
  subscribeKnownRemoteDesktopCerts,
  trustKnownRemoteDesktopCert,
  verifyKnownRemoteDesktopCert,
} from './knownRemoteDesktopCerts';
import { STORAGE_KEY_KNOWN_REMOTE_DESKTOP_CERTS } from '../../infrastructure/config/storageKeys';

const memoryStorage = new Map<string, string>();

const mockLocalStorage = {
  getItem: (key: string) => memoryStorage.get(key) ?? null,
  setItem: (key: string, value: string) => {
    memoryStorage.set(key, value);
  },
  removeItem: (key: string) => {
    memoryStorage.delete(key);
  },
  clear: () => {
    memoryStorage.clear();
  },
};

Object.defineProperty(globalThis, 'localStorage', {
  value: mockLocalStorage,
  configurable: true,
});

test('normalizeCertFingerprint normalizes into uppercase colon-separated hex', () => {
  assert.equal(normalizeCertFingerprint('sha256:aa:bb:cc:dd'), 'AA:BB:CC:DD');
  assert.equal(normalizeCertFingerprint('aabbccdd'), 'AA:BB:CC:DD');
  assert.equal(normalizeCertFingerprint('  SHA-256:01 23 ab cd  '), '01:23:AB:CD');
  assert.equal(normalizeCertFingerprint(''), '');
});

test('getRemoteDesktopCertKey builds normalized protocol:host:port keys', () => {
  assert.equal(getRemoteDesktopCertKey('rdp', '  WIN-HOST.Local ', 3389), 'rdp:win-host.local:3389');
  assert.equal(getRemoteDesktopCertKey('vnc', '192.168.1.10', 5901), 'vnc:192.168.1.10:5901');
});

test('parseRemoteDesktopCertKey handles IPv4, hostnames, IPv6, and rejects malformed keys', () => {
  assert.deepEqual(parseRemoteDesktopCertKey('rdp:192.168.1.10:3389'), {
    protocol: 'rdp',
    host: '192.168.1.10',
    port: 3389,
  });
  assert.deepEqual(parseRemoteDesktopCertKey('vnc:desktop.example.com:5901'), {
    protocol: 'vnc',
    host: 'desktop.example.com',
    port: 5901,
  });
  assert.deepEqual(parseRemoteDesktopCertKey('rdp:::1:3389'), {
    protocol: 'rdp',
    host: '::1',
    port: 3389,
  });
  assert.deepEqual(parseRemoteDesktopCertKey('rdp:[fe80::1]:3389'), {
    protocol: 'rdp',
    host: '[fe80::1]',
    port: 3389,
  });
  assert.equal(parseRemoteDesktopCertKey('ssh:host:22'), null);
  assert.equal(parseRemoteDesktopCertKey('rdp::3389'), null);
  assert.equal(parseRemoteDesktopCertKey('rdp:host:0'), null);
  assert.equal(parseRemoteDesktopCertKey('rdp:host:99999'), null);
  assert.equal(parseRemoteDesktopCertKey('rdp:host:notaport'), null);
  assert.equal(parseRemoteDesktopCertKey('invalid'), null);
});

test('TOFU store tracks first-seen, trusted, changed, validity dates, and removal via localStorage', () => {
  memoryStorage.clear();

  assert.deepEqual(
    verifyKnownRemoteDesktopCert('rdp', 'server.example', 3389, 'aa:bb:cc:dd'),
    { status: 'first-seen', previousFingerprint: null },
  );

  const saved = trustKnownRemoteDesktopCert(
    'rdp',
    'server.example',
    3389,
    {
      fingerprintSha256: 'aabbccdd',
      subject: 'CN=server.example',
      issuer: 'CN=Self',
      validFrom: '2025-01-01T00:00:00Z',
      validTo: '2028-01-01T00:00:00Z',
    },
    1000,
  );
  assert.equal(saved?.fingerprintSha256, 'AA:BB:CC:DD');
  assert.equal(saved?.validFrom, '2025-01-01T00:00:00Z');
  assert.equal(saved?.validTo, '2028-01-01T00:00:00Z');
  assert.equal(memoryStorage.has(STORAGE_KEY_KNOWN_REMOTE_DESKTOP_CERTS), true);

  assert.deepEqual(
    verifyKnownRemoteDesktopCert('rdp', 'SERVER.EXAMPLE', 3389, 'AA:BB:CC:DD'),
    { status: 'trusted', previousFingerprint: 'AA:BB:CC:DD' },
  );

  assert.deepEqual(
    getKnownRemoteDesktopFingerprints('rdp', 'server.example', 3389),
    ['AA:BB:CC:DD'],
  );

  assert.deepEqual(
    verifyKnownRemoteDesktopCert('rdp', 'server.example', 3389, '11:22:33:44'),
    { status: 'changed', previousFingerprint: 'AA:BB:CC:DD' },
  );

  const updated = trustKnownRemoteDesktopCert(
    'rdp',
    'server.example',
    3389,
    { fingerprintSha256: '11:22:33:44' },
    2000,
  );
  assert.equal(updated?.trustedAt, 2000);
  assert.equal(updated?.validTo, undefined);
  assert.equal(getKnownRemoteDesktopCert('rdp', 'server.example', 3389)?.fingerprintSha256, '11:22:33:44');

  assert.equal(getKnownRemoteDesktopCert('vnc', 'server.example', 3389), null);
  assert.equal(getKnownRemoteDesktopCert('rdp', 'server.example', 33890), null);

  assert.equal(removeKnownRemoteDesktopCert('rdp', 'server.example', 3389), true);
  assert.deepEqual(readKnownRemoteDesktopCerts(), {});
});

test('listKnownRemoteDesktopCerts, removeKnownRemoteDesktopCertByKey, and clearAllKnownRemoteDesktopCerts', () => {
  memoryStorage.clear();

  trustKnownRemoteDesktopCert('rdp', '::1', 3389, { fingerprintSha256: 'aa:bb' }, 100);
  trustKnownRemoteDesktopCert('vnc', '10.0.0.5', 5900, { fingerprintSha256: 'cc:dd' }, 200);

  const listed = listKnownRemoteDesktopCerts();
  assert.equal(listed.length, 2);
  assert.equal(listed[0].key, 'vnc:10.0.0.5:5900');
  assert.equal(listed[0].protocol, 'vnc');
  assert.equal(listed[0].host, '10.0.0.5');
  assert.equal(listed[0].port, 5900);
  assert.equal(listed[1].key, 'rdp:::1:3389');
  assert.equal(listed[1].host, '::1');

  assert.equal(removeKnownRemoteDesktopCertByKey('rdp:::1:3389'), true);
  assert.equal(removeKnownRemoteDesktopCertByKey('rdp:::1:3389'), false);
  assert.equal(listKnownRemoteDesktopCerts().length, 1);

  assert.equal(clearAllKnownRemoteDesktopCerts(), 1);
  assert.equal(clearAllKnownRemoteDesktopCerts(), 0);
  assert.deepEqual(listKnownRemoteDesktopCerts(), []);
});

test('subscribeKnownRemoteDesktopCerts notifies on both same-window writes and cross-window storage events', () => {
  memoryStorage.clear();
  const target = new EventTarget();
  const prevAdd = globalThis.addEventListener;
  const prevRemove = globalThis.removeEventListener;
  const prevDispatch = globalThis.dispatchEvent;

  Object.defineProperty(globalThis, 'addEventListener', {
    value: target.addEventListener.bind(target),
    configurable: true,
  });
  Object.defineProperty(globalThis, 'removeEventListener', {
    value: target.removeEventListener.bind(target),
    configurable: true,
  });
  Object.defineProperty(globalThis, 'dispatchEvent', {
    value: target.dispatchEvent.bind(target),
    configurable: true,
  });

  try {
    let calls = 0;
    const unsubscribe = subscribeKnownRemoteDesktopCerts(() => {
      calls += 1;
    });

    trustKnownRemoteDesktopCert('rdp', 'win.local', 3389, { fingerprintSha256: 'aa:bb' }, 500);
    assert.equal(calls, 1);

    const crossWindowEvent = new Event('storage');
    Object.defineProperty(crossWindowEvent, 'key', { value: STORAGE_KEY_KNOWN_REMOTE_DESKTOP_CERTS });
    target.dispatchEvent(crossWindowEvent);
    assert.equal(calls, 2);

    const unrelatedEvent = new Event('storage');
    Object.defineProperty(unrelatedEvent, 'key', { value: 'other_key' });
    target.dispatchEvent(unrelatedEvent);
    assert.equal(calls, 2);

    unsubscribe();
    clearAllKnownRemoteDesktopCerts();
    assert.equal(calls, 2);
  } finally {
    Object.defineProperty(globalThis, 'addEventListener', { value: prevAdd, configurable: true });
    Object.defineProperty(globalThis, 'removeEventListener', { value: prevRemove, configurable: true });
    Object.defineProperty(globalThis, 'dispatchEvent', { value: prevDispatch, configurable: true });
  }
});
