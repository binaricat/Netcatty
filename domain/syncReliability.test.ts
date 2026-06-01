import test from "node:test";
import assert from "node:assert/strict";

import {
  collectSyncDeletions,
  summarizeSyncChanges,
  withSyncReliabilityMeta,
} from "./syncReliability.ts";
import type { SyncPayload } from "./sync.ts";

function payload(overrides: Partial<SyncPayload> = {}): SyncPayload {
  return {
    hosts: [],
    keys: [],
    identities: [],
    proxyProfiles: [],
    snippets: [],
    customGroups: [],
    snippetPackages: [],
    portForwardingRules: [],
    groupConfigs: [],
    settings: undefined,
    syncedAt: 0,
    ...overrides,
  };
}

test("summarizeSyncChanges records whether local data changed", () => {
  const base = payload({
    hosts: [{
      id: "host-1",
      label: "Old",
      hostname: "old.example.com",
      username: "root",
      tags: [],
      os: "linux",
    }],
  });
  const local = payload({
    hosts: [{
      id: "host-1",
      label: "New",
      hostname: "old.example.com",
      username: "root",
      tags: [],
      os: "linux",
    }],
  });

  const summary = summarizeSyncChanges(base, local);

  assert.equal(summary.hasLocalChanges, true);
  assert.equal(summary.byEntity.hosts.modified.local, 1);
});

test("collectSyncDeletions records deleted entities explicitly", () => {
  const base = payload({
    hosts: [{
      id: "host-1",
      label: "Old",
      hostname: "old.example.com",
      username: "root",
      tags: [],
      os: "linux",
    }],
    customGroups: ["prod"],
  });

  const deletions = collectSyncDeletions(base, payload(), {
    deletedAt: 123,
    deviceId: "device-a",
  });

  assert.deepEqual(deletions, [
    { entityType: "hosts", id: "host-1", deletedAt: 123, deviceId: "device-a" },
    { entityType: "customGroups", id: "prod", deletedAt: 123, deviceId: "device-a" },
  ]);
});

test("collectSyncDeletions records group config deletions by path", () => {
  const deletions = collectSyncDeletions(
    payload({ groupConfigs: [{ path: "prod", username: "root" }] }),
    payload({ groupConfigs: [] }),
    { deletedAt: 123 },
  );

  assert.deepEqual(deletions, [{
    entityType: "groupConfigs",
    id: "prod",
    deletedAt: 123,
  }]);
});

test("summarizeSyncChanges treats missing optional arrays as legacy payloads", () => {
  const base = payload({
    groupConfigs: [{ path: "prod", username: "root" }],
  });
  const remote = payload();
  delete remote.groupConfigs;

  const summary = summarizeSyncChanges(base, base, remote);

  assert.equal(summary.hasRemoteChanges, false);
  assert.equal(summary.byEntity.groupConfigs, undefined);
});

test("summarizeSyncChanges reports conflict categories", () => {
  const base = payload({
    hosts: [{
      id: "host-1",
      label: "Base",
      hostname: "base.example.com",
      username: "root",
      tags: [],
      os: "linux",
    }],
  });
  const local = payload({
    hosts: [{
      id: "host-1",
      label: "Local",
      hostname: "base.example.com",
      username: "root",
      tags: [],
      os: "linux",
    }],
  });
  const remote = payload({
    hosts: [{
      id: "host-1",
      label: "Remote",
      hostname: "base.example.com",
      username: "root",
      tags: [],
      os: "linux",
    }],
  });

  const summary = summarizeSyncChanges(base, local, remote);

  assert.equal(summary.hasConflicts, true);
  assert.deepEqual(summary.conflicts, [{
    entityType: "hosts",
    id: "host-1",
    kind: "both-modified",
  }]);
});

test("summarizeSyncChanges reports both-added conflicts by entity type", () => {
  const local = payload({
    hosts: [{
      id: "host-1",
      label: "Local",
      hostname: "local.example.com",
      username: "root",
      tags: [],
      os: "linux",
    }],
  });
  const remote = payload({
    hosts: [{
      id: "host-1",
      label: "Remote",
      hostname: "remote.example.com",
      username: "root",
      tags: [],
      os: "linux",
    }],
  });

  const summary = summarizeSyncChanges(payload(), local, remote);

  assert.equal(summary.hasConflicts, true);
  assert.deepEqual(summary.conflicts, [{
    entityType: "hosts",
    id: "host-1",
    kind: "both-added",
  }]);
});

test("withSyncReliabilityMeta carries old deletion records until the entity is recreated", () => {
  const current = payload({
    syncMeta: {
      schemaVersion: 1,
      generatedAt: 100,
      localChanged: true,
      deletions: [{
        entityType: "hosts",
        id: "host-1",
        deletedAt: 100,
        deviceId: "device-a",
      }],
      changeSummary: {
        hasLocalChanges: true,
        hasRemoteChanges: false,
        hasConflicts: false,
        byEntity: {},
        conflicts: [],
      },
    },
  });

  const enriched = withSyncReliabilityMeta(current, payload(), {
    deviceId: "device-a",
    now: 200,
  });

  assert.deepEqual(enriched.syncMeta?.deletions, [{
    entityType: "hosts",
    id: "host-1",
    deletedAt: 100,
    deviceId: "device-a",
  }]);

  const recreated = withSyncReliabilityMeta(
    payload({
      hosts: [{
        id: "host-1",
        label: "Recreated",
        hostname: "new.example.com",
        username: "root",
        tags: [],
        os: "linux",
      }],
      syncMeta: enriched.syncMeta,
    }),
    payload(),
    { deviceId: "device-a", now: 300 },
  );

  assert.deepEqual(recreated.syncMeta?.deletions, []);
});

test("withSyncReliabilityMeta attaches change summary and deletion records", () => {
  const base = payload({
    snippets: [{ id: "snippet-1", label: "Old", command: "ls" }],
  });
  const current = payload();

  const enriched = withSyncReliabilityMeta(current, base, {
    deviceId: "device-a",
    now: 456,
  });

  assert.equal(enriched.syncMeta?.schemaVersion, 1);
  assert.equal(enriched.syncMeta?.localChanged, true);
  assert.deepEqual(enriched.syncMeta?.deletions, [{
    entityType: "snippets",
    id: "snippet-1",
    deletedAt: 456,
    deviceId: "device-a",
  }]);
});
