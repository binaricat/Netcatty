import assert from "node:assert/strict";
import test from "node:test";

import { importVaultHostFiles } from "./vaultImportBatch.ts";

const secureCrtFile = (
  relativePath: string,
  hostname: string | null,
  portHex = "00000016",
  protocol = "SSH2",
) => {
  const file = new File([[
      hostname ? `S:"Hostname"=${hostname}` : "S:\"Username\"=nobody",
      'S:"Username"=operator',
      `S:"Protocol Name"=${protocol}`,
      `D:"[SSH2] Port"=${portHex}`,
    ].join("\n")], relativePath.split("/").at(-1) ?? "session.ini");
  Object.defineProperty(file, "webkitRelativePath", { value: relativePath });
  return file;
};

test("SecureCRT directory import reads every session and preserves folder groups", async () => {
  const result = await importVaultHostFiles({
    format: "securecrt",
    files: [
      secureCrtFile("Sessions/Production/Web.ini", "web.example.com", "000008ae"),
      secureCrtFile("Sessions/Staging/DB.ini", "db.example.com"),
      secureCrtFile("Sessions/Archive/Web Copy.ini", "web.example.com", "000008ae"),
      secureCrtFile("Sessions/Default.ini", "should-not-import.example.com"),
      secureCrtFile("Sessions/Production/__FolderData__.ini", "should-not-import.example.com"),
      secureCrtFile("Sessions/Broken.ini", null),
    ],
  });

  assert.deepEqual(result.stats, {
    parsed: 3,
    imported: 3,
    skipped: 1,
    duplicates: 0,
  });
  assert.deepEqual(
    result.hosts.map(({ label, hostname, port, group }) => ({ label, hostname, port, group })),
    [
      {
        label: "Web",
        hostname: "web.example.com",
        port: 2222,
        group: "Production",
      },
      {
        label: "DB",
        hostname: "db.example.com",
        port: 22,
        group: "Staging",
      },
      {
        label: "Web Copy",
        hostname: "web.example.com",
        port: 2222,
        group: "Archive",
      },
    ],
  );
  assert.deepEqual(result.groups, ["Production", "Staging", "Archive"]);
  assert.match(result.issues[0]?.message ?? "", /Broken\.ini/);
});

test("SecureCRT keeps separate session files that point to the same endpoint", async () => {
  const session = [
    'S:"Hostname"=shared.example.com',
    'S:"Username"=root',
    'S:"Protocol Name"=SSH2',
  ].join("\n");
  const result = await importVaultHostFiles({
    format: "securecrt",
    files: [
      new File([session], "web.ini"),
      new File([session], "web.ini"),
    ],
    relativePaths: [
      "Sessions/Prod/web.ini",
      "Sessions/Staging/web.ini",
    ],
  });

  assert.equal(result.hosts.length, 2);
  assert.deepEqual(result.hosts.map((host) => host.group), ["Prod", "Staging"]);
});

test("SecureCRT batch import does not count an unsupported session twice", async () => {
  const result = await importVaultHostFiles({
    format: "securecrt",
    files: [secureCrtFile("Sessions/Local.ini", "localhost", "00000016", "Local")],
  });

  assert.equal(result.hosts.length, 0);
  assert.equal(result.stats.parsed, 1);
  assert.equal(result.stats.skipped, 1);
  assert.equal(result.issues.length, 1);
});

test("SecureCRT folder paths transferred alongside files survive the worker boundary", async () => {
  const file = new File([
    [
      'S:"Hostname"=transferred.example.com',
      'S:"Username"=operator',
      'S:"Protocol Name"=SSH2',
    ].join("\n"),
  ], "Transferred.ini");

  const result = await importVaultHostFiles({
    format: "securecrt",
    files: [file],
    relativePaths: ["Sessions/Production/Transferred.ini"],
  });

  assert.equal(result.hosts[0]?.group, "Production");
  assert.deepEqual(result.groups, ["Production"]);
});

test("SecureCRT keeps a real nested Sessions folder when that folder was selected", async () => {
  const result = await importVaultHostFiles({
    format: "securecrt",
    files: [secureCrtFile("Sessions/Sessions/Nested.ini", "nested.example.com")],
  });

  assert.equal(result.hosts[0]?.group, "Sessions");
  assert.deepEqual(result.groups, ["Sessions"]);
});
