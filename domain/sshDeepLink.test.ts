import test from "node:test";
import assert from "node:assert/strict";
import type { Host } from "./models";
import { resolveHostAutofillPassword } from "./sshAuth";
import {
  buildSshDeepLinkConnectionHost,
  buildSshDeepLinkEphemeralHost,
  buildSshDeepLinkEphemeralHostFromSaved,
  buildSshDeepLinkHostDraft,
  buildSshDeepLinkOpenHost,
  buildSshNoteLinkOpenHost,
  findSshDeepLinkHost,
  parseSshDeepLink,
  shouldHandleSshDeepLink,
} from "./sshDeepLink";

const host = (overrides: Partial<Host>): Host => ({
  id: overrides.id || "host-1",
  label: overrides.label || "Example",
  hostname: overrides.hostname || "example.com",
  username: overrides.username ?? "root",
  port: overrides.port,
  group: "",
  tags: [],
  os: "linux",
  protocol: overrides.protocol ?? "ssh",
  ...overrides,
});

test("parseSshDeepLink accepts username host and port", () => {
  assert.deepEqual(parseSshDeepLink("ssh://alice@example.com:2200"), {
    rawUrl: "ssh://alice@example.com:2200",
    username: "alice",
    hostname: "example.com",
    port: 2200,
  });
});

test("parseSshDeepLink accepts IPv6 hosts", () => {
  assert.deepEqual(parseSshDeepLink("ssh://bob@[2001:db8::10]:2222"), {
    rawUrl: "ssh://bob@[2001:db8::10]:2222",
    username: "bob",
    hostname: "2001:db8::10",
    port: 2222,
  });
});

test("parseSshDeepLink extracts and percent-decodes passwords", () => {
  assert.deepEqual(parseSshDeepLink("ssh://alice:secret@example.com"), {
    rawUrl: "ssh://alice:secret@example.com",
    username: "alice",
    password: "secret",
    hostname: "example.com",
  });
  assert.deepEqual(parseSshDeepLink("ssh://alice:p%40ss@example.com:2200"), {
    rawUrl: "ssh://alice:p%40ss@example.com:2200",
    username: "alice",
    password: "p@ss",
    hostname: "example.com",
    port: 2200,
  });
});

test("parseSshDeepLink omits password when not present", () => {
  const target = parseSshDeepLink("ssh://alice@example.com");
  assert.ok(target);
  assert.equal(target.password, undefined);
});

test("buildSshDeepLinkEphemeralHost includes password auth and disables mosh and et", () => {
  const ephemeral = buildSshDeepLinkEphemeralHost(
    parseSshDeepLink("ssh://alice:secret@example.com:2200")!,
    { id: "ephemeral-id", now: 789 },
  );

  assert.equal(ephemeral.id, "ephemeral-id");
  assert.equal(ephemeral.password, "secret");
  assert.equal(ephemeral.authMethod, "password");
  assert.equal(ephemeral.savePassword, false);
  assert.equal(resolveHostAutofillPassword({ host: ephemeral, keys: [] }), undefined);
  assert.equal(ephemeral.moshEnabled, false);
  assert.equal(ephemeral.etEnabled, false);
  assert.equal(ephemeral.protocol, "ssh");
  assert.equal(ephemeral.ephemeral, true);
});

test("buildSshDeepLinkEphemeralHost omits password fields when target has no password", () => {
  const ephemeral = buildSshDeepLinkEphemeralHost(
    parseSshDeepLink("ssh://alice@example.com")!,
    { id: "ephemeral-id", now: 789 },
  );

  assert.equal(ephemeral.password, undefined);
  assert.equal(ephemeral.authMethod, undefined);
  assert.equal(ephemeral.savePassword, false);
  assert.equal(ephemeral.moshEnabled, false);
  assert.equal(ephemeral.etEnabled, false);
});

