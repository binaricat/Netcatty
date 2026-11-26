import test from 'node:test';
import assert from 'node:assert/strict';

import type { GroupConfig, Host } from './models.ts';
import { applyGroupDefaults, resolveGroupDefaults } from './groupConfig.ts';
import { resolveHostValueSources } from './hostValueSources.ts';

const makeHost = (overrides: Partial<Host> = {}): Host => ({
  id: 'host-1', label: 'host', hostname: 'host.example.com', username: 'root', tags: [], os: 'linux',
  ...overrides,
});

const sourcesFor = (host: Host, configs: GroupConfig[], globalProxyProfileId = '') => {
  const options = { validProxyProfileIds: new Set(['group-proxy', 'global-proxy', 'host-proxy']), globalProxyProfileId };
  const groupDefaults = host.group ? resolveGroupDefaults(host.group, configs, options) : {};
  return resolveHostValueSources(host, applyGroupDefaults(host, groupDefaults, options), configs);
};

test('valueSources separates host values, the nearest group and app defaults', () => {
  const configs: GroupConfig[] = [
    { path: 'prod', charset: 'GBK', deviceType: 'network', startupCommand: 'parent-start' },
    { path: 'prod/routers', charset: 'Big5' },
  ];
  const sources = sourcesFor(makeHost({ group: 'prod/routers', backspaceBehavior: 'ctrl-h' }), configs);

  assert.equal(sources.charset, 'group:prod/routers');
  assert.equal(sources.deviceType, 'group:prod');
  assert.equal(sources.startupCommand, 'group:prod');
  assert.equal(sources.backspaceBehavior, 'host');
  assert.equal(sources.etPort, 'default');
  assert.equal(sources.keepalive, 'global');
});

test('valueSources treats empty strings like applyGroupDefaults does', () => {
  const configs: GroupConfig[] = [{ path: 'prod', startupCommand: 'group-start', identityId: 'identity-1' }];
  const sources = sourcesFor(makeHost({ group: 'prod', startupCommand: '', identityId: '' }), configs);

  assert.equal(sources.startupCommand, 'group:prod', 'empty startupCommand inherits');
  assert.equal(sources.identityId, 'host', 'empty identityId is an explicit host choice');
});

test('valueSources reports every proxy source', () => {
  const configs: GroupConfig[] = [{ path: 'prod', proxyProfileId: 'group-proxy' }];
  const groupOneOff: GroupConfig[] = [{ path: 'prod', proxyConfig: { type: 'http', host: 'gw.example.com', port: 3128 } }];

  assert.equal(sourcesFor(makeHost({ group: 'prod', directProxy: true }), configs, 'global-proxy').proxy, 'direct');
  assert.equal(sourcesFor(makeHost({ group: 'prod', proxyProfileId: 'host-proxy' }), configs).proxy, 'host');
  assert.equal(sourcesFor(makeHost({ group: 'prod' }), configs, 'global-proxy').proxy, 'group:prod');
  assert.equal(sourcesFor(makeHost({ group: 'prod' }), groupOneOff).proxy, 'group:prod');
  assert.equal(sourcesFor(makeHost(), [], 'global-proxy').proxy, 'global-default');
  assert.equal(sourcesFor(makeHost(), []).proxy, 'none');
});

test('valueSources reports host keepalive and jump hosts', () => {
  const configs: GroupConfig[] = [{ path: 'prod', hostChain: { hostIds: ['jump-1'] } }];

  const inherited = sourcesFor(makeHost({ group: 'prod', keepaliveOverride: true }), configs);
  assert.equal(inherited.jumpHostIds, 'group:prod');
  assert.equal(inherited.keepalive, 'host');

  const blocked = sourcesFor(makeHost({ group: 'prod', hostChain: { hostIds: [] } }), configs);
  assert.equal(blocked.jumpHostIds, 'host', 'an empty host chain blocks the group chain');
});
