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

test("SecureCRT destination group keeps same-endpoint session files", async () => {
  const { applyVaultImportDestination } = await import("../../domain/vaultImport");
  const session = [
    'S:"Hostname"=shared.example.com',
    'S:"Username"=root',
    'S:"Protocol Name"=SSH2',
  ].join("\n");
  const imported = await importVaultHostFiles({
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

test("FinalShell conn directory import reads JSON files, preserves nested groups, and continues past damage", async () => {
  const finalShellFile = (relativePath: string, host: string) => {
    const file = new File([JSON.stringify({
      name: relativePath.split("/").at(-1)?.replace(/\.json$/u, ""),
      host,
      port: 22,
      user_name: "root",
      conection_type: 100,
    })], relativePath.split("/").at(-1) ?? "connection.json");
    Object.defineProperty(file, "webkitRelativePath", { value: relativePath });
    return file;
  };
  const ignored = new File(["ignored"], "notes.txt");
  Object.defineProperty(ignored, "webkitRelativePath", { value: "conn/Prod/notes.txt" });
  const broken = new File(["{"], "broken.json");
  Object.defineProperty(broken, "webkitRelativePath", { value: "conn/Broken/broken.json" });

  const result = await importVaultHostFiles({
    format: "finalshell",
    files: [
      finalShellFile("conn/Prod/Web/web.json", "web.example.com"),
      broken,
      ignored,
      finalShellFile("conn/Staging/db.json", "db.example.com"),
    ],
  });

  assert.deepEqual(result.hosts.map(({ hostname, group }) => ({ hostname, group })), [
    { hostname: "web.example.com", group: "Prod/Web" },
    { hostname: "db.example.com", group: "Staging" },
  ]);
  assert.deepEqual(result.groups, ["Prod/Web", "Staging"]);
  assert.equal(result.stats.imported, 2);
  assert.equal(result.stats.skipped, 1);
  assert.match(result.issues[0]?.message ?? "", /broken\.json/i);
});
