import type { GroupConfig, Host } from './models';

/**
 * Where an effective host value comes from, so agents can tell a value set on
 * the host apart from one inherited from a group or a global default before
 * changing it.
 *
 * - `host`: stored on the host itself.
 * - `group:<path>`: inherited from that group (the nearest group that sets it).
 * - proxy only: `direct` (host forces no proxy) or `global-default`.
 * - keepalive only: `host`.
 *
 * Fields that use the app default (no proxy, global keepalive) are left out
 * to keep tool results small.
 */
export type HostValueSource = string;

/** Host fields reported in valueSources, keyed by their tool field name. */
const SOURCE_FIELDS: Record<string, keyof Host & keyof GroupConfig> = {
  port: 'port',
  protocol: 'protocol',
  username: 'username',
  authMethod: 'authMethod',
  identityId: 'identityId',
  deviceType: 'deviceType',
  charset: 'charset',
  backspaceBehavior: 'backspaceBehavior',
  startupCommand: 'startupCommand',
  startupCommandRunMode: 'startupCommandRunMode',
  environmentVariables: 'environmentVariables',
  jumpHostIds: 'hostChain',
  moshEnabled: 'moshEnabled',
  moshServerPath: 'moshServerPath',
  etEnabled: 'etEnabled',
  etPort: 'etPort',
};

// Mirrors applyGroupDefaults: an empty string on these keys is an explicit
// host choice; on every other key it means "inherit".
const EMPTY_STRING_IS_HOST_VALUE = new Set<string>(['identityId']);

const sameValue = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);

const hasHostValue = (host: Host, key: keyof Host): boolean => {
  const value = host[key];
  if (value === undefined || value === null) return false;
  return value !== '' || EMPTY_STRING_IS_HOST_VALUE.has(key);
};

/** Group paths from the host's own group up to the top-level group. */
const ancestorPathsNearestFirst = (groupPath: string | undefined): string[] => {
  const parts = (groupPath ?? '').split('/').filter(Boolean);
  return parts.map((_, index) => parts.slice(0, parts.length - index).join('/'));
};

export function resolveHostValueSources(
  host: Host,
  effectiveHost: Host,
  groupConfigs: GroupConfig[],
): Record<string, HostValueSource> {
  const configByPath = new Map(groupConfigs.map((config) => [config.path, config]));
  const ancestors = ancestorPathsNearestFirst(host.group)
    .map((path) => configByPath.get(path))
    .filter((config): config is GroupConfig => Boolean(config));

  const sources: Record<string, HostValueSource> = {};
  for (const [field, key] of Object.entries(SOURCE_FIELDS)) {
    if (hasHostValue(host, key)) {
      sources[field] = 'host';
      continue;
    }
    const effectiveValue = effectiveHost[key];
    if (effectiveValue === undefined || effectiveValue === null || effectiveValue === '') continue;
    const group = ancestors.find((config) => (
      config[key] !== undefined && sameValue(config[key], effectiveValue)
    ));
    if (group) sources[field] = `group:${group.path}`;
  }

  // resolveHostAuth logs in with the identity's username and method, so
  // report them from wherever the identity comes from.
  if (effectiveHost.identityId && sources.identityId) {
    sources.username = sources.identityId;
    sources.authMethod = sources.identityId;
  }

  const proxySource = resolveProxySource(host, effectiveHost, ancestors);
  if (proxySource) sources.proxy = proxySource;
  if (host.keepaliveOverride === true) sources.keepalive = 'host';
  return sources;
}

function resolveProxySource(host: Host, effectiveHost: Host, ancestors: GroupConfig[]): HostValueSource | undefined {
  if (host.directProxy === true) return 'direct';
  if (host.proxyProfileId || host.proxyConfig !== undefined) return 'host';
  const group = ancestors.find((config) => (
    effectiveHost.proxyProfileId
      ? config.proxyProfileId === effectiveHost.proxyProfileId
      : config.proxyConfig !== undefined && sameValue(config.proxyConfig, effectiveHost.proxyConfig)
  ));
  if (group) return `group:${group.path}`;
  if (effectiveHost.proxyProfileId || effectiveHost.proxyConfig) return 'global-default';
  return undefined;
}
