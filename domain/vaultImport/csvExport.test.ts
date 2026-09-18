import assert from "node:assert/strict";
import test from "node:test";

import { importVaultHostsFromText } from "../vaultImport.ts";
import { exportHostsToCsvWithStats, getVaultCsvTemplate } from "./csvExport.ts";
import type { Host } from "../models.ts";

const hostDefaults = { username: "root", tags: [], os: "linux" as const };

test("CSV exports include a UTF-8 BOM and preserve Chinese text when imported again", () => {
  const host: Host = {
    ...hostDefaults,
    id: "host-1",
    label: "中文服务器",
    hostname: "10.0.0.1",
    username: "root",
    port: 22,
  };

  const { csv } = exportHostsToCsvWithStats([host]);

  assert.equal(csv.charCodeAt(0), 0xfeff);
  assert.deepEqual([...new TextEncoder().encode(csv).slice(0, 3)], [0xef, 0xbb, 0xbf]);

  const imported = importVaultHostsFromText("csv", csv);
  assert.equal(imported.hosts[0]?.label, host.label);
  assert.equal(imported.hosts[0]?.hostname, host.hostname);
});

test("CSV round-trips local key authentication and its saved passphrase", () => {
  const host: Host = {
    ...hostDefaults,
    id: "host-key",
    label: "Key host",
    hostname: "key.example.com",
    username: "ubuntu",
    port: 22,
    identityFilePaths: ["~/.ssh/id_ed25519"],
    authMethod: "key",
  };

  const { csv } = exportHostsToCsvWithStats([host], {
    keyPassphrases: new Map([["~/.ssh/id_ed25519", "+secret"]]),
  });
  assert.equal(csv.includes(",+secret"), false);
  const imported = importVaultHostsFromText("csv", csv);

  assert.deepEqual(imported.hosts[0]?.identityFilePaths, ["~/.ssh/id_ed25519"]);
  assert.equal(imported.hosts[0]?.authMethod, "key");
  assert.equal(imported.hosts[0]?.password, undefined);
  assert.deepEqual(imported.keyPassphrases, [{
    hostId: imported.hosts[0]?.id,
    keyPath: "~/.ssh/id_ed25519",
    passphrase: "+secret",
  }]);
});

test("CSV round-trips a referenced Keychain file path and saved passphrase", () => {
  const host: Host = {
    ...hostDefaults,
    id: "host-reference-key",
    label: "Reference key host",
    hostname: "reference.example.com",
    username: "ubuntu",
    port: 22,
    identityFileId: "key-reference",
    identityFilePaths: ["/Users/alice/.ssh/stale"],
    authMethod: "key",
  };
  const keyPath = "/Users/alice/.ssh/id_ed25519";

  const { csv } = exportHostsToCsvWithStats([host], {
    keyPathsById: new Map([["key-reference", keyPath]]),
    keyPassphrasesById: new Map([["key-reference", "reference-secret"]]),
    keyPassphrases: new Map([[keyPath, "stale-side-store-secret"]]),
  });
  const imported = importVaultHostsFromText("csv", csv);

  assert.deepEqual(imported.hosts[0]?.identityFilePaths, [keyPath]);
  assert.deepEqual(imported.keyPassphrases, [{
    hostId: imported.hosts[0]?.id,
    keyPath,
    passphrase: "reference-secret",
  }]);
});

test("CSV never falls back to path storage for a referenced key", () => {
  const host: Host = {
    ...hostDefaults,
    id: "host-reference-key",
    label: "Reference key host",
    hostname: "reference.example.com",
    username: "ubuntu",
    port: 22,
    identityFileId: "key-reference",
    authMethod: "key",
  };
  const keyPath = "/Users/alice/.ssh/id_ed25519";

  const { csv } = exportHostsToCsvWithStats([host], {
    keyPathsById: new Map([["key-reference", keyPath]]),
    keyPassphrases: new Map([[keyPath, "stale-side-store-secret"]]),
  });
  const imported = importVaultHostsFromText("csv", csv);

  assert.deepEqual(imported.hosts[0]?.identityFilePaths, [keyPath]);
  assert.deepEqual(imported.keyPassphrases, []);
  assert.equal(csv.includes("stale-side-store-secret"), false);
});

