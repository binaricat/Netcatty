import test from "node:test";
import assert from "node:assert/strict";
import { createCipheriv, createHash } from "node:crypto";

import {
  importVaultHostsFromText,
  detectVaultImportFormat,
  applyVaultHostImport,
  applyVaultImportDestination,
  filterVaultImportKeyPassphrasesAgainstExisting,
  resolveVaultImportKeyPassphraseConflicts,
} from "./vaultImport.ts";
import { encodeCsvPassphrase } from "./vaultImport/csvCredentialFields.ts";
import type { Host } from "./models.ts";

const mobaXtermSshSession = (
  hostname: string,
  port = 22,
  username = "root",
) => `#109#0%${hostname}%${port}%${username}%%-1%-1%%%%%0%0%0%%%-1%0%0%0%%1080%%0%0%1%#MobaFont%10%0%0%-1#0# #-1`;

test("ssh_config import maps ForwardX11 yes to host X11 forwarding", () => {
  const result = importVaultHostsFromText("ssh_config", [
    "Host x11-host",
    "  HostName x11.example.com",
    "  User root",
    "  ForwardX11 yes",
  ].join("\n"));

  assert.equal(result.hosts.length, 1);
  assert.equal(result.hosts[0].x11Forwarding, true);
});

test("ssh_config import maps ForwardX11 no to disabled host X11 forwarding", () => {
  const result = importVaultHostsFromText("ssh_config", [
    "Host no-x11-host",
    "  HostName no-x11.example.com",
    "  User root",
    "  ForwardX11 no",
  ].join("\n"));

  assert.equal(result.hosts.length, 1);
  assert.equal(result.hosts[0].x11Forwarding, false);
});

test("ssh_config import enables agent login for the macOS Keychain pattern", () => {
  const result = importVaultHostsFromText("ssh_config", [
    "Host aws-sg",
    "  HostName 1.1.1.1",
    "  Port 2222",
    "  User root",
    "  AddKeysToAgent yes",
    "  UseKeychain yes",
    "  IdentityFile ~/.ssh/aws_root",
    "  IdentitiesOnly yes",
  ].join("\n"));

  assert.equal(result.hosts.length, 1);
  assert.deepEqual(
    {
      label: result.hosts[0].label,
      hostname: result.hosts[0].hostname,
      port: result.hosts[0].port,
      username: result.hosts[0].username,
      identityFilePaths: result.hosts[0].identityFilePaths,
      useSshAgent: result.hosts[0].useSshAgent,
      identityAgent: result.hosts[0].identityAgent,
      identitiesOnly: result.hosts[0].identitiesOnly,
      addKeysToAgent: result.hosts[0].addKeysToAgent,
      useKeychain: result.hosts[0].useKeychain,
    },
    {
      label: "aws-sg",
      hostname: "1.1.1.1",
      port: 2222,
      username: "root",
      identityFilePaths: ["~/.ssh/aws_root"],
      useSshAgent: true,
      identityAgent: undefined,
      identitiesOnly: true,
      addKeysToAgent: "yes",
      useKeychain: true,
    },
  );
});

test("ssh_config AddKeysToAgent does not enable agent login when IdentityAgent is none", () => {
  const result = importVaultHostsFromText("ssh_config", [
    "Host local-key-only",
    "  HostName server.example.com",
    "  IdentityAgent none",
    "  AddKeysToAgent yes",
    "  IdentityFile ~/.ssh/id_ed25519",
  ].join("\n"));

  assert.equal(result.hosts.length, 1);
  assert.equal(result.hosts[0].identityAgent, "none");
  assert.equal(result.hosts[0].useSshAgent, false);
});

test("ssh_config AddKeysToAgent alone preserves direct-key authentication", () => {
  const result = importVaultHostsFromText("ssh_config", [
    "Host direct-key-host",
    "  HostName server.example.com",
    "  AddKeysToAgent yes",
    "  IdentityFile ~/.ssh/id_ed25519",
  ].join("\n"));

  assert.equal(result.hosts.length, 1);
  assert.equal(result.hosts[0].addKeysToAgent, "yes");
  assert.notEqual(result.hosts[0].useSshAgent, true);
});

test("ssh_config IdentityAgent enables system agent authentication", () => {
  const result = importVaultHostsFromText("ssh_config", [
    "Host agent-host",
    "  HostName server.example.com",
    "  IdentityAgent $SSH_AUTH_SOCK",
    "  IdentityFile ~/.ssh/id_ed25519",
  ].join("\n"));

  assert.equal(result.hosts.length, 1);
  assert.equal(result.hosts[0].identityAgent, "$SSH_AUTH_SOCK");
  assert.equal(result.hosts[0].useSshAgent, true);
});

