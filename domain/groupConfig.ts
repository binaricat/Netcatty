import type { GroupConfig, Host } from './models';

/**
 * Resolve merged group defaults by walking the ancestor chain.
 * For group "A/B/C", merges configs from A, A/B, A/B/C (child overrides parent).
 */
export function resolveGroupDefaults(
  groupPath: string,
  groupConfigs: GroupConfig[],
): Partial<GroupConfig> {
  const configMap = new Map(groupConfigs.map((c) => [c.path, c]));
  const parts = groupPath.split('/').filter(Boolean);
  const merged: Record<string, unknown> = {};

  for (let i = 0; i < parts.length; i++) {
    const ancestorPath = parts.slice(0, i + 1).join('/');
    const config = configMap.get(ancestorPath);
    if (config) {
      for (const [key, value] of Object.entries(config)) {
        if (key !== 'path' && value !== undefined) {
          merged[key] = value;
        }
      }
    }
  }
  return merged as Partial<GroupConfig>;
}

const INHERITABLE_KEYS: (keyof GroupConfig)[] = [
  'username', 'password', 'savePassword', 'authMethod', 'identityId', 'identityFileId', 'identityFilePaths',
  'port', 'protocol', 'agentForwarding', 'proxyConfig', 'hostChain', 'startupCommand',
  'legacyAlgorithms', 'environmentVariables', 'charset', 'moshEnabled', 'moshServerPath',
  'telnetEnabled', 'telnetPort', 'telnetUsername', 'telnetPassword',
  'theme', 'themeOverride', 'fontFamily', 'fontFamilyOverride', 'fontSize', 'fontSizeOverride',
];

/**
 * Apply group defaults to a host. Only fills in fields the host doesn't already have.
 * Returns a new host object — does NOT mutate the original.
 */
export function applyGroupDefaults(host: Host, groupDefaults: Partial<GroupConfig>): Host {
  const effective = { ...host };
  for (const key of INHERITABLE_KEYS) {
    const hostValue = (host as unknown as Record<string, unknown>)[key];
    const groupValue = (groupDefaults as unknown as Record<string, unknown>)[key];
    if ((hostValue === undefined || hostValue === '' || hostValue === null) && groupValue !== undefined) {
      (effective as unknown as Record<string, unknown>)[key] = groupValue;
    }
  }
  return effective;
}
