import assert from 'node:assert/strict';
import test from 'node:test';

import { sanitizeHost } from '../host.ts';
import type { SyncFileMeta, SyncPayload } from '../sync.ts';
import {
  applyConvergentMutations,
  assertConvergentSyncWriteCompatible,
  applyLegacySyncPayload,
  cloudSyncPayloadsEqual,
  createConvergentSyncEnvelope,
  createConvergentSyncStateFromPayload,
  diffLegacySyncPayload,
  hydrateConvergentSyncEnvelope,
  materializeSyncPayloadFromConvergentState,
  mergeConvergentSyncStates,
  planConvergentSyncMigration,
  serializeConvergentSyncState,
  validateConvergentSyncPayload,
  withConvergentSyncEnvelope,
  createConvergentSyncState,
} from './index.ts';

const NOW = 1_700_000_000_000;

function payload(label = 'Production'): SyncPayload {
  return {
    hosts: [{
      id: 'host-1',
      label,
      hostname: 'example.com',
      username: 'root',
      tags: ['prod'],
      os: 'linux',
      password: 'host-secret',
    }],
    keys: [{
      id: 'key-1',
      label: 'Deploy key',
      type: 'ED25519',
      privateKey: 'private-secret',
      source: 'imported',
      category: 'key',
      created: NOW,
    }],
    identities: [],
    proxyProfiles: [],
    snippets: [],
    customGroups: ['prod'],
    snippetPackages: [],
    notes: [],
    noteGroups: [],
    portForwardingRules: [],
    groupConfigs: [],
    settings: {
      theme: 'dark',
      ai: { providers: [{ id: 'provider-1', apiKey: 'api-secret' }] },
    },
    syncedAt: NOW,
  };
}

function emptyPayload(settings?: SyncPayload['settings']): SyncPayload {
  return {
    hosts: [],
    keys: [],
    identities: [],
    proxyProfiles: [],
    snippets: [],
    customGroups: [],
    snippetPackages: [],
    notes: [],
    noteGroups: [],
    portForwardingRules: [],
    groupConfigs: [],
    settings,
    syncedAt: NOW,
  };
}

function meta(overrides: Partial<SyncFileMeta> = {}): SyncFileMeta {
  return {
    version: 1,
    updatedAt: NOW,
    deviceId: 'remote-device',
    appVersion: '1.0.0',
    iv: 'iv',
    salt: 'salt',
    algorithm: 'AES-256-GCM',
    kdf: 'PBKDF2',
    ...overrides,
  };
}

test('encrypted envelope omits materialized winner values and hydrates exactly', () => {
  const state = createConvergentSyncStateFromPayload(payload(), 'device-a', NOW);
  const materialized = materializeSyncPayloadFromConvergentState(state, { syncedAt: NOW });
  const envelope = createConvergentSyncEnvelope(state, materialized);
  const envelopeJson = JSON.stringify(envelope);

  assert.equal(envelopeJson.includes('host-secret'), false);
  assert.equal(envelopeJson.includes('private-secret'), false);
  assert.equal(envelopeJson.includes('api-secret'), false);
  assert.match(JSON.stringify(materialized), /private-secret/);
  assert.equal(
    serializeConvergentSyncState(hydrateConvergentSyncEnvelope(envelope, materialized)),
    serializeConvergentSyncState(state),
  );
});

test('envelope creation and hydration reject a materialized snapshot that disagrees with state', () => {
  const state = createConvergentSyncStateFromPayload(payload('State value'), 'device-a', NOW);
  const mismatched = payload('Different snapshot value');
  assert.throws(
    () => createConvergentSyncEnvelope(state, mismatched),
    /does not match its materialized v1 snapshot/,
  );
  const materialized = materializeSyncPayloadFromConvergentState(state, { syncedAt: NOW });
  const envelope = createConvergentSyncEnvelope(state, materialized);
  const damaged = structuredClone(envelope);
  const labelRegister = damaged.state.collections.hosts.entities['host-1'].fields.label;
  const selected = labelRegister.candidates.find(
    (candidate) => 'materialized' in candidate && candidate.materialized === true,
  );
  assert.ok(selected);
  const damagedCandidate = selected as unknown as { materialized?: true; value?: string };
  delete damagedCandidate.materialized;
  damagedCandidate.value = 'Envelope-only value';
  assert.throws(
    () => hydrateConvergentSyncEnvelope(damaged, materialized),
    /does not match its materialized v1 snapshot/,
  );
});

