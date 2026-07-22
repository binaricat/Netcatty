import test from "node:test";
import assert from "node:assert/strict";

import type { Host } from "./models.ts";
import {
  classifyDistroId,
  detectVendorFromSshVersion,
  migrateHostsFromLegacyLineTimestamps,
  normalizeDistroId,
  normalizePrimaryTelnetState,
  preserveConcurrentHostLineTimestampUpdate,
  resolveHostKeepalive,
  resolveTelnetPort,
  resolveTelnetPassword,
  resolveTelnetUsername,
  sanitizeHost,
  shouldProbeSessionCwd,
  upsertHostById,
} from "./host.ts";

const makeHost = (overrides: Partial<Host> = {}): Host => ({
  id: "host-1",
  label: "Primary Host",
  hostname: "127.0.0.1",
  port: 22,
  username: "root",
  authMethod: "password",
  tags: [],
  os: "linux",
  createdAt: 1,
  protocol: "ssh",
  ...overrides,
});

test("upsertHostById updates an existing host in place", () => {
  const existing = makeHost();
  const updated = makeHost({ label: "Updated Host" });

  assert.deepEqual(upsertHostById([existing], updated), [updated]);
});

test("upsertHostById appends a duplicated host with a fresh id", () => {
  const existing = makeHost({
    id: "serial-original",
    label: "Serial Config",
    protocol: "serial",
    hostname: "/dev/ttyUSB0",
    port: 115200,
    serialConfig: {
      path: "/dev/ttyUSB0",
      baudRate: 115200,
      dataBits: 8,
      stopBits: 1,
      parity: "none",
      flowControl: "none",
      localEcho: false,
      lineMode: false,
    },
  });
  const duplicate = makeHost({
    ...existing,
    id: "serial-duplicate",
    label: "Serial Config (copy)",
  });

  assert.deepEqual(upsertHostById([existing], duplicate), [existing, duplicate]);
});

test("telnet credential helpers preserve explicitly cleared values", () => {
  const host = makeHost({
    username: "ssh-user",
    password: "ssh-password",
    telnetUsername: "",
    telnetPassword: "",
  });

  assert.equal(resolveTelnetUsername(host), "");
  assert.equal(resolveTelnetPassword(host), "");
});

test("telnet credential helpers fall back only when telnet fields are unset", () => {
  const host = makeHost({
    username: " ssh-user ",
    password: "ssh-password",
    telnetUsername: undefined,
    telnetPassword: undefined,
  });

  assert.equal(resolveTelnetUsername(host), "ssh-user");
  assert.equal(resolveTelnetPassword(host), "ssh-password");
});

test("normalizePrimaryTelnetState enables primary telnet without materializing a port", () => {
  const result = normalizePrimaryTelnetState(makeHost({
    protocol: "telnet",
    telnetEnabled: false,
    telnetPort: undefined,
    port: undefined,
  }));

  assert.equal(result.telnetEnabled, true);
  assert.equal(result.telnetPort, undefined);
  assert.equal(result.port, undefined);
});

test("normalizePrimaryTelnetState leaves optional telnet hosts unchanged", () => {
  const result = normalizePrimaryTelnetState(makeHost({
    protocol: "ssh",
    telnetEnabled: false,
    telnetPort: undefined,
  }));

  assert.equal(result.telnetEnabled, false);
  assert.equal(result.telnetPort, undefined);
});

test("migrateHostsFromLegacyLineTimestamps preserves the old global opt-in", () => {
  const host = makeHost();

  assert.deepEqual(migrateHostsFromLegacyLineTimestamps([host], true), [
    { ...host, showLineTimestamps: true },
  ]);
});

test("migrateHostsFromLegacyLineTimestamps does not override explicit host choices", () => {
  const enabled = makeHost({ id: "enabled", showLineTimestamps: true });
  const disabled = makeHost({ id: "disabled", showLineTimestamps: false });

  assert.deepEqual(migrateHostsFromLegacyLineTimestamps([enabled, disabled], true), [enabled, disabled]);
});

