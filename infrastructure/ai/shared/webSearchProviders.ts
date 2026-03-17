/**
 * Web search provider implementations.
 *
 * Each provider function normalises its API response into a common
 * `{ results: Array<{ title, url, content }> }` shape so callers don't need
 * to know about provider-specific quirks.
 *
 * All HTTP requests go through `bridge.aiFetch()` to avoid CORS issues in the
 * renderer process.
 */

import type { NetcattyBridge } from '../cattyAgent/executor';
import type { WebSearchConfig } from '../types';
import { WEB_SEARCH_PROVIDER_PRESETS } from '../types';

export interface WebSearchResult {
  title: string;
  url: string;
  content: string;
}

interface BridgeFetchResponse {
  ok: boolean;
  status?: number;
  data?: string;
  error?: string;
}

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

function resolveApiHost(config: WebSearchConfig): string {
  return config.apiHost || WEB_SEARCH_PROVIDER_PRESETS[config.providerId].defaultApiHost;
}

async function fetchJson(
  bridge: NetcattyBridge,
  url: string,
  method: string,
  headers: Record<string, string>,
  body?: string,
): Promise<unknown> {
  const aiFetch = (bridge as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>).aiFetch;
  if (!aiFetch) throw new Error('aiFetch is not available on the bridge');
  // skipHostCheck=true: search provider hosts are known-safe API endpoints
  const resp = await aiFetch(url, method, headers, body, undefined, true) as BridgeFetchResponse;
  if (!resp.ok) throw new Error(resp.error || `HTTP ${resp.status}`);
  return JSON.parse(resp.data || '{}');
}

// ---------------------------------------------------------------------------
// Tavily
// ---------------------------------------------------------------------------

async function searchTavily(
  bridge: NetcattyBridge,
  config: WebSearchConfig,
  query: string,
  maxResults: number,
): Promise<WebSearchResult[]> {
  const host = resolveApiHost(config);
  const data = await fetchJson(bridge, `${host}/search`, 'POST', {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${config.apiKey}`,
  }, JSON.stringify({
    query,
    max_results: maxResults,
    search_depth: 'basic',
  })) as { results?: Array<{ title?: string; url?: string; content?: string }> };

  return (data.results || []).map(r => ({
    title: r.title || '',
    url: r.url || '',
    content: r.content || '',
  }));
}

// ---------------------------------------------------------------------------
// Exa
// ---------------------------------------------------------------------------

async function searchExa(
  bridge: NetcattyBridge,
  config: WebSearchConfig,
  query: string,
  maxResults: number,
): Promise<WebSearchResult[]> {
  const host = resolveApiHost(config);
  const data = await fetchJson(bridge, `${host}/search`, 'POST', {
    'Content-Type': 'application/json',
    'x-api-key': config.apiKey || '',
  }, JSON.stringify({
    query,
    numResults: maxResults,
    contents: { text: true },
  })) as { results?: Array<{ title?: string; url?: string; text?: string }> };

  return (data.results || []).map(r => ({
    title: r.title || '',
    url: r.url || '',
    content: r.text || '',
  }));
}

// ---------------------------------------------------------------------------
// Bocha
// ---------------------------------------------------------------------------

async function searchBocha(
  bridge: NetcattyBridge,
  config: WebSearchConfig,
  query: string,
  maxResults: number,
): Promise<WebSearchResult[]> {
  const host = resolveApiHost(config);
  const data = await fetchJson(bridge, `${host}/v1/web-search`, 'POST', {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${config.apiKey}`,
  }, JSON.stringify({
    query,
    count: maxResults,
    summary: true,
  })) as { webPages?: { value?: Array<{ name?: string; url?: string; snippet?: string; summary?: string }> } };

  return (data.webPages?.value || []).map(r => ({
    title: r.name || '',
    url: r.url || '',
    content: r.summary || r.snippet || '',
  }));
}

// ---------------------------------------------------------------------------
// Zhipu
// ---------------------------------------------------------------------------

async function searchZhipu(
  bridge: NetcattyBridge,
  config: WebSearchConfig,
  query: string,
  _maxResults: number,
): Promise<WebSearchResult[]> {
  const host = resolveApiHost(config);
  const data = await fetchJson(bridge, `${host}/web_search`, 'POST', {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${config.apiKey}`,
  }, JSON.stringify({
    search_query: query,
    search_engine: 'search_std',
  })) as { search_result?: Array<{ title?: string; link?: string; content?: string }> };

  return (data.search_result || []).map(r => ({
    title: r.title || '',
    url: r.link || '',
    content: r.content || '',
  }));
}

// ---------------------------------------------------------------------------
// SearXNG
// ---------------------------------------------------------------------------

async function searchSearxng(
  bridge: NetcattyBridge,
  config: WebSearchConfig,
  query: string,
  _maxResults: number,
): Promise<WebSearchResult[]> {
  const host = resolveApiHost(config);
  if (!host) throw new Error('SearXNG requires an API Host to be configured');
  const url = `${host}/search?q=${encodeURIComponent(query)}&format=json`;
  const data = await fetchJson(bridge, url, 'GET', {}) as {
    results?: Array<{ title?: string; url?: string; content?: string }>;
  };

  return (data.results || []).map(r => ({
    title: r.title || '',
    url: r.url || '',
    content: r.content || '',
  }));
}

// ---------------------------------------------------------------------------
// Dispatcher
// ---------------------------------------------------------------------------

const PROVIDER_SEARCH_FNS: Record<string, typeof searchTavily> = {
  tavily: searchTavily,
  exa: searchExa,
  bocha: searchBocha,
  zhipu: searchZhipu,
  searxng: searchSearxng,
};

async function decryptApiKey(bridge: NetcattyBridge, encryptedKey?: string): Promise<string> {
  if (!encryptedKey) return '';
  if (!encryptedKey.startsWith('enc:v1:')) return encryptedKey;
  const decrypt = (bridge as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>).credentialsDecrypt;
  if (!decrypt) return encryptedKey;
  try {
    return (await decrypt(encryptedKey)) as string || '';
  } catch {
    return '';
  }
}

export async function executeWebSearchProvider(
  bridge: NetcattyBridge,
  config: WebSearchConfig,
  query: string,
  maxResults: number,
): Promise<WebSearchResult[]> {
  const fn = PROVIDER_SEARCH_FNS[config.providerId];
  if (!fn) throw new Error(`Unsupported web search provider: ${config.providerId}`);
  // Decrypt the API key before passing to provider functions
  const decryptedKey = await decryptApiKey(bridge, config.apiKey);
  return fn(bridge, { ...config, apiKey: decryptedKey }, query, maxResults);
}
