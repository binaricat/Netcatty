import test from "node:test";
import assert from "node:assert/strict";

import { importVaultHostsFromText, detectVaultImportFormat, applyVaultHostImport } from "./vaultImport.ts";
import type { Host } from "./models.ts";

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