test('envelope maps preserve prototype-like entity, field, setting, and string identifiers', () => {
  const specialObject = JSON.parse('{"id":"__proto__","constructor":"safe"}') as {
    id: string;
    constructor: string;
  };
  const state = applyConvergentMutations(createConvergentSyncState(), 'device-a', [
    {
      kind: 'entity-upsert',
      collection: 'hosts',
      entityId: '__proto__',
      value: specialObject,
      position: 0,
    },
    { kind: 'setting-set', path: ['__proto__'], value: 'safe-setting' },
    { kind: 'string-entry-add', collection: 'customGroups', value: '__proto__', position: 0 },
  ], NOW);
  const materialized = materializeSyncPayloadFromConvergentState(state, { syncedAt: NOW });
  const envelope = createConvergentSyncEnvelope(state, materialized);
  const hydrated = hydrateConvergentSyncEnvelope(
    JSON.parse(JSON.stringify(envelope)),
    JSON.parse(JSON.stringify(materialized)),
  );

  assert.equal(serializeConvergentSyncState(hydrated), serializeConvergentSyncState(state));
});

test('envelope retains concurrent alternatives while the selected winner remains materialized', () => {
  const base = createConvergentSyncStateFromPayload(payload('Base'), 'seed', NOW);
  const left = applyConvergentMutations(base, 'device-a', [{
    kind: 'entity-field-set',
    collection: 'hosts',
    entityId: 'host-1',
    field: 'label',
    value: 'Left alternative',
  }], NOW + 1);
  const right = applyConvergentMutations(base, 'device-z', [{
    kind: 'entity-field-set',
    collection: 'hosts',
    entityId: 'host-1',
    field: 'label',
    value: 'Right winner',
  }], NOW + 1);
  const state = mergeConvergentSyncStates(left, right);
  const materialized = materializeSyncPayloadFromConvergentState(state, { syncedAt: NOW + 1 });
  const envelopeJson = JSON.stringify(createConvergentSyncEnvelope(state, materialized));

  assert.match(envelopeJson, /Left alternative/);
  assert.equal(envelopeJson.includes('Right winner'), false);
});

test('schema validation fails closed for missing, mismatched, future, and damaged envelopes', () => {
  const state = createConvergentSyncStateFromPayload(payload(), 'device-a', NOW);
  const v2 = withConvergentSyncEnvelope(state, { syncedAt: NOW });
  assert.equal(
    serializeConvergentSyncState(validateConvergentSyncPayload(meta({ syncSchemaVersion: 2 }), v2)!),
    serializeConvergentSyncState(state),
  );
  assert.throws(
    () => validateConvergentSyncPayload(meta(), v2),
    /without schema metadata/,
  );
  assert.throws(
    () => validateConvergentSyncPayload(meta({ syncSchemaVersion: 2 }), payload()),
    /missing its convergent envelope/,
  );
  assert.throws(
    () => validateConvergentSyncPayload(
      { ...meta(), syncSchemaVersion: 3 } as unknown as SyncFileMeta,
      payload(),
    ),
    /Unsupported sync schema version/,
  );
  const damaged = structuredClone(v2);
  damaged.convergentSync!.state.vector['device-a'] = 999;
  assert.throws(
    () => validateConvergentSyncPayload(meta({ syncSchemaVersion: 2 }), damaged),
    /not witnessed|cover every counter/,
  );
});

test('legacy writers cannot silently overwrite convergent or future cloud schemas', () => {
  const state = createConvergentSyncStateFromPayload(payload(), 'device-a', NOW);
  const v2 = withConvergentSyncEnvelope(state, { syncedAt: NOW });
  assert.doesNotThrow(() => assertConvergentSyncWriteCompatible(meta(), payload()));
  assert.doesNotThrow(() => assertConvergentSyncWriteCompatible(
    meta({ syncSchemaVersion: 2 }),
    v2,
  ));
  assert.throws(
    () => assertConvergentSyncWriteCompatible(meta({ syncSchemaVersion: 2 }), payload()),
    /Enable or migrate convergent sync/,
  );
  assert.throws(
    () => assertConvergentSyncWriteCompatible(
      { syncSchemaVersion: 3 } as unknown as SyncFileMeta,
      v2,
    ),
    /unsupported sync schema/,
  );
});

