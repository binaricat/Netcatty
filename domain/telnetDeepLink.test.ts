import test from "node:test";
import assert from "node:assert/strict";
import type { Host } from "./models";
import {
  buildTelnetDeepLinkConnectionHost,
  buildTelnetDeepLinkHostDraft,
  buildTelnetDeepLinkOpenHost,
  findTelnetDeepLinkHost,
  parseTelnetDeepLink,
  shouldHandleTelnetDeepLink,
} from "./telnetDeepLink";

const host = (overrides: Partial<Host>): Host => ({
  id: overrides.id || "host-1",
  label: overrides.label || "Example",
  hostname: overrides.hostname || "example.com",
  username: overrides.username ?? "",
  port: overrides.port,
  group: "",
  tags: [],
  os: "linux",
  protocol: overrides.protocol ?? "telnet",
  ...overrides,
});

test("parseTelnetDeepLink accepts host and port", () => {
  assert.deepEqual(parseTelnetDeepLink("telnet://router.example.com:2001"), {
    rawUrl: "telnet://router.example.com:2001",
    hostname: "router.example.com",
    port: 2001,
  });
});

test("parseTelnetDeepLink accepts credentials and IPv6 hosts", () => {
  assert.deepEqual(parseTelnetDeepLink("telnet://admin:p%40ss@[2001:db8::10]:2323"), {
    rawUrl: "telnet://admin:p%40ss@[2001:db8::10]:2323",
    username: "admin",
    password: "p@ss",
    hostname: "2001:db8::10",
    port: 2323,
  });
});

test("parseTelnetDeepLink rejects unsupported or incomplete links", () => {
  assert.equal(parseTelnetDeepLink("ssh://example.com"), null);
  assert.equal(parseTelnetDeepLink("telnet://"), null);
  assert.equal(parseTelnetDeepLink("telnet://example.com:99999"), null);
});

test("shouldHandleTelnetDeepLink respects the shared deep link setting", () => {
  assert.equal(shouldHandleTelnetDeepLink("telnet://example.com:23", true), true);
  assert.equal(shouldHandleTelnetDeepLink("telnet://example.com:23", false), false);
  assert.equal(shouldHandleTelnetDeepLink("https://example.com", true), false);
});

test("findTelnetDeepLinkHost matches saved telnet hosts by hostname and port", () => {
  const hosts = [
    host({ id: "wrong-port", hostname: "example.com", port: 23 }),
    host({ id: "match", hostname: "example.com", port: 2001 }),
    host({ id: "ssh", hostname: "example.com", port: 2001, protocol: "ssh" }),
  ];

  const match = findTelnetDeepLinkHost(hosts, parseTelnetDeepLink("telnet://example.com:2001")!);

  assert.equal(match?.id, "match");
});

test("findTelnetDeepLinkHost treats omitted ports as the telnet default", () => {
  const hosts = [
    host({ id: "custom-port", hostname: "example.com", port: 2323 }),
    host({ id: "default-port", hostname: "example.com" }),
  ];

  const match = findTelnetDeepLinkHost(hosts, parseTelnetDeepLink("telnet://example.com")!);

  assert.equal(match?.id, "default-port");
});

test("findTelnetDeepLinkHost avoids ambiguous saved hosts", () => {
  const hosts = [
    host({ id: "one", hostname: "example.com", port: 23 }),
    host({ id: "two", hostname: "example.com", telnetEnabled: true, protocol: "ssh", telnetPort: 23 }),
  ];

  const match = findTelnetDeepLinkHost(hosts, parseTelnetDeepLink("telnet://example.com")!);

  assert.equal(match, null);
});

test("buildTelnetDeepLinkConnectionHost forces a saved host to open with telnet", () => {
  const savedHost = host({
    id: "saved",
    hostname: "example.com",
    protocol: "ssh",
    telnetEnabled: true,
    telnetPort: 2323,
    moshEnabled: true,
    etEnabled: true,
  });

  const connectionHost = buildTelnetDeepLinkConnectionHost(savedHost);

  assert.equal(connectionHost.protocol, "telnet");
  assert.equal(connectionHost.telnetEnabled, true);
  assert.equal(connectionHost.telnetPort, 2323);
  assert.equal(connectionHost.moshEnabled, false);
  assert.equal(connectionHost.etEnabled, false);
});

test("buildTelnetDeepLinkHostDraft prepares an ephemeral telnet host", () => {
  const draft = buildTelnetDeepLinkHostDraft(
    parseTelnetDeepLink("telnet://admin:secret@example.com:2323")!,
    { id: "new-id", now: 123 },
  );

  assert.deepEqual(draft, {
    id: "new-id",
    label: "admin@example.com",
    hostname: "example.com",
    username: "admin",
    port: 2323,
    group: "",
    tags: [],
    os: "linux",
    protocol: "telnet",
    telnetEnabled: true,
    telnetPort: 2323,
    telnetUsername: "admin",
    telnetPassword: "secret",
    savePassword: false,
    ephemeral: true,
    moshEnabled: false,
    etEnabled: false,
    createdAt: 123,
  });
});

test("buildTelnetDeepLinkOpenHost falls back to a draft host when no saved host matches", () => {
  const openHost = buildTelnetDeepLinkOpenHost(
    [],
    parseTelnetDeepLink("telnet://missing.example.com:2001")!,
    { id: "draft-id", now: 456 },
  );

  assert.equal(openHost.id, "draft-id");
  assert.equal(openHost.hostname, "missing.example.com");
  assert.equal(openHost.port, 2001);
  assert.equal(openHost.protocol, "telnet");
  assert.equal(openHost.telnetEnabled, true);
  assert.equal(openHost.ephemeral, true);
});