test("detectVaultImportFormat recognizes csv and ssh_config exports", () => {
  assert.equal(
    detectVaultImportFormat("Label,Hostname,Port,Username\nweb,10.0.0.1,22,root"),
    "csv",
  );
  assert.equal(
    detectVaultImportFormat(["Host prod", "  HostName prod.example.com", "  User deploy"].join("\n")),
    "ssh_config",
  );
});

test("SecureCRT import reads the protocol-specific hexadecimal port", () => {
  const result = importVaultHostsFromText("securecrt", [
    'S:"Hostname"=secure.example.com',
    'S:"Username"=operator',
    'S:"Protocol Name"=SSH2',
    'D:"[SSH2] Port"=000008ae',
  ].join("\n"), { fileName: "Secure Host.ini" });

  assert.equal(result.hosts.length, 1);
  assert.equal(result.hosts[0].label, "Secure Host");
  assert.equal(result.hosts[0].port, 2222);
});

test("SecureCRT import selects the port field for the configured SSH version", () => {
  const ssh2 = importVaultHostsFromText("securecrt", [
    'S:"Hostname"=ssh2.example.com',
    'S:"Protocol Name"=SSH2',
    'D:"[SSH2] Port"=000008ae',
    'D:"[SSH1] Port"=00000017',
  ].join("\n"));
  const ssh1 = importVaultHostsFromText("securecrt", [
    'S:"Hostname"=ssh1.example.com',
    'S:"Protocol Name"=SSH1',
    'D:"[SSH1] Port"=000008af',
    'D:"[SSH2] Port"=00000016',
  ].join("\n"));

  assert.equal(ssh2.hosts[0]?.port, 2222);
  assert.equal(ssh1.hosts[0]?.port, 2223);
});

test("vault import can place every imported host into one selected group", () => {
  const imported = importVaultHostsFromText("csv", [
    "Label,Hostname,Group",
    "web,web.example.com,Production/Web",
    "db,db.example.com,Production/DB",
  ].join("\n"));

  const targeted = applyVaultImportDestination(imported, {
    mode: "group",
    group: "Imported/July",
  });

  assert.deepEqual(targeted.hosts.map((host) => host.group), [
    "Imported/July",
    "Imported/July",
  ]);
  assert.deepEqual(targeted.groups, ["Imported/July"]);
  assert.deepEqual(imported.groups, ["Production/Web", "Production/DB"]);
});

test("applyVaultImportDestination re-dedupes same-endpoint hosts collapsed into one group", () => {
  const imported = importVaultHostsFromText("csv", [
    "Groups,Label,Hostname,Port,Username",
    "lan,direct,10.10.10.10,22,root",
    "lan-proxy,via-socks,10.10.10.10,22,root",
  ].join("\n"));

  assert.equal(imported.hosts.length, 2);

  const targeted = applyVaultImportDestination(imported, {
    mode: "group",
    group: "Imported/July",
  });

  assert.equal(targeted.hosts.length, 1);
  assert.equal(targeted.hosts[0]?.group, "Imported/July");
  assert.equal(targeted.stats.duplicates, 1);
  assert.equal(targeted.stats.imported, 1);
  assert.deepEqual(targeted.groups, ["Imported/July"]);

  const merged = applyVaultHostImport([], [], targeted);
  assert.equal(merged.addedCount, 1);
  assert.equal(merged.hosts.length, 1);
});

test("applyVaultImportDestination remaps a shared key passphrase onto the retained host", () => {
  const imported = importVaultHostsFromText("csv", [
    "Groups,Label,Hostname,Port,Username,KeyPath,Passphrase",
    "lan,direct,10.10.10.10,22,root,~/.ssh/id_ed25519,",
    "lan-proxy,via-socks,10.10.10.10,22,root,~/.ssh/id_ed25519,secret",
  ].join("\n"));

  assert.equal(imported.hosts.length, 2);

  const targeted = applyVaultImportDestination(imported, {
    mode: "group",
    group: "Imported/July",
  });

  assert.equal(targeted.hosts.length, 1);
  assert.deepEqual(targeted.hosts[0]?.identityFilePaths, ["~/.ssh/id_ed25519"]);
  assert.deepEqual(targeted.keyPassphrases, [{
    hostId: targeted.hosts[0]?.id,
    keyPath: "~/.ssh/id_ed25519",
    passphrase: "secret",
  }]);
});

