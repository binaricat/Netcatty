import assert from "node:assert/strict";
import test from "node:test";

import { importVaultHostsFromText } from "../vaultImport.ts";
import { exportHostsToCsvWithStats } from "./csvExport.ts";
import type { Host } from "../models.ts";

test("CSV exports include a UTF-8 BOM and preserve Chinese text when imported again", () => {
  const host: Host = {
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
    keyPassphrases: new Map([[keyPath, "reference-secret"]]),
  });
  const imported = importVaultHostsFromText("csv", csv);

  assert.deepEqual(imported.hosts[0]?.identityFilePaths, [keyPath]);
  assert.deepEqual(imported.keyPassphrases, [{
    hostId: imported.hosts[0]?.id,
    keyPath,
    passphrase: "reference-secret",
  }]);
});

test("CSV reversibly guards key paths that spreadsheets treat as formulas", () => {
  const hosts: Host[] = [
    "-relative-key",
    "'-literal-key",
    "__netcatty_csv_keypath_v1__:literal",
  ].map((keyPath, index) => ({
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
