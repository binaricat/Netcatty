import test from "node:test";
import assert from "node:assert/strict";

import { mergeSyncPayloads } from "./syncMerge.ts";
import type { SyncPayload } from "./sync.ts";

function payload(overrides: Partial<SyncPayload> = {}): SyncPayload {
  return {
    hosts: [],
    keys: [],
    identities: [],
    snippets: [],
    customGroups: [],
    snippetPackages: [],
    notes: [],
    noteGroups: [],
    portForwardingRules: [],
    groupConfigs: [],
    settings: undefined,
    syncedAt: 0,
    ...overrides,
  };
}

const host = (id: string, extra: Record<string, unknown> = {}) =>
  ({ id, label: id, hostname: `${id}.example`, port: 22, username: "root", ...extra }) as SyncPayload["hosts"][number];

const ids = (list: Array<{ id: string }> | undefined) =>
  new Set((list ?? []).map((e) => e.id));

test("preserveDeletions: a one-sided deletion is not propagated", () => {
  const base = payload({ hosts: [host("a"), host("b"), host("c")] });
  // Local lost "b" (restored from an older backup), remote still has all three.
  const local = payload({ hosts: [host("a"), host("c")] });
  const remote = payload({ hosts: [host("a"), host("b"), host("c")] });

  const destructive = mergeSyncPayloads(base, local, remote);
  assert.deepEqual([...ids(destructive.payload.hosts)].sort(), ["a", "c"], "default mode still propagates");

  const preserved = mergeSyncPayloads(base, local, remote, { preserveDeletions: true });
  assert.deepEqual([...ids(preserved.payload.hosts)].sort(), ["a", "b", "c"], "b must survive");
});

test("preserveDeletions: a one-sided *remote* deletion is not propagated either", () => {
  const base = payload({ hosts: [host("a"), host("b")] });
  const local = payload({ hosts: [host("a"), host("b")] });
  const remote = payload({ hosts: [host("a")] });

  const preserved = mergeSyncPayloads(base, local, remote, { preserveDeletions: true });
  assert.deepEqual([...ids(preserved.payload.hosts)].sort(), ["a", "b"]);
});

test("preserveDeletions: an entity deleted on BOTH sides is still removed", () => {
  const base = payload({ hosts: [host("a"), host("b")] });
  const local = payload({ hosts: [host("a")] });
  const remote = payload({ hosts: [host("a")] });

  const preserved = mergeSyncPayloads(base, local, remote, { preserveDeletions: true });
  assert.deepEqual([...ids(preserved.payload.hosts)], ["a"]);
});

test("preserveDeletions: additions on either side still merge", () => {
  const base = payload({ hosts: [host("a")] });
  const local = payload({ hosts: [host("a"), host("local-only")] });
  const remote = payload({ hosts: [host("a"), host("remote-only")] });

  const preserved = mergeSyncPayloads(base, local, remote, { preserveDeletions: true });
  assert.deepEqual([...ids(preserved.payload.hosts)].sort(), ["a", "local-only", "remote-only"]);
});

test("preserveDeletions: notes, snippets and port forwarding are preserved too", () => {
  const base = payload({
    notes: [{ id: "n1", title: "one" }, { id: "n2", title: "two" }] as SyncPayload["notes"],
    snippets: [{ id: "s1", label: "s1", command: "echo" }, { id: "s2", label: "s2", command: "ls" }] as SyncPayload["snippets"],
    portForwardingRules: [
      { id: "p1", type: "local", localPort: 13389 } as unknown as SyncPayload["portForwardingRules"][number],
      { id: "p2", type: "local", localPort: 13390 } as unknown as SyncPayload["portForwardingRules"][number],
    ],
  });
  const local = payload({
    notes: [{ id: "n1", title: "one" }] as SyncPayload["notes"],
    snippets: [{ id: "s1", label: "s1", command: "echo" }] as SyncPayload["snippets"],
    portForwardingRules: [
      { id: "p1", type: "local", localPort: 13389 } as unknown as SyncPayload["portForwardingRules"][number],
    ],
  });
  const remote = base;

  const preserved = mergeSyncPayloads(base, local, remote, { preserveDeletions: true });
  assert.deepEqual([...ids(preserved.payload.notes)].sort(), ["n1", "n2"]);
  assert.deepEqual([...ids(preserved.payload.snippets)].sort(), ["s1", "s2"]);
  assert.deepEqual([...ids(preserved.payload.portForwardingRules)].sort(), ["p1", "p2"]);
});