test("applyVaultImportDestination does not attach a passphrase for a non-retained key", () => {
  const imported = importVaultHostsFromText("csv", [
    "Groups,Label,Hostname,Port,Username,KeyPath,Passphrase",
    "lan,direct,10.10.10.10,22,root,~/.ssh/id_first,first",
    "lan-proxy,via-socks,10.10.10.10,22,root,~/.ssh/id_second,second",
  ].join("\n"));

  const targeted = applyVaultImportDestination(imported, {
    mode: "group",
    group: "Imported/July",
  });

  assert.equal(targeted.hosts.length, 1);
  assert.deepEqual(targeted.hosts[0]?.identityFilePaths, ["~/.ssh/id_first"]);
  assert.deepEqual(targeted.keyPassphrases, [{
    hostId: targeted.hosts[0]?.id,
    keyPath: "~/.ssh/id_first",
    passphrase: "first",
  }]);
});

test("applyVaultImportDestination can keep same-endpoint hosts when collapse is disabled", () => {
  const imported = importVaultHostsFromText("csv", [
    "Groups,Label,Hostname,Port,Username",
    "Prod,web-a,shared.example.com,22,root",
    "Staging,web-b,shared.example.com,22,root",
  ].join("\n"));

  assert.equal(imported.hosts.length, 2);

  const targeted = applyVaultImportDestination(
    imported,
    { mode: "group", group: "Imported/SecureCRT" },
    { collapseDuplicateEndpoints: false },
  );

  assert.equal(targeted.hosts.length, 2);
  assert.deepEqual(targeted.hosts.map((host) => host.group), [
    "Imported/SecureCRT",
    "Imported/SecureCRT",
  ]);
  assert.equal(targeted.stats.duplicates, 0);
  assert.equal(targeted.stats.imported, 2);
});

test("applyVaultImportDestination can skip collapse for selected hosts", () => {
  const imported = importVaultHostsFromText("csv", [
    "Groups,Label,Hostname,Port,Username",
    "lan,direct,10.10.10.10,22,root",
    "lan-proxy,via-socks,10.10.10.10,22,root",
  ].join("\n"));
  const withPluginFlag = {
    ...imported,
    hosts: imported.hosts.map((host, index) => (
      index === 0
        ? host
        : {
            ...host,
            pluginConnection: {
              providerId: "com.example.transport.connection",
              configuration: { endpoint: "via-socks" },
            },
          }
    )),
  };

  const targeted = applyVaultImportDestination(
    withPluginFlag,
    { mode: "group", group: "Imported/Plugin" },
    { isCollapsible: (host) => !host.pluginConnection },
  );

  assert.equal(targeted.hosts.length, 2);
  assert.deepEqual(targeted.hosts.map((host) => host.group), [
    "Imported/Plugin",
    "Imported/Plugin",
  ]);
});

test("applyVaultImportDestination merges referenced credentials onto the retained host", () => {
  const imported = importVaultHostsFromText("csv", [
    "Groups,Label,Hostname,Port,Username",
    "lan,direct,10.10.10.10,22,root",
    "lan-proxy,via-socks,10.10.10.10,22,root",
  ].join("\n"));
  const [first, second] = imported.hosts;
  assert.ok(first && second);
  const withRefs = {
    ...imported,
    hosts: [
      { ...first, identityId: undefined, identityFileId: undefined },
      { ...second, identityId: "identity-1", identityFileId: "key-1" },
    ],
  };

  const targeted = applyVaultImportDestination(withRefs, {
    mode: "group",
    group: "Imported/July",
  });

  assert.equal(targeted.hosts.length, 1);
  assert.equal(targeted.hosts[0]?.identityId, "identity-1");
  assert.equal(targeted.hosts[0]?.identityFileId, "key-1");
});

test("applyVaultImportDestination does not override retained key auth with identity refs", () => {
  const imported = importVaultHostsFromText("csv", [
    "Groups,Label,Hostname,Port,Username,KeyPath",
    "lan,direct,10.10.10.10,22,root,~/.ssh/id_ed25519",
    "lan-proxy,via-socks,10.10.10.10,22,root,",
  ].join("\n"));
  const [first, second] = imported.hosts;
  assert.ok(first && second);
  const withRefs = {
    ...imported,
    hosts: [
      first,
      { ...second, identityId: "identity-1" },
    ],
  };

  const targeted = applyVaultImportDestination(withRefs, {
    mode: "group",
    group: "Imported/July",
  });

  assert.equal(targeted.hosts.length, 1);
  assert.deepEqual(targeted.hosts[0]?.identityFilePaths, ["~/.ssh/id_ed25519"]);
  assert.equal(targeted.hosts[0]?.identityId, undefined);
});

test("CSV import keeps working when KeyPath and Passphrase columns are absent", () => {
  const result = importVaultHostsFromText(
    "csv",
    "Label,Hostname,Port,Username,Password\nlegacy,legacy.example.com,22,root,secret",
  );

  assert.equal(result.hosts.length, 1);
  assert.equal(result.hosts[0]?.password, "secret");
  assert.deepEqual(result.keyPassphrases, []);
});

