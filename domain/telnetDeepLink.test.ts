import test from "node:test";
import assert from "node:assert/strict";
import type { Host } from "./models";
import {
  buildTelnetDeepLinkConnectionHost,
  buildTelnetDeepLinkEphemeralHostFromSaved,
  buildTelnetDeepLinkHostDraft,
  buildTelnetDeepLinkOpenHost,
  findTelnetDeepLinkHost,
  materializeTelnetDeepLinkMatchHost,
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

test("findTelnetDeepLinkHost can ignore URL username for one-time credential links", () => {
  const hosts = [
    host({
      id: "saved",
      hostname: "example.com",
      port: 23,
      telnetUsername: "vault-user",
    }),
  ];

  const strictMatch = findTelnetDeepLinkHost(
    hosts,
    parseTelnetDeepLink("telnet://link-user:link-password@example.com")!,
  );
  const credentialMatch = findTelnetDeepLinkHost(
    hosts,
    parseTelnetDeepLink("telnet://link-user:link-password@example.com")!,
    { ignoreTargetUsername: true },
  );

  assert.equal(strictMatch, null);
  assert.equal(credentialMatch?.id, "saved");
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

test("buildTelnetDeepLinkConnectionHost uses the telnet default for ssh hosts with telnet enabled", () => {
  const savedHost = host({
    id: "saved",
    hostname: "example.com",
    protocol: "ssh",
    port: 22,
    telnetEnabled: true,
  });

  const connectionHost = buildTelnetDeepLinkConnectionHost(savedHost);

  assert.equal(connectionHost.protocol, "telnet");
  assert.equal(connectionHost.port, 23);
  assert.equal(connectionHost.telnetPort, 23);
});

test("buildTelnetDeepLinkEphemeralHostFromSaved keeps saved settings but uses URL credentials", () => {
  const savedHost = host({
    id: "saved",
    label: "Saved",
    hostname: "example.com",
    username: "vault-user",
    port: 22,
    protocol: "ssh",
    telnetEnabled: true,
    telnetUsername: "vault-telnet-user",
    telnetPassword: "vault-password",
    telnetIdentityId: "identity-1",
    proxyProfileId: "proxy-1",
    charset: "gb18030",
    group: "network",
  });

  const ephemeral = buildTelnetDeepLinkEphemeralHostFromSaved(
    savedHost,
    parseTelnetDeepLink("telnet://link-user:link-password@example.com")!,
    { id: "ephemeral-id", now: 789 },
  );

  assert.equal(ephemeral.id, "ephemeral-id");
  assert.equal(ephemeral.ephemeral, true);
  assert.equal(ephemeral.protocol, "telnet");
  assert.equal(ephemeral.telnetEnabled, true);
  assert.equal(ephemeral.telnetPort, 23);
  assert.equal(ephemeral.username, "link-user");
  assert.equal(ephemeral.telnetUsername, "link-user");
  assert.equal(ephemeral.telnetPassword, "link-password");
  assert.equal(ephemeral.telnetIdentityId, undefined);
  assert.equal(ephemeral.savePassword, false);
  assert.equal(ephemeral.group, "");
  assert.equal(ephemeral.proxyProfileId, "proxy-1");
  assert.equal(ephemeral.charset, "gb18030");
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

test("materializeTelnetDeepLinkMatchHost makes telnet identity usernames matchable", () => {
  const savedHost = host({
    id: "saved",
    hostname: "example.com",
    username: "",
    protocol: "ssh",
    telnetEnabled: true,
    telnetIdentityId: "identity-1",
  });

  const materialized = materializeTelnetDeepLinkMatchHost(savedHost, [
    { id: "identity-1", username: "identity-user" },
  ]);
  const match = findTelnetDeepLinkHost(
    [materialized],
    parseTelnetDeepLink("telnet://identity-user@example.com")!,
  );

  assert.equal(match?.id, "saved");
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

test("buildTelnetDeepLinkOpenHost keeps URL password instead of strict matching a saved host", () => {
  const openHost = buildTelnetDeepLinkOpenHost(
    [
      host({
        id: "saved-alice",
        hostname: "example.com",
        port: 23,
        telnetUsername: "alice",
        telnetPassword: "saved-password",
      }),
    ],
    parseTelnetDeepLink("telnet://alice:new-password@example.com")!,
    { id: "draft-id", now: 456 },
  );

  assert.equal(openHost.id, "draft-id");
  assert.equal(openHost.username, "alice");
  assert.equal(openHost.telnetUsername, "alice");
  assert.equal(openHost.telnetPassword, "new-password");
  assert.equal(openHost.ephemeral, true);
});
