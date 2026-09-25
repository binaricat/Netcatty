import assert from "node:assert/strict";
import test from "node:test";

import { importVaultHostsFromText } from "../../domain/vaultImport.ts";
import { readVaultImportFile } from "./vaultImportFile.ts";

const sessionValue = "#109#0%10.0.0.1%22%root";

test("MobaXterm import decodes legacy GB18030 Chinese text", async () => {
  const prefix = new TextEncoder().encode("[Bookmarks]\nSubRep=\nImgNum=42\n");
  const suffix = new TextEncoder().encode(`=${sessionValue}`);
  const encodedLabel = new Uint8Array([
    0xd6, 0xd0, 0xce, 0xc4, 0xb7, 0xfe, 0xce, 0xf1, 0xc6, 0xf7,
  ]);
  const bytes = new Uint8Array(prefix.length + encodedLabel.length + suffix.length);
  bytes.set(prefix);
  bytes.set(encodedLabel, prefix.length);
  bytes.set(suffix, prefix.length + encodedLabel.length);

  const text = await readVaultImportFile(
    "mobaxterm",
    new File([bytes], "MobaXterm.ini", { type: "text/plain" }),
  );
  const result = importVaultHostsFromText("mobaxterm", text);

  assert.equal(result.hosts[0]?.label, "中文服务器");
});

test("MobaXterm import keeps unmarked UTF-8 Chinese text", async () => {
  const text = `[Bookmarks]\nSubRep=\nImgNum=42\n北京上海=${sessionValue}`;
  const decoded = await readVaultImportFile(
    "mobaxterm",
    new File([text], "MobaXterm.ini", { type: "text/plain" }),
  );
  const result = importVaultHostsFromText("mobaxterm", decoded);

  assert.equal(result.hosts[0]?.label, "北京上海");
});

test("MobaXterm import keeps valid UTF-8 labels when GB18030 would produce Chinese", async () => {
  const text = `[Bookmarks]\nSubRep=\nImgNum=42\n¡prod=${sessionValue}`;
  const decoded = await readVaultImportFile(
    "mobaxterm",
    new File([text], "MobaXterm.ini", { type: "text/plain" }),
  );
  const result = importVaultHostsFromText("mobaxterm", decoded);

  assert.equal(result.hosts[0]?.label, "¡prod");
});

test("CSV import decodes legacy GB18030 Chinese group names", async () => {
  const header = new TextEncoder().encode("Groups,Label,Hostname/IP,Port,Username\n");
  const encodedGroup = new Uint8Array([
    0xd6, 0xd0, 0xce, 0xc4, 0xd7, 0xe9, // 中文组 in GB18030
  ]);
  const row = new TextEncoder().encode(",web,192.168.1.10,22,root\n");
  const bytes = new Uint8Array(header.length + encodedGroup.length + row.length);
  bytes.set(header);
  bytes.set(encodedGroup, header.length);
  bytes.set(row, header.length + encodedGroup.length);

  const text = await readVaultImportFile(
    "csv",
    new File([bytes], "hosts.csv", { type: "text/csv" }),
  );
  const result = importVaultHostsFromText("csv", text);

  assert.equal(result.hosts[0]?.group, "中文组");
});

test("CSV import keeps valid UTF-8 Chinese group names", async () => {
  const text = "Groups,Label,Hostname/IP,Port,Username\n中文组,web,192.168.1.10,22,root\n";
  const decoded = await readVaultImportFile(
    "csv",
    new File([text], "hosts.csv", { type: "text/csv" }),
  );
  const result = importVaultHostsFromText("csv", decoded);

  assert.equal(result.hosts[0]?.group, "中文组");
});

test("ssh_config import keeps UTF-8 host names when a comment has invalid bytes", async () => {
  const file = new File([
    new TextEncoder().encode("# legacy comment "),
    new Uint8Array([0xff]),
    new TextEncoder().encode("\nHost 中文组\n  HostName example.com\n"),
  ], "config", { type: "text/plain" });

  const text = await readVaultImportFile("ssh_config", file);
  const result = importVaultHostsFromText("ssh_config", text);

  assert.equal(result.hosts[0]?.label, "中文组");
  assert.equal(result.hosts[0]?.hostname, "example.com");
});

test("MobaXterm import can force GB18030 for ambiguous legacy Chinese text", async () => {
  const prefix = new TextEncoder().encode("[Bookmarks]\nSubRep=\nImgNum=42\n");
  const suffix = new TextEncoder().encode(`prod=${sessionValue}`);
  const bytes = new Uint8Array(prefix.length + 2 + suffix.length);
  bytes.set(prefix);
  bytes.set([0xc2, 0xa1], prefix.length);
  bytes.set(suffix, prefix.length + 2);

  const decoded = await readVaultImportFile(
    "mobaxterm",
    new File([bytes], "MobaXterm.ini", { type: "text/plain" }),
    "gb18030",
  );
  const result = importVaultHostsFromText("mobaxterm", decoded);

  assert.equal(result.hosts[0]?.label, "隆prod");
});