test("CSV import preserves legacy Passphrase login-password columns without KeyPath", () => {
  const result = importVaultHostsFromText(
    "csv",
    "Hostname,Username,Passphrase\nlegacy.example.com,root,login-secret",
  );

  assert.equal(result.hosts[0]?.password, "login-secret");
  assert.deepEqual(result.keyPassphrases, []);
  assert.deepEqual(result.issues, []);
});

test("CSV import preserves annotated legacy login-password columns", () => {
  for (const header of [
    "Password (optional)",
    "Password_Value",
    "Passphrase (optional)",
    "Passphrase_Value",
    "Pass (optional)",
    "Passcode",
  ]) {
    const result = importVaultHostsFromText(
      "csv",
      `Hostname,Username,${header}\nlegacy.example.com,root,login-secret`,
    );

    assert.equal(result.hosts[0]?.password, "login-secret");
  }
});

test("CSV import prefers an explicit Password column over legacy Passphrase", () => {
  const result = importVaultHostsFromText(
    "csv",
    "Hostname,Username,Password,Passphrase\nlegacy.example.com,root,login-secret,legacy-fallback",
  );

  assert.equal(result.hosts[0]?.password, "login-secret");
  assert.deepEqual(result.keyPassphrases, []);
});

test("CSV import does not treat descriptive headers as key credentials", () => {
  const result = importVaultHostsFromText(
    "csv",
    "Hostname,KeyPathDescription,PassphraseHint\nhost.example.com,documentation,NOT_A_SECRET",
  );

  assert.equal(result.hosts[0]?.identityFilePaths, undefined);
  assert.equal(result.hosts[0]?.password, undefined);
  assert.deepEqual(result.keyPassphrases, []);
});

test("CSV import ignores a passphrase without a key path", () => {
  const result = importVaultHostsFromText(
    "csv",
    "Label,Hostname,KeyPath,Passphrase\nbroken,broken.example.com,,secret",
  );

  assert.equal(result.hosts.length, 1);
  assert.equal(result.hosts[0]?.password, undefined);
  assert.deepEqual(result.keyPassphrases, []);
  assert.match(result.issues[0]?.message ?? "", /KeyPath is empty/u);
});

test("CSV import rejects encrypted passphrase placeholders", () => {
  const placeholder = "enc:v1:djEwYWJjAAAAAAAAAAAAAAAAAA==";
  for (const value of [placeholder, encodeCsvPassphrase(placeholder)]) {
    const result = importVaultHostsFromText(
      "csv",
      `Hostname,KeyPath,Passphrase\nhost.example.com,~/.ssh/id_ed25519,${value}`,
    );

    assert.deepEqual(result.keyPassphrases, []);
    assert.match(result.issues[0]?.message ?? "", /encrypted credential values/u);
  }
});

test("CSV duplicate rows merge later key credentials into the retained host", () => {
  const result = importVaultHostsFromText(
    "csv",
    [
      "Label,Hostname,Username,KeyPath,Passphrase",
      "first,duplicate.example.com,root,,",
      "second,duplicate.example.com,root,~/.ssh/id_ed25519,secret",
    ].join("\n"),
  );

  assert.equal(result.hosts.length, 1);
  assert.deepEqual(result.hosts[0]?.identityFilePaths, ["~/.ssh/id_ed25519"]);
  assert.deepEqual(result.keyPassphrases, [{
    hostId: result.hosts[0]?.id,
    keyPath: "~/.ssh/id_ed25519",
    passphrase: "secret",
  }]);
});

test("CSV duplicate rows never attach a passphrase for a different retained key", () => {
  const result = importVaultHostsFromText(
    "csv",
    [
      "Label,Hostname,Username,KeyPath,Passphrase",
      "first,duplicate.example.com,root,~/.ssh/id_first,",
      "second,duplicate.example.com,root,~/.ssh/id_second,secret",
    ].join("\n"),
  );

  assert.deepEqual(result.hosts[0]?.identityFilePaths, ["~/.ssh/id_first"]);
  assert.deepEqual(result.keyPassphrases, []);
});

