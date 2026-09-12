#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const http = require('node:http');
const https = require('node:https');
const { promises: dnsPromises } = require('node:dns');
const { URL } = require('node:url');
const { isIP } = require('node:net');

const BRAVE_SEARCH_URL = 'https://api.search.brave.com/res/v1/web/search';
const USER_AGENT = 'netcatty-ai-automation/1.0';
const MAX_FETCH_BYTES = 200_000;
const FETCH_TIMEOUT_MS = 10_000;
const SEARCH_TIMEOUT_MS = 12_000;

function readApiKey() {
  const file = String(process.env.BRAVE_API_KEY_FILE || '').trim();
  if (file) {
    const value = fs.readFileSync(file, 'utf8').replace(/[\r\n]+$/g, '');
    if (!value) throw new Error('BRAVE_API_KEY_FILE is empty.');
    return value;
  }
  const env = String(process.env.BRAVE_API_KEY || '').trim();
  if (!env) throw new Error('BRAVE_API_KEY is not configured.');
  return env;
}

function appendToolLog(event) {
  const logPath = String(process.env.BRAVE_TOOL_LOG || '').trim();
  if (!logPath) return;
  fs.appendFileSync(logPath, `${JSON.stringify(event)}\n`);
}

function requestJson(url, { headers = {}, timeoutMs = SEARCH_TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const lib = parsed.protocol === 'https:' ? https : http;
    const req = lib.request(parsed, {
      method: 'GET',
      headers,
      timeout: timeoutMs,
    }, (res) => {
      const chunks = [];
      let size = 0;
      res.on('data', (chunk) => {
        size += chunk.length;
        if (size > MAX_FETCH_BYTES) {
          req.destroy(new Error('Response exceeded byte limit.'));
          return;
        }
        chunks.push(chunk);
      });
      res.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        if (res.statusCode < 200 || res.statusCode >= 300) {
          reject(new Error(`HTTP ${res.statusCode}: ${body.slice(0, 300)}`));
          return;
        }
        try {
          resolve(JSON.parse(body));
        } catch {
          reject(new Error('Brave Search returned non-JSON.'));
        }
      });
    });
    req.on('timeout', () => req.destroy(new Error('Request timed out.')));
    req.on('error', reject);
    req.end();
  });
}

async function requestText(url, { timeoutMs = FETCH_TIMEOUT_MS, redirects = 0 } = {}) {
  if (redirects > 2) {
    throw new Error('Too many redirects.');
  }
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error('Invalid URL.');
  }
  if (parsed.protocol !== 'https:') {
    throw new Error('Only https URLs can be fetched.');
  }
  if (isPrivateHostname(parsed.hostname)) {
    throw new Error('Refusing to fetch a private or local address.');
  }
  let addresses;
  try {
    addresses = await dnsPromises.lookup(parsed.hostname, { all: true, verbatim: true });
  } catch {
    throw new Error('Could not resolve fetch host.');
  }
  if (
    !addresses.length
    || addresses.some((entry) => isPrivateHostname(entry.address))
  ) {
    throw new Error('Refusing to fetch a private or local address.');
  }
  return new Promise((resolve, reject) => {
    const req = https.request(parsed, {
      method: 'GET',
      headers: {
        'User-Agent': USER_AGENT,
        Accept: 'text/html,application/xhtml+xml,application/json,text/plain;q=0.9',
      },
      timeout: timeoutMs,
    }, (res) => {
      const location = res.headers.location;
      if (res.statusCode >= 300 && res.statusCode < 400 && location) {
        const next = new URL(location, parsed).toString();
        resolve(requestText(next, { timeoutMs, redirects: redirects + 1 }));
        res.resume();
        return;
      }
      const chunks = [];
      let size = 0;
      res.on('data', (chunk) => {
        size += chunk.length;
        if (size > MAX_FETCH_BYTES) {
          req.destroy(new Error('Response exceeded byte limit.'));
          return;
        }
        chunks.push(chunk);
      });
      res.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        if (res.statusCode < 200 || res.statusCode >= 300) {
          reject(new Error(`HTTP ${res.statusCode}`));
          return;
        }
        resolve(body);
      });
    });
    req.on('timeout', () => req.destroy(new Error('Request timed out.')));
    req.on('error', reject);
    req.end();
  });
}