test("CSV reversibly guards key paths that spreadsheets treat as formulas", () => {
  const hosts: Host[] = [
    "-relative-key",
    "'-literal-key",
    "__netcatty_csv_keypath_v1__:literal",
  ].map((keyPath, index) => ({
    ...hostDefaults,
    id: `host-${index}`,
    label: `Host ${index}`,
    hostname: `host-${index}.example.com`,
    username: "root",
    port: 22,
    identityFilePaths: [keyPath],
    authMethod: "key",
  }));

  const { csv } = exportHostsToCsvWithStats(hosts);
  const imported = importVaultHostsFromText("csv", csv);

  assert.deepEqual(imported.hosts.map((host) => host.identityFilePaths?.[0]), [
    "-relative-key",
    "'-literal-key",
    "__netcatty_csv_keypath_v1__:literal",
  ]);
});

test("CSV export never writes credentials from skipped serial hosts", () => {
  const serialHost: Host = {
    ...hostDefaults,
    id: "serial-with-stale-key",
    label: "Serial with stale key",
    hostname: "ttyUSB0",
    protocol: "serial",
    port: 22,
    identityFilePaths: ["~/.ssh/id_stale"],
    authMethod: "key",
  };
  const sshHost: Host = {
    ...hostDefaults,
    id: "ssh-host",
    label: "SSH host",
    hostname: "ssh.example.com",
    protocol: "ssh",
    port: 22,
  };

  const result = exportHostsToCsvWithStats([serialHost, sshHost], {
    keyPassphrases: new Map([["~/.ssh/id_stale", "must-not-leak"]]),
  });

  assert.equal(result.exportedCount, 1);
  assert.equal(result.skippedCount, 1);
  assert.equal(result.csv.includes(serialHost.label), false);
  assert.equal(result.csv.includes("id_stale"), false);
  assert.equal(result.csv.includes("must-not-leak"), false);
  assert.equal(result.csv.includes(sshHost.hostname), true);
});

test("CSV export skips plugin hosts instead of discarding opaque provider configuration", () => {
  const pluginHost: Host = {
    ...hostDefaults,
    id: "plugin-host",
    label: "Plugin host",
    hostname: "com.example.transport.connection",
    username: "alice",
    protocol: "plugin:com.example.transport.connection",
    pluginConnection: {
      providerId: "com.example.transport.connection",
      configuration: { endpoint: "opaque://target" },
    },
  };
  const result = exportHostsToCsvWithStats([pluginHost]);
  assert.equal(result.exportedCount, 0);
  assert.equal(result.skippedCount, 1);
  assert.equal(result.csv.includes("opaque://target"), false);
});

test("CSV round-trips inline HTTP and SOCKS5 proxy configuration", () => {
  const host: Host = {
    ...hostDefaults,
    id: "host-proxy",
    label: "Proxied host",
    hostname: "target.example.com",
    username: "root",
    port: 22,
    proxyConfig: {
      type: "http",
      host: "proxy.example.com",
      port: 8080,
      username: "ali=ce",
      password: "p@a,s\"s",
    },
  };

  const { csv } = exportHostsToCsvWithStats([host]);
  assert.ok(csv.includes("http://ali%3Dce:p%40a%2Cs%22s@proxy.example.com:8080"));
  assert.ok(csv.includes("Proxy"));

  const imported = importVaultHostsFromText("csv", csv);
  assert.deepEqual(imported.hosts[0]?.proxyConfig, {
    type: "http",
    host: "proxy.example.com",
    port: 8080,
    username: "ali=ce",
    password: "p@a,s\"s",
  });
});

test("CSV round-trips command and socks5 proxy configuration", () => {
  const commandHost: Host = {
    ...hostDefaults,
    id: "host-command-proxy",
    label: "Command proxy host",
    hostname: "target.example.com",
    username: "root",
    port: 22,
    proxyConfig: {
      type: "command",
      host: "",
      port: 0,
      command: "nc -X connect -x 10.0.0.9:1080 %h %p",
    },
  };
  const socksHost: Host = {
    ...hostDefaults,
    id: "host-socks-proxy",
    label: "Socks proxy host",
    hostname: "target2.example.com",
    username: "root",
    port: 22,
    proxyConfig: {
      type: "socks5",
      host: "127.0.0.1",
      port: 1080,
    },
  };

  const { csv } = exportHostsToCsvWithStats([commandHost, socksHost]);
  const imported = importVaultHostsFromText("csv", csv);
  assert.deepEqual(imported.hosts[0]?.proxyConfig, commandHost.proxyConfig);
  assert.deepEqual(imported.hosts[1]?.proxyConfig, socksHost.proxyConfig);
});