test("CSV duplicate rows preserve alias candidates for conflict resolution", async () => {
  const result = importVaultHostsFromText(
    "csv",
    [
      "Label,Hostname,Username,KeyPath,Passphrase",
      "first,duplicate.example.com,root,~/.ssh/shared,first-secret",
      "second,duplicate.example.com,root,/Users/alice/.ssh/shared,second-secret",
    ].join("\n"),
  );
  const host = result.hosts[0];
  assert.ok(host);
  const resolved = await resolveVaultImportKeyPassphraseConflicts(
    result.keyPassphraseCandidates ?? [],
    async (keyPath) => (
      keyPath.startsWith("~/")
        ? [keyPath, `/Users/alice/${keyPath.slice(2)}`]
        : [keyPath, `~/${keyPath.slice("/Users/alice/".length)}`]
    ),
    new Set([host.id]),
    new Map([[host.id, "~/.ssh/shared"]]),
  );

  assert.equal(result.keyPassphraseCandidates?.length, 2);
  assert.deepEqual(resolved.keyPassphrases, []);
  assert.match(resolved.issues[0]?.message ?? "", /conflicting passphrases/u);
});

test("CSV duplicate rows do not save candidates for a different retained key", async () => {
  const result = importVaultHostsFromText(
    "csv",
    [
      "Label,Hostname,Username,KeyPath,Passphrase",
      "first,duplicate.example.com,root,~/.ssh/id_first,",
      "second,duplicate.example.com,root,~/.ssh/id_second,secret",
    ].join("\n"),
  );
  const host = result.hosts[0];
  assert.ok(host);
  const resolved = await resolveVaultImportKeyPassphraseConflicts(
    result.keyPassphraseCandidates ?? [],
    async (keyPath) => [keyPath],
    new Set([host.id]),
    new Map([[host.id, "~/.ssh/id_first"]]),
  );

  assert.deepEqual(resolved.keyPassphrases, []);
  assert.deepEqual(resolved.issues, []);
});

test("CSV import rejects conflicting passphrases for a shared key path", () => {
  const result = importVaultHostsFromText(
    "csv",
    [
      "Label,Hostname,Username,KeyPath,Passphrase",
      "first,first.example.com,root,~/.ssh/id_shared,first-secret",
      "second,second.example.com,root,~/.ssh/id_shared,second-secret",
    ].join("\n"),
  );

  assert.equal(result.hosts.length, 2);
  assert.deepEqual(result.keyPassphrases, []);
  assert.equal(result.keyPassphraseCandidates?.length, 2);
  assert.match(result.issues[0]?.message ?? "", /conflicting passphrases/u);
});

test("CSV alias conflict resolution sees candidates rejected by exact-path checks", async () => {
  const result = importVaultHostsFromText(
    "csv",
    [
      "Label,Hostname,Username,KeyPath,Passphrase",
      "one,one.example.com,root,~/.ssh/shared,one",
      "two,two.example.com,root,~/.ssh/shared,two",
      "three,three.example.com,root,/Users/alice/.ssh/shared,three",
    ].join("\n"),
  );
  const resolved = await resolveVaultImportKeyPassphraseConflicts(
    result.keyPassphraseCandidates ?? [],
    async (keyPath) => (
      keyPath.startsWith("~/")
        ? [keyPath, `/Users/alice/${keyPath.slice(2)}`]
        : [keyPath, `~/${keyPath.slice("/Users/alice/".length)}`]
    ),
  );

  assert.deepEqual(resolved.keyPassphrases, []);
  assert.match(resolved.issues[0]?.message ?? "", /conflicting passphrases/u);
});

test("CSV import keeps POSIX backslashes distinct from path separators", () => {
  const result = importVaultHostsFromText(
    "csv",
    [
      "Label,Hostname,Username,KeyPath,Passphrase",
      "first,first.example.com,root,/home/alice/.ssh/team\\key,first-secret",
      "second,second.example.com,root,/home/alice/.ssh/team/key,second-secret",
    ].join("\n"),
  );

  assert.equal(result.hosts.length, 2);
  assert.deepEqual(result.keyPassphrases?.map((entry) => entry.passphrase), [
    "first-secret",
    "second-secret",
  ]);
  assert.equal(result.issues.some((issue) => /conflicting passphrases/u.test(issue.message)), false);
});

test("CSV passphrase conflicts include home-relative path aliases", async () => {
  const resolved = await resolveVaultImportKeyPassphraseConflicts([
    { hostId: "first", keyPath: "~/.ssh/shared", passphrase: "first-secret" },
    { hostId: "second", keyPath: "/Users/alice/.ssh/shared", passphrase: "second-secret" },
  ], async (keyPath) => (
    keyPath.startsWith("~/")
      ? [keyPath, `/Users/alice/${keyPath.slice(2)}`]
      : [keyPath, `~/${keyPath.slice("/Users/alice/".length)}`]
  ));

  assert.deepEqual(resolved.keyPassphrases, []);
  assert.match(resolved.issues[0]?.message ?? "", /conflicting passphrases/u);
});

