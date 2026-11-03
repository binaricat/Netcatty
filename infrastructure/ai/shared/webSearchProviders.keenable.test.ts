import test from 'node:test';
import assert from 'node:assert/strict';

import { executeWebSearchProvider } from './webSearchProviders';
import { isWebSearchReady } from '../types';

test('Keenable uses the keyless public endpoint and maps description then snippet', async () => {
  const calls: Array<{ url: string; method: string; headers: Record<string, string>; body?: string }> = [];
  const bridge = {
    aiFetch: async (url: string, method: string, headers: Record<string, string>, body?: string) => {
      calls.push({ url, method, headers, body });
      return {
        ok: true,
        data: JSON.stringify({
          results: [
            { title: 'A', url: 'https://a.example/', description: 'd', snippet: 's' },
            { title: 'B', url: 'https://b.example/', snippet: 'x'.repeat(900) },
          ],
        }),
      };
    },
  };

  const results = await executeWebSearchProvider(
    bridge as never,
    { providerId: 'keenable', enabled: true },
    'netcatty',
    3,
  );

  assert.equal(calls[0].url, 'https://api.keenable.ai/v1/search/public');
  assert.equal(calls[0].method, 'POST');
  assert.equal(calls[0].headers['X-Keenable-Title'], 'Netcatty');
  assert.equal(calls[0].headers.Authorization, undefined);
  assert.deepEqual(JSON.parse(calls[0].body ?? '{}'), { query: 'netcatty', max_results: 3 });
  assert.deepEqual(results, [
    { title: 'A', url: 'https://a.example/', content: 'd' },
    { title: 'B', url: 'https://b.example/', content: 'x'.repeat(500) },
  ]);
});

test('Keenable is ready without an API key', () => {
  assert.equal(isWebSearchReady({ providerId: 'keenable', enabled: true }), true);
});
