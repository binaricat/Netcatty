import type { GroupConfig, Host } from './models';
import { migrateDeprecatedFontOverride } from '../infrastructure/config/fonts';

/**
 * Migrate deprecated primary-font ids out of a GroupConfig's
 * font-override fields. Symmetrical to sanitizeHost; both run on load
 * to keep the same proportional-font protection working for group
 * defaults too.
 */
export function sanitizeGroupConfig(config: GroupConfig): GroupConfig {
  return migrateDeprecatedFontOverride(config);
}

export interface ApplyGroupDefaultsOptions {
  validProxyProfileIds?: ReadonlySet<string>;
}

const hasUsableProxyProfileId = (
  proxyProfileId: string | undefined,
  options?: ApplyGroupDefaultsOptions,
): boolean => {
  if (!proxyProfileId) return false;
  return !options?.validProxyProfileIds || options.validProxyProfileIds.has(proxyProfileId);
};

/**
 * Resolve merged group defaults by walking the ancestor chain.
 * For group "A/B/C", merges configs from A, A/B, A/B/C (child overrides parent).
 */
export function resolveGroupDefaults(
  groupPath: string,
  groupConfigs: GroupConfig[],
  options?: ApplyGroupDefaultsOptions,
): Partial<GroupConfig> {
  const configMap = new Map(groupConfigs.map((c) => [c.path, c]));
  const parts = groupPath.split('/').filter(Boolean);
  const merged: Record<string, unknown> = {};

  for (let i = 0; i < parts.length; i++) {
    const ancestorPath = parts.slice(0, i + 1).join('/');
    const config = configMap.get(ancestorPath);
    if (config) {
      for (const [key, value] of Object.entries(config)) {
        if (
          key === 'proxyProfileId' &&
          typeof value === 'string' &&
          options?.validProxyProfileIds &&
          !options.validProxyProfileIds.has(value)
        ) {
          delete merged.proxyConfig;
        }
        if (
          (key === 'theme' && config.themeOverride === false) ||
          (key === 'fontFamily' && config.fontFamilyOverride === false) ||
          (key === 'fontSize' && config.fontSizeOverride === false) ||
          (key === 'fontWeight' && config.fontWeightOverride === false)
        ) {
          continue;
        }
        if (key !== 'path' && value !== undefined) {
          if (key === 'proxyProfileId') {
            delete merged.proxyConfig;
          }
          if (key === 'proxyConfig') {
            delete merged.proxyProfileId;
          }
          merged[key] = value;
        }
      }
      if (config.themeOverride === false) {
        delete merged.themeOverride;
      }
      if (config.fontFamilyOverride === false) {
        delete merged.fontFamilyOverride;
      }
      if (config.fontSizeOverride === false) {
        delete merged.fontSizeOverride;
      }
      if (config.fontWeightOverride === false) {
        delete merged.fontWeightOverride;
      }
    }
  }
  return merged as Partial<GroupConfig>;
}

const INHERITABLE_KEYS: (keyof GroupConfig)[] = [
  'username', 'password', 'savePassword', 'authMethod', 'identityId', 'identityFileId', 'identityFilePaths',
  'port', 'protocol', 'agentForwarding', 'proxyProfileId', 'proxyConfig', 'hostChain', 'startupCommand',
  'legacyAlgorithms', 'skipEcdsaHostKey', 'algorithms',
  'environmentVariables', 'charset', 'moshEnabled', 'moshServerPath',
  'etEnabled', 'etPort',
  'telnetEnabled', 'telnetPort', 'telnetUsername', 'telnetPassword',
  'theme', 'themeOverride', 'fontFamily', 'fontFamilyOverride', 'fontSize', 'fontSizeOverride', 'fontWeight', 'fontWeightOverride',
  'backspaceBehavior',
];

const EMPTY_STRING_OVERRIDES_GROUP_DEFAULT = new Set<keyof GroupConfig>([
  'telnetUsername',
  'telnetPassword',
]);

/**
 * Apply group defaults to a host. Only fills in fields the host doesn't already have.
 * Returns a new host object — does NOT mutate the original.
 */
export function applyGroupDefaults(
  host: Host,
  groupDefaults: Partial<GroupConfig>,
  options?: ApplyGroupDefaultsOptions,
): Host {
  const effective = { ...host };
  const hostHasUsableProxyProfile = hasUsableProxyProfileId(host.proxyProfileId, options);

  for (const key of INHERITABLE_KEYS) {
    if (key === 'proxyProfileId') {
      if (host.proxyConfig !== undefined || !groupDefaults.proxyProfileId) continue;
    }
    if (key === 'proxyConfig' && (host.proxyProfileId !== undefined || hostHasUsableProxyProfile)) continue;
    const hostValue = (effective as unknown as Record<string, unknown>)[key];
    const groupValue = (groupDefaults as unknown as Record<string, unknown>)[key];
    const emptyStringIsOverride = EMPTY_STRING_OVERRIDES_GROUP_DEFAULT.has(key);
    const shouldInherit =
      hostValue === undefined ||
      hostValue === null ||
      (hostValue === '' && !emptyStringIsOverride);
    if (shouldInherit && groupValue !== undefined) {
      (effective as unknown as Record<string, unknown>)[key] = groupValue;
    }
  }
  return effective;
}

export function resolveGroupTerminalThemeId(
  groupDefaults: Partial<GroupConfig> | undefined,
  fallbackThemeId: string,
): string {
  if (!groupDefaults) return fallbackThemeId;
  return groupDefaults.theme || fallbackThemeId;
}