test("CSV import keeps an existing saved passphrase on mismatch", async () => {
  const entry = {
    hostId: "new-host",
    keyPath: "~/.ssh/shared",
    passphrase: "stale-import",
  };
  const checked = await filterVaultImportKeyPassphrasesAgainstExisting(
    [entry],
    async () => ({ values: ["current-saved"], unreadable: false }),
  );

  assert.deepEqual(checked.keyPassphrases, []);
  assert.match(checked.issues[0]?.message ?? "", /existing saved passphrase/u);
});

test("CSV import does not replace an unreadable saved passphrase", async () => {
  const checked = await filterVaultImportKeyPassphrasesAgainstExisting(
    [{ hostId: "new-host", keyPath: "~/.ssh/shared", passphrase: "imported" }],
    async () => ({ values: [], unreadable: true }),
  );

  assert.deepEqual(checked.keyPassphrases, []);
  assert.match(checked.issues[0]?.message ?? "", /Could not verify/u);
});

test("detectVaultImportFormat recognizes MobaXterm bookmark exports", () => {
  assert.equal(
    detectVaultImportFormat([
      "[Bookmarks]",
      "SubRep=",
      "ImgNum=42",
      `server=${mobaXtermSshSession("10.0.0.1")}`,
    ].join("\n")),
    "mobaxterm",
  );
  assert.equal(
    detectVaultImportFormat([
      "[Bookmarks_1]",
      "SubRep=Production",
      "ImgNum=41",
      `server=${mobaXtermSshSession("10.0.0.1")}`,
    ].join("\n")),
    "mobaxterm",
  );
});

test("detectVaultImportFormat does not treat generic bookmark INI sections as MobaXterm", () => {
  assert.equal(
    detectVaultImportFormat([
      "[Bookmarks]",
      "home=https://example.com",
    ].join("\n")),
    null,
  );
});

test("MobaXterm import reads standard session fields and bookmark groups", () => {
  const result = importVaultHostsFromText("mobaxterm", [
    "[Bookmarks]",
    "SubRep=",
    "ImgNum=42",
    `root-server=${mobaXtermSshSession("root.example.com", 22, "<default>")}`,
    "",
    "[Bookmarks_1]",
    "SubRep=Production\\Linux",
    "ImgNum=41",
    `web-server=${mobaXtermSshSession("10.0.0.20", 2222, "deploy")}`,
  ].join("\n"));

  assert.deepEqual(result.stats, {
    parsed: 2,
    imported: 2,
    skipped: 0,
    duplicates: 0,
  });
  assert.deepEqual(
    result.hosts.map(({ label, hostname, port, username, group, protocol }) => ({
      label,
      hostname,
      port,
      username,
      group,
      protocol,
    })),
    [
      {
        label: "root-server",
        hostname: "root.example.com",
        port: 22,
        username: "",
        group: undefined,
        protocol: "ssh",
      },
      {
        label: "web-server",
        hostname: "10.0.0.20",
        port: 2222,
        username: "deploy",
        group: "Production/Linux",
        protocol: "ssh",
      },
    ],
  );
  assert.deepEqual(result.groups, ["Production/Linux"]);
});

test("MobaXterm import does not mistake icon metadata for duplicate hosts", () => {
  const sessions = Array.from(
    { length: 40 },
    (_, index) => `host-${index + 1}=${mobaXtermSshSession(`10.0.0.${index + 1}`)}`,
  );
  const result = importVaultHostsFromText("mobaxterm", [
    "[Bookmarks]",
    "SubRep=",
    "ImgNum=42",
    ...sessions,
  ].join("\n"));

  assert.deepEqual(result.stats, {
    parsed: 40,
    imported: 40,
    skipped: 0,
    duplicates: 0,
  });
  assert.equal(result.hosts[0].hostname, "10.0.0.1");
  assert.equal(result.hosts[39].hostname, "10.0.0.40");
});

test("MobaXterm import preserves path-based groups when SubRep is absent", () => {
  const result = importVaultHostsFromText("mobaxterm", [
    "[Bookmarks]",
    "Legacy\\server=deploy@legacy.example.com:2222#ssh",
  ].join("\n"));

  assert.deepEqual(result.stats, {
    parsed: 1,
    imported: 1,
    skipped: 0,
    duplicates: 0,
  });
  assert.equal(result.hosts[0].label, "server");
  assert.equal(result.hosts[0].group, "Legacy");
  assert.equal(result.hosts[0].hostname, "legacy.example.com");
  assert.equal(result.hosts[0].port, 2222);
  assert.equal(result.hosts[0].username, "deploy");
});