test('trusted legacy diff becomes causal CRDT writes without carrying transport metadata', () => {
  const baseline = payload('Before');
  const state = createConvergentSyncStateFromPayload(baseline, 'seed', NOW);
  const legacy = {
    ...payload('After'),
    keys: [],
    syncedAt: NOW + 100,
  };
  const next = applyLegacySyncPayload(
    state,
    baseline,
    legacy,
    'legacy:github:remote-device',
    NOW + 100,
  );
  const materialized = materializeSyncPayloadFromConvergentState(next, { syncedAt: NOW + 100 });

  assert.equal(materialized.hosts[0].label, 'After');
  assert.deepEqual(materialized.keys, []);
  assert.equal(cloudSyncPayloadsEqual(materialized, legacy), true);
});

test('payload and legacy conversion normalize undefined fields with JSON semantics', () => {
  const baseline = payload('Before');
  baseline.hosts = [sanitizeHost({
    ...baseline.hosts[0],
    proxyConfig: {
      type: 'http',
      host: 'proxy.example.com',
      port: 8080,
      username: undefined,
    },
  })];
  assert.equal(Object.hasOwn(baseline.hosts[0], 'iconMode'), true);
  assert.equal(Object.hasOwn(baseline.hosts[0].proxyConfig!, 'username'), true);

  const state = createConvergentSyncStateFromPayload(baseline, 'seed', NOW);
  const initial = materializeSyncPayloadFromConvergentState(state, { syncedAt: NOW });
  assert.equal(Object.hasOwn(initial.hosts[0], 'iconMode'), false);
  assert.equal(Object.hasOwn(initial.hosts[0].proxyConfig!, 'username'), false);

  const legacy: SyncPayload = {
    ...baseline,
    hosts: [{ ...baseline.hosts[0], label: 'After' }],
    syncedAt: NOW + 1,
  };
  const next = applyLegacySyncPayload(
    state,
    baseline,
    legacy,
    'legacy:github:remote-device',
    NOW + 1,
  );
  const materialized = materializeSyncPayloadFromConvergentState(next, { syncedAt: NOW + 1 });

  assert.equal(materialized.hosts[0].label, 'After');
  assert.equal(Object.hasOwn(materialized.hosts[0], 'iconMode'), false);
  assert.equal(Object.hasOwn(materialized.hosts[0].proxyConfig!, 'username'), false);
});

test('trusted legacy diff treats own undefined optional fields as omitted', () => {
  const baseline = payload();
  baseline.identities = [{
    id: 'identity-1',
    label: 'Production identity',
    username: 'root',
    authMethod: 'password',
    password: 'identity-secret',
    created: NOW,
  }];
  baseline.noteGroups = ['operations'];
  const legacy = {
    ...baseline,
    identities: undefined,
    noteGroups: undefined,
    settings: undefined,
    syncedAt: NOW + 1,
  } as unknown as SyncPayload;

  assert.deepEqual(diffLegacySyncPayload(baseline, legacy), []);

  const state = createConvergentSyncStateFromPayload(baseline, 'seed', NOW);
  const next = applyLegacySyncPayload(
    state,
    baseline,
    legacy,
    'legacy:github:remote-device',
    NOW + 1,
  );
  const materialized = materializeSyncPayloadFromConvergentState(next, { syncedAt: NOW + 1 });

  assert.equal(materialized.identities?.[0]?.id, 'identity-1');
  assert.deepEqual(materialized.noteGroups, ['operations']);
  assert.equal(materialized.settings?.theme, 'dark');
});

test('payload conversion still rejects entities that JSON cannot serialize', () => {
  const invalid = payload();
  const circular: Record<string, unknown> = {};
  circular.self = circular;
  (invalid.hosts[0] as unknown as Record<string, unknown>).invalid = circular;

  assert.throws(
    () => createConvergentSyncStateFromPayload(invalid, 'seed', NOW),
    /cannot be represented as JSON/,
  );
});

