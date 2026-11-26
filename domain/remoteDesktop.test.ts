import assert from 'node:assert/strict';
import test from 'node:test';
import type { Host, Identity } from './models';
import {
  buildStandaloneRdpHost,
  buildStandaloneVncHost,
  DEFAULT_RDP_PORT,
  DEFAULT_VNC_PORT,
  formatVncDisplayNumber,
  getAvailableRemoteDesktopProtocols,
  hasCompanionRdp,
  hasCompanionVnc,
  isRdpProtocol,
  isRemoteDesktopProtocol,
  isVncProtocol,
  normalizeRdpConfig,
  normalizeVncConfig,
  parseVncPortOrDisplay,
  resolveRemoteDesktopConnectionSpec,
  sanitizeRdpConfig,
  sanitizeVncConfig,
  splitWindowsUserDomain,
} from './remoteDesktop';

test('protocol predicates identify VNC and RDP accurately', () => {
  assert.equal(isVncProtocol('vnc'), true);
  assert.equal(isVncProtocol('VNC'), true);
  assert.equal(isVncProtocol('rdp'), false);
  assert.equal(isRdpProtocol('rdp'), true);
  assert.equal(isRdpProtocol('RDP'), true);
  assert.equal(isRdpProtocol('vnc'), false);
  assert.equal(isRemoteDesktopProtocol('vnc'), true);
  assert.equal(isRemoteDesktopProtocol('rdp'), true);
  assert.equal(isRemoteDesktopProtocol('ssh'), false);
  assert.equal(isRemoteDesktopProtocol(undefined), false);
});

test('companion desktop predicates and available protocol list respect primary and host type', () => {
  const sshHost: Host = {
    id: 'h1',
    label: 'Linux Workstation',
    hostname: '10.0.0.10',
    username: 'alice',
    tags: [],
    os: 'linux',
    protocol: 'ssh',
    rdpConfig: { enabled: true, port: 3389 },
    vncConfig: { enabled: true, port: 5901 },
  };
  assert.equal(hasCompanionRdp(sshHost), true);
  assert.equal(hasCompanionVnc(sshHost), true);
  assert.deepEqual(getAvailableRemoteDesktopProtocols(sshHost), ['rdp', 'vnc']);

  const standaloneRdp = buildStandaloneRdpHost({ hostname: '10.0.0.20', rdpConfig: { enabled: true } });
  assert.equal(hasCompanionRdp(standaloneRdp), false);
  assert.equal(hasCompanionVnc(standaloneRdp), false);
  assert.deepEqual(getAvailableRemoteDesktopProtocols(standaloneRdp), ['rdp']);

  const localWithStaleConfig: Host = {
    id: 'local-1',
    label: 'Local',
    hostname: 'localhost',
    username: '',
    tags: [],
    os: 'macos',
    protocol: 'local',
    vncConfig: { enabled: true },
    rdpConfig: { enabled: true },
  };
  assert.equal(hasCompanionVnc(localWithStaleConfig), false);
  assert.equal(hasCompanionRdp(localWithStaleConfig), false);
  assert.deepEqual(getAvailableRemoteDesktopProtocols(localWithStaleConfig), []);
});

test('parseVncPortOrDisplay converts :0..:99 and 0..99 display numbers to 5900+N and validates TCP ports', () => {
  assert.equal(parseVncPortOrDisplay(':0'), 5900);
  assert.equal(parseVncPortOrDisplay(':1'), 5901);
  assert.equal(parseVncPortOrDisplay(':99'), 5999);
  assert.equal(parseVncPortOrDisplay('0'), 5900);
  assert.equal(parseVncPortOrDisplay('5'), 5905);
  assert.equal(parseVncPortOrDisplay(0), 5900);
  assert.equal(parseVncPortOrDisplay(99), 5999);
  assert.equal(parseVncPortOrDisplay(5900), 5900);
  assert.equal(parseVncPortOrDisplay('5902'), 5902);
  assert.equal(parseVncPortOrDisplay('65535'), 65535);
  assert.equal(parseVncPortOrDisplay(':100'), null);
  assert.equal(parseVncPortOrDisplay('-1'), null);
  assert.equal(parseVncPortOrDisplay(65536), null);
  assert.equal(parseVncPortOrDisplay(''), null);
  assert.equal(parseVncPortOrDisplay('abc'), null);

  assert.equal(formatVncDisplayNumber(5900), ':0');
  assert.equal(formatVncDisplayNumber(5901), ':1');
  assert.equal(formatVncDisplayNumber(5999), ':99');
  assert.equal(formatVncDisplayNumber(6000), null);
});

