import assert from 'node:assert/strict';
import test from 'node:test';

import type { Host, PortForwardingRule } from '../models.ts';
import type { TerminalSession } from '../../types.ts';
import type { ListeningPortInfo } from './types.ts';
import {
  buildQuickForwardRuleLabel,
  canQuickForwardSession,
  findExactReusableForwardRule,
  findLocalPortConflict,
  formatCopyableLocalEndpoint,
  formatHostPort,
  isForwardableListeningPort,
  matchListeningPortForwardRules,
  resolveForwardRemoteHost,
  suggestQuickForwardLocalPort,
  validateQuickForwardInput,
} from './portForwardQuick.ts';

function makeHost(overrides: Partial<Host> = {}): Host {
  return {
    id: 'host-1',
    label: 'prod-api',
    hostname: '10.0.0.10',
    username: 'root',
    tags: [],
    os: 'linux',
    ...overrides,
  };
}

function makeSession(overrides: Partial<TerminalSession> = {}): TerminalSession {
  return {
    id: 'session-1',
    hostId: 'host-1',
    hostLabel: 'prod-api',
    username: 'root',
    hostname: '10.0.0.10',
    status: 'connected',
    protocol: 'ssh',
    ...overrides,
  };
}

function makePort(overrides: Partial<ListeningPortInfo> = {}): ListeningPortInfo {
  const protocol = overrides.protocol ?? 'tcp';
  const address = overrides.address ?? '*';
  const port = overrides.port ?? 5432;
  const pid = overrides.pid === undefined ? 1234 : overrides.pid;
  return {
    id: `${protocol}|${address}|${port}|${pid ?? '-'}`,
    protocol,
    address,
    port,
    pid,
    processName: 'postgres',
    ...overrides,
  };
}

function makeRule(overrides: Partial<PortForwardingRule> = {}): PortForwardingRule {
  return {
    id: 'rule-1',
    label: 'Rule 1',
    type: 'local',
    localPort: 5432,
    bindAddress: '127.0.0.1',
    remoteHost: '127.0.0.1',
    remotePort: 5432,
    hostId: 'host-1',
    status: 'inactive',
    createdAt: 1,
    ...overrides,
  };
}

test('canQuickForwardSession allows connected SSH and Mosh remote sessions only', () => {
  assert.equal(canQuickForwardSession(makeHost(), makeSession()), true);
  assert.equal(canQuickForwardSession(makeHost({ protocol: 'mosh' }), makeSession({ protocol: 'mosh' })), true);
  assert.equal(canQuickForwardSession(makeHost(), makeSession({ status: 'disconnected' })), false);
  assert.equal(canQuickForwardSession(makeHost({ protocol: 'local' }), makeSession({ protocol: 'local' })), false);
  assert.equal(canQuickForwardSession(makeHost({ protocol: 'telnet' }), makeSession({ protocol: 'telnet' })), false);
  assert.equal(canQuickForwardSession(makeHost({ protocol: 'serial' }), makeSession({ protocol: 'serial' })), false);
  assert.equal(canQuickForwardSession(makeHost({ protocol: 'et' }), makeSession({ protocol: 'et' })), false);
  assert.equal(canQuickForwardSession(makeHost({ hostname: '   ' }), makeSession()), false);
  assert.equal(canQuickForwardSession(null, makeSession()), false);
});

test('isForwardableListeningPort accepts TCP and TCP6 valid ports and rejects UDP', () => {
  assert.equal(isForwardableListeningPort(makePort({ protocol: 'tcp', port: 8080 })), true);
  assert.equal(isForwardableListeningPort(makePort({ protocol: 'tcp6', port: 443 })), true);
  assert.equal(isForwardableListeningPort(makePort({ protocol: 'udp', port: 53 })), false);
  assert.equal(isForwardableListeningPort(makePort({ protocol: 'udp6', port: 5353 })), false);
  assert.equal(isForwardableListeningPort(makePort({ protocol: 'unknown', port: 80 })), false);
  assert.equal(isForwardableListeningPort(makePort({ protocol: 'tcp', port: 0 })), false);
  assert.equal(isForwardableListeningPort(makePort({ protocol: 'tcp', port: 65536 })), false);
});