test('trusted legacy diff preserves reorder-only entity and string collection edits', () => {
  const baseline = payload();
  baseline.hosts.push({
    ...baseline.hosts[0],
    id: 'host-2',
    label: 'Staging',
    hostname: 'staging.example.com',
  });
  baseline.customGroups = ['prod', 'staging'];
  const state = createConvergentSyncStateFromPayload(baseline, 'seed', NOW);
  const legacy: SyncPayload = {
    ...baseline,
    hosts: [baseline.hosts[1], baseline.hosts[0]],
    customGroups: ['staging', 'prod'],
    syncedAt: NOW + 1,
  };

  const next = applyLegacySyncPayload(
    state,
    baseline,
    legacy,
    'legacy:github:remote-device',
    NOW + 1,
  );
  const materialized = materializeSyncPayloadFromConvergentState(next, { syncedAt: NOW + 1 });

  assert.deepEqual(materialized.hosts.map((host) => host.id), ['host-2', 'host-1']);
  assert.deepEqual(materialized.customGroups, ['staging', 'prod']);
  assert.equal(cloudSyncPayloadsEqual(materialized, legacy), true);
});

test('v1-only migration previews and creates a backward-compatible v2 payload', () => {
  const local = payload();
  const remote = {
    ...payload(),
    snippets: [{ id: 'snippet-1', label: 'List', command: 'ls' }],
  };
  const plan = planConvergentSyncMigration({
    localPayload: local,
    localTrustedBaseline: null,
    providers: [{
      provider: 'github',
      status: 'ready',
      meta: meta(),
      payload: remote,
      trustedBaseline: local,
    }],
    deviceId: 'local-device',
    now: NOW + 1,
  });

  assert.equal(plan.preview.canInitialize, true);
  assert.equal(plan.preview.oldClientCompatibility, 'materialized-v1-snapshot');
  assert.equal(plan.payload?.snippets.length, 1);
  assert.equal(plan.payload?.convergentSync?.schemaVersion, 2);
});

test('a fresh entity-empty device adopts v1 cloud settings instead of merging local defaults', () => {
  const remote = payload('Remote');
  remote.settings = { theme: 'dark' };
  const plan = planConvergentSyncMigration({
    localPayload: emptyPayload({ theme: 'light' }),
    localTrustedBaseline: null,
    providers: [{
      provider: 'github',
      status: 'ready',
      meta: meta(),
      payload: remote,
      trustedBaseline: null,
    }],
    deviceId: 'fresh-device',
    now: NOW + 1,
  });

  assert.equal(plan.preview.canInitialize, true);
  assert.equal(plan.payload?.hosts[0].label, 'Remote');
  assert.equal(plan.payload?.settings?.theme, 'dark');
});

test('v1-only migration blocks divergent provider data without a trusted baseline', () => {
  const local = payload('Stale local host');
  const remote = emptyPayload();
  const plan = planConvergentSyncMigration({
    localPayload: local,
    localTrustedBaseline: null,
    providers: [{
      provider: 'github',
      status: 'ready',
      meta: meta(),
      payload: remote,
      trustedBaseline: null,
    }],
    deviceId: 'local-device',
    now: NOW + 1,
  });

  assert.equal(plan.preview.canInitialize, false);
  assert.match(plan.preview.blockedReasons.join(' '), /github: no trusted legacy baseline/);
  assert.equal(plan.payload, null);
});

test('v1-only migration accepts matching provider data without a trusted baseline', () => {
  const local = payload('Matching host');
  const plan = planConvergentSyncMigration({
    localPayload: local,
    localTrustedBaseline: null,
    providers: [{
      provider: 'github',
      status: 'ready',
      meta: meta(),
      payload: structuredClone(local),
      trustedBaseline: null,
    }],
    deviceId: 'local-device',
    now: NOW + 1,
  });

  assert.equal(plan.preview.canInitialize, true);
  assert.equal(plan.payload?.hosts[0]?.label, 'Matching host');
});