test("CSV export materializes a referenced proxy profile and never writes encrypted placeholders", () => {
  const host: Host = {
    ...hostDefaults,
    id: "host-profile-proxy",
    label: "Profile proxy host",
    hostname: "target.example.com",
    username: "root",
    port: 22,
    proxyProfileId: "profile-1",
  };

  const { csv } = exportHostsToCsvWithStats([host], {
    proxyProfiles: [{
      id: "profile-1",
      label: "Corp proxy",
      createdAt: 0,
      config: {
        type: "http",
        host: "proxy.example.com",
        port: 8080,
        username: "alice",
        password: "enc:v1:djEwdGVzdAAAAAAAAAAAAAAAAA==",
      },
    }],
  });
  assert.ok(csv.includes("http://alice@proxy.example.com:8080"));
  assert.equal(csv.includes("enc:v1:"), false);

  const imported = importVaultHostsFromText("csv", csv);
  assert.deepEqual(imported.hosts[0]?.proxyConfig, {
    type: "http",
    host: "proxy.example.com",
    port: 8080,
    username: "alice",
  });
});

test("CSV import warns and skips an unrecognized Proxy value", () => {
  const csv = [
    "Groups,Label,Tags,Notes,Hostname/IP,Protocol,Port,Username,Password,KeyPath,Passphrase,Proxy",
    ',"Bad proxy",,,bad.example.com,ssh,22,root,,,,"not a proxy"',
  ].join("\r\n");

  const imported = importVaultHostsFromText("csv", csv);
  assert.equal(imported.hosts.length, 1);
  assert.equal(imported.hosts[0]?.proxyConfig, undefined);
  assert.ok(imported.issues.some((issue) => issue.message.includes("row 2") && issue.message.includes("Proxy")));
});

test("CSV resolves proxy identity credentials for inline and profile proxies", () => {
  const proxyConfig = { type: "socks5" as const, host: "proxy.example.com", port: 1080, identityId: "identity-1" };
  const hosts: Host[] = [
    { ...hostDefaults, id: "inline", label: "Inline", hostname: "inline.example.com", proxyConfig },
    { ...hostDefaults, id: "profile", label: "Profile", hostname: "profile.example.com", proxyProfileId: "profile-1" },
  ];
  const { csv } = exportHostsToCsvWithStats(hosts, {
    proxyProfiles: [{ id: "profile-1", label: "Proxy", createdAt: 0, config: proxyConfig }],
    identities: [{ id: "identity-1", label: "Account", username: "alice@work", password: ' p,a:ss"%+ ', authMethod: 'password', created: 0 }],
  });
  const imported = importVaultHostsFromText("csv", csv);
  assert.equal(imported.hosts.length, 2);
  assert.deepEqual(imported.issues, []);
  for (const host of imported.hosts) {
    assert.deepEqual(host.proxyConfig, {
      type: "socks5", host: "proxy.example.com", port: 1080,
      username: "alice@work", password: ' p,a:ss"%+ ',
    });
    assert.equal(host.proxyProfileId, undefined);
  }
  assert.equal(csv.includes("identity-1"), false);
});

test("CSV proxy identity export omits encrypted passwords and stale manual credentials", () => {
  const proxyConfig = {
    type: "http" as const, host: "proxy.example.com", port: 8080, identityId: "identity-1",
    username: "stale-user", password: "stale-password",
  };
  const host: Host = { ...hostDefaults, id: "identity-host", label: "Identity", hostname: "target.example.com", proxyConfig };
  const { csv } = exportHostsToCsvWithStats([host], {
    identities: [{ id: "identity-1", label: "Account", username: "alice", password: "enc:v1:djEwdGVzdAAAAAAAAAAAAAAAAA==", authMethod: "password", created: 0 }],
  });
  assert.equal(csv.includes("enc%3Av1"), false);
  assert.equal(csv.includes("stale"), false);
  assert.deepEqual(importVaultHostsFromText("csv", csv).hosts[0]?.proxyConfig, {
    type: "http", host: "proxy.example.com", port: 8080, username: "alice",
  });
});