test('resolveForwardRemoteHost preserves IPv4/IPv6 address family for wildcards and keeps explicit addresses', () => {
  assert.equal(resolveForwardRemoteHost(makePort({ address: '*', protocol: 'tcp' })), '127.0.0.1');
  assert.equal(resolveForwardRemoteHost(makePort({ address: '0.0.0.0', protocol: 'tcp' })), '127.0.0.1');
  assert.equal(resolveForwardRemoteHost(makePort({ address: '*', protocol: 'tcp6' })), '::1');
  assert.equal(resolveForwardRemoteHost(makePort({ address: '::', protocol: 'tcp6' })), '::1');
  assert.equal(resolveForwardRemoteHost(makePort({ address: '::', protocol: 'tcp' })), '::1');
  assert.equal(resolveForwardRemoteHost(makePort({ address: '127.0.0.1' })), '127.0.0.1');
  assert.equal(resolveForwardRemoteHost(makePort({ address: '::1', protocol: 'tcp6' })), '::1');
  assert.equal(resolveForwardRemoteHost(makePort({ address: '[::1]', protocol: 'tcp6' })), '::1');
  assert.equal(resolveForwardRemoteHost(makePort({ address: '10.0.0.5' })), '10.0.0.5');
  assert.equal(resolveForwardRemoteHost(makePort({ address: 'fe80::1%eth0', protocol: 'tcp6' })), 'fe80::1');
});

test('formatHostPort and formatCopyableLocalEndpoint bracket IPv6 and map wildcards', () => {
  assert.equal(formatHostPort('127.0.0.1', 8080), '127.0.0.1:8080');
  assert.equal(formatHostPort('::1', 8080), '[::1]:8080');
  assert.equal(formatHostPort('*', 80), '*:80');
  assert.equal(formatCopyableLocalEndpoint('0.0.0.0', 8080), '127.0.0.1:8080');
  assert.equal(formatCopyableLocalEndpoint('::', 8080), '[::1]:8080');
  assert.equal(formatCopyableLocalEndpoint('127.0.0.1', 3000), '127.0.0.1:3000');
  assert.equal(formatCopyableLocalEndpoint('::1', 3000), '[::1]:3000');
});

test('suggestQuickForwardLocalPort avoids privileged ports and existing rule collisions', () => {
  assert.equal(suggestQuickForwardLocalPort(3000, []), 3000);
  assert.equal(suggestQuickForwardLocalPort(80, []), 8080);
  assert.equal(suggestQuickForwardLocalPort(443, []), 8443);
  assert.equal(suggestQuickForwardLocalPort(22, []), 10022);
  assert.equal(
    suggestQuickForwardLocalPort(80, [makeRule({ localPort: 8080 })]),
    10080,
  );
  assert.equal(
    suggestQuickForwardLocalPort(3000, [
      makeRule({ id: 'r1', localPort: 3000 }),
      makeRule({ id: 'r2', localPort: 3001 }),
    ]),
    3002,
  );
  // Remote forwarding rules bind on the remote host, so they do not occupy a local port.
  assert.equal(
    suggestQuickForwardLocalPort(3000, [makeRule({ type: 'remote', localPort: 3000 })]),
    3000,
  );
});

test('matchListeningPortForwardRules matches active, connecting, and reusable rules per address family', () => {
  const ipv4Port = makePort({ address: '*', protocol: 'tcp', port: 5432 });
  const ipv6Port = makePort({ address: '*', protocol: 'tcp6', port: 5432 });
  const rules = [
    makeRule({ id: 'other-host', hostId: 'host-2', status: 'active', localPort: 5432, remotePort: 5432 }),
    makeRule({ id: 'connecting-rule', status: 'connecting', localPort: 15432, remoteHost: 'localhost', remotePort: 5432 }),
    makeRule({ id: 'active-rule', status: 'active', localPort: 25432, remoteHost: '127.0.0.1', remotePort: 5432 }),
    makeRule({ id: 'inactive-v4-rule', status: 'inactive', localPort: 35432, remoteHost: '127.0.0.1', remotePort: 5432 }),
    makeRule({ id: 'active-v6-rule', status: 'active', localPort: 45432, remoteHost: '::1', remotePort: 5432 }),
  ];

  const v4Matches = matchListeningPortForwardRules(ipv4Port, 'host-1', rules);
  assert.deepEqual(
    v4Matches.activeRules.map((r) => r.id),
    ['active-rule', 'connecting-rule'],
  );
  assert.equal(v4Matches.primaryActiveRule?.id, 'active-rule');
  assert.equal(v4Matches.reusableInactiveRule?.id, 'inactive-v4-rule');

  // IPv6 wildcard row matches ::1 rules only and does not cross-match IPv4 127.0.0.1 rules.
  const v6Matches = matchListeningPortForwardRules(ipv6Port, 'host-1', rules);
  assert.deepEqual(
    v6Matches.activeRules.map((r) => r.id),
    ['active-v6-rule'],
  );
  assert.equal(v6Matches.primaryActiveRule?.id, 'active-v6-rule');
  assert.equal(v6Matches.reusableInactiveRule, undefined);

  // Specific IP listener does not match a 127.0.0.1 rule.
  const specificPort = makePort({ address: '10.0.0.5', port: 5432 });
  assert.equal(matchListeningPortForwardRules(specificPort, 'host-1', rules).activeRules.length, 0);
});