test('a fresh device still blocks a shrunk v1 provider used as the migration seed', () => {
  const baseline = payload('Base');
  baseline.hosts = Array.from({ length: 4 }, (_, index) => ({
    ...baseline.hosts[0],
    id: `host-${index + 1}`,
    label: `Host ${index + 1}`,
  }));
  const remote: SyncPayload = {
    ...baseline,
    hosts: baseline.hosts.slice(0, 1),
    syncedAt: NOW + 1,
  };
  const plan = planConvergentSyncMigration({
    localPayload: emptyPayload(),
    localTrustedBaseline: null,
    providers: [{
      provider: 'github',
      status: 'ready',
      meta: meta(),
      payload: remote,
      trustedBaseline: baseline,
    }],
    deviceId: 'fresh-device',
    now: NOW + 1,
  });

  assert.equal(plan.preview.canInitialize, false);
  assert.equal(plan.preview.shrinkFindings[0]?.provider, 'github');
  assert.equal(plan.preview.shrinkFindings[0]?.finding.lost, 3);
  assert.match(plan.preview.blockedReasons.join(' '), /remove too many entities/);
});

test('migration blocks unresolved v1 conflicts and future provider schemas', () => {
  const baseline = payload('Base');
  const conflict = planConvergentSyncMigration({
    localPayload: payload('Local'),
    localTrustedBaseline: baseline,
    providers: [{
      provider: 'github',
      status: 'ready',
      meta: meta(),
      payload: payload('Remote'),
      trustedBaseline: baseline,
    }],
    deviceId: 'local-device',
    now: NOW + 1,
  });
  assert.equal(conflict.preview.canInitialize, false);
  assert.match(conflict.preview.blockedReasons.join(' '), /unresolved conflicts/);

  const future = planConvergentSyncMigration({
    localPayload: baseline,
    localTrustedBaseline: null,
    providers: [{
      provider: 'github',
      status: 'ready',
      meta: { ...meta(), syncSchemaVersion: 3 } as unknown as SyncFileMeta,
      payload: baseline,
      trustedBaseline: null,
    }],
    deviceId: 'local-device',
    now: NOW + 1,
  });
  assert.equal(future.preview.canInitialize, false);
  assert.equal(future.preview.providers[0].schemaVersion, 'future');
});

test('joining existing v2 data blocks changed legacy writers without a trusted baseline', () => {
  const remoteState = createConvergentSyncStateFromPayload(payload('Remote'), 'remote', NOW);
  const remotePayload = withConvergentSyncEnvelope(remoteState, { syncedAt: NOW });
  const plan = planConvergentSyncMigration({
    localPayload: payload('Unbased local edit'),
    localTrustedBaseline: null,
    providers: [{
      provider: 'github',
      status: 'ready',
      meta: meta({ syncSchemaVersion: 2 }),
      payload: remotePayload,
      trustedBaseline: null,
    }],
    deviceId: 'local-device',
    now: NOW + 1,
  });

  assert.equal(plan.preview.canInitialize, false);
  assert.match(plan.preview.blockedReasons.join(' '), /no trusted legacy baseline/);
});

test('joining existing v2 data blocks a shrunk legacy local source', () => {
  const baseline = payload('Remote');
  baseline.hosts = Array.from({ length: 4 }, (_, index) => ({
    ...baseline.hosts[0],
    id: `host-${index + 1}`,
    label: `Host ${index + 1}`,
  }));
  const local: SyncPayload = {
    ...baseline,
    hosts: baseline.hosts.slice(0, 1),
    syncedAt: NOW + 1,
  };
  const remoteState = createConvergentSyncStateFromPayload(baseline, 'remote', NOW);
  const plan = planConvergentSyncMigration({
    localPayload: local,
    localTrustedBaseline: baseline,
    providers: [{
      provider: 'github',
      status: 'ready',
      meta: meta({ syncSchemaVersion: 2 }),
      payload: withConvergentSyncEnvelope(remoteState, { syncedAt: NOW }),
      trustedBaseline: null,
    }],
    deviceId: 'local-device',
    now: NOW + 1,
  });

  assert.equal(plan.preview.canInitialize, false);
  assert.match(plan.preview.blockedReasons.join(' '), /legacy-local:local-device.*remove too many entities/);
});

