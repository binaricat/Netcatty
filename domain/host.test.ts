import test from "node:test";
import assert from "node:assert/strict";

import type { Host } from "./models.ts";
import {
  normalizePrimaryTelnetState,
  resolveHostKeepalive,
  resolveTelnetPort,
  resolveTelnetPassword,
  resolveTelnetUsername,
  sanitizeHost,
  upsertHostById,
} from "./host.ts";

const makeHost = (overrides: Partial<Host> = {}): Host => ({
  id: "host-1",
  label: "Primary Host",
  hostname: "127.0.0.1",
  port: 22,
  username: "root",
  authType: "password",
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