test("buildSshDeepLinkEphemeralHostFromSaved keeps saved settings but overrides credentials", () => {
  // Effective host: group defaults already resolved, including
  // group-inherited credentials that must not survive the build.
  const effectiveSavedHost = {
    id: "saved-id",
    label: "Saved Host",
    hostname: "example.com",
    username: "vault-user",
    port: 2200,
    group: "prod",
    tags: ["bastion"],
    os: "linux" as const,
    identityId: "group-identity-1",
    identityFileId: "group-key-1",
    identityFilePaths: ["/home/user/.ssh/id_ed25519"],
    password: "vault-password",
    savePassword: true,
    authMethod: "key" as const,
    proxyProfileId: "proxy-1",
    hostChain: { hostIds: ["jump-1"] },
    charset: "utf8",
    moshEnabled: true,
    createdAt: 1,
  };

  const ephemeral = buildSshDeepLinkEphemeralHostFromSaved(
    effectiveSavedHost,
    parseSshDeepLink("ssh://alice:otp@example.com:2200")!,
    { id: "ephemeral-id", now: 789 },
  );

  assert.equal(ephemeral.id, "ephemeral-id");
  assert.equal(ephemeral.ephemeral, true);
  assert.equal(ephemeral.username, "alice");
  assert.equal(ephemeral.password, "otp");
  assert.equal(ephemeral.authMethod, "password");
  assert.equal(ephemeral.identityId, undefined);
  assert.equal(ephemeral.identityFileId, undefined);
  assert.equal(ephemeral.identityFilePaths, undefined);
  assert.equal(ephemeral.savePassword, false);
  assert.equal(resolveHostAutofillPassword({ host: ephemeral, keys: [] }), undefined);
  // Group is cleared so effective-host resolution cannot re-inherit
  // group credentials over the one-time password.
  assert.equal(ephemeral.group, "");
  assert.equal(ephemeral.proxyProfileId, "proxy-1");
  assert.deepEqual(ephemeral.hostChain, { hostIds: ["jump-1"] });
  assert.equal(ephemeral.charset, "utf8");
  assert.equal(ephemeral.protocol, "ssh");
  assert.equal(ephemeral.moshEnabled, false);
  assert.equal(ephemeral.etEnabled, false);
});

test("buildSshDeepLinkHostDraft never includes a password", () => {
  const draft = buildSshDeepLinkHostDraft(
    parseSshDeepLink("ssh://alice:secret@example.com")!,
    { id: "draft-id", now: 123 },
  );

  assert.equal(draft.password, undefined);
  assert.equal(draft.authMethod, undefined);
});

test("parseSshDeepLink rejects unsupported or incomplete links", () => {
  assert.equal(parseSshDeepLink("https://example.com"), null);
  assert.equal(parseSshDeepLink("ssh://"), null);
  assert.equal(parseSshDeepLink("ssh://example.com:99999"), null);
});

test("shouldHandleSshDeepLink respects the user setting", () => {
  assert.equal(shouldHandleSshDeepLink("ssh://alice@example.com", true), true);
  assert.equal(shouldHandleSshDeepLink("ssh://alice@example.com", false), false);
  assert.equal(shouldHandleSshDeepLink("https://example.com", true), false);
});

test("findSshDeepLinkHost matches saved ssh hosts by username hostname and port", () => {
  const hosts = [
    host({ id: "wrong-port", hostname: "example.com", username: "alice", port: 22 }),
    host({ id: "match", hostname: "example.com", username: "alice", port: 2200 }),
    host({ id: "telnet", hostname: "example.com", username: "alice", port: 2200, protocol: "telnet" }),
  ];

  const match = findSshDeepLinkHost(hosts, parseSshDeepLink("ssh://alice@example.com:2200")!);

  assert.equal(match?.id, "match");
});

test("findSshDeepLinkHost avoids ambiguous saved hosts", () => {
  const hosts = [
    host({ id: "one", hostname: "example.com", username: "alice", port: 2200 }),
    host({ id: "two", hostname: "example.com", username: "alice", port: 2222 }),
  ];

  const match = findSshDeepLinkHost(hosts, parseSshDeepLink("ssh://alice@example.com")!);

  assert.equal(match, null);
});

test("findSshDeepLinkHost treats omitted ports as the ssh default", () => {
  const hosts = [
    host({ id: "custom-port", hostname: "example.com", username: "alice", port: 2200 }),
    host({ id: "default-port", hostname: "example.com", username: "alice" }),
  ];

  const match = findSshDeepLinkHost(hosts, parseSshDeepLink("ssh://alice@example.com")!);

  assert.equal(match?.id, "default-port");
});