test('findExactReusableForwardRule only reuses inactive rules with identical connection params', () => {
  const inactive = makeRule({
    id: 'inactive-exact',
    status: 'inactive',
    hostId: 'host-1',
    remoteHost: '127.0.0.1',
    remotePort: 5432,
    localPort: 15432,
    bindAddress: '127.0.0.1',
  });
  const active = makeRule({ ...inactive, id: 'active-exact', status: 'active' });

  assert.equal(
    findExactReusableForwardRule([active, inactive], {
      hostId: 'host-1',
      remoteHost: '127.0.0.1',
      remotePort: 5432,
      localPort: 15432,
      bindAddress: '127.0.0.1',
    })?.id,
    'inactive-exact',
  );

  // Different local port should NOT silently reuse/mutate the existing rule.
  assert.equal(
    findExactReusableForwardRule([inactive], {
      hostId: 'host-1',
      remoteHost: '127.0.0.1',
      remotePort: 5432,
      localPort: 25432,
      bindAddress: '127.0.0.1',
    }),
    undefined,
  );
});

test('findLocalPortConflict and validateQuickForwardInput catch invalid input and overlapping binds', () => {
  const activeWildcard = makeRule({
    id: 'wild',
    status: 'active',
    bindAddress: '0.0.0.0',
    localPort: 8080,
  });
  const activeLoopback = makeRule({
    id: 'loop',
    status: 'connecting',
    bindAddress: '127.0.0.1',
    localPort: 9090,
  });
  const inactiveLoopback = makeRule({
    id: 'idle',
    status: 'inactive',
    bindAddress: '127.0.0.1',
    localPort: 7070,
  });

  const rules = [activeWildcard, activeLoopback, inactiveLoopback];
  assert.equal(findLocalPortConflict(rules, '127.0.0.1', 8080)?.id, 'wild');
  assert.equal(findLocalPortConflict(rules, 'localhost', 9090)?.id, 'loop');
  assert.equal(findLocalPortConflict(rules, '127.0.0.1', 7070), undefined);
  assert.equal(findLocalPortConflict(rules, '127.0.0.1', 9090, 'loop'), undefined);

  assert.deepEqual(
    validateQuickForwardInput({ localPortText: '0', bindAddressText: '127.0.0.1', rules }),
    { ok: false, error: { code: 'invalidPort' } },
  );
  assert.deepEqual(
    validateQuickForwardInput({ localPortText: 'abc', bindAddressText: '127.0.0.1', rules }),
    { ok: false, error: { code: 'invalidPort' } },
  );
  assert.deepEqual(
    validateQuickForwardInput({ localPortText: '7070', bindAddressText: 'bad host', rules }),
    { ok: false, error: { code: 'invalidBindAddress' } },
  );
  const conflict = validateQuickForwardInput({
    localPortText: '8080',
    bindAddressText: '127.0.0.1',
    rules,
  });
  assert.equal(conflict.ok, false);
  if ('error' in conflict) {
    assert.equal(conflict.error.code, 'localPortInUse');
  }

  assert.deepEqual(
    validateQuickForwardInput({ localPortText: '7070', bindAddressText: '', rules }),
    { ok: true, localPort: 7070, bindAddress: '127.0.0.1' },
  );
});

test('buildQuickForwardRuleLabel creates descriptive human-readable labels', () => {
  assert.equal(
    buildQuickForwardRuleLabel('prod-db', makePort({ port: 5432, processName: 'postgres' }), 5432, '127.0.0.1'),
    'prod-db · postgres (:5432)',
  );
  assert.equal(
    buildQuickForwardRuleLabel('prod-db', makePort({ port: 5432, processName: '' }), 5432, '127.0.0.1'),
    'prod-db :5432',
  );
  assert.equal(
    buildQuickForwardRuleLabel('', makePort({ port: 5432, processName: 'redis-server' }), 6379, '127.0.0.1'),
    'redis-server (:5432)',
  );
  assert.equal(
    buildQuickForwardRuleLabel('', makePort({ port: 5432, processName: '' }), 15432, '::1'),
    'Local:15432 -> [::1]:5432',
  );
});
