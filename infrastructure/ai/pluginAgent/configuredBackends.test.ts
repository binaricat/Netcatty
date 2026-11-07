import test from 'node:test';
import assert from 'node:assert/strict';
import { ConfiguredPluginAgentBackends, getConfiguredCattyAgentModel, prepareConfiguredCattyAgentModel } from './configuredBackends';
import * as keys from '../../config/storageKeys';

const config = { id: 'synthetic', name: 'Synthetic', providerId: 'custom' as const, enabled: true, defaultModel: 'fixture', apiKey: 'FIXTURE_ONLY_MARKER' };
test('Catty backend follows existing Agent overrides and syncs host configuration without opening the sidebar', async (t) => {
  const values = new Map<string, string>(); const old = Object.getOwnPropertyDescriptor(globalThis, 'localStorage'); const windowOld = Object.getOwnPropertyDescriptor(globalThis, 'window');
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { getItem: (key: string) => values.get(key) ?? null } });
  const providers = [config, { ...config, id: 'override', name: 'Override', defaultModel: 'override-default' }];
  values.set(keys.STORAGE_KEY_AI_PROVIDERS, JSON.stringify(providers)); values.set(keys.STORAGE_KEY_AI_ACTIVE_PROVIDER, config.id);
  values.set(keys.STORAGE_KEY_AI_ACTIVE_MODEL, 'active-only');
  values.set(keys.STORAGE_KEY_AI_AGENT_PROVIDER_MAP, JSON.stringify({ catty: 'override' }));
  values.set(keys.STORAGE_KEY_AI_AGENT_MODEL_MAP, JSON.stringify({ catty: 'agent-specific' }));
  let syncs = 0;
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { netcatty: { aiSyncProviders: async (items: unknown[]) => {
    assert.deepEqual(items, providers); syncs++; return { ok: true };
  } } } });
  t.after(() => { for (const [key, descriptor] of [['localStorage', old], ['window', windowOld]] as const) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key);
  } });
  const selected = getConfiguredCattyAgentModel()!; assert.equal(selected.config.id, 'override'); assert.equal(selected.config.defaultModel, 'agent-specific');
  await prepareConfiguredCattyAgentModel(selected.revision); assert.equal(syncs, 1);
  values.set(keys.STORAGE_KEY_AI_AGENT_MODEL_MAP, JSON.stringify({ catty: 'changed' })); await assert.rejects(prepareConfiguredCattyAgentModel(selected.revision));
  assert.equal(syncs, 1);
});

test('backend refs isolate runtimes, expire with controlled time and invalidate native/model configuration changes', () => {
  let time = 1; let revision = '1'; let externalModel = 'synthetic-native-model';
  const external = { id: 'claude-local', name: 'Claude synthetic', command: '/synthetic/claude', enabled: true, available: true, sdkBackend: 'claude', env: { PRIVATE: 'PRIVATE_ENV' } };
  const backends = new ConfiguredPluginAgentBackends({ getModel: () => ({ config, label: 'Synthetic', revision }),
    prepareModel: async () => {}, getExternal: () => [external, { ...external, id: 'codex', sdkBackend: 'codex' }],
    getExternalModel: () => externalModel, clock: () => time });
  const rows = backends.list('r1'); const catty = rows.find((item) => item.backend === 'catty')!; const claude = rows.find((item) => item.backend === 'claude')!;
  assert.doesNotMatch(JSON.stringify(rows), /FIXTURE_ONLY_MARKER|PRIVATE_ENV|apiKey|command|env|claude-local|synthetic-native-model/);
  assert.equal(rows.find((item) => item.backend === 'codex')?.status, 'unsupported');
  assert.equal(backends.resolve(claude.hostHandle, 'r1').selectedModel, externalModel);
  assert.throws(() => backends.resolve(catty.hostHandle, 'r2'));
  revision = '2'; assert.throws(() => backends.resolve(catty.hostHandle, 'r1'));
  externalModel = 'changed'; assert.throws(() => backends.resolve(claude.hostHandle, 'r1'));
  const next = backends.list('r1').find((item) => item.backend === 'catty')!;
  time += 300_001; assert.throws(() => backends.resolve(next.hostHandle, 'r1'));
  const refreshed = backends.list('r1').find((item) => item.backend === 'catty')!; assert.notEqual(refreshed.hostHandle, next.hostHandle);
  backends.releaseRuntime('r1'); assert.throws(() => backends.resolve(refreshed.hostHandle, 'r1')); backends.shutdown();
});