test("migrateHostsFromLegacyLineTimestamps fills only missing host choices", () => {
  const inherited = makeHost({ id: "inherited" });
  const disabled = makeHost({ id: "disabled", showLineTimestamps: false });

  assert.deepEqual(migrateHostsFromLegacyLineTimestamps([inherited, disabled], true), [
    { ...inherited, showLineTimestamps: true },
    disabled,
  ]);
});

test("sanitizeHost preserves valid custom host icon fields", () => {
  const sanitized = sanitizeHost(makeHost({
    iconMode: "custom",
    iconId: "database",
    iconColor: "blue",
  }));

  assert.equal(sanitized.iconMode, "custom");
  assert.equal(sanitized.iconId, "database");
  assert.equal(sanitized.iconColor, "blue");
});

test("sanitizeHost keeps legacy empty-password hosts on automatic authentication", () => {
  const sanitized = sanitizeHost(makeHost({
    password: undefined,
    authMethod: "password",
    authPolicyVersion: undefined,
  }));

  assert.equal(sanitized.authMethod, undefined);
  assert.equal(sanitized.authPolicyVersion, 1);
});

test("sanitizeHost keeps legacy agent and key hosts on their prior authentication path", () => {
  for (const legacySettings of [
    { useSshAgent: true, password: "saved-secret" },
    { identityFilePaths: ["~/.ssh/id_work"], password: "saved-secret" },
  ]) {
    const sanitized = sanitizeHost(makeHost({
      authMethod: "password",
      authPolicyVersion: undefined,
      ...legacySettings,
    }));

    assert.equal(sanitized.authMethod, undefined);
    assert.equal(sanitized.authPolicyVersion, 1);
  }
});

test("sanitizeHost preserves an explicit password-only choice", () => {
  const sanitized = sanitizeHost(makeHost({
    password: undefined,
    authMethod: "password",
    authPolicyVersion: 1,
  }));

  assert.equal(sanitized.authMethod, "password");
  assert.equal(sanitized.authPolicyVersion, 1);
});

test("sanitizeHost preserves a legacy no-save password-only choice", () => {
  const sanitized = sanitizeHost(makeHost({
    password: undefined,
    savePassword: false,
    authMethod: "password",
    authPolicyVersion: undefined,
  }));

  assert.equal(sanitized.authMethod, "password");
  assert.equal(sanitized.savePassword, false);
  assert.equal(sanitized.authPolicyVersion, 1);
});

test("sanitizeHost keeps legacy no-save agent and key hosts on their prior authentication path", () => {
  for (const legacySettings of [
    { useSshAgent: true },
    { identityFileId: "selected-key" },
    { identityFilePaths: ["~/.ssh/id_work"] },
  ]) {
    const sanitized = sanitizeHost(makeHost({
      password: undefined,
      savePassword: false,
      authMethod: "password",
      authPolicyVersion: undefined,
      ...legacySettings,
    }));

    assert.equal(sanitized.authMethod, undefined);
    assert.equal(sanitized.authPolicyVersion, 1);
  }
});

test("sanitizeHost preserves a legacy whitespace-only password", () => {
  const sanitized = sanitizeHost(makeHost({
    password: "   ",
    authMethod: "password",
    authPolicyVersion: undefined,
  }));

  assert.equal(sanitized.authMethod, "password");
  assert.equal(sanitized.password, "   ");
  assert.equal(sanitized.authPolicyVersion, 1);
});

test("sanitizeHost preserves an inferred legacy saved password", () => {
  const sanitized = sanitizeHost(makeHost({
    password: "saved-secret",
    authMethod: undefined,
    authPolicyVersion: undefined,
  }));

  assert.equal(sanitized.authMethod, "password");
  assert.equal(sanitized.authPolicyVersion, 1);
});

test("sanitizeHost preserves inferred legacy identity file paths", () => {
  const sanitized = sanitizeHost(makeHost({
    password: "fallback-secret",
    authMethod: undefined,
    authPolicyVersion: undefined,
    identityFilePaths: ["~/.ssh/id_work"],
  }));

  assert.equal(sanitized.authMethod, "key");
  assert.equal(sanitized.authPolicyVersion, 1);
});

