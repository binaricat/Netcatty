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
    protocol: "mysql",
  }));
  assert.equal(target?.protocol, "mysql");
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

test("isSupportedJmsProtocol accepts ssh, sftp, telnet, rdp, and vnc", () => {
  assert.equal(isSupportedJmsProtocol("ssh"), true);
  assert.equal(isSupportedJmsProtocol("SFTP"), true);
  assert.equal(isSupportedJmsProtocol("telnet"), true);
  assert.equal(isSupportedJmsProtocol("rdp"), true);
  assert.equal(isSupportedJmsProtocol("RDP"), true);
  assert.equal(isSupportedJmsProtocol("vnc"), true);
  assert.equal(isSupportedJmsProtocol("VNC"), true);
  assert.equal(isSupportedJmsProtocol("mysql"), false);
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

test("parseJmsDeepLinkResult parses JumpServer v4 embedded .rdp file payload and preserves raw content", () => {
  const rawRdpContent = [
    "full address:s:razor.example.com:33890",
    "username:s:alice|550e8400-e29b-41d4-a716-446655440000",
    "use redirection server name:i:0",
    "loadbalanceinfo:s:tsv://MS Terminal Services Plugin.1.Desktop",
    "desktopwidth:i:1920",
    "desktopheight:i:1080",
    "redirectclipboard:i:1",
    "audiomode:i:0",
  ].join("\r\n");

  const result = parseJmsDeepLinkResult(encodePayload({
    version: 2,
    protocol: "rdp",
    name: "admin@windows-host",
    token: { id: "tok-1", value: "one-time-secret" },
    file: { name: "admin@windows-host.rdp", content: rawRdpContent },
  }));

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.target.protocol, "rdp");
  assert.equal(result.target.hostname, "razor.example.com");
  assert.equal(result.target.port, 33890);
  assert.equal(result.target.username, "alice|550e8400-e29b-41d4-a716-446655440000");
  assert.equal(result.target.password, "one-time-secret");
  assert.equal(result.target.label, "admin@windows-host");
  assert.equal(result.target.rawRdpFileContent, rawRdpContent);
  assert.equal(result.target.rawRdpFileName, "admin@windows-host.rdp");
  assert.equal(result.target.rdpConfig?.loadBalanceInfo, "tsv://MS Terminal Services Plugin.1.Desktop");
  assert.equal(result.target.rdpConfig?.width, 1920);
  assert.equal(result.target.rdpConfig?.audioEnabled, true);

  const host = buildJmsDeepLinkEphemeralHost(result.target, { id: "ephemeral-rdp", now: 789 });
  assert.equal(host.protocol, "rdp");
  assert.equal(host.os, "windows");
  assert.equal(host.ephemeral, true);
  assert.equal(host.savePassword, false);
  assert.equal(host.username, "alice|550e8400-e29b-41d4-a716-446655440000");
  assert.equal(host.password, "one-time-secret");
  assert.equal(host.authMethod, "password");
  assert.equal(host.rdpConfig?.loadBalanceInfo, "tsv://MS Terminal Services Plugin.1.Desktop");
  assert.equal("password" in (host.rdpConfig ?? {}), false);
});

test("parseJmsDeepLinkResult accepts JumpServer v4 embedded .rdp without token password and rejects empty RDP payload", () => {
  const withoutToken = parseJmsDeepLinkResult(encodePayload({
    version: 2,
    protocol: "rdp",
    name: "win-prompt",
    file: { name: "win-prompt.rdp", content: "full address:s:10.0.0.10:3389\r\nusername:s:alice|uuid" },
  }));
  assert.equal(withoutToken.ok, true);
  if (withoutToken.ok) {
    assert.equal(withoutToken.target.password, "");
    const host = buildJmsDeepLinkEphemeralHost(withoutToken.target, { id: "ephemeral-rdp-2", now: 1 });
    assert.equal(host.password, undefined);
    assert.equal(host.username, "alice|uuid");
  }

  assert.deepEqual(
    parseJmsDeepLinkResult(encodePayload({ protocol: "  RDP  " })),
    { ok: false, reason: "invalid" },
  );
});

test("parseJmsDeepLinkResult supports endpoint+token payloads for rdp and vnc", () => {
  const rdpResult = parseJmsDeepLinkResult(encodePayload({
    protocol: "rdp",
    token: { id: "rdp-tok", value: "rdp-secret" },
    endpoint: { host: "gw.example.com", rdp_port: 33890 },
    asset: { name: "Win Asset" },
  }));
  assert.equal(rdpResult.ok, true);
  if (rdpResult.ok) {
    assert.equal(rdpResult.target.port, 33890);
    assert.equal(rdpResult.target.username, "JMS-rdp-tok");
    assert.equal(rdpResult.target.password, "rdp-secret");
    const host = buildJmsDeepLinkEphemeralHost(rdpResult.target, { id: "ep-rdp", now: 2 });
    assert.equal(host.protocol, "rdp");
    assert.equal(host.os, "windows");
    assert.equal(host.port, 33890);
  }

  const vncResult = parseJmsDeepLinkResult(encodePayload({
    protocol: "vnc",
    token: { id: "vnc-tok", value: "vnc-secret" },
    endpoint: { host: "gw.example.com", port: 5900 },
    asset: { name: "Linux Desktop" },
  }));
  assert.equal(vncResult.ok, true);
  if (vncResult.ok) {
    assert.equal(vncResult.target.protocol, "vnc");
    assert.equal(vncResult.target.port, 5900);
    assert.equal(vncResult.target.username, "JMS-vnc-tok");
    const host = buildJmsDeepLinkEphemeralHost(vncResult.target, { id: "ep-vnc", now: 3 });
    assert.equal(host.protocol, "vnc");
    assert.equal(host.port, 5900);
    assert.equal(host.ephemeral, true);
    assert.equal(host.savePassword, false);
    assert.equal(host.password, "vnc-secret");
    assert.equal(host.authMethod, "password");
  }
});

test("parseJmsDeepLinkResult reports unsupported_protocol for database and k8s payloads without endpoint or token", () => {
  for (const protocol of ["mysql", "postgresql", "k8s"]) {
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