test("buildSshDeepLinkConnectionHost forces a saved host to open with ssh", () => {
  const savedHost = host({
    id: "saved",
    hostname: "example.com",
    username: "alice",
    moshEnabled: true,
    etEnabled: true,
  });

  const connectionHost = buildSshDeepLinkConnectionHost(savedHost);

  assert.equal(connectionHost.protocol, "ssh");
  assert.equal(connectionHost.moshEnabled, false);
  assert.equal(connectionHost.etEnabled, false);
  assert.equal(savedHost.moshEnabled, true);
  assert.equal(savedHost.etEnabled, true);
});

test("buildSshDeepLinkHostDraft prepares an editable new ssh host", () => {
  const draft = buildSshDeepLinkHostDraft(
    parseSshDeepLink("ssh://alice@example.com:2200")!,
    { id: "new-id", now: 123 },
  );

  assert.deepEqual(draft, {
    id: "new-id",
    label: "alice@example.com",
    hostname: "example.com",
    username: "alice",
    port: 2200,
    group: "",
    tags: [],
    os: "linux",
    protocol: "ssh",
    createdAt: 123,
  });
});

test("buildSshDeepLinkOpenHost falls back to a draft host when no saved host matches", () => {
  const openHost = buildSshDeepLinkOpenHost(
    [],
    parseSshDeepLink("ssh://root@missing.example.com:2200")!,
    { id: "draft-id", now: 456 },
  );

  assert.equal(openHost.id, "draft-id");
  assert.equal(openHost.hostname, "missing.example.com");
  assert.equal(openHost.username, "root");
  assert.equal(openHost.port, 2200);
  assert.equal(openHost.protocol, "ssh");
  assert.equal(openHost.moshEnabled, false);
  assert.equal(openHost.etEnabled, false);
});

test("buildSshNoteLinkOpenHost opens an existing ssh link host", () => {
  const openHost = buildSshNoteLinkOpenHost(
    [host({ id: "match", hostname: "10.2.0.32", username: "root" })],
    "ssh://10.2.0.32",
    "10.2.0.32",
    { id: "draft-id", now: 456 },
  );

  assert.equal(openHost?.id, "match");
  assert.equal(openHost?.protocol, "ssh");
  assert.equal(openHost?.moshEnabled, false);
  assert.equal(openHost?.etEnabled, false);
});

test("buildSshNoteLinkOpenHost treats a bare host link as an existing ssh host reference", () => {
  const openHost = buildSshNoteLinkOpenHost(
    [host({ id: "match", hostname: "10.2.0.32", username: "root" })],
    "10.2.0.32",
    "10.2.0.32",
    { id: "draft-id", now: 456 },
  );

  assert.equal(openHost?.id, "match");
  assert.equal(openHost?.protocol, "ssh");
});

test("buildSshNoteLinkOpenHost leaves document-relative note links alone", () => {
  const hosts = [
    host({ id: "docs", label: "docs", hostname: "docs.example.com" }),
    host({ id: "section", label: "section", hostname: "section.example.com" }),
  ];

  for (const [href, label] of [
    ["/docs", "docs"],
    ["#section", "section"],
    ["./docs", "docs"],
    ["../docs", "docs"],
    ["docs/page", "docs"],
    ["docs?tab=install", "docs"],
    ["docs#install", "docs"],
  ] as const) {
    assert.equal(
      buildSshNoteLinkOpenHost(hosts, href, label, { id: "draft-id", now: 456 }),
      null,
    );
  }
});

test("buildSshNoteLinkOpenHost does not treat sanitized editor links as hosts", () => {
  const openHost = buildSshNoteLinkOpenHost(
    [host({ id: "match", hostname: "10.2.0.32", username: "root" })],
    "about:blank",
    "10.2.0.32",
    { id: "draft-id", now: 456 },
  );

  assert.equal(openHost, null);
});

test("buildSshNoteLinkOpenHost ignores unrelated external links", () => {
  const openHost = buildSshNoteLinkOpenHost(
    [host({ id: "match", hostname: "10.2.0.32", username: "root" })],
    "https://example.com",
    "Example",
    { id: "draft-id", now: 456 },
  );

  assert.equal(openHost, null);
});
