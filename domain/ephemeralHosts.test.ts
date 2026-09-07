import assert from "node:assert/strict";
import test from "node:test";

import { applyEphemeralHostDistroUpdate, applyEphemeralHostsUpdate, isSavedVaultHost, splitHostsUpdateByEphemeral } from "./ephemeralHosts";
import type { Host } from "./models";

const makeHost = (id: string, overrides: Partial<Host> = {}): Host => ({
  id,
  label: id,
  hostname: `${id}.example.com`,
  username: "root",
  group: "",
  tags: [],
  os: "linux",
  ...overrides,
});

test("splitHostsUpdateByEphemeral separates ephemeral hosts from vault hosts", () => {
  const vaultHost = makeHost("vault-1");
  const ephemeralHost = makeHost("ephemeral-1", { password: "secret" });

  const { vaultHosts, ephemeralHosts } = splitHostsUpdateByEphemeral(
    [vaultHost, ephemeralHost],
    new Set(["ephemeral-1"]),
  );

  assert.deepEqual(vaultHosts, [vaultHost]);
  assert.deepEqual(ephemeralHosts, [ephemeralHost]);
});

test("splitHostsUpdateByEphemeral passes everything through when no ephemeral ids", () => {
  const hosts = [makeHost("a"), makeHost("b")];
  const { vaultHosts, ephemeralHosts } = splitHostsUpdateByEphemeral(hosts, new Set());
  assert.deepEqual(vaultHosts, hosts);
  assert.deepEqual(ephemeralHosts, []);
});

test("applyEphemeralHostsUpdate replaces matching hosts and keeps the rest", () => {
  const original = [
    makeHost("a", { password: "one-time" }),
    makeHost("b", { password: "other" }),
  ];
  const updated = makeHost("a", { password: "one-time", sftpFollowTerminalCwd: true });

  const next = applyEphemeralHostsUpdate(original, [updated]);

  assert.equal(next.length, 2);
  assert.equal(next[0], updated);
  assert.equal(next[1], original[1]);
});

test("applyEphemeralHostsUpdate returns previous array when nothing updated", () => {
  const original = [makeHost("a")];
  assert.equal(applyEphemeralHostsUpdate(original, []), original);
});

test("isSavedVaultHost is false for missing or ephemeral hosts", () => {
  assert.equal(isSavedVaultHost(makeHost("a")), true);
  assert.equal(isSavedVaultHost(makeHost("a", { ephemeral: true })), false);
  assert.equal(isSavedVaultHost(null), false);
  assert.equal(isSavedVaultHost(undefined), false);
});

test("temporary host detection reaches AI without changing other hosts or reviving closed sessions", async () => {
  const { buildAITerminalSessionInfo } = await import('./buildAITerminalSessionInfo');
  const other = makeHost('other');
  for (const [distro, os] of [['ubuntu', 'linux'], ['darwin', 'macos'], ['windows', 'windows']]) {
    const target = makeHost('quick-connect', { ephemeral: true });
    const next = applyEphemeralHostDistroUpdate([target, other], target.id, distro);
    assert.equal(buildAITerminalSessionInfo(undefined, next[0], 'macos').os, os);
    assert.equal(next[0].ephemeral, true);
    assert.equal(next[1], other);
    assert.equal(applyEphemeralHostDistroUpdate(next, target.id, distro), next);
    const closed = [other];
    assert.equal(applyEphemeralHostDistroUpdate(closed, target.id, distro), closed);
  }
});