test("sanitizeHost preserves automatic host icon color fields", () => {
  const sanitized = sanitizeHost(makeHost({
    iconMode: "auto",
    iconColor: "violet",
  }));

  assert.equal(sanitized.iconMode, "auto");
  assert.equal(sanitized.iconId, undefined);
  assert.equal(sanitized.iconColor, "violet");
});

test("sanitizeHost removes invalid custom host icon fields", () => {
  const sanitized = sanitizeHost(makeHost({
    iconMode: "custom",
    iconId: "bad",
    iconColor: "blue",
  } as unknown as Partial<Host>));

  assert.equal(sanitized.iconMode, undefined);
  assert.equal(sanitized.iconId, undefined);
  assert.equal(sanitized.iconColor, undefined);
});

test("sanitizeHost trims leading whitespace before extracting the hostname", () => {
  const sanitized = sanitizeHost(makeHost({
    hostname: " 127.0.0.1",
  }));

  assert.equal(sanitized.hostname, "127.0.0.1");
});

test("sanitizeHost preserves valid per-host SSH timeouts and removes invalid values", () => {
  const sanitized = sanitizeHost(makeHost({
    sshTcpConnectTimeoutSeconds: 45.4,
    sshAuthReadyTimeoutSeconds: 3601,
  }));

  assert.equal(sanitized.sshTcpConnectTimeoutSeconds, 45);
  assert.equal(sanitized.sshAuthReadyTimeoutSeconds, undefined);
});

test("preserves a concurrent terminal timestamp toggle when host details did not edit it", () => {
  const openedHost = makeHost({ showLineTimestamps: false });
  const latestHost = makeHost({ showLineTimestamps: true });
  const draft = makeHost({ label: "Edited label", showLineTimestamps: false });

  assert.deepEqual(
    preserveConcurrentHostLineTimestampUpdate({ draft, openedHost, latestHost }),
    { ...draft, showLineTimestamps: true },
  );
});

test("keeps host details timestamp value when the details form edits it", () => {
  const openedHost = makeHost({ showLineTimestamps: false });
  const latestHost = makeHost({ showLineTimestamps: false });
  const draft = makeHost({ showLineTimestamps: true });

  assert.equal(
    preserveConcurrentHostLineTimestampUpdate({ draft, openedHost, latestHost }).showLineTimestamps,
    true,
  );
});

test("preserves a concurrent SFTP follow-terminal-directory toggle when host details did not edit it", () => {
  const openedHost = makeHost({ sftpFollowTerminalCwd: undefined });
  const latestHost = makeHost({ sftpFollowTerminalCwd: true });
  const draft = makeHost({ label: "Edited label", sftpFollowTerminalCwd: undefined });

  assert.deepEqual(
    preserveConcurrentHostLineTimestampUpdate({ draft, openedHost, latestHost }),
    { ...draft, sftpFollowTerminalCwd: true },
  );
});

test("keeps host details SFTP follow-terminal-directory value when the details form edits it", () => {
  const openedHost = makeHost({ sftpFollowTerminalCwd: false });
  const latestHost = makeHost({ sftpFollowTerminalCwd: false });
  const draft = makeHost({ sftpFollowTerminalCwd: true });

  assert.equal(
    preserveConcurrentHostLineTimestampUpdate({ draft, openedHost, latestHost }).sftpFollowTerminalCwd,
    true,
  );
});

test("normalizePrimaryTelnetState preserves an explicit telnet port", () => {
  const result = normalizePrimaryTelnetState(makeHost({
    protocol: "telnet",
    telnetEnabled: false,
    telnetPort: 2325,
  }));

  assert.equal(result.telnetEnabled, true);
  assert.equal(result.telnetPort, 2325);
});

test("resolveTelnetPort ignores ssh ports for optional telnet", () => {
  assert.equal(resolveTelnetPort(makeHost({
    protocol: "ssh",
    port: 2222,
    telnetPort: undefined,
  })), 23);
});