test("MobaXterm import handles incomplete standard session records safely", () => {
  const result = importVaultHostsFromText("mobaxterm", [
    "[Bookmarks]",
    "SubRep=",
    "ImgNum=42",
    "short=#109#0%short.example.com",
    "missing-host=#109#0",
    "missing-type=#109#",
    "unsupported=#91#4",
  ].join("\n"));

  assert.deepEqual(result.stats, {
    parsed: 4,
    imported: 1,
    skipped: 3,
    duplicates: 0,
  });
  assert.equal(result.hosts[0].hostname, "short.example.com");
  assert.equal(result.hosts[0].port, 22);
  assert.equal(result.hosts[0].label, "short");
  assert.equal(result.issues.length, 3);
});

test("MobaXterm import attaches master-password secrets from a full config export", () => {
  const result = importVaultHostsFromText("mobaxterm", [
    "[Misc]",
    "SessionP=165821882556840",
    "[Sesspass]",
    "Administrator@WIN=dummy",
    "[Passwords]",
    "deploy@10.0.0.20=1du11XKQBOxud/FWh4ouWA==",
    "[Credentials]",
    "prod=root:0XROpGmLAYVx",
    "[Bookmarks]",
    "SubRep=",
    "ImgNum=42",
    `web-server=${mobaXtermSshSession("10.0.0.20", 2222, "deploy")}`,
    `root-server=${mobaXtermSshSession("root.example.com", 22, "root")}`,
  ].join("\n"), { masterPassword: "12345678" });

  assert.equal(result.hosts.length, 2);
  const web = result.hosts.find((host) => host.label === "web-server");
  const root = result.hosts.find((host) => host.label === "root-server");
  assert.equal(web?.password, "Lw3+cZ2s.w@U@f]U");
  assert.equal(web?.savePassword, true);
  assert.equal(root?.password, "HyperSine");
});

test("MobaXterm import does not save garbage passwords for a wrong master password", () => {
  const source = [
    "[Misc]",
    "SessionP=165821882556840",
    "[Sesspass]",
    "Administrator@WIN=dummy",
    "[Passwords]",
    "deploy@10.0.0.20=1du11XKQBOxud/FWh4ouWA==",
    "[Credentials]",
    "prod=root:0XROpGmLAYVx",
    "[Bookmarks]",
    "SubRep=",
    "ImgNum=42",
    `web-server=${mobaXtermSshSession("10.0.0.20", 2222, "deploy")}`,
    `root-server=${mobaXtermSshSession("root.example.com", 22, "root")}`,
  ].join("\n");

  for (const masterPassword of ["wrong0", "wrong25", "wrong-password"]) {
    const result = importVaultHostsFromText("mobaxterm", source, { masterPassword });
    assert.equal(result.hosts.length, 2, masterPassword);
    assert.equal(result.hosts.every((host) => host.password === undefined), true, masterPassword);
    assert.match(result.issues[0]?.message ?? "", /master password/i, masterPassword);
  }
});

test("MobaXterm import does not save a truncated UTF-8 prefix from a lone credential", () => {
  const result = importVaultHostsFromText("mobaxterm", [
    "[Sesspass]",
    "Administrator@WIN=dummy",
    "[Credentials]",
    "prod=root:0XROpGmLAYVx",
    "[Bookmarks]",
    "SubRep=",
    "ImgNum=42",
    `root-server=${mobaXtermSshSession("root.example.com", 22, "root")}`,
  ].join("\n"), { masterPassword: "wrong25" });

  assert.equal(result.hosts.length, 1);
  assert.equal(result.hosts[0].password, undefined);
  assert.match(result.issues[0]?.message ?? "", /master password/i);
});

test("MobaXterm import keeps leading whitespace in the master password", () => {
  const masterPassword = " 12345678";
  const key = createHash("sha512").update(masterPassword, "utf8").digest().subarray(0, 32);
  const iv = createCipheriv("aes-256-ecb", key, null).update(Buffer.alloc(16));
  const cipher = createCipheriv("aes-256-cfb8", key, iv);
  cipher.setAutoPadding(false);
  const ciphertext = Buffer.concat([
    cipher.update("spaced-secret", "utf8"),
    cipher.final(),
  ]).toString("base64");

  const result = importVaultHostsFromText("mobaxterm", [
    "[Sesspass]",
    "Administrator@WIN=dummy",
    "[Passwords]",
    `deploy@10.0.0.20=${ciphertext}`,
    "[Bookmarks]",
    "SubRep=",
    "ImgNum=42",
    `web-server=${mobaXtermSshSession("10.0.0.20", 2222, "deploy")}`,
  ].join("\n"), { masterPassword });

  assert.equal(result.hosts[0]?.password, "spaced-secret");
  assert.equal(result.hosts[0]?.savePassword, true);
});

