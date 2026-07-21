import test from "node:test";
import assert from "node:assert/strict";

import {
  importVaultHostsFromText,
  detectVaultImportFormat,
  applyVaultHostImport,
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
  const placeholder = "enc:v1:djEwYWJj";
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
