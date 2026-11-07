import assert from "node:assert/strict";
import test from "node:test";

import { publishActiveGlobalDefaultProxyProfileId } from "../globalDefaultProxy.ts";
import { applyGroupDefaults } from "../groupConfig.ts";
import { applyVaultHostImport, applyVaultImportDestination, importVaultHostsFromText } from "../vaultImport.ts";
import { exportHostsToCsvWithStats, getVaultCsvTemplate } from "./csvExport.ts";
import { parseCsv } from "./csvUtils.ts";
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

test("CSV import keeps distinct local-shell entries in the same group", () => {
  const localShellHost = (id: string, label: string, shell: string, shellName: string): Host => ({
    ...hostDefaults,
    id,
    label,
    hostname: "localhost",
    port: 22,
    protocol: "local",
    group: "Shells",
    localShell: shell,
    localShellName: shellName,
  });

  const cmd = localShellHost("local-cmd", "Command Prompt", "cmd.exe", "Command Prompt");
  const powershell = localShellHost("local-ps", "PowerShell", "powershell.exe", "Windows PowerShell");
  const { csv } = exportHostsToCsvWithStats([cmd, powershell]);

  const imported = importVaultHostsFromText("csv", csv);
  assert.equal(imported.stats.duplicates, 0);
  assert.equal(imported.hosts.length, 2);
  assert.deepEqual(
    imported.hosts.map((h) => h.localShell).sort(),
    ["cmd.exe", "powershell.exe"],
  );
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

test("CSV round-trips explicit direct proxy mode and still treats an empty Proxy as inherit", () => {
  const staleProxy = { type: "http" as const, host: "stale.example.com", port: 8080 };
  const groupProxy = { type: "socks5" as const, host: "group.example.com", port: 1080 };
  const hosts: Host[] = [
    {
      ...hostDefaults,
      id: "direct",
      label: "Direct",
      hostname: "direct.example.com",
      directProxy: true,
      proxyConfig: staleProxy,
    },
    {
      ...hostDefaults,
      id: "grouped-direct",
      label: "Grouped direct",
      hostname: "grouped.example.com",
      group: "Corp",
      directProxy: true,
    },
    { ...hostDefaults, id: "inherit", label: "Inherit", hostname: "inherit.example.com" },
  ];
  const { csv } = exportHostsToCsvWithStats(hosts, {
    groupConfigs: [{ path: "Corp", proxyConfig: groupProxy }],
  });
  const lines = csv.replace(/^\uFEFF/, "").trimEnd().split("\r\n");
  const proxyIndex = lines[0].split(",").indexOf("Proxy");
  const proxyCell = (line: string) => line.split(",")[proxyIndex];
  assert.equal(proxyCell(lines[1]), "direct");
  assert.equal(proxyCell(lines[2]), "direct");
  assert.equal(proxyCell(lines[3]), "");
  assert.equal(csv.includes("stale.example.com"), false);
  assert.equal(csv.includes("group.example.com"), false);

  const imported = importVaultHostsFromText("csv", csv);
  assert.deepEqual(imported.issues, []);
  assert.equal(imported.hosts[0]?.directProxy, true);
  assert.equal(imported.hosts[0]?.proxyConfig, undefined);
  assert.equal(imported.hosts[1]?.directProxy, true);
  assert.equal(imported.hosts[1]?.proxyConfig, undefined);
  assert.equal(imported.hosts[2]?.directProxy, undefined);
  assert.equal(imported.hosts[2]?.proxyConfig, undefined);

  const options = {
    globalProxyProfileId: "global-proxy",
    validProxyProfileIds: new Set(["global-proxy"]),
  };
  const directEffective = applyGroupDefaults(imported.hosts[0], {}, options);
  assert.equal(directEffective.directProxy, true);
  assert.equal(directEffective.proxyProfileId, undefined);
  const inheritEffective = applyGroupDefaults(imported.hosts[2], {}, options);
  assert.equal(inheritEffective.directProxy, undefined);
  assert.equal(inheritEffective.proxyProfileId, "global-proxy");

  const literal = importVaultHostsFromText("csv", "Hostname,Proxy\nmanual.example.com,direct\nempty.example.com,");
  assert.deepEqual(literal.issues, []);
  assert.equal(literal.hosts[0]?.directProxy, true);
  assert.equal(literal.hosts[0]?.proxyConfig, undefined);
  assert.equal(literal.hosts[1]?.directProxy, undefined);
});

test("CSV export keeps an empty Proxy cell when only the global default is set", () => {
  publishActiveGlobalDefaultProxyProfileId("global-proxy");
  try {
    const groupProxy = { type: "socks5" as const, host: "group.example.com", port: 1080 };
    const hosts: Host[] = [
      { ...hostDefaults, id: "grouped", label: "Grouped", hostname: "grouped.example.com", group: "Corp" },
      { ...hostDefaults, id: "plain", label: "Plain", hostname: "plain.example.com" },
      { ...hostDefaults, id: "edge", label: "Edge", hostname: "edge.example.com", group: "Corp/Edge" },
    ];
    const { csv } = exportHostsToCsvWithStats(hosts, {
      groupConfigs: [{ path: "Corp/Edge", proxyConfig: groupProxy }],
      proxyProfiles: [{
        id: "global-proxy",
        label: "Global",
        createdAt: 0,
        config: {
          type: "http",
          host: "secret-proxy.example.com",
          port: 8080,
          username: "alice",
          password: "s3cret",
        },
      }],
    });
    const lines = csv.replace(/^\uFEFF/, "").trimEnd().split("\r\n");
    const proxyIndex = lines[0].split(",").indexOf("Proxy");
    const proxyCell = (line: string) => line.split(",")[proxyIndex];
    assert.equal(proxyCell(lines[1]), "");
    assert.equal(proxyCell(lines[2]), "");
    assert.equal(proxyCell(lines[3]), "socks5://group.example.com:1080");
    assert.equal(csv.includes("secret-proxy.example.com"), false);
    assert.equal(csv.includes("s3cret"), false);
    assert.equal(importVaultHostsFromText("csv", csv).hosts[0]?.proxyConfig, undefined);
    assert.equal(importVaultHostsFromText("csv", csv).hosts[1]?.proxyConfig, undefined);
  } finally {
    publishActiveGlobalDefaultProxyProfileId(undefined);
  }
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
    "http://proxy.example:8080:80", "socks5://::1:1080",
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

test("CSV reports unreadable proxy passwords for exported hosts only", () => {
  const encrypted = "enc:v1:djEwdGVzdAAAAAAAAAAAAAAAAA==";
  const inline = { type: "http" as const, host: "proxy.example.com", port: 8080, username: "alice", password: encrypted };
  const identityProxy = { type: "socks5" as const, host: "proxy.example.com", port: 1080, identityId: "identity-1" };
  const result = exportHostsToCsvWithStats([
    { ...hostDefaults, id: "inline", label: "Inline", hostname: "one.example.com", proxyConfig: inline },
    { ...hostDefaults, id: "group", label: "Group", hostname: "two.example.com", group: "Corp" },
    { ...hostDefaults, id: "good", label: "Readable", hostname: "three.example.com", proxyConfig: { ...inline, password: "readable" } },
    { ...hostDefaults, id: "serial", label: "Serial", hostname: "ttyUSB0", protocol: "serial", proxyConfig: inline },
  ], {
    groupConfigs: [{ path: "Corp", proxyProfileId: "profile-1" }],
    proxyProfiles: [{ id: "profile-1", label: "Profile", createdAt: 0, config: identityProxy }],
    identities: [{ id: "identity-1", label: "Account", username: "alice", password: encrypted, authMethod: "password", created: 0 }],
  });
  assert.equal(result.unreadableProxyCredentialCount, 2);
  assert.equal(result.exportedCount, 3);
  assert.equal(result.skippedCount, 1);
  const imported = importVaultHostsFromText("csv", result.csv);
  assert.deepEqual(imported.hosts.map((host) => host.proxyConfig?.password), [undefined, undefined, "readable"]);
  assert.equal(exportHostsToCsvWithStats([]).unreadableProxyCredentialCount, 0);
});

test("CSV round-trips local-shell vault host settings", () => {
  const localHost: Host = {
    ...hostDefaults,
    id: "local-cmd",
    label: "CMD host",
    hostname: "localhost",
    username: "",
    protocol: "local",
    os: "windows",
    tags: ["local"],
    localShell: "cmd",
    localShellArgs: ["/k", "echo hi"],
    localShellName: "CMD",
    localShellIcon: "cmd",
    localStartDir: "C:\\Users\\dev",
  };
  const defaultLocalHost: Host = {
    ...hostDefaults,
    id: "local-default",
    label: "Local shell",
    hostname: "localhost",
    username: "",
    protocol: "local",
    os: "windows",
    tags: ["local"],
    group: "Backups",
  };

  const { csv, exportedCount, skippedCount } = exportHostsToCsvWithStats([localHost, defaultLocalHost]);
  assert.equal(exportedCount, 2);
  assert.equal(skippedCount, 0);

  const imported = importVaultHostsFromText("csv", csv);
  assert.equal(imported.hosts.length, 2);
  assert.equal(imported.issues.length, 0);

  const roundTripped = imported.hosts[0];
  assert.equal(roundTripped.protocol, "local");
  assert.equal(roundTripped.os, "windows");
  assert.equal(roundTripped.localShell, "cmd");
  assert.deepEqual(roundTripped.localShellArgs, ["/k", "echo hi"]);
  assert.equal(roundTripped.localShellName, "CMD");
  assert.equal(roundTripped.localShellIcon, "cmd");
  assert.equal(roundTripped.localStartDir, "C:\\Users\\dev");

  const roundTrippedDefault = imported.hosts[1];
  assert.equal(roundTrippedDefault.protocol, "local");
  assert.equal(roundTrippedDefault.os, "windows");
  assert.equal(roundTrippedDefault.localShell, undefined);
  assert.equal(roundTrippedDefault.localStartDir, undefined);
});

const proxyJumpCell = (csv: string, hostname: string): string => {
  const rows = parseCsv(csv.replace(/^\uFEFF/, "")).filter((row) => row.some((cell) => cell.trim() !== ""));
  const header = rows[0] ?? [];
  const jumpIndex = header.indexOf("ProxyJump");
  const hostIndex = header.findIndex((cell) => cell.toLowerCase().includes("hostname"));
  const row = rows.slice(1).find((cells) => cells[hostIndex] === hostname);
  return jumpIndex >= 0 ? (row?.[jumpIndex] ?? "") : "";
};

const chainHost = (id: string, label: string, hostname: string, username: string, port = 22): Host => ({
  ...hostDefaults,
  id,
  label,
  hostname,
  username,
  port,
});

test("CSV export writes one-hop and two-hop ProxyJump chains", () => {
  const bastion = chainHost("jump-1", "Bastion", "bastion.example.com", "alice");
  const second = chainHost("jump-2", "Second hop", "jump.example.com", "bob", 2222);
  const v6 = chainHost("jump-v6", "IPv6 hop", "2001:db8::1", "carol", 2222);
  const oneHop = chainHost("app-1", "One hop", "one.example.com", "root");
  oneHop.hostChain = { hostIds: [bastion.id] };
  const twoHop = chainHost("app-2", "Two hop", "two.example.com", "root");
  twoHop.hostChain = { hostIds: [bastion.id, second.id] };
  const viaV6 = chainHost("app-v6", "Via IPv6", "v6.example.com", "root");
  viaV6.hostChain = { hostIds: [v6.id] };
  const direct = chainHost("app-3", "Direct", "direct.example.com", "root");

  const { csv } = exportHostsToCsvWithStats([bastion, second, v6, oneHop, twoHop, viaV6, direct]);

  assert.equal(proxyJumpCell(csv, bastion.hostname), "");
  assert.equal(proxyJumpCell(csv, oneHop.hostname), "alice@bastion.example.com");
  assert.equal(proxyJumpCell(csv, twoHop.hostname), "alice@bastion.example.com,bob@jump.example.com:2222");
  assert.equal(proxyJumpCell(csv, viaV6.hostname), "carol@[2001:db8::1]:2222");
  assert.equal(proxyJumpCell(csv, direct.hostname), "");
  assert.match(getVaultCsvTemplate().split(/\r?\n/, 1)[0] ?? "", /(^|,)ProxyJump(,|$)/);
});

test("CSV round-trips a jump host chain onto the imported hosts", () => {
  const bastion = chainHost("jump-1", "Bastion", "bastion.example.com", "alice");
  const second = chainHost("jump-2", "Second hop", "jump.example.com", "bob", 2222);
  const target = chainHost("app", "App", "app.example.com", "root");
  target.group = "Prod";
  target.hostChain = { hostIds: [bastion.id, second.id] };

  const { csv } = exportHostsToCsvWithStats([bastion, second, target]);
  const imported = importVaultHostsFromText("csv", csv);
  const byHostname = new Map(imported.hosts.map((host) => [host.hostname, host]));
  const importedTarget = byHostname.get(target.hostname);
  const importedBastion = byHostname.get(bastion.hostname);
  const importedSecond = byHostname.get(second.hostname);

  assert.equal(imported.issues.length, 0);
  assert.deepEqual(importedTarget?.hostChain?.hostIds, [importedBastion?.id, importedSecond?.id]);
  assert.equal(importedBastion?.hostChain, undefined);
  assert.equal(importedSecond?.port, 2222);
  assert.equal(importedSecond?.username, "bob");
});

test("CSV import creates an inline jump host when the hop is not in the file", () => {
  const imported = importVaultHostsFromText("csv", [
    "Hostname,Username,ProxyJump",
    "app.example.com,root,alice@bastion.example.com:2222",
  ].join("\n"));
  const target = imported.hosts.find((host) => host.hostname === "app.example.com");
  const jump = imported.hosts.find((host) => host.hostname === "bastion.example.com");

  assert.equal(imported.hosts.length, 2);
  assert.equal(jump?.username, "alice");
  assert.equal(jump?.port, 2222);
  assert.equal(jump?.protocol, "ssh");
  assert.deepEqual(target?.hostChain?.hostIds, jump ? [jump.id] : []);
  assert.ok(imported.issues.some((issue) => issue.level === "warning" && /inline jump host/i.test(issue.message)));
});

test("CSV import binds a missing hop to an existing vault host by endpoint", () => {
  const existing = chainHost("vault-jump", "Old bastion", "bastion.example.com", "alice", 2222);
  const imported = importVaultHostsFromText("csv", [
    "Hostname,Username,ProxyJump",
    "app.example.com,root,alice@bastion.example.com:2222",
  ].join("\n"), { existingHosts: [existing] });

  assert.equal(imported.hosts.length, 1);
  assert.equal(imported.hosts[0]?.hostname, "app.example.com");
  assert.deepEqual(imported.hosts[0]?.hostChain, { hostIds: [existing.id] });
  assert.deepEqual(imported.issues, []);

  const moved = applyVaultImportDestination(imported, { mode: "group", group: "Moved" });
  assert.deepEqual(moved.hosts[0]?.hostChain, { hostIds: [existing.id] });
});

test("CSV import keeps an old file without a ProxyJump column unchanged", () => {
  const imported = importVaultHostsFromText("csv", [
    "Hostname,Username,Password",
    "legacy.example.com,root,secret",
  ].join("\n"));

  assert.equal(imported.hosts.length, 1);
  assert.equal(imported.hosts[0]?.hostname, "legacy.example.com");
  assert.equal(imported.hosts[0]?.username, "root");
  assert.equal(imported.hosts[0]?.password, "secret");
  assert.equal(imported.hosts[0]?.hostChain, undefined);
  assert.deepEqual(imported.issues, []);
});

test("CSV import retargets a chain when the jump host is already in the vault", () => {
  const bastion = chainHost("jump-1", "Bastion", "bastion.example.com", "alice");
  bastion.group = "Prod";
  const target = chainHost("app", "App", "app.example.com", "root");
  target.group = "Prod";
  target.hostChain = { hostIds: [bastion.id] };
  const existing = chainHost("vault-jump", "Bastion", "bastion.example.com", "alice");
  existing.group = "Prod";

  const { csv } = exportHostsToCsvWithStats([bastion, target]);
  const imported = importVaultHostsFromText("csv", csv, { existingHosts: [existing] });
  const merged = applyVaultHostImport([existing], ["Prod"], imported);

  assert.equal(merged.addedHosts.length, 1);
  assert.equal(merged.addedHosts[0]?.hostname, "app.example.com");
  assert.deepEqual(merged.addedHosts[0]?.hostChain, { hostIds: [existing.id] });
  assert.equal(merged.hosts.some((host) => host.id !== existing.id && host.hostname === bastion.hostname), false);
});

test("CSV export materializes a jump chain inherited from group defaults", () => {
  const bastion = chainHost("jump-1", "Bastion", "bastion.example.com", "alice");
  const target = chainHost("app", "App", "app.example.com", "root");
  target.group = "Corp";

  const { csv } = exportHostsToCsvWithStats([bastion, target], {
    groupConfigs: [{ path: "Corp", hostChain: { hostIds: [bastion.id] } }],
  });

  assert.equal(proxyJumpCell(csv, target.hostname), "alice@bastion.example.com");
});

test("CSV import warns and drops a circular ProxyJump chain", () => {
  const imported = importVaultHostsFromText("csv", [
    "Hostname,Username,ProxyJump",
    "a.example.com,root,b.example.com",
    "b.example.com,root,a.example.com",
  ].join("\n"));

  assert.equal(imported.hosts.length, 2);
  assert.equal(imported.hosts.every((host) => host.hostChain === undefined), true);
  assert.ok(imported.issues.some((issue) => issue.level === "warning" && /circular/i.test(issue.message)));
});

test("CSV import drops inline hops created only for a rejected self-referential ProxyJump", () => {
  const imported = importVaultHostsFromText("csv", [
    "Hostname,Username,ProxyJump",
    "ok.example.com,root,kept-hop.example.com",
    "app.example.com,root,\"new-hop.example.com,app.example.com\"",
  ].join("\n"));

  const hostnames = imported.hosts.map((host) => host.hostname).sort();
  assert.deepEqual(hostnames, ["app.example.com", "kept-hop.example.com", "ok.example.com"]);
  const app = imported.hosts.find((host) => host.hostname === "app.example.com");
  const ok = imported.hosts.find((host) => host.hostname === "ok.example.com");
  const kept = imported.hosts.find((host) => host.hostname === "kept-hop.example.com");
  assert.equal(app?.hostChain, undefined);
  assert.deepEqual(ok?.hostChain?.hostIds, kept ? [kept.id] : []);
  assert.ok(imported.issues.some((issue) => issue.level === "warning" && /circular/i.test(issue.message)));
});

test("CSV import prefers a same-group existing hop over a cross-group imported match", () => {
  const existing = chainHost("vault-jump", "Bastion", "bastion.example.com", "alice");
  existing.group = "Prod";
  const imported = importVaultHostsFromText("csv", [
    "Groups,Hostname,Username,ProxyJump",
    "Other,bastion.example.com,alice,",
    "Prod,app.example.com,root,alice@bastion.example.com",
  ].join("\n"), { existingHosts: [existing] });

  const app = imported.hosts.find((host) => host.hostname === "app.example.com");
  const importedBastion = imported.hosts.find((host) => host.hostname === "bastion.example.com");
  assert.equal(importedBastion?.group, "Other");
  assert.notEqual(importedBastion?.id, existing.id);
  assert.deepEqual(app?.hostChain, { hostIds: [existing.id] });
});

test("CSV import prefers a same-group existing label hop over a cross-group imported label", () => {
  const existing = chainHost("vault-jump", "Bastion", "vault-bastion.internal", "alice");
  existing.group = "Prod";
  const imported = importVaultHostsFromText("csv", [
    "Groups,Label,Hostname,Username,ProxyJump",
    "Other,Bastion,other-bastion.internal,alice,",
    "Prod,App,app.example.com,root,alice@Bastion",
  ].join("\n"), { existingHosts: [existing] });

  const app = imported.hosts.find((host) => host.hostname === "app.example.com");
  const importedBastion = imported.hosts.find((host) => host.hostname === "other-bastion.internal");
  assert.equal(importedBastion?.group, "Other");
  assert.equal(importedBastion?.label, "Bastion");
  assert.notEqual(importedBastion?.id, existing.id);
  assert.deepEqual(app?.hostChain, { hostIds: [existing.id] });
});

test("CSV import warns and ignores a ProxyJump value that is not a jump host", () => {
  const imported = importVaultHostsFromText("csv", [
    "Hostname,Username,ProxyJump",
    "app.example.com,root,not a hop",
  ].join("\n"));

  assert.equal(imported.hosts.length, 1);
  assert.equal(imported.hosts[0]?.hostChain, undefined);
  assert.ok(imported.issues.some((issue) => issue.level === "warning" && issue.message.includes("ProxyJump")));
});

test("CSV import rejects a ProxyJump chain that contains a malformed hop", () => {
  const imported = importVaultHostsFromText("csv", [
    "Hostname,Username,ProxyJump",
    "app.example.com,root,\"bastion.example.com,not a hop\"",
  ].join("\n"));

  assert.deepEqual(imported.hosts.map((host) => host.hostname), ["app.example.com"]);
  assert.equal(imported.hosts[0]?.hostChain, undefined);
  assert.ok(imported.issues.some((issue) => (
    issue.level === "warning" && issue.message.includes("not a hop")
  )));
});

test("CSV import warns and ignores a malformed LocalShell value", () => {
  const csv = [
    "Groups,Label,Tags,Notes,Hostname/IP,Protocol,Port,Username,Password,KeyPath,Passphrase,Proxy,LocalShell",
    ',"Bad local shell",,,localhost,local,22,,,,,,"not json"',
  ].join("\r\n");

  const imported = importVaultHostsFromText("csv", csv);
  assert.equal(imported.hosts.length, 1);
  assert.equal(imported.hosts[0]?.localShell, undefined);
  assert.ok(imported.issues.some((issue) => issue.message.includes("row 2") && issue.message.includes("LocalShell")));
});


test("CSV export/import preserves independent SSH input compatibility choices", () => {
  const hosts: Host[] = [false, true].map((choice, index) => ({
    ...hostDefaults, id: `mode-${index}`, label: `Mode ${index}`,
    hostname: `mode-${index}.example.test`, protocol: "ssh", sshInputCompatibility: choice,
  }));
  const { csv } = exportHostsToCsvWithStats(hosts);
  const imported = importVaultHostsFromText("csv", csv);
  assert.deepEqual(imported.hosts.map(host => host.sshInputCompatibility), [false, true]);
  const second = importVaultHostsFromText("csv", exportHostsToCsvWithStats(imported.hosts).csv);
  assert.deepEqual(second.hosts.map(host => host.sshInputCompatibility), [false, true]);
});
