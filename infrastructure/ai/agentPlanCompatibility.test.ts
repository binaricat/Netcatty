import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeAnthropicSdkBaseURL } from './anthropicCompatBaseUrl';
import { buildModelDiscoveryHeaders } from './modelDiscoveryHeaders';
import { createModelFromConfig } from './sdk/providers';

const origin = 'https://ark.cn-beijing.volces.com';
const bases = ['/api/plan', '/api/plan/', '/api/plan/v1', '/api/plan/v1/'];

test('Agent Plan official Anthropic bases normalize and use Bearer discovery auth', () => {
  for (const suffix of bases) {
    const base = origin + suffix;
    assert.equal(normalizeAnthropicSdkBaseURL(base), origin + '/api/plan/v1');
    assert.deepEqual(buildModelDiscoveryHeaders('anthropic', 'fake-key', {}, base), {
      Authorization: 'Bearer fake-key', 'anthropic-version': '2023-06-01',
    });
  }
});

test('Agent Plan special handling does not change other origins, paths or protocols', () => {
  for (const base of [
    'http://ark.cn-beijing.volces.com/api/plan', origin + ':444/api/plan',
    'https://ark.cn-beijing.volces.com.example/api/plan', 'https://proxy.example/api/plan',
    origin + '/api/coding', origin + '/api/plan/v3', origin + '/api/planner',
    origin + '/api/plan?route=other', origin + '/api/plan#other',
    'https://user@ark.cn-beijing.volces.com/api/plan',
  ]) {
    assert.equal(normalizeAnthropicSdkBaseURL(base), base);
    assert.equal(buildModelDiscoveryHeaders('anthropic', 'fake-key', {}, base)['x-api-key'], 'fake-key');
  }
  assert.equal(buildModelDiscoveryHeaders('openai', 'fake-key', {}, origin + '/api/plan').Authorization, 'Bearer fake-key');
  assert.deepEqual(buildModelDiscoveryHeaders('anthropic', 'fake-key', { authorization: 'custom', 'X-Tenant': 'tenant' }, origin + '/api/plan'), {
    'anthropic-version': '2023-06-01', authorization: 'custom', 'X-Tenant': 'tenant',
  });
});

test('Agent Plan SDK stream and nonstream use the placeholder and exact messages path', async t => {
  const old = Reflect.get(globalThis, 'window');
  t.after(() => Reflect.set(globalThis, 'window', old));
  const requests: {url: string; headers: Headers}[] = [];
  const capture = (url: string, headers: Record<string,string>) => requests.push({ url, headers: new Headers(headers) });
  Reflect.set(globalThis, 'window', { netcatty: {
    aiFetch: async (url: string, _method: string, headers: Record<string,string>) => {
      capture(url, headers); return { ok: false, status: 400, data: '{"error":{"message":"captured"}}' };
    },
    aiChatStream: async (_id: string, url: string, headers: Record<string,string>) => {
      capture(url, headers); return { ok: false, error: 'captured' };
    },
    onAiStreamData: () => () => {}, onAiStreamEnd: () => () => {}, onAiStreamError: () => () => {},
  }});
  for (const suffix of bases) {
    for (const streaming of [false, true]) {
      const model = createModelFromConfig({id:'p',providerId:'custom',name:'Test',enabled:true,style:'anthropic',apiKey:'not-a-real-secret',baseURL:origin+suffix,defaultModel:'test-model',customHeaders:{'X-Tenant':'tenant'}});
      const params = {prompt:[{role:'user' as const,content:[{type:'text' as const,text:'hello'}]}]};
      if (streaming) {
        try { const result = await model.doStream(params); await result.stream.pipeTo(new WritableStream()); } catch { /* deliberately rejected at IPC boundary */ }
      } else await assert.rejects(Promise.resolve(model.doGenerate(params)));
      const request = requests.at(-1)!;
      assert.equal(request.url, origin + '/api/plan/v1/messages');
      assert.equal(request.headers.get('authorization'), 'Bearer __IPC_SECURED__');
      assert.equal(request.headers.get('x-api-key'), null);
      assert.equal(request.headers.get('x-tenant'), 'tenant');
      assert.ok(!JSON.stringify([...request.headers]).includes('not-a-real-secret'));
    }
  }
  assert.equal(requests.length, 8);
});

test('Agent Plan Detect sends Bearer on the same origin without treating missing model listing as valid auth', async () => {
  const { probeProviderConnection } = await import('./providerConnectionProbe');
  const requests: {url: string; headers?: Record<string,string>}[] = [];
  for (const suffix of bases) {
    const result = await probeProviderConnection({
      baseURL: origin + suffix, apiKey: 'fake-key', providerId: 'custom', style: 'anthropic',
      customHeaders: { 'X-Tenant': 'tenant' },
      bridge: { aiFetch: async (url, _method, headers) => {
        requests.push({url, headers});
        return {ok:false,status:404,data:'not found'};
      } },
    });
    assert.equal(result.ok, true, 'probe ran, not an assertion that authentication succeeded');
    if (result.ok) {
      assert.equal(result.classification.statusCode, 404);
      assert.equal(result.classification.health, 'error');
    }
    assert.equal(requests.at(-1)?.url, origin + '/api/plan/v1/models');
    assert.equal(requests.at(-1)?.headers?.Authorization, 'Bearer fake-key');
    assert.equal(requests.at(-1)?.headers?.['x-api-key'], undefined);
    assert.equal(requests.at(-1)?.headers?.['X-Tenant'], 'tenant');
  }
});
