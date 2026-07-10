import test from "node:test";
import assert from "node:assert/strict";

import { importVaultHostsFromText, detectVaultImportFormat, applyVaultHostImport } from "./vaultImport.ts";
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
