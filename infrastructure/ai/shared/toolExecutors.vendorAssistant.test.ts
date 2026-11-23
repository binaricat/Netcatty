import assert from 'node:assert/strict';
import test from 'node:test';
import { DEFAULT_COMMAND_BLOCKLIST } from '../types';
import { executeVendorAssistantAsk, executeVendorAssistantList } from './toolExecutors';

function createDeps(overrides: Record<string, unknown> = {}) {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const bridge = {
    async aiVendorAssistantAsk(vendor: string, question: string, timeoutMs?: number) {
      calls.push({ method: 'ask', args: [vendor, question, timeoutMs] });
      return { ok: true, vendor, name: 'Ruijie AZAI', status: 'ok', text: 'show ip ospf neighbor', url: 'https://example', elapsedMs: 12, error: null };
    },
    async aiVendorAssistantStatus() {
      calls.push({ method: 'status', args: [] });
      return { ok: true, profileRoot: '/profiles', vendors: [{ key: 'ruijie', name: 'Ruijie AZAI', url: '', login: 'logged', dir: '' }] };
    },
    ...overrides,
  };
  return {
    calls,
    deps: {
      bridge,
      context: { sessions: [] },
      commandBlocklist: DEFAULT_COMMAND_BLOCKLIST,
      permissionMode: 'auto' as const,
    } as never,
  };
}

test('asks the vendor assistant and reports the answer text', async () => {
  const { deps, calls } = createDeps();
  const result = await executeVendorAssistantAsk(deps, { vendor: 'ruijie', question: 'show ip ospf neighbor' });

  assert.equal(result.ok, true);
  assert.equal(result.ok && result.data.text, 'show ip ospf neighbor');
  assert.deepEqual(calls, [{ method: 'ask', args: ['ruijie', 'show ip ospf neighbor', undefined] }]);
});

test('a returned failure becomes a tool error that names the status', async () => {
  const { deps } = createDeps({
    async aiVendorAssistantAsk(vendor: string) {
      return { ok: false, vendor, name: 'Huawei WeiKnow', status: 'need_login', text: '', url: '', elapsedMs: 5, error: 'sign in first' };
    },
  });
  const result = await executeVendorAssistantAsk(deps, { vendor: 'huawei', question: 'port isolation' });

  assert.equal(result.ok, false);
  assert.match(result.ok === false ? result.error : '', /Huawei WeiKnow did not answer \(need_login\): sign in first/);
});

test('a hand-off is backfilled with web search results', async () => {
  const { deps } = createDeps({
    async aiVendorAssistantAsk(vendor: string) {
      return {
        ok: false,
        vendor,
        name: 'Ruijie AZAI',
        status: 'no_answer',
        text: '',
        url: '',
        elapsedMs: 5,
        error: 'answered with a hand-off notice only',
      };
    },
    async aiFetch() {
      return {
        ok: true,
        data: JSON.stringify({
          results: [
            { title: 'show monitor', url: 'https://example.com/span', content: 'Ruijie show monitor lists mirror sessions.' },
          ],
        }),
      };
    },
  });
  (deps as { webSearchConfig?: unknown }).webSearchConfig = {
    enabled: true,
    providerId: 'tavily',
    apiHost: 'https://search.example.com',
    apiKey: 'test-key',
    maxResults: 5,
  };

  const result = await executeVendorAssistantAsk(deps, { vendor: 'ruijie', question: '端口镜像怎么查' });

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.data.fallback, 'web_search');
  assert.equal(result.data.status, 'no_answer');
  assert.match(result.data.text, /handed this question to a human agent/);
  assert.match(result.data.text, /https:\/\/example\.com\/span/);
  assert.deepEqual(result.data.sources, [{ title: 'show monitor', url: 'https://example.com/span' }]);
});

test('a hand-off without a usable web search still reports the vendor status', async () => {
  const { deps } = createDeps({
    async aiVendorAssistantAsk(vendor: string) {
      return { ok: false, vendor, name: 'Ruijie AZAI', status: 'no_answer', text: '', url: '', elapsedMs: 5, error: 'hand-off' };
    },
  });

  const result = await executeVendorAssistantAsk(deps, { vendor: 'ruijie', question: '端口镜像怎么查' });

  assert.equal(result.ok, false);
  assert.match(result.ok === false ? result.error : '', /did not answer \(no_answer\)/);
  assert.match(result.ok === false ? result.error : '', /Web search fallback also failed/);
});

test('lists the vendors with their login state', async () => {
  const { deps } = createDeps();
  const result = await executeVendorAssistantList(deps);

  assert.equal(result.ok, true);
  assert.equal(result.ok && result.data.vendors.length, 1);
  assert.equal(result.ok && result.data.vendors[0].login, 'logged');
});

test('a bridge without the vendor API fails instead of throwing', async () => {
  const { deps } = createDeps({
    aiVendorAssistantAsk: undefined,
    aiVendorAssistantStatus: undefined,
  });
  const asked = await executeVendorAssistantAsk(deps, { vendor: 'ruijie', question: 'x' });
  const listed = await executeVendorAssistantList(deps);

  assert.equal(asked.ok, false);
  assert.equal(listed.ok, false);
});