function isPrivateHostname(hostname) {
  let host = String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (host.startsWith('::ffff:')) host = host.slice(7);
  if (
    host === 'localhost'
    || host.endsWith('.localhost')
    || host.endsWith('.local')
    || host === '0.0.0.0'
    || host === '::1'
  ) {
    return true;
  }
  const ipVersion = isIP(host);
  if (!ipVersion) return false;
  if (ipVersion === 4) {
    const [a, b] = host.split('.').map((part) => Number(part));
    return (
      a === 10
      || a === 127
      || a === 0
      || (a === 169 && b === 254)
      || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 168)
    );
  }
  return (
    host === '::1'
    || host.startsWith('fc')
    || host.startsWith('fd')
    || host.startsWith('fe80')
  );
}

function extractUrlsFromSearch(data) {
  const urls = [];
  const results = [];
  const web = Array.isArray(data?.web?.results) ? data.web.results : [];
  for (const item of web.slice(0, 8)) {
    const url = String(item?.url || '').trim();
    if (!url.startsWith('https://')) continue;
    urls.push(url);
    results.push({
      title: String(item.title || '').slice(0, 200),
      url,
      description: String(item.description || '').slice(0, 500),
    });
  }
  return { urls, results };
}

function stripHtml(value) {
  return String(value || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 8_000);
}

async function runSearch(query) {
  const q = String(query || '').trim();
  if (!q) throw new Error('Search query is required.');
  if (q.length > 400) throw new Error('Search query is too long.');
  const url = new URL(BRAVE_SEARCH_URL);
  url.searchParams.set('q', q);
  url.searchParams.set('count', '8');
  url.searchParams.set('text_decorations', 'false');
  url.searchParams.set('search_lang', 'en');
  const data = await requestJson(url.toString(), {
    headers: {
      Accept: 'application/json',
      'Accept-Encoding': 'identity',
      'X-Subscription-Token': readApiKey(),
      'User-Agent': USER_AGENT,
    },
  });
  const extracted = extractUrlsFromSearch(data);
  const event = {
    ok: true,
    action: 'search',
    query: q,
    urls: extracted.urls,
    results: extracted.results,
  };
  appendToolLog(event);
  return event;
}

async function runFetch(target) {
  const url = String(target || '').trim();
  if (!url.startsWith('https://')) throw new Error('Fetch URL must be https.');
  const body = stripHtml(await requestText(url));
  const event = {
    ok: true,
    action: 'fetch',
    query: url,
    urls: [url],
    results: [{ title: url, url, description: body }],
  };
  appendToolLog(event);
  return event;
}

async function main(argv) {
  const action = String(argv[2] || '').toLowerCase();
  const input = argv.slice(3).join(' ').trim();
  if (action !== 'search' && action !== 'fetch') {
    throw new Error('Usage: ai-brave-search.cjs <search|fetch> <query-or-url>');
  }
  const event = action === 'search' ? await runSearch(input) : await runFetch(input);
  process.stdout.write(`${JSON.stringify(event, null, 2)}\n`);
}

module.exports = {
  extractUrlsFromSearch,
  isPrivateHostname,
  stripHtml,
  runSearch,
  runFetch,
};

if (require.main === module) {
  main(process.argv).catch((error) => {
    const failed = {
      ok: false,
      action: String(process.argv[2] || ''),
      query: process.argv.slice(3).join(' '),
      error: error.message,
    };
    try { appendToolLog(failed); } catch { /* ignore log failure */ }
    process.stderr.write(`${error.message}\n`);
    process.exit(1);
  });
}
