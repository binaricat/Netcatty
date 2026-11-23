import test from "node:test";
import assert from "node:assert/strict";
import {
  buildJmsDeepLinkEphemeralHost,
  isSupportedJmsProtocol,
  parseJmsDeepLink,
  parseJmsDeepLinkResult,
} from "./jmsDeepLink";
import { resolveHostAutofillPassword } from "./sshAuth";

const encodeRawJson = (value: unknown): string =>
  `jms://${Buffer.from(JSON.stringify(value), "utf8").toString("base64")}`;

const encodePayload = (payload: Record<string, unknown>): string =>
  encodeRawJson(payload);

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

test("parseJmsDeepLinkResult reports unsupported_protocol for JumpServer v4 RDP payload without endpoint or token", () => {
  assert.deepEqual(
    parseJmsDeepLinkResult(encodePayload({
      version: 2,
      protocol: "rdp",
      name: "admin@windows-host",
      file: { name: "admin@windows-host.rdp", content: "full address:s:10.0.0.10:3389" },
    })),
    { ok: false, reason: "unsupported_protocol", protocol: "rdp" },
  );

  assert.deepEqual(
    parseJmsDeepLinkResult(encodePayload({
      protocol: "  RDP  ",
    })),
    { ok: false, reason: "unsupported_protocol", protocol: "rdp" },
  );
});

test("parseJmsDeepLinkResult reports unsupported_protocol for vnc, database, and k8s payloads without endpoint or token", () => {
  for (const protocol of ["vnc", "mysql", "postgresql", "k8s"]) {
    assert.deepEqual(
      parseJmsDeepLinkResult(encodePayload({ protocol })),
      { ok: false, reason: "unsupported_protocol", protocol },
    );
  }
});

test("parseJmsDeepLinkResult returns invalid for malformed links, missing protocol, or non-object JSON", () => {
  assert.deepEqual(parseJmsDeepLinkResult(""), { ok: false, reason: "invalid" });
  assert.deepEqual(parseJmsDeepLinkResult("ssh://example.com"), { ok: false, reason: "invalid" });
  assert.deepEqual(parseJmsDeepLinkResult("jms://"), { ok: false, reason: "invalid" });
  assert.deepEqual(parseJmsDeepLinkResult("jms://%%%"), { ok: false, reason: "invalid" });
  assert.deepEqual(parseJmsDeepLinkResult("jms://eyJub3QtanNvbiI6"), { ok: false, reason: "invalid" });

  for (const nonObject of [null, [], "rdp", 123, true]) {
    assert.deepEqual(parseJmsDeepLinkResult(encodeRawJson(nonObject)), { ok: false, reason: "invalid" });
    assert.equal(parseJmsDeepLink(encodeRawJson(nonObject)), null);
  }

  assert.deepEqual(parseJmsDeepLinkResult(encodePayload({})), { ok: false, reason: "invalid" });
  assert.deepEqual(parseJmsDeepLinkResult(encodePayload({ protocol: "   " })), { ok: false, reason: "invalid" });
  assert.deepEqual(parseJmsDeepLinkResult(encodePayload({ protocol: 123 })), { ok: false, reason: "invalid" });
});

test("parseJmsDeepLinkResult returns invalid when supported ssh payload is missing endpoint or token", () => {
  assert.deepEqual(
    parseJmsDeepLinkResult(encodePayload({
      protocol: "ssh",
      token: { id: "token-id", value: "token-secret" },
    })),
    { ok: false, reason: "invalid" },
  );
  assert.deepEqual(
    parseJmsDeepLinkResult(encodePayload({
      protocol: "ssh",
      endpoint: { host: "gw.example.com", port: 2222 },
    })),
    { ok: false, reason: "invalid" },
  );
  assert.deepEqual(
    parseJmsDeepLinkResult(encodePayload({
      ...validPayload,
      endpoint: { host: "gw.example.com", port: 70000 },
    })),
    { ok: false, reason: "invalid" },
  );
});

test("parseJmsDeepLinkResult returns ok with target for valid ssh, sftp, and telnet payloads", () => {
  for (const protocol of ["ssh", "sftp", "telnet"]) {
    assert.deepEqual(
      parseJmsDeepLinkResult(encodePayload({
        ...validPayload,
        protocol,
      })),
      {
        ok: true,
        target: {
          protocol,
          hostname: "gw.example.com",
          port: 2222,
          username: "JMS-token-id",
          password: "token-secret",
          label: "Production Server",
        },
      },
    );
  }
});