test("CSV rejects HTTPS proxies without silently downgrading their transport", () => {
  const imported = importVaultHostsFromText("csv", "Hostname,Proxy\ntarget.example.com,https://alice:secret@proxy.example.com:443");
  assert.equal(imported.hosts[0]?.proxyConfig, undefined);
  assert.equal(imported.issues.length, 1);
  assert.match(imported.issues[0].message, /CSV row 2: Proxy/);
  assert.equal(imported.issues[0].message.includes("secret"), false);
});

test("CSV preserves inherited proxies and gives host settings priority", () => {
  const inline = { type: "http" as const, host: "inline.example.com", port: 8080 };
  const groupProxy = { type: "socks5" as const, host: "group.example.com", port: 1080 };
  const profileProxy = { type: "http" as const, host: "profile.example.com", port: 3128 };
  const hosts: Host[] = [
    { ...hostDefaults, id: "inherited", label: "Inherited", hostname: "one.example.com", group: "Corp/Dev" },
    { ...hostDefaults, id: "profile", label: "Profile", hostname: "two.example.com", group: "Corp/Prod" },
    { ...hostDefaults, id: "inline", label: "Inline", hostname: "three.example.com", group: "Corp/Prod", proxyConfig: inline },
    { ...hostDefaults, id: "override", label: "Override", hostname: "four.example.com", group: "Corp/Dev", proxyProfileId: "profile-1" },
  ];
  const original = structuredClone(hosts);
  const { csv } = exportHostsToCsvWithStats(hosts, {
    groupConfigs: [{ path: "Corp", proxyConfig: groupProxy }, { path: "Corp/Prod", proxyProfileId: "profile-1" }],
    proxyProfiles: [{ id: "profile-1", label: "Profile", createdAt: 0, config: profileProxy }],
  });
  assert.deepEqual(importVaultHostsFromText("csv", csv).hosts.map((host) => host.proxyConfig), [groupProxy, profileProxy, inline, profileProxy]);
  assert.deepEqual(hosts, original);
});

test("CSV preserves IPv6 proxies and multiline commands with CSV punctuation", () => {
  const proxies = [
    { type: "socks5" as const, host: "::1", port: 1080 },
    { type: "http" as const, host: "2001:db8::1", port: 8080, username: "用户", password: "密@码%" },
    { type: "command" as const, host: "", port: 0, command: 'sh -c "printf x,y;\nexec nc %h %p"' },
  ];
  const { csv } = exportHostsToCsvWithStats(proxies.map((proxyConfig, i) => ({ ...hostDefaults, id: String(i), label: String(i), hostname: `host${i}.example.com`, proxyConfig })));
  assert.ok(csv.includes("socks5://[::1]:1080"));
  const imported = importVaultHostsFromText("csv", csv);
  assert.deepEqual(imported.hosts.map((host) => host.proxyConfig), proxies);
  assert.deepEqual(imported.issues, []);
});

test("CSV proxy parsing warns on paths, query strings, fragments, and invalid ports", () => {
  for (const value of [
    "http://proxy.example:8080/path:80", "http://proxy.example?query:80",
    "http://proxy.example#fragment:80", "http://proxy.example:0",
    "socks5://proxy.example:65536", "http://[::1:8080", "command://",
  ]) {
    const imported = importVaultHostsFromText("csv", `Hostname,Proxy\ntarget.example.com,${value}`);
    assert.equal(imported.hosts[0]?.proxyConfig, undefined, value);
    assert.equal(imported.issues.length, 1, value);
  }
});

test("CSV template includes a working proxy example and legacy CSV stays compatible", () => {
  const imported = importVaultHostsFromText("csv", getVaultCsvTemplate());
  assert.equal(imported.hosts.length, 3);
  assert.deepEqual(imported.hosts[0]?.proxyConfig, { type: "socks5", host: "127.0.0.1", port: 1080 });
  assert.equal(imported.hosts[1]?.proxyConfig, undefined);
  assert.deepEqual(imported.issues, []);
  const legacy = importVaultHostsFromText("csv", "Hostname,Username,Password\nlegacy.example.com,root,secret");
  assert.equal(legacy.hosts[0]?.password, "secret");
  assert.equal(legacy.hosts[0]?.proxyConfig, undefined);
  assert.deepEqual(legacy.issues, []);
});