test('joining existing v2 data blocks a shrunk legacy provider source', () => {
  const baseline = payload('Remote');
  baseline.hosts = Array.from({ length: 4 }, (_, index) => ({
    ...baseline.hosts[0],
    id: `host-${index + 1}`,
    label: `Host ${index + 1}`,
  }));
  const legacy: SyncPayload = {
    ...baseline,
    hosts: baseline.hosts.slice(0, 1),
    syncedAt: NOW + 1,
  };
  const remoteState = createConvergentSyncStateFromPayload(baseline, 'remote', NOW);
  const plan = planConvergentSyncMigration({
    localPayload: emptyPayload(),
    localTrustedBaseline: null,
    providers: [
      {
        provider: 'github',
        status: 'ready',
        meta: meta({ syncSchemaVersion: 2 }),
        payload: withConvergentSyncEnvelope(remoteState, { syncedAt: NOW }),
        trustedBaseline: null,
      },
      {
        provider: 'webdav',
        status: 'ready',
        meta: meta({ deviceId: 'legacy-device' }),
        payload: legacy,
        trustedBaseline: baseline,
      },
    ],
    deviceId: 'fresh-device',
    now: NOW + 1,
  });

  assert.equal(plan.preview.canInitialize, false);
  assert.equal(plan.preview.shrinkFindings[0]?.provider, 'webdav');
  assert.equal(plan.preview.shrinkFindings[0]?.finding.lost, 3);
});

test('v2 migration shrink checks preserve optional collections omitted by legacy clients', () => {
  const baseline = payload('Remote');
  baseline.identities = Array.from({ length: 4 }, (_, index) => ({
    id: `identity-${index + 1}`,
    label: `Identity ${index + 1}`,
    username: `user-${index + 1}`,
    authMethod: 'password' as const,
    created: NOW,
  }));
  const local = {
    ...baseline,
    identities: undefined,
    syncedAt: NOW + 1,
  } as unknown as SyncPayload;
  const remoteState = createConvergentSyncStateFromPayload(baseline, 'remote', NOW);
  const plan = planConvergentSyncMigration({
    localPayload: local,
    localTrustedBaseline: baseline,
    providers: [{
      provider: 'github',
      status: 'ready',
      meta: meta({ syncSchemaVersion: 2 }),
      payload: withConvergentSyncEnvelope(remoteState, { syncedAt: NOW }),
      trustedBaseline: null,
    }],
    deviceId: 'local-device',
    now: NOW + 1,
  });

  assert.equal(plan.preview.canInitialize, true);
  assert.equal(plan.preview.shrinkFindings.length, 0);
  assert.equal(plan.payload?.identities?.length, 4);
});

test('a fresh entity-empty device adopts existing v2 data without a trusted baseline', () => {
  const remoteState = createConvergentSyncStateFromPayload(payload('Remote'), 'remote', NOW);
  const remotePayload = withConvergentSyncEnvelope(remoteState, { syncedAt: NOW });
  const plan = planConvergentSyncMigration({
    localPayload: emptyPayload({ theme: 'light' }),
    localTrustedBaseline: null,
    providers: [{
      provider: 'github',
      status: 'ready',
      meta: meta({ syncSchemaVersion: 2 }),
      payload: remotePayload,
      trustedBaseline: null,
    }],
    deviceId: 'fresh-device',
    now: NOW + 1,
  });

  assert.equal(plan.preview.canInitialize, true);
  assert.equal(plan.payload?.hosts[0].label, 'Remote');
  assert.equal(plan.payload?.settings?.theme, 'dark');
});

test('an empty local snapshot with a trusted baseline remains a real deletion', () => {
  const baseline = payload('Remote');
  const remoteState = createConvergentSyncStateFromPayload(baseline, 'remote', NOW);
  const remotePayload = withConvergentSyncEnvelope(remoteState, { syncedAt: NOW });
  const plan = planConvergentSyncMigration({
    localPayload: emptyPayload(),
    localTrustedBaseline: baseline,
    providers: [{
      provider: 'github',
      status: 'ready',
      meta: meta({ syncSchemaVersion: 2 }),
      payload: remotePayload,
      trustedBaseline: null,
    }],
    deviceId: 'legacy-device',
    now: NOW + 1,
  });

  assert.equal(plan.preview.canInitialize, true);
  assert.deepEqual(plan.payload?.hosts, []);
});
