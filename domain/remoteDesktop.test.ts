import assert from 'node:assert/strict';
import test from 'node:test';
import type { Host, Identity } from './models';
import {
  buildStandaloneRdpHost,
  buildStandaloneVncHost,
  classifyNetworkQualityTier,
  computeMonitorLayoutEntries,
  computeMonitorVirtualBounds,
  DEFAULT_RDP_PORT,
  DEFAULT_VNC_PORT,
  formatBandwidthBps,
  formatStandardRdpSecurityBadge,
  formatVncDisplayNumber,
  getAvailableRemoteDesktopProtocols,
  hasCompanionRdp,
  hasCompanionVnc,
  hasValidRdpFixedResolution,
  parseRdpDimensionDraft,
  isRdpProtocol,
  isRemoteDesktopProtocol,
  isVncProtocol,
  mapViewportToVirtualDesktopCoords,
  normalizeRdpConfig,
  normalizeVncConfig,
  parseVncPortOrDisplay,
  RDP_RESOLUTION_PRESETS,
  resolveEffectiveRdpSecurityMode,
  resolveNextRdpAutoFallback,
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

test('sanitizeRdpConfig preserves portable multiMonitorMode and strips local path fields', () => {
  const sanitized = sanitizeRdpConfig({
    multiMonitorMode: 'dual',
    sharedFolders: [{ path: '/Users/alice/secret', name: 'Secret' }],
    localPath: '/tmp/nope',
  });
  assert.equal(sanitized?.multiMonitorMode, 'dual');
  assert.equal('sharedFolders' in (sanitized ?? {}), false);
  assert.equal('localPath' in (sanitized ?? {}), false);

  const invalidMode = sanitizeRdpConfig({ multiMonitorMode: 'quad' });
  assert.equal(invalidMode, undefined);
});

test('RDP_RESOLUTION_PRESETS contains expected standard presets', () => {
  assert.deepEqual(
    RDP_RESOLUTION_PRESETS.map((p) => `${p.width}x${p.height}`),
    ['2560x1440', '1920x1080', '1600x900', '1440x900', '1366x768', '1280x800', '1280x720'],
  );
});

test('computeMonitorLayoutEntries produces normalized even-width non-overlapping layouts with primary at (0,0)', () => {
  const single = computeMonitorLayoutEntries('single', {
    paneWidth: 1281,
    paneHeight: 801,
    dpr: 2,
    highDpi: true,
  });
  assert.equal(single.length, 1);
  assert.equal(single[0].left, 0);
  assert.equal(single[0].top, 0);
  assert.equal(single[0].width % 2, 0);
  assert.equal(single[0].height % 2, 0);
  assert.equal(single[0].isPrimary, true);
  assert.equal(single[0].scaleFactor, 200);

  const dual = computeMonitorLayoutEntries('dual', {
    paneWidth: 1280,
    paneHeight: 720,
    dpr: 1,
    highDpi: false,
  });
  assert.equal(dual.length, 2);
  assert.deepEqual(dual[0], { left: 0, top: 0, width: 1280, height: 720, isPrimary: true, scaleFactor: 100 });
  assert.deepEqual(dual[1], { left: 1280, top: 0, width: 1280, height: 720, isPrimary: false, scaleFactor: 100 });

  // maxMonitors = 1 clamps dual back to single
  const clamped = computeMonitorLayoutEntries('dual', {
    paneWidth: 1280,
    paneHeight: 720,
    maxMonitors: 1,
  });
  assert.equal(clamped.length, 1);

  // all-local with secondary monitor to the left of primary normalizes primary to (0,0) and keeps adjacency
  const allLocal = computeMonitorLayoutEntries('all-local', {
    paneWidth: 1280,
    paneHeight: 800,
    highDpi: false,
    localDisplays: [
      { left: -1920, top: 0, width: 1920, height: 1080, scaleFactor: 1, isPrimary: false },
      { left: 0, top: 0, width: 2560, height: 1440, scaleFactor: 2, isPrimary: true },
    ],
  });
  assert.equal(allLocal.length, 2);
  const primary = allLocal.find((m) => m.isPrimary)!;
  const secondary = allLocal.find((m) => !m.isPrimary)!;
  assert.equal(primary.left, 0);
  assert.equal(primary.top, 0);
  assert.equal(secondary.left + secondary.width, primary.left);
  assert.equal(primary.width % 2, 0);
  assert.equal(secondary.width % 2, 0);

  const bounds = computeMonitorVirtualBounds(allLocal)!;
  assert.equal(bounds.width, 1920 + 2560);
  assert.equal(bounds.height, 1440);
  assert.equal(bounds.monitorRects[0].left, 0);
  assert.equal(bounds.monitorRects[1].left, 1920);
});

test('classifyNetworkQualityTier and formatBandwidthBps format telemetry accurately', () => {
  assert.equal(classifyNetworkQualityTier(null), 'unknown');
  assert.equal(classifyNetworkQualityTier(undefined), 'unknown');
  assert.equal(classifyNetworkQualityTier(-5), 'unknown');
  assert.equal(classifyNetworkQualityTier(12), 'excellent');
  assert.equal(classifyNetworkQualityTier(39.9), 'excellent');
  assert.equal(classifyNetworkQualityTier(40), 'good');
  assert.equal(classifyNetworkQualityTier(99), 'good');
  assert.equal(classifyNetworkQualityTier(100), 'fair');
  assert.equal(classifyNetworkQualityTier(199), 'fair');
  assert.equal(classifyNetworkQualityTier(200), 'poor');
  assert.equal(classifyNetworkQualityTier(550), 'poor');

  assert.equal(formatBandwidthBps(0), '0 B/s');
  assert.equal(formatBandwidthBps(-10), '0 B/s');
  assert.equal(formatBandwidthBps(512), '512 B/s');
  assert.equal(formatBandwidthBps(12.4 * 1024), '12.4 KB/s');
  assert.equal(formatBandwidthBps(3.2 * 1024 * 1024), '3.2 MB/s');
});

test('mapViewportToVirtualDesktopCoords maps full view and cropped single-monitor view accurately', () => {
  const rect = { left: 100, top: 50, width: 1000, height: 500 };
  const virtualSize = { width: 3840, height: 1080 };

  // Full view (no activeMonitorRect): midpoint maps to center of 3840x1080
  assert.deepEqual(
    mapViewportToVirtualDesktopCoords(600, 300, rect, virtualSize, null),
    { x: 1920, y: 540 },
  );

  // Monitor 1 slice: [0..1920, 0..1080]
  assert.deepEqual(
    mapViewportToVirtualDesktopCoords(600, 300, rect, virtualSize, { left: 0, top: 0, width: 1920, height: 1080 }),
    { x: 960, y: 540 },
  );

  // Monitor 2 slice: [1920..3840, 0..1080]
  assert.deepEqual(
    mapViewportToVirtualDesktopCoords(600, 300, rect, virtualSize, { left: 1920, top: 0, width: 1920, height: 1080 }),
    { x: 2880, y: 540 },
  );

  // Edge clamping
  assert.deepEqual(
    mapViewportToVirtualDesktopCoords(1200, 600, rect, virtualSize, { left: 1920, top: 0, width: 1920, height: 1080 }),
    { x: 3839, y: 1079 },
  );
});

test('fixed RDP resolution validation rejects invalid drafts before sanitization', () => {
  const config = { resolutionMode: 'fixed' as const, width: 1920, height: 1080 };
  for (const value of ['', ' ', '19', '192', '199', '8193', '3840.5', 'abc', 'Infinity']) {
    assert.equal(parseRdpDimensionDraft(value), undefined, value);
    assert.equal(hasValidRdpFixedResolution(config, { width: value }), false, value);
    assert.equal(hasValidRdpFixedResolution(config, { height: value }), false, value);
  }
  for (const value of ['200', '3840', '8192']) {
    assert.equal(parseRdpDimensionDraft(value), Number(value));
    assert.equal(hasValidRdpFixedResolution(config, { width: value, height: value }), true);
  }
  for (const dimension of [192, 8193, 3840.5, NaN]) {
    assert.equal(hasValidRdpFixedResolution({ ...config, width: dimension }), false);
    assert.equal(hasValidRdpFixedResolution({ ...config, height: dimension }), false);
  }
  assert.equal(hasValidRdpFixedResolution(config), true);
  assert.equal(hasValidRdpFixedResolution({ resolutionMode: 'fixed' }), true);
  for (const resolutionMode of ['dynamic', 'fit'] as const) {
    assert.equal(hasValidRdpFixedResolution({ ...config, resolutionMode }, { width: '' }), true);
  }
});

test('RDP auto-fallback steps NLA -> TLS -> Standard RDP safely without downgrading explicit modes', () => {
  assert.equal(resolveEffectiveRdpSecurityMode('auto', 'none'), 'auto');
  assert.equal(resolveEffectiveRdpSecurityMode('auto', 'tls'), 'tls');
  assert.equal(resolveEffectiveRdpSecurityMode('auto', 'rdp'), 'rdp');
  assert.equal(resolveEffectiveRdpSecurityMode('nla', 'rdp'), 'nla');
  assert.equal(resolveEffectiveRdpSecurityMode('tls', 'rdp'), 'tls');

  // Generic negotiation failure steps none -> tls -> rdp -> null
  assert.equal(
    resolveNextRdpAutoFallback({
      configuredMode: 'auto',
      currentStage: 'none',
      isNegotiationFailure: true,
      errorMessage: 'server requires TLS without CredSSP',
    }),
    'tls',
  );
  assert.equal(
    resolveNextRdpAutoFallback({
      configuredMode: 'auto',
      currentStage: 'tls',
      isNegotiationFailure: true,
      errorMessage: 'negotiation failure',
    }),
    'rdp',
  );
  assert.equal(
    resolveNextRdpAutoFallback({
      configuredMode: 'auto',
      currentStage: 'rdp',
      isNegotiationFailure: true,
      errorMessage: 'negotiation failure',
    }),
    null,
  );

  // Server explicitly advertising Standard-RDP-only jumps straight to 'rdp'
  assert.equal(
    resolveNextRdpAutoFallback({
      configuredMode: 'auto',
      currentStage: 'none',
      isNegotiationFailure: true,
      errorMessage: '[negotiation failure] server only supports Standard RDP Security',
    }),
    'rdp',
  );
  assert.equal(
    resolveNextRdpAutoFallback({
      configuredMode: 'auto',
      currentStage: 'none',
      isNegotiationFailure: true,
      errorMessage: 'SSL_NOT_ALLOWED_BY_SERVER',
    }),
    'rdp',
  );

  // Explicit modes and non-negotiation errors must never fallback
  assert.equal(
    resolveNextRdpAutoFallback({
      configuredMode: 'nla',
      currentStage: 'none',
      isNegotiationFailure: true,
      errorMessage: 'server only supports Standard RDP Security',
    }),
    null,
  );
  assert.equal(
    resolveNextRdpAutoFallback({
      configuredMode: 'tls',
      currentStage: 'none',
      isNegotiationFailure: true,
      errorMessage: 'server only supports Standard RDP Security',
    }),
    null,
  );
  assert.equal(
    resolveNextRdpAutoFallback({
      configuredMode: 'auto',
      currentStage: 'none',
      isNegotiationFailure: false,
      errorMessage: 'wrong password',
    }),
    null,
  );
});

test('formatStandardRdpSecurityBadge formats RC4/FIPS/Unencrypted labels and hides TLS', () => {
  assert.equal(formatStandardRdpSecurityBadge(null), null);
  assert.equal(
    formatStandardRdpSecurityBadge({ standardRdp: false, encrypted: true, method: 'tls', level: 'enhanced' }),
    null,
  );
  assert.equal(
    formatStandardRdpSecurityBadge({ standardRdp: true, encrypted: true, method: 'rc4-128', level: 'client-compatible' }),
    'RC4-128',
  );
  assert.equal(
    formatStandardRdpSecurityBadge({ standardRdp: true, encrypted: true, method: 'rc4-56', level: 'client-compatible' }),
    'RC4-56',
  );
  assert.equal(
    formatStandardRdpSecurityBadge({ standardRdp: true, encrypted: true, method: 'rc4-40', level: 'low' }),
    'RC4-40',
  );
  assert.equal(
    formatStandardRdpSecurityBadge({ standardRdp: true, encrypted: true, method: 'fips', level: 'fips' }),
    'FIPS',
  );
  assert.equal(
    formatStandardRdpSecurityBadge({ standardRdp: true, encrypted: false, method: 'none', level: 'none' }),
    'Unencrypted',
  );
});