test('splitWindowsUserDomain splits only on backslash and preserves JumpServer user|uuid and UPNs verbatim', () => {
  assert.deepEqual(splitWindowsUserDomain('CORP\\Administrator'), {
    domain: 'CORP',
    username: 'Administrator',
  });
  assert.deepEqual(splitWindowsUserDomain('.\\localuser'), {
    domain: '.',
    username: 'localuser',
  });
  assert.deepEqual(
    splitWindowsUserDomain('alice|550e8400-e29b-41d4-a716-446655440000'),
    {
      domain: '',
      username: 'alice|550e8400-e29b-41d4-a716-446655440000',
    },
  );
  assert.deepEqual(
    splitWindowsUserDomain('alice@corp.example.com'),
    {
      domain: '',
      username: 'alice@corp.example.com',
    },
  );
  assert.deepEqual(
    splitWindowsUserDomain('CORP\\alice', 'OVERRIDE'),
    {
      domain: 'OVERRIDE',
      username: 'alice',
    },
  );
  assert.deepEqual(
    splitWindowsUserDomain('alice|token-id', 'CORP'),
    {
      domain: 'CORP',
      username: 'alice|token-id',
    },
  );
});

test('sanitize and normalize configs enforce zero-password invariant and clamp numeric options', () => {
  const dirtyRdp = {
    port: 3390,
    domain: 'CORP',
    password: 'MUST-NEVER-BE-STORED',
    width: 99999,
    height: 100,
    colorDepth: 32,
    securityMode: 'nla',
    loadBalanceInfo: 'tsv://MS Terminal Services Plugin.1.Desktop',
  } as Record<string, unknown>;
  const sanitizedRdp = sanitizeRdpConfig(dirtyRdp);
  assert.equal('password' in (sanitizedRdp ?? {}), false);
  assert.equal(sanitizedRdp?.port, 3390);
  assert.equal(sanitizedRdp?.width, 8192);
  assert.equal(sanitizedRdp?.height, 200);

  const normalizedRdp = normalizeRdpConfig(dirtyRdp);
  assert.equal('password' in normalizedRdp, false);
  assert.equal(normalizedRdp.port, 3390);
  assert.equal(normalizedRdp.audioEnabled, true);
  assert.equal(normalizedRdp.clipboardSync, true);
  assert.equal(normalizedRdp.clipboardFilesEnabled, true);

  const dirtyVnc = {
    port: 5902,
    password: 'MUST-NEVER-BE-STORED',
    quality: 15,
    compressionLevel: -4,
    scalingMode: 'dynamic',
    viewOnly: true,
  } as Record<string, unknown>;
  const sanitizedVnc = sanitizeVncConfig(dirtyVnc);
  assert.equal('password' in (sanitizedVnc ?? {}), false);
  assert.equal(sanitizedVnc?.quality, 9);
  assert.equal(sanitizedVnc?.compressionLevel, 0);

  const normalizedVnc = normalizeVncConfig(dirtyVnc);
  assert.equal('password' in normalizedVnc, false);
  assert.equal(normalizedVnc.port, 5902);
  assert.equal(normalizedVnc.quality, 9);
  assert.equal(normalizedVnc.compressionLevel, 0);
  assert.equal(normalizedVnc.sharedSession, true);
});

