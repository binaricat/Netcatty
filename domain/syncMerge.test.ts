import test from "node:test";
import assert from "node:assert/strict";

import { mergeSyncPayloads } from "./syncMerge.ts";
import { withSyncReliabilityMeta } from "./syncReliability.ts";
import type { SyncPayload } from "./sync.ts";

function payload(overrides: Partial<SyncPayload> = {}): SyncPayload {
  return {
    hosts: [],
    keys: [],
    identities: [],
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

const knownHosts = (n: number): SyncPayload["knownHosts"] =>
  Array.from({ length: n }, (_, i) => ({
    id: `kh-${i}`,
    hostname: `host-${i}.example.com`,
    port: 22,
    keyType: "ssh-ed25519",
    publicKey: `SHA256:${i}`,
    discoveredAt: 1,
  }));

test("mergeSyncPayloads does not carry legacy known hosts forward", () => {
  const result = mergeSyncPayloads(
    payload({ knownHosts: knownHosts(2) }),
    payload(),
    payload({ knownHosts: knownHosts(3) }),
  );

  assert.equal("knownHosts" in result.payload, false);
});

test("mergeSyncPayloads merges reusable proxy profiles by id", () => {
  const localProfile = {
    id: "proxy-local",
    label: "Local Proxy",
    config: { type: "http", host: "local.example.com", port: 3128 },
    createdAt: 1,
    updatedAt: 1,
  };
  const remoteProfile = {
    id: "proxy-remote",
    label: "Remote Proxy",
    config: { type: "socks5", host: "remote.example.com", port: 1080 },
    createdAt: 2,
    updatedAt: 2,
  };

  const result = mergeSyncPayloads(
    payload(),
    payload({ proxyProfiles: [localProfile] } as Partial<SyncPayload>),
    payload({ proxyProfiles: [remoteProfile] } as Partial<SyncPayload>),
  );

  assert.deepEqual(result.payload.proxyProfiles?.map((item) => item.id).sort(), [
    "proxy-local",
    "proxy-remote",
  ]);
});

test("mergeSyncPayloads preserves proxy profiles when remote payload predates them", () => {
  const proxy = {
    id: "proxy-1",
    label: "Office Proxy",
    config: { type: "http", host: "proxy.example.com", port: 3128 },
    createdAt: 1,
  };

  const result = mergeSyncPayloads(
    payload({ proxyProfiles: [proxy] } as Partial<SyncPayload>),
    payload({ proxyProfiles: [proxy] } as Partial<SyncPayload>),
    payload(),
  );

  assert.deepEqual(result.payload.proxyProfiles, [proxy]);
});

test("mergeSyncPayloads keeps missing proxy references visible to connection guards", () => {
  const result = mergeSyncPayloads(
    payload({
      hosts: [{
        id: "host-1",
        label: "Host",
        hostname: "example.com",
        username: "root",
        tags: [],
        os: "linux",
        proxyProfileId: "proxy-1",
      }],
      proxyProfiles: [{
        id: "proxy-1",
        label: "Old Proxy",
        config: { type: "http", host: "old.example.com", port: 3128 },
        createdAt: 1,
      }],
      groupConfigs: [{ path: "prod", proxyProfileId: "proxy-1" }],
    }),
    payload({
      hosts: [{
        id: "host-1",
        label: "Host",
        hostname: "example.com",
        username: "root",
        tags: [],
        os: "linux",
        proxyProfileId: "proxy-1",
      }],
      proxyProfiles: [],
      groupConfigs: [{ path: "prod", proxyProfileId: "proxy-1" }],
    }),
    payload({
      hosts: [{
        id: "host-1",
        label: "Host",
        hostname: "example.com",
        username: "root",
        tags: [],
        os: "linux",
        proxyProfileId: "proxy-1",
      }],
      proxyProfiles: [],
      groupConfigs: [{ path: "prod", proxyProfileId: "proxy-1" }],
    }),
  );

  assert.equal(result.payload.hosts[0]?.proxyProfileId, "proxy-1");
  assert.equal(result.payload.groupConfigs?.[0]?.proxyProfileId, "proxy-1");
});

test("mergeSyncPayloads honors remote deletion records when base is unavailable", () => {
  const result = mergeSyncPayloads(
    null,
    payload({
      hosts: [{
        id: "host-1",
        label: "Stale local copy",
        hostname: "old.example.com",
        username: "root",
        tags: [],
        os: "linux",
      }],
    }),
    payload({
      syncMeta: {
        schemaVersion: 1,
        generatedAt: 123,
        localChanged: true,
        deletions: [{
          entityType: "hosts",
          id: "host-1",
          deletedAt: 123,
          deviceId: "remote-device",
        }],
        changeSummary: {
          hasLocalChanges: true,
          hasRemoteChanges: false,
          hasConflicts: false,
          byEntity: {},
          conflicts: [],
        },
      },
    }),
  );

  assert.deepEqual(result.payload.hosts, []);
  assert.equal(result.summary.deleted.remote, 1);
});

test("mergeSyncPayloads carries deletion records forward after applying a tombstone", () => {
  const remote = payload({
    syncMeta: {
      schemaVersion: 1,
      generatedAt: 123,
      localChanged: true,
      deletions: [{
        entityType: "hosts",
        id: "host-1",
        deletedAt: 123,
        deviceId: "remote-device",
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

  const result = mergeSyncPayloads(
    null,
    payload({
      hosts: [{
        id: "host-1",
        label: "Stale local copy",
        hostname: "old.example.com",
        username: "root",
        tags: [],
        os: "linux",
      }],
    }),
    remote,
  );
  const enriched = withSyncReliabilityMeta(result.payload, null, {
    deviceId: "local-device",
    now: 456,
  });

  assert.deepEqual(enriched.syncMeta?.deletions, [{
    entityType: "hosts",
    id: "host-1",
    deletedAt: 123,
    deviceId: "remote-device",
  }]);
});

test("mergeSyncPayloads treats missing optional arrays as legacy payloads, not deletions", () => {
  const identity = {
    id: "identity-1",
    label: "Prod",
    username: "root",
    authMethod: "password" as const,
    created: 1,
  };
  const rule = {
    id: "rule-1",
    name: "Web",
    hostId: "host-1",
    type: "local" as const,
    localHost: "127.0.0.1",
    localPort: 8080,
    remoteHost: "127.0.0.1",
    remotePort: 80,
    enabled: true,
    createdAt: 1,
  };

  const base = payload({
    identities: [identity],
    snippetPackages: ["ops"],
    portForwardingRules: [rule],
    groupConfigs: [{ path: "prod", username: "root" }],
  });
  const local = payload({
    identities: [identity],
    snippetPackages: ["ops"],
    portForwardingRules: [rule],
    groupConfigs: [{ path: "prod", username: "root" }],
  });
  const remote = payload();
  delete remote.identities;
  delete remote.snippetPackages;
  delete remote.portForwardingRules;
  delete remote.groupConfigs;

  const result = mergeSyncPayloads(base, local, remote);

  assert.deepEqual(result.payload.identities, [identity]);
  assert.deepEqual(result.payload.snippetPackages, ["ops"]);
  assert.deepEqual(result.payload.portForwardingRules, [rule]);
  assert.deepEqual(result.payload.groupConfigs, [{ path: "prod", username: "root" }]);
});