test("MobaXterm import leaves sessions intact when encrypted passwords need a master password", () => {
  const result = importVaultHostsFromText("mobaxterm", [
    "[Sesspass]",
    "Administrator@WIN=dummy",
    "[Passwords]",
    "deploy@10.0.0.20=1du11XKQBOxud/FWh4ouWA==",
    "[Bookmarks]",
    "SubRep=",
    "ImgNum=42",
    `web-server=${mobaXtermSshSession("10.0.0.20", 2222, "deploy")}`,
  ].join("\n"));

  assert.equal(result.hosts.length, 1);
  assert.equal(result.hosts[0].password, undefined);
  assert.match(result.issues[0]?.message ?? "", /master password/i);
});

test("detectVaultImportFormat recognizes full MobaXterm configuration exports", () => {
  assert.equal(
    detectVaultImportFormat([
      "[Misc]",
      "SessionP=165821882556840",
      "[Passwords]",
      "deploy@10.0.0.20=1du11XKQBOxud/FWh4ouWA==",
      "[Bookmarks]",
      "SubRep=",
      "ImgNum=42",
      `server=${mobaXtermSshSession("10.0.0.1")}`,
    ].join("\n")),
    "mobaxterm",
  );
});

test("applyVaultHostImport skips duplicates by default", () => {
  const existing: Host = {
    id: "existing-1",
    label: "web",
    hostname: "10.0.0.10",
    username: "deploy",
    port: 22,
  };
  const imported = importVaultHostsFromText("csv", [
    "Label,Hostname,Port,Username",
    "web-1,10.0.0.10,22,deploy",
    "db-1,10.0.0.20,22,root",
  ].join("\n"));

  const merged = applyVaultHostImport([existing], [], imported);
  assert.equal(merged.addedCount, 1);
  assert.equal(merged.skippedExistingCount, 1);
  assert.equal(merged.hosts.length, 2);
});

test("CSV import keeps same-endpoint rows that use different groups", () => {
  const result = importVaultHostsFromText(
    "csv",
    [
      "Groups,Label,Hostname,Port,Username",
      "lan,direct,10.10.10.10,22,root",
      "lan-proxy,via-socks,10.10.10.10,22,root",
    ].join("\n"),
  );

  assert.equal(result.hosts.length, 2);
  assert.equal(result.stats.duplicates, 0);
  assert.deepEqual(
    result.hosts.map((host) => host.group).sort(),
    ["lan", "lan-proxy"],
  );
});

test("applyVaultHostImport keeps same-endpoint hosts when the group differs", () => {
  const existing: Host = {
    id: "existing-1",
    label: "direct",
    hostname: "10.10.10.10",
    username: "root",
    port: 22,
    group: "lan",
  };
  const imported = importVaultHostsFromText("csv", [
    "Groups,Label,Hostname,Port,Username",
    "lan-proxy,via-socks,10.10.10.10,22,root",
  ].join("\n"));
  const targeted = applyVaultImportDestination(imported, {
    mode: "group",
    group: "lan-proxy",
  });

  const merged = applyVaultHostImport([existing], ["lan"], targeted);
  assert.equal(merged.addedCount, 1);
  assert.equal(merged.skippedExistingCount, 0);
  assert.equal(merged.hosts.length, 2);
  assert.equal(merged.addedHosts[0]?.group, "lan-proxy");
});

test("applyVaultHostImport still skips same-endpoint hosts in the same group", () => {
  const existing: Host = {
    id: "existing-1",
    label: "direct",
    hostname: "10.10.10.10",
    username: "root",
    port: 22,
    group: "lan",
  };
  const imported = importVaultHostsFromText("csv", [
    "Groups,Label,Hostname,Port,Username",
    "lan,copy,10.10.10.10,22,root",
  ].join("\n"));

  const merged = applyVaultHostImport([existing], ["lan"], imported);
  assert.equal(merged.addedCount, 0);
  assert.equal(merged.skippedExistingCount, 1);
  assert.equal(merged.hosts.length, 1);
});

test("applyVaultHostImport can preserve distinct sessions with the same endpoint", () => {
  const existing: Host = {
    id: "existing-1",
    label: "Existing session",
    hostname: "shared.example.com",
    username: "deploy",
    port: 22,
    tags: [],
    os: "linux",
  };
  const importedHosts: Host[] = ["Session A", "Session B"].map((label, index) => ({
    ...existing,
    id: `imported-${index}`,
    label,
  }));
  const imported = {
    hosts: importedHosts,
    groups: [],
    issues: [],
    stats: { parsed: 2, imported: 2, skipped: 0, duplicates: 0 },
  };

  const merged = applyVaultHostImport([existing], [], imported, { skipDuplicates: false });
  assert.equal(merged.addedCount, 2);
  assert.equal(merged.skippedExistingCount, 0);
  assert.equal(merged.hosts.length, 3);
});