test("resolveTelnetPort uses primary telnet port fallback", () => {
  assert.equal(resolveTelnetPort(makeHost({
    protocol: "telnet",
    port: 2325,
    telnetPort: undefined,
  })), 2325);
});

test("sanitizeHost migrates a deprecated fontFamily and clears the override flag", () => {
  // Regression guard for codex P2 review on PR #940: hosts saved with
  // pingfang-sc / microsoft-yahei / comic-sans-ms in fontFamily must
  // have the override dropped so they fall back to the global default
  // instead of silently rendering the wrong font while still claiming
  // an override is active.
  const before = makeHost({
    fontFamily: "comic-sans-ms",
    fontFamilyOverride: true,
  });
  const after = sanitizeHost(before);
  assert.equal(after.fontFamily, undefined);
  assert.equal(after.fontFamilyOverride, false);
});

test("sanitizeHost keeps a still-valid fontFamily untouched", () => {
  const before = makeHost({
    fontFamily: "fira-code",
    fontFamilyOverride: true,
  });
  const after = sanitizeHost(before);
  assert.equal(after.fontFamily, "fira-code");
  assert.equal(after.fontFamilyOverride, true);
});

test("detectVendorFromSshVersion recognizes legacy Huawei VRP dash banner", () => {
  assert.equal(detectVendorFromSshVersion("-"), "huawei");
  assert.equal(detectVendorFromSshVersion("SSH-2.0--"), "huawei");
});

test("detectVendorFromSshVersion recognizes Ruijie RGOS banner", () => {
  assert.equal(detectVendorFromSshVersion("RGOS_SSH"), "ruijie");
  assert.equal(detectVendorFromSshVersion("SSH-2.0-RGOS_SSH"), "ruijie");
});

test("detectVendorFromSshVersion recognizes H3C and Comware banners", () => {
  assert.equal(detectVendorFromSshVersion("H3C-Comware-7.1.064"), "h3c");
  assert.equal(detectVendorFromSshVersion("SSH-2.0-Comware-7.1.064"), "h3c");
  assert.equal(detectVendorFromSshVersion("SSH-2.0-3Com OS"), "h3c");
});

test("detectVendorFromSshVersion maps mpSSH banners to HPE iLO", () => {
  assert.equal(detectVendorFromSshVersion("SSH-2.0-mpSSH_0.2.1"), "hpe");
});

test("normalizeDistroId maps Alibaba Cloud Linux os-release ID to alinux", () => {
  // /etc/os-release ID="alinux" — the canonical signal from Alibaba Cloud
  // Linux 3 (issue #1200). Regression guard: 'alinux'.includes('linux') is
  // true, so without a dedicated branch this would fall through to the
  // generic 'linux' icon (the bug the issue reports).
  assert.equal(normalizeDistroId("alinux"), "alinux");
  assert.notEqual(normalizeDistroId("alinux"), "linux");
});

test("normalizeDistroId maps legacy Aliyun Linux IDs to alinux", () => {
  // Older releases branded the distro as "Aliyun Linux" with ID=aliyun.
  assert.equal(normalizeDistroId("aliyun"), "alinux");
});

test("normalizeDistroId matches Alibaba Cloud Linux PRETTY_NAME/NAME fallback", () => {
  // When ID is absent the detector falls back to NAME / PRETTY_NAME text.
  assert.equal(normalizeDistroId("Alibaba Cloud Linux"), "alinux");
  assert.equal(
    normalizeDistroId("Alibaba Cloud Linux 3.2104 U13.1 (OpenAnolis Edition)"),
    "alinux",
  );
});

test("normalizeDistroId maps openEuler before the generic Linux fallback", () => {
  assert.equal(normalizeDistroId("openeuler"), "openeuler");
  assert.equal(normalizeDistroId("openEuler"), "openeuler");
  assert.notEqual(normalizeDistroId("openeuler"), "linux");
});