test("preserveDeletions: string entities (customGroups/noteGroups) are preserved", () => {
  const base = payload({ customGroups: ["a", "b", "c"], noteGroups: ["x", "y"] });
  const local = payload({ customGroups: ["a", "c"], noteGroups: ["x"] });
  const remote = base;

  const preserved = mergeSyncPayloads(base, local, remote, { preserveDeletions: true });
  assert.deepEqual([...preserved.payload.customGroups].sort(), ["a", "b", "c"]);
  assert.deepEqual([...preserved.payload.noteGroups].sort(), ["x", "y"]);
});

test("preserveDeletions: is idempotent and lossless across repeated merges", () => {
  const base = payload({ hosts: [host("a"), host("b")] });
  const local = payload({ hosts: [host("a")] });
  const remote = base;

  const first = mergeSyncPayloads(base, local, remote, { preserveDeletions: true });
  const second = mergeSyncPayloads(base, first.payload, remote, { preserveDeletions: true });
  const third = mergeSyncPayloads(base, second.payload, first.payload, { preserveDeletions: true });

  assert.deepEqual([...ids(first.payload.hosts)].sort(), ["a", "b"]);
  assert.deepEqual([...ids(second.payload.hosts)].sort(), ["a", "b"]);
  assert.deepEqual([...ids(third.payload.hosts)].sort(), ["a", "b"]);
});

test("preserveDeletions: merge(x, x, x) is a no-op", () => {
  const p = payload({ hosts: [host("a"), host("b")], customGroups: ["g"] });
  const merged = mergeSyncPayloads(p, p, p, { preserveDeletions: true });
  assert.deepEqual([...ids(merged.payload.hosts)].sort(), ["a", "b"]);
  assert.deepEqual(merged.payload.customGroups, ["g"]);
});

test("preserveDeletions: a modified entity is still kept (conflicts resolved as before)", () => {
  const base = payload({ hosts: [host("a", { label: "old" })] });
  const local = payload({ hosts: [host("a", { label: "local-edit" })] });
  const remote = payload({ hosts: [host("a", { label: "remote-edit" })] });

  const preserved = mergeSyncPayloads(base, local, remote, { preserveDeletions: true });
  assert.equal(preserved.payload.hosts.length, 1);
  assert.equal((preserved.payload.hosts[0] as unknown as { label: string }).label, "local-edit");
});

test("preserveDeletions: deletions are still reported in the summary", () => {
  const base = payload({ hosts: [host("a"), host("b")] });
  const local = payload({ hosts: [host("a")] });
  const remote = base;

  const preserved = mergeSyncPayloads(base, local, remote, { preserveDeletions: true });
  assert.equal(preserved.summary.deleted.local, 1, "summary should report the local deletion that was not propagated");
  assert.ok(preserved.payload.hosts.some((h) => h.id === "b"));
});


test("preserveDeletions: no-base tombstones cannot suppress surviving entities or strings", () => {
  const survivor = payload({ hosts: [host("a")], customGroups: ["group"], noteGroups: ["notes"] });
  const removed = payload({
    syncMeta: {
      schemaVersion: 1, generatedAt: 10, localChanged: true,
      changeSummary: { hasLocalChanges: true, hasRemoteChanges: false, hasConflicts: false, byEntity: {}, conflicts: [] },
      deletions: [
        { entityType: "hosts", id: "a", deletedAt: 10 },
        { entityType: "customGroups", id: "group", deletedAt: 10 },
        { entityType: "noteGroups", id: "notes", deletedAt: 10 },
      ],
    },
  });
  for (const [local, remote] of [[survivor, removed], [removed, survivor]]) {
    const normal = mergeSyncPayloads(null, local, remote).payload;
    assert.deepEqual(normal.hosts, []);
    assert.deepEqual(normal.customGroups, []);
    assert.deepEqual(normal.noteGroups, []);
    const preserved = mergeSyncPayloads(null, local, remote, { preserveDeletions: true }).payload;
    assert.deepEqual(preserved.hosts.map((item) => item.id), ["a"]);
    assert.deepEqual(preserved.customGroups, survivor.customGroups);
    assert.deepEqual(preserved.noteGroups, survivor.noteGroups);
    assert.equal(preserved.syncMeta?.deletions.length ?? 0, 0);
  }
});
