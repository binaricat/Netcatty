import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { GroupConfig, Host, ProxyProfile } from './models';
import { applyGroupDefaults, resolveGroupDefaults } from './groupConfig';
import { upsertGroup } from './vaultGroupAgentOps';

const hosts: Host[] = [
  { id: 'host-1', label: 'Router', hostname: 'router.test', username: 'root', group: 'prod/routers', tags: [], os: 'linux' },
];
const proxyProfiles: ProxyProfile[] = [{
  id: 'proxy-1', label: 'Proxy', config: { type: 'socks5', host: '127.0.0.1', port: 1080 }, createdAt: 1,
}];
const proxyOptions = { validProxyProfileIds: new Set(['proxy-1']), globalProxyProfileId: '' };
const stateWith = (configs: GroupConfig[]) => ({
  groups: ['prod', 'prod/routers'], configs, hosts, managedSources: [],
});
const effectiveHost = (configs: GroupConfig[]) => applyGroupDefaults(
  hosts[0], resolveGroupDefaults('prod/routers', configs, proxyOptions), proxyOptions,
);

describe('vault group connection defaults', () => {
  it('sets device type, charset and backspace defaults that hosts inherit', () => {
    const result = upsertGroup(
      stateWith([]), 'prod/routers',
      '{"deviceType":"network","charset":"GBK","backspaceBehavior":"ctrl-h"}', [], proxyProfiles,
    );
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.config?.deviceType, 'network');
    assert.equal(result.config?.charset, 'GB18030', 'GBK is saved as GB18030 like Group Details');
    assert.equal(result.config?.backspaceBehavior, 'ctrl-h');
    const host = effectiveHost(result.state.configs);
    assert.equal(host.deviceType, 'network');
    assert.equal(host.charset, 'GB18030');
  });

  it('rejects invalid connection defaults', () => {
    const cases: Array<[string, RegExp]> = [
      ['{"deviceType":"router"}', /deviceType must be general or network/i],
      ['{"charset":"UTF-8\\nX"}', /charset must be UTF-8 or GB18030/i],
      ['{"charset":"Big5"}', /charset must be UTF-8 or GB18030/i],
      ['{"backspaceBehavior":"del"}', /backspaceBehavior must be ctrl-h/i],
      ['{"authMethod":"key"}', /authMethod cannot be set on a group/i],
    ];
    for (const [defaults, error] of cases) {
      const result = upsertGroup(stateWith([]), 'prod', defaults, [], proxyProfiles);
      assert.equal(result.ok, false, defaults);
      if (!result.ok) assert.match(result.error, error);
    }
  });

  it('removeDefaults deletes group defaults so parent groups apply again', () => {
    const configs: GroupConfig[] = [
      { path: 'prod', charset: 'Big5', startupCommand: 'parent-start' },
      { path: 'prod/routers', charset: 'GBK', deviceType: 'network', startupCommand: 'child-start', hostChain: { hostIds: [] } },
    ];
    const result = upsertGroup(
      stateWith(configs), 'prod/routers', undefined, [], proxyProfiles,
      { removeDefaults: '["charset","deviceType","startupCommand","jumpHostIds"]' },
    );
    assert.equal(result.ok, true);
    if (!result.ok) return;
    for (const key of ['charset', 'deviceType', 'startupCommand', 'hostChain'] as const) {
      assert.equal(result.config?.[key], undefined, key);
    }
    const host = effectiveHost(result.state.configs);
    assert.equal(host.charset, 'Big5');
    assert.equal(host.startupCommand, 'parent-start');
    assert.equal(host.deviceType, undefined);
  });

  it('rejects unknown, credential or conflicting removeDefaults', () => {
    const cases: Array<[unknown, string | undefined, RegExp]> = [
      ['["password"]', undefined, /cannot remove "password"/i],
      ['["identityId"]', undefined, /cannot remove "identityId"/i],
      ['["charset"', undefined, /valid JSON array/i],
      ['["charset"]', '{"charset":"GBK"}', /charset cannot be set and removed/i],
      ['["proxy"]', '{"proxyProfileId":"proxy-1"}', /proxyProfileId cannot be set and removed/i],
    ];
    for (const [removeDefaults, defaults, error] of cases) {
      const result = upsertGroup(stateWith([]), 'prod', defaults, [], proxyProfiles, { removeDefaults });
      assert.equal(result.ok, false, String(removeDefaults));
      if (!result.ok) assert.match(result.error, error);
    }
  });

  it('clearing a child group proxy lets the parent group proxy apply, like Group Details', () => {
    const parent: GroupConfig = { path: 'prod', proxyConfig: { type: 'http', host: 'parent-gw.test', port: 3128 } };
    const child: GroupConfig = { path: 'prod/routers', proxyProfileId: 'proxy-1' };

    for (const options of [{}, { removeDefaults: ['proxy'] }]) {
      const result = upsertGroup(
        stateWith([parent, child]), 'prod/routers',
        'removeDefaults' in options ? undefined : '{"proxyProfileId":""}', [], proxyProfiles, options,
      );
      assert.equal(result.ok, true, JSON.stringify(options));
      if (!result.ok) continue;
      assert.equal(result.config?.proxyProfileId, undefined);
      assert.equal(result.config?.proxyConfig, undefined);
      assert.equal(effectiveHost(result.state.configs).proxyConfig?.host, 'parent-gw.test');
    }
  });
});