test("normalizeDistroId maps Darwin and macOS labels to macos", () => {
  assert.equal(normalizeDistroId("Darwin"), "macos");
  assert.equal(normalizeDistroId("Darwin Kernel Version 24.5.0"), "macos");
  assert.equal(normalizeDistroId("macOS"), "macos");
  assert.equal(normalizeDistroId("Mac OS X"), "macos");
});

test("normalizeDistroId maps FreeBSD uname output to freebsd", () => {
  assert.equal(normalizeDistroId("FreeBSD"), "freebsd");
  assert.equal(
    normalizeDistroId("FreeBSD host.example.com 14.3-RELEASE-p1 GENERIC amd64"),
    "freebsd",
  );
});

test("classifyDistroId limits Linux-like runtime support to implemented POSIX platforms", () => {
  assert.equal(classifyDistroId("macos"), "linux-like");
  assert.equal(classifyDistroId("Darwin"), "linux-like");
  assert.equal(classifyDistroId("freebsd"), "other");
});

test("shouldProbeSessionCwd allows the probe on a plain Linux host", () => {
  assert.equal(
    shouldProbeSessionCwd({ isNetworkDevice: false, remoteSshVersion: "OpenSSH_9.6" }),
    true,
  );
});

test("shouldProbeSessionCwd skips the probe on an already-classified network device", () => {
  // Reconnect / manual deviceType='network': host.distro already says network.
  assert.equal(
    shouldProbeSessionCwd({ isNetworkDevice: true, remoteSshVersion: "OpenSSH_9.6" }),
    false,
  );
});

test("shouldProbeSessionCwd skips the probe when the SSH banner reveals a network vendor", () => {
  // First connect to a brand-new Huawei VRP: host.distro not persisted yet, so
  // isNetworkDevice is still false — the banner is the only signal (#1043).
  assert.equal(
    shouldProbeSessionCwd({ isNetworkDevice: false, remoteSshVersion: "-" }),
    false,
  );
  assert.equal(
    shouldProbeSessionCwd({ isNetworkDevice: false, remoteSshVersion: "SSH-1.99--" }),
    false,
  );
});

const GLOBAL_KEEPALIVE = { keepaliveInterval: 30, keepaliveCountMax: 10 };

test("resolveHostKeepalive falls back to global when override is not set", () => {
  const host = makeHost();
  assert.deepEqual(
    resolveHostKeepalive(host, GLOBAL_KEEPALIVE),
    { interval: 30, countMax: 10, source: "global" },
  );
});

test("resolveHostKeepalive falls back to global when override is explicitly false", () => {
  const host = makeHost({
    keepaliveOverride: false,
    keepaliveInterval: 0,
    keepaliveCountMax: 3,
  });
  // Override flag is the gate; the host's stored values stay parked and
  // unused so toggling the flag back on later restores them.
  assert.deepEqual(
    resolveHostKeepalive(host, GLOBAL_KEEPALIVE),
    { interval: 30, countMax: 10, source: "global" },
  );
});

test("resolveHostKeepalive uses host values when override is true", () => {
  const host = makeHost({
    keepaliveOverride: true,
    keepaliveInterval: 0,
    keepaliveCountMax: 3,
  });
  assert.deepEqual(
    resolveHostKeepalive(host, GLOBAL_KEEPALIVE),
    { interval: 0, countMax: 3, source: "host" },
  );
});

test("resolveHostKeepalive lets each field fall back independently", () => {
  // Override on, but only `interval` set on the host: inherit global countMax.
  assert.deepEqual(
    resolveHostKeepalive(
      makeHost({ keepaliveOverride: true, keepaliveInterval: 5 }),
      GLOBAL_KEEPALIVE,
    ),
    { interval: 5, countMax: 10, source: "host" },
  );
  // Override on, but only countMax set: inherit global interval.
  assert.deepEqual(
    resolveHostKeepalive(
      makeHost({ keepaliveOverride: true, keepaliveCountMax: 50 }),
      GLOBAL_KEEPALIVE,
    ),
    { interval: 30, countMax: 50, source: "host" },
  );
});
