import assert from 'node:assert/strict';
import test from 'node:test';
import { createTrustedPluginAIHostRuntime } from './trustedHostRuntime';
import { buildSelectedPluginSources, type SelectedSnapshot } from './selectedSources';

const syntheticModel = { config: { id: 'synthetic', name: 'Synthetic', providerId: 'custom' as const, enabled: true, defaultModel: 'fixture', apiKey: 'synthetic-not-a-secret' }, label: 'Synthetic model', revision: '1' };

test('renderer-owned model handles never serialize provider config and cannot cross runtimes', async () => {
  let active = true;
  const runtime = createTrustedPluginAIHostRuntime({ getModel: () => syntheticModel, prepareModel: async () => {}, chooseSelected: async () => [], isActive: () => active });
  const model = await runtime.handle('model.select', {}, 'runtime-a') as { hostHandle: string; label: string };
  assert.doesNotMatch(JSON.stringify(model), /synthetic-not-a-secret|apiKey|providerId|config/);
  await assert.rejects(runtime.handle('model.current', model, 'runtime-b'));
  assert.deepEqual(await runtime.handle('model.current', model, 'runtime-a'), { current: true });
  await runtime.handle('model.release', model, 'runtime-a');
  await assert.rejects(runtime.handle('model.current', model, 'runtime-a'));
  active = false; await assert.rejects(runtime.handle('model.select', {}, 'runtime-a')); runtime.shutdown();
});

test('selected metadata uses explicit safe projections and current resource identity', async () => {
  const session = { id: 's', hostId: 'h', hostLabel: 'Synthetic host', hostname: 'synthetic.invalid', username: 'test', status: 'connected' as const,
    password: 'NEVER_SERIALIZE_PASSWORD', privateKey: 'NEVER_SERIALIZE_KEY', startupCommand: 'NEVER_SERIALIZE_COMMAND', environmentVariables: { PRIVATE: 'NEVER_SERIALIZE_ENV' } };
  const note = { id: 'n', title: 'Synthetic Note', content: 'Synthetic note body', createdAt: 1, updatedAt: 1 };
  let snapshot: SelectedSnapshot = { activeTabId: 's', sessions: [session], workspaces: [], note };
  const sources = buildSelectedPluginSources(() => snapshot);
  assert.deepEqual(sources.map((source) => source.scope), ['tab', 'session', 'host', 'note']);
  for (const source of sources) {
    assert.equal(await source.isCurrent(), true);
    assert.doesNotMatch(await source.readText(), /NEVER_SERIALIZE/);
  }
  snapshot = { ...snapshot, activeTabId: 'another' };
  assert.equal(await sources.find((source) => source.scope === 'session')!.isCurrent(), false);
  snapshot = { ...snapshot, note: { ...note, content: 'Changed' } };
  assert.equal(await sources.find((source) => source.scope === 'note')!.isCurrent(), false);
});

test('selected summaries never read content; late resource changes and runtime release deny content', async () => {
  let current = true; let reads = 0; let resolve: (text: string) => void;
  const runtime = createTrustedPluginAIHostRuntime({ getModel: () => syntheticModel, prepareModel: async () => {}, isActive: () => true,
    chooseSelected: async () => [{ key: 'note', scope: 'note', title: 'Synthetic', version: '1', isCurrent: () => current,
      readText: () => { reads++; return new Promise<string>((r) => { resolve = r; }); } }] });
  const result = await runtime.handle('context.select', {}, 'runtime-a') as { items: Array<{ hostHandle: string; version: string }> };
  assert.equal(reads, 0); const reference = result.items[0];
  await assert.rejects(runtime.handle('context.read', reference, 'runtime-b'));
  const reading = runtime.handle('context.read', reference, 'runtime-a');
  await new Promise(setImmediate); current = false; resolve!('Late synthetic text'); await assert.rejects(reading);
  runtime.releaseRuntime('runtime-a'); await assert.rejects(runtime.handle('context.current', reference, 'runtime-a')); runtime.shutdown();
});

test('provider preparation failures and late results cannot publish a model handle after release, cancellation or model change', async () => {
  for (const action of ['failure', 'release', 'cancel', 'change', 'shutdown']) {
    let resume!: () => void; let current = syntheticModel;
    const waiting = new Promise<void>((resolve) => { resume = resolve; });
    const controller = new AbortController();
    const runtime = createTrustedPluginAIHostRuntime({ getModel: () => current, isActive: () => true, chooseSelected: async () => [],
      prepareModel: async () => { await waiting; if (action === 'failure') throw Error('Synthetic sync denied'); } });
    const selecting = runtime.handle('model.select', {}, 'runtime-a', controller.signal);
    const rejection = assert.rejects(selecting);
    if (action === 'release') runtime.releaseRuntime('runtime-a');
    if (action === 'cancel') controller.abort();
    if (action === 'change') current = { ...syntheticModel, revision: '2' };
    if (action === 'shutdown') runtime.shutdown();
    resume(); await rejection;
    await assert.rejects(runtime.handle('model.current', { hostHandle: 'not-published' }, 'runtime-a'));
    runtime.shutdown();
  }
});
