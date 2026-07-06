import test from "node:test";
import assert from "node:assert/strict";
import {
  buildJmsDeepLinkEphemeralHost,
  isSupportedJmsProtocol,
  parseJmsDeepLink,
} from "./jmsDeepLink";
import { resolveHostAutofillPassword } from "./sshAuth";

const encodePayload = (payload: Record<string, unknown>): string =>
  `jms://${Buffer.from(JSON.stringify(payload), "utf8").toString("base64")}`;

const validPayload = {
  version: 2,
  id: "legacy-id",
  value: "legacy-secret",
  name: "account@asset[2024-01-01_12:00:00]",
  protocol: "ssh",
  token: { id: "token-id", value: "token-secret" },
  asset: { id: "asset-id", name: "Production Server", address: "10.0.0.1" },
  endpoint: { host: "gw.example.com", port: 2222 },
  file: {},
  command: "",
};

test("parseJmsDeepLink accepts a valid ssh payload", () => {
  const target = parseJmsDeepLink(encodePayload(validPayload));
  assert.deepEqual(target, {
    protocol: "ssh",
    hostname: "gw.example.com",
    port: 2222,
    username: "JMS-token-id",
    password: "token-secret",
    label: "Production Server",
  });
});

test("parseJmsDeepLink tolerates URL-safe base64 and trailing slash", () => {
  const encoded = Buffer.from(JSON.stringify(validPayload), "utf8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
  const target = parseJmsDeepLink(`jms://${encoded}/`);
  assert.equal(target?.hostname, "gw.example.com");
  assert.equal(target?.username, "JMS-token-id");
});

test("parseJmsDeepLink falls back to legacy top-level token fields", () => {
  const target = parseJmsDeepLink(encodePayload({
    protocol: "sftp",
    id: "legacy-id",
    value: "legacy-secret",
    endpoint: { host: "gw.example.com", port: 2222 },
  }));
  assert.equal(target?.username, "JMS-legacy-id");
  assert.equal(target?.password, "legacy-secret");
  assert.equal(target?.protocol, "sftp");
});

test("parseJmsDeepLink returns null when token or endpoint is missing", () => {
  assert.equal(parseJmsDeepLink(encodePayload({
    protocol: "ssh",
    token: { id: "token-id", value: "token-secret" },
  })), null);
  assert.equal(parseJmsDeepLink(encodePayload({
    protocol: "ssh",
    token: { id: "token-id", value: "token-secret" },
    endpoint: { host: "gw.example.com" },
  })), null);
  assert.equal(parseJmsDeepLink(encodePayload({
    protocol: "ssh",
    endpoint: { host: "gw.example.com", port: 2222 },
  })), null);
});

test("parseJmsDeepLink returns null for bad base64 or JSON", () => {
  assert.equal(parseJmsDeepLink("jms://%%%"), null);
  assert.equal(parseJmsDeepLink("jms://eyJub3QtanNvbiI6"), null);
});

test("parseJmsDeepLink still parses unsupported protocols", () => {
  const target = parseJmsDeepLink(encodePayload({
    ...validPayload,
    protocol: "rdp",
  }));
  assert.equal(target?.protocol, "rdp");
  assert.equal(target?.hostname, "gw.example.com");
});

test("parseJmsDeepLink coerces string ports and rejects invalid ports", () => {
  const target = parseJmsDeepLink(encodePayload({
    ...validPayload,
    endpoint: { host: "gw.example.com", port: "2222" },
  }));
  assert.equal(target?.port, 2222);

  assert.equal(parseJmsDeepLink(encodePayload({
    ...validPayload,
    endpoint: { host: "gw.example.com", port: 70000 },
  })), null);
  assert.equal(parseJmsDeepLink(encodePayload({
    ...validPayload,
    endpoint: { host: "gw.example.com", port: "abc" },
  })), null);
});

test("parseJmsDeepLink uses name or hostname for label", () => {
  const fromName = parseJmsDeepLink(encodePayload({
    ...validPayload,
    asset: undefined,
    name: "account@asset",
  }));
  assert.equal(fromName?.label, "account@asset");

  const fromHostname = parseJmsDeepLink(encodePayload({
    ...validPayload,
    asset: undefined,
    name: "",
  }));
  assert.equal(fromHostname?.label, "gw.example.com");
});

test("isSupportedJmsProtocol accepts ssh, sftp, and telnet", () => {
  assert.equal(isSupportedJmsProtocol("ssh"), true);
  assert.equal(isSupportedJmsProtocol("SFTP"), true);
  assert.equal(isSupportedJmsProtocol("telnet"), true);
  assert.equal(isSupportedJmsProtocol("rdp"), false);
});

test("buildJmsDeepLinkEphemeralHost builds password ssh host with mosh and et disabled", () => {
  const target = parseJmsDeepLink(encodePayload(validPayload))!;
  const host = buildJmsDeepLinkEphemeralHost(target, { id: "ephemeral-id", now: 456 });

  assert.equal(host.id, "ephemeral-id");
  assert.equal(host.label, "Production Server");
  assert.equal(host.hostname, "gw.example.com");
  assert.equal(host.port, 2222);
  assert.equal(host.username, "JMS-token-id");
  assert.equal(host.password, "token-secret");
  assert.equal(host.authMethod, "password");
  assert.equal(host.savePassword, false);
  assert.equal(resolveHostAutofillPassword({ host, keys: [] }), undefined);
  assert.equal(host.protocol, "ssh");
  assert.equal(host.moshEnabled, false);
  assert.equal(host.ephemeral, true);
  assert.equal(host.etEnabled, false);
  assert.equal(host.createdAt, 456);
  assert.equal(host.autoOpenSftpPanel, undefined);
});

test("buildJmsDeepLinkEphemeralHost flags sftp payloads for the SFTP side panel", () => {
  const target = parseJmsDeepLink(encodePayload({
    ...validPayload,
    protocol: "sftp",
  }))!;
  const host = buildJmsDeepLinkEphemeralHost(target, { id: "ephemeral-id", now: 456 });

  assert.equal(host.protocol, "ssh");
  assert.equal(host.autoOpenSftpPanel, true);
  assert.equal(host.ephemeral, true);
});

test("buildJmsDeepLinkEphemeralHost keeps telnet payloads on the JumpServer ssh gateway", () => {
  const target = parseJmsDeepLink(encodePayload({
    ...validPayload,
    protocol: "telnet",
  }))!;
  const host = buildJmsDeepLinkEphemeralHost(target, { id: "ephemeral-id", now: 456 });

  assert.equal(host.protocol, "ssh");
  assert.equal(host.hostname, "gw.example.com");
  assert.equal(host.port, 2222);
  assert.equal(host.username, "JMS-token-id");
  assert.equal(host.password, "token-secret");
  assert.equal(host.telnetUsername, undefined);
  assert.equal(host.telnetPassword, undefined);
  assert.equal(host.autoOpenSftpPanel, undefined);
  assert.equal(host.ephemeral, true);
});