test('standalone VNC and RDP host builders satisfy cross-client iOS sync invariants', () => {
  const rdpHost = buildStandaloneRdpHost({
    id: 'rdp-1',
    hostname: '10.0.0.5',
    password: 'secret',
    createdAt: 100,
  });
  assert.equal(rdpHost.protocol, 'rdp');
  assert.equal(rdpHost.username, '');
  assert.equal(rdpHost.os, 'windows');
  assert.equal(rdpHost.port, DEFAULT_RDP_PORT);
  assert.deepEqual(rdpHost.tags, []);
  assert.equal(rdpHost.authMethod, 'password');
  assert.equal(rdpHost.password, 'secret');
  assert.equal('password' in (rdpHost.rdpConfig ?? {}), false);

  const vncHost = buildStandaloneVncHost({
    id: 'vnc-1',
    hostname: '10.0.0.9',
    password: 'vnc-secret',
    createdAt: 200,
  });
  assert.equal(vncHost.protocol, 'vnc');
  assert.equal(vncHost.username, '');
  assert.equal(vncHost.os, 'linux');
  assert.equal(vncHost.port, DEFAULT_VNC_PORT);
  assert.deepEqual(vncHost.tags, []);
  assert.equal(vncHost.authMethod, 'password');
  assert.equal(vncHost.password, 'vnc-secret');
  assert.equal('password' in (vncHost.vncConfig ?? {}), false);
});

test('resolveRemoteDesktopConnectionSpec resolves standalone and companion credentials and SSH tunneling', () => {
  const rdpIdentity: Identity = {
    id: 'id-win',
    label: 'Windows Admin',
    username: 'Administrator',
    domain: 'ACME',
    authMethod: 'password',
    password: 'id-password',
    created: 1,
  };

  // Standalone RDP with Identity
  const standaloneRdp = buildStandaloneRdpHost({
    id: 'win-1',
    label: 'Win Box',
    hostname: '10.1.0.5',
    port: 3390,
    identityId: 'id-win',
  });
  const standaloneSpec = resolveRemoteDesktopConnectionSpec(standaloneRdp, 'rdp', [rdpIdentity]);
  assert.equal(standaloneSpec.isCompanion, false);
  assert.equal(standaloneSpec.tunnelViaHostSsh, false);
  assert.equal(standaloneSpec.hostname, '10.1.0.5');
  assert.equal(standaloneSpec.port, 3390);
  assert.equal(standaloneSpec.username, 'Administrator');
  assert.equal(standaloneSpec.domain, 'ACME');
  assert.equal(standaloneSpec.password, 'id-password');
  assert.equal(standaloneSpec.credentialSource, 'identity');
  assert.equal(standaloneSpec.needsPasswordPrompt, false);

  // Companion VNC on SSH host defaults to tunneling via SSH to 127.0.0.1
  const sshHostWithCompanion: Host = {
    id: 'linux-1',
    label: 'Dev Box',
    hostname: 'dev.example.com',
    port: 22,
    username: 'dev',
    password: 'ssh-password',
    tags: [],
    os: 'linux',
    protocol: 'ssh',
    vncConfig: {
      enabled: true,
      port: 5901,
    },
    rdpConfig: {
      enabled: true,
      port: 3389,
      useHostCredentials: true,
      tunnelViaHostSsh: false,
    },
  };

  const companionVncSpec = resolveRemoteDesktopConnectionSpec(sshHostWithCompanion, 'vnc', [rdpIdentity]);
  assert.equal(companionVncSpec.isCompanion, true);
  assert.equal(companionVncSpec.tunnelViaHostSsh, true);
  assert.equal(companionVncSpec.hostname, '127.0.0.1');
  assert.equal(companionVncSpec.hostHostname, 'dev.example.com');
  assert.equal(companionVncSpec.port, 5901);
  assert.equal(companionVncSpec.password, undefined);
  assert.equal(companionVncSpec.credentialSource, 'prompt');
  assert.equal(companionVncSpec.needsPasswordPrompt, true);

  const companionRdpSpec = resolveRemoteDesktopConnectionSpec(sshHostWithCompanion, 'rdp', [rdpIdentity]);
  assert.equal(companionRdpSpec.isCompanion, true);
  assert.equal(companionRdpSpec.tunnelViaHostSsh, false);
  assert.equal(companionRdpSpec.hostname, 'dev.example.com');
  assert.equal(companionRdpSpec.username, 'dev');
  assert.equal(companionRdpSpec.password, 'ssh-password');
  assert.equal(companionRdpSpec.credentialSource, 'host');
  assert.equal(companionRdpSpec.needsPasswordPrompt, false);
});
