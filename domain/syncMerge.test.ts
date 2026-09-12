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
    notes: [],
    noteGroups: [],
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

test("mergeSyncPayloads keeps local and remote notes", () => {
  const result = mergeSyncPayloads(
    payload(),
    payload({
      notes: [{
        id: "local",
        title: "Local",
        content: "",
        createdAt: 1,
        updatedAt: 2,
      }],
      noteGroups: ["Local"],
    }),
    payload({
      notes: [{
        id: "remote",
        title: "Remote",
        content: "",
        createdAt: 1,
        updatedAt: 3,
      }],
      noteGroups: ["Remote"],
    }),
  );

  assert.deepEqual(result.payload.notes?.map((note) => note.id).sort(), ["local", "remote"]);
  assert.deepEqual(result.payload.noteGroups?.sort(), ["Local", "Remote"]);
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

test("mergeSyncPayloads adopts cloud settings on the first merge without a base", () => {
  const result = mergeSyncPayloads(
    null,
    payload({
      settings: {
        theme: "dark",
        terminalFontSize: 14,
        terminalSettings: {
          cursorBlink: true,
          copyOnSelect: false,
        },
      },
    }),
    payload({
      settings: {
        theme: "light",
        terminalFontSize: 18,
        terminalSettings: {
          cursorBlink: false,
          copyOnSelect: true,
        },
      },
    }),
  );

  assert.deepEqual(result.payload.settings, {
    theme: "light",
    terminalFontSize: 18,
    terminalSettings: {
      cursorBlink: false,
      copyOnSelect: true,
    },
  });
});

test("mergeSyncPayloads preserves one-sided settings on the first merge", () => {
  const result = mergeSyncPayloads(
    null,
    payload({
      settings: {
        customCSS: ".terminal { opacity: 0.9; }",
        terminalSettings: { copyOnSelect: true },
      },
    }),
    payload({
      settings: {
        theme: "system",
        terminalSettings: { cursorBlink: false },
      },
    }),
  );

  assert.deepEqual(result.payload.settings, {
    customCSS: ".terminal { opacity: 0.9; }",
    theme: "system",
    terminalSettings: {
      copyOnSelect: true,
      cursorBlink: false,
    },
  });
});

test("mergeSyncPayloads honors empty cloud setting maps as resets on the first merge", () => {
  const result = mergeSyncPayloads(
    null,
    payload({
      settings: {
        customKeyBindings: {
          copy: { mac: "meta+c", pc: "ctrl+c" },
        },
        ai: {
          agentModelMap: { codex: "gpt-local" },
          agentProviderMap: { codex: "openai-local" },
          activeModelId: "local-model",
        },
      },
    }),
    payload({
      settings: {
        customKeyBindings: {},
        ai: {
          agentModelMap: {},
          agentProviderMap: {},
          activeProviderId: "cloud-provider",
        },
      },
    }),
  );

  assert.deepEqual(result.payload.settings, {
    customKeyBindings: {},
    ai: {
      agentModelMap: {},
      agentProviderMap: {},
      activeModelId: "local-model",
      activeProviderId: "cloud-provider",
    },
  });
});

test("mergeSyncPayloads retains unique nested setting entries while cloud wins duplicate ids", () => {
  const result = mergeSyncPayloads(
    null,
    payload({
      settings: {
        ai: {
          providers: [
            { id: "shared", name: "Local shared" },
            { id: "local-only", name: "Local only" },
          ],
        },
      },
    }),
    payload({
      settings: {
        ai: {
          providers: [
            { id: "shared", name: "Cloud shared" },
            { id: "cloud-only", name: "Cloud only" },
          ],
        },
      },
    }),
  );

  assert.deepEqual(result.payload.settings?.ai?.providers, [
    { id: "shared", name: "Cloud shared" },
    { id: "cloud-only", name: "Cloud only" },
    { id: "local-only", name: "Local only" },
  ]);
});

test("mergeSyncPayloads keeps local settings conflict policy when a base exists", () => {
  const base = payload({
    settings: {
      theme: "system",
      terminalSettings: { cursorBlink: true },
    },
  });
  const result = mergeSyncPayloads(
    base,
    payload({
      settings: {
        theme: "dark",
        terminalSettings: { cursorBlink: false },
      },
    }),
    payload({
      settings: {
        theme: "light",
        terminalSettings: { cursorBlink: true },
      },
    }),
  );

  assert.deepEqual(result.payload.settings, {
    theme: "dark",
    terminalSettings: { cursorBlink: false },
  });
});

test("mergeSyncPayloads carries plugin sidecars through without dropping remote baselines", () => {
  const local: SyncPayload = {
    hosts: [],
    keys: [],
    identities: [],
    snippets: [],
    customGroups: [],
    syncedAt: 1,
    pluginSidecars: {
      version: 1,
      entries: [{
        pluginId: "com.local.plugin",
        kind: "settings",
        key: "com.local.plugin.theme\0application\0application",
        value: "dark",
        updatedAt: 5,
      }],
    },
  };
  const remote: SyncPayload = {
    hosts: [],
    keys: [],
    identities: [],
    snippets: [],
    customGroups: [],
    syncedAt: 2,
    pluginSidecars: {
      version: 1,
      entries: [{
        pluginId: "com.remote.plugin",
        kind: "account_baseline",
        key: "account",
        value: { id: "acct-r" },
        updatedAt: 9,
      }],
    },
  };
  const result = mergeSyncPayloads(null, local, remote);
  assert.ok(result.payload.pluginSidecars);
  assert.equal(result.payload.pluginSidecars!.entries.length, 2);
  assert.ok(result.payload.pluginSidecars!.entries.some((e) => e.pluginId === "com.local.plugin"));
  assert.ok(result.payload.pluginSidecars!.entries.some((e) => e.kind === "account_baseline"));
});

test("mergeSyncPayloads propagates local sidecar setting resets via three-way merge", () => {
  const entry = {
    pluginId: "com.example.p",
    kind: "settings" as const,
    key: "com.example.p.theme\0application\0application",
    value: "dark",
    updatedAt: 1,
  };
  const base: SyncPayload = {
    hosts: [], keys: [], identities: [], snippets: [], customGroups: [],
    syncedAt: 1,
    pluginSidecars: { version: 1, entries: [entry] },
  };
  const local: SyncPayload = {
    hosts: [], keys: [], identities: [], snippets: [], customGroups: [],
    syncedAt: 2,
    // user reset: explicit empty sidecar bundle (omitted field = legacy/unsupported)
    pluginSidecars: { version: 1, entries: [] },
  };
  const remote: SyncPayload = {
    hosts: [], keys: [], identities: [], snippets: [], customGroups: [],
    syncedAt: 2,
    pluginSidecars: { version: 1, entries: [entry] },
  };
  const result = mergeSyncPayloads(base, local, remote);
  assert.equal(
    result.payload.pluginSidecars?.entries?.some((e) => e.key === entry.key) ?? false,
    false,
    "local reset must not be resurrected from base/remote",
  );
  assert.ok(
    Object.prototype.hasOwnProperty.call(result.payload, "pluginSidecars"),
    "explicit empty sidecar field must remain so apply clears remote/local DB",
  );
  assert.deepEqual(result.payload.pluginSidecars, { version: 1, entries: [] });
});

test("mergeSyncPayloads preserves sidecars when remote legacy payload omits the field", () => {
  const entry = {
    pluginId: "com.example.p",
    kind: "settings" as const,
    key: "com.example.p.theme\0application\0application",
    value: "dark",
    updatedAt: 1,
  };
  const base: SyncPayload = {
    hosts: [], keys: [], identities: [], snippets: [], customGroups: [],
    syncedAt: 1,
    pluginSidecars: { version: 1, entries: [entry] },
  };
  const local: SyncPayload = {
    hosts: [], keys: [], identities: [], snippets: [], customGroups: [],
    syncedAt: 2,
    pluginSidecars: { version: 1, entries: [entry] },
  };
  const remote: SyncPayload = {
    hosts: [], keys: [], identities: [], snippets: [], customGroups: [],
    syncedAt: 2,
    // legacy remote omits pluginSidecars entirely
  };
  const result = mergeSyncPayloads(base, local, remote);
  assert.ok(result.payload.pluginSidecars?.entries?.some((e) => e.key === entry.key));
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

const hostWithTelemetry = (lastConnectedAt?: number) => ({
  id: "host-1",
  label: "prod",
  hostname: "prod.example.com",
  username: "root",
  tags: [],
  os: "linux" as const,
  protocol: "ssh" as const,
  ...(lastConnectedAt === undefined ? {} : { lastConnectedAt }),
});

test("mergeSyncPayloads normalizes lastConnectedAt across base and remote so sanitized local does not shadow remote edits", () => {
  // Legacy base + old-device remote still carry the legacy telemetry field;
  // the upgraded local payload strips it. A remote edit to the same host
  // must not be classified as a local-modified conflict and overwritten.
  const base = payload({
    hosts: [hostWithTelemetry(1_000)],
  });
  // Local is otherwise unchanged — it only lost the telemetry field to the
  // new sanitize-on-build behavior.
  const local = payload({
    hosts: [hostWithTelemetry()],
  });
  const remote = payload({
    hosts: [{ ...hostWithTelemetry(1_000), label: "prod-renamed-by-remote" }],
  });

  const result = mergeSyncPayloads(base, local, remote);

  // Remote edit survives: the telemetry-only local delta must not classify
  // this host as locally modified and shadow the remote rename.
  assert.equal(result.payload.hosts[0]?.label, "prod-renamed-by-remote");
  assert.equal(result.summary.modified.local, 0);
  assert.equal(result.summary.modified.remote, 1);
});

test("mergeSyncPayloads keeps host telemetry off merged payloads", () => {
  const base = payload({ hosts: [hostWithTelemetry(1_000)] });

  const unchanged = mergeSyncPayloads(
    base,
    payload({ hosts: [hostWithTelemetry(2_000)] }),
    payload({ hosts: [hostWithTelemetry(1_000)] }),
  );
  assert.equal(unchanged.payload.hosts[0]?.lastConnectedAt, undefined);
  assert.equal(unchanged.summary.modified.local, 0);
});
