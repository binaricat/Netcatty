import test from "node:test";
import assert from "node:assert/strict";

import { detectSuspiciousShrink } from "./syncGuards.ts";
import type { SyncPayload } from "./sync.ts";

function payload(overrides: Partial<SyncPayload> = {}): SyncPayload {
  return {
    hosts: [],
    keys: [],
    identities: [],
    snippets: [],
    customGroups: [],
    snippetPackages: [],
    knownHosts: [],
    portForwardingRules: [],
    groupConfigs: [],
    settings: undefined,
    syncedAt: 0,
    ...overrides,
  };
}

function hosts(n: number): SyncPayload["hosts"] {
  return Array.from({ length: n }, (_, i) => ({
    id: `h${i}`,
    label: `h${i}`,
    hostname: `h${i}.example`,
    port: 22,
    username: "root",
    protocol: "ssh",
  })) as SyncPayload["hosts"];
}

test("null base → not suspicious (first sync / null after re-auth)", () => {
  const result = detectSuspiciousShrink(payload({ hosts: hosts(1) }), null);
  assert.deepEqual(result, { suspicious: false });
});

test("no shrink — same counts → not suspicious", () => {
  const base = payload({ hosts: hosts(5) });
  const out = payload({ hosts: hosts(5) });
  assert.deepEqual(detectSuspiciousShrink(out, base), { suspicious: false });
});

test("growth only → not suspicious", () => {
  const base = payload({ hosts: hosts(5) });
  const out = payload({ hosts: hosts(10) });
  assert.deepEqual(detectSuspiciousShrink(out, base), { suspicious: false });
});

test("shrink under both thresholds → not suspicious (delete 2 of 4)", () => {
  const base = payload({ hosts: hosts(4) });
  const out = payload({ hosts: hosts(2) });
  assert.deepEqual(detectSuspiciousShrink(out, base), { suspicious: false });
});

test("bulk-shrink 50% AND absolute 3 — exactly at threshold → suspicious", () => {
  const base = payload({ hosts: hosts(6) });
  const out = payload({ hosts: hosts(3) });
  assert.deepEqual(detectSuspiciousShrink(out, base), {
    suspicious: true,
    reason: "bulk-shrink",
    entityType: "hosts",
    baseCount: 6,
    outgoingCount: 3,
    lost: 3,
  });
});

test("bulk-shrink 50% but absolute 2 → not suspicious (absolute gate)", () => {
  const base = payload({ hosts: hosts(4) });
  const out = payload({ hosts: hosts(2) });
  assert.deepEqual(detectSuspiciousShrink(out, base), { suspicious: false });
});

test("bulk-shrink 40% absolute 4 → not suspicious (ratio gate)", () => {
  const base = payload({ hosts: hosts(10) });
  const out = payload({ hosts: hosts(6) });
  assert.deepEqual(detectSuspiciousShrink(out, base), { suspicious: false });
});

test("large-shrink absolute 10 regardless of ratio → suspicious", () => {
  const base = payload({ hosts: hosts(100) });
  const out = payload({ hosts: hosts(90) });
  assert.deepEqual(detectSuspiciousShrink(out, base), {
    suspicious: true,
    reason: "large-shrink",
    entityType: "hosts",
    baseCount: 100,
    outgoingCount: 90,
    lost: 10,
  });
});

test("dual-trigger (large-shrink AND bulk-shrink both satisfied) → reason is 'large-shrink'", () => {
  // base=20, lost=10: satisfies large-shrink (>=10) AND bulk-shrink (50%, >=3)
  const base = payload({ hosts: hosts(20) });
  const out = payload({ hosts: hosts(10) });
  const result = detectSuspiciousShrink(out, base);
  assert.equal(result.suspicious, true);
  if (result.suspicious) assert.equal(result.reason, "large-shrink");
});

test("multiple entity types shrinking — returns first in declaration order (hosts before keys)", () => {
  const base = payload({ hosts: hosts(6), keys: Array.from({ length: 6 }, (_, i) => ({ id: `k${i}`, label: `k${i}`, privateKey: "x" })) as SyncPayload["keys"] });
  const out = payload({ hosts: hosts(3), keys: Array.from({ length: 3 }, (_, i) => ({ id: `k${i}`, label: `k${i}`, privateKey: "x" })) as SyncPayload["keys"] });
  const result = detectSuspiciousShrink(out, base);
  assert.equal(result.suspicious, true);
  if (result.suspicious) assert.equal(result.entityType, "hosts");
});

test("only non-hosts entity shrinks → reports that entity", () => {
  const snippets = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `s${i}`, label: `s${i}`, command: "" })) as SyncPayload["snippets"];
  const base = payload({ snippets: snippets(10) });
  const out = payload({ snippets: snippets(0) });
  const result = detectSuspiciousShrink(out, base);
  assert.equal(result.suspicious, true);
  if (result.suspicious) {
    assert.equal(result.entityType, "snippets");
    assert.equal(result.reason, "large-shrink");
  }
});

test("knownHosts shrink triggers (security-sensitive)", () => {
  const kh = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `kh${i}`, hostname: `h${i}`, port: 22, keyType: "rsa", fingerprint: "x" })) as unknown as SyncPayload["knownHosts"];
  const base = payload({ knownHosts: kh(12) });
  const out = payload({ knownHosts: kh(2) });
  const result = detectSuspiciousShrink(out, base);
  assert.equal(result.suspicious, true);
  if (result.suspicious) assert.equal(result.entityType, "knownHosts");
});

test("empty base (all zeros) — no shrink possible, returns not suspicious", () => {
  const base = payload();
  const out = payload({ hosts: hosts(5) });
  // All base counts are 0; no shrink possible
  assert.deepEqual(detectSuspiciousShrink(out, base), { suspicious: false });
});
