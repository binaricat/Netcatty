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

export const hasManualGroupSshCredentials = (config: Partial<GroupConfig>): boolean => [
  config.username,
  config.password,
  config.savePassword,
  config.authMethod,
  config.identityFileId,
  config.identityFilePaths,
].some((value) => value !== undefined);

export const hasManualGroupTelnetCredentials = (config: Partial<GroupConfig>): boolean => [
  config.telnetUsername,
  config.telnetPassword,
].some((value) => value !== undefined);

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
      const hasSshIdentitySetting = config.identityId !== undefined;
      const hasManualSshCredentials = hasManualGroupSshCredentials(config);
      if (hasSshIdentitySetting) {
        delete merged.username;
        delete merged.password;
        delete merged.savePassword;
        delete merged.authMethod;
        delete merged.identityFileId;
        delete merged.identityFilePaths;
      } else if (!hasSshIdentitySetting && hasManualSshCredentials) {
        const replacesInheritedIdentity = Boolean(merged.identityId);
        delete merged.identityId;
        if (replacesInheritedIdentity) {
          delete merged.username;
          delete merged.password;
          delete merged.savePassword;
          delete merged.authMethod;
          delete merged.identityFileId;
          delete merged.identityFilePaths;
        }
      }

      const hasTelnetIdentitySetting = config.telnetIdentityId !== undefined;
      const hasManualTelnetCredentials = hasManualGroupTelnetCredentials(config);
      if (hasTelnetIdentitySetting) {
        delete merged.telnetUsername;
        delete merged.telnetPassword;
      } else if (!hasTelnetIdentitySetting && hasManualTelnetCredentials) {
        const replacesInheritedIdentity = Boolean(merged.telnetIdentityId);
        delete merged.telnetIdentityId;
        if (replacesInheritedIdentity) {
          delete merged.telnetUsername;
          delete merged.telnetPassword;
        }
      }

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
  'port', 'protocol', 'deviceType', 'agentForwarding', 'proxyProfileId', 'proxyConfig', 'hostChain', 'startupCommand', 'startupCommandRunMode',
  'legacyAlgorithms', 'skipEcdsaHostKey', 'algorithms',
  'environmentVariables', 'charset', 'moshEnabled', 'moshServerPath',
  'etEnabled', 'etPort',
  'telnetEnabled', 'telnetPort', 'telnetIdentityId', 'telnetUsername', 'telnetPassword',
  'theme', 'themeOverride', 'fontFamily', 'fontFamilyOverride', 'fontSize', 'fontSizeOverride', 'fontWeight', 'fontWeightOverride',
  'backspaceBehavior',
];

const EMPTY_STRING_OVERRIDES_GROUP_DEFAULT = new Set<keyof GroupConfig>([
  'telnetUsername',
  'telnetPassword',
  'telnetIdentityId',
  // Empty-string host identityId = explicitly no identity (auth-retry save, #1956); do not re-inherit group identity.
  'identityId',
]);

const SSH_CREDENTIAL_KEYS = new Set<keyof GroupConfig>([
  'username',
  'password',
  'savePassword',
  'authMethod',
  'identityId',
  'identityFileId',
  'identityFilePaths',
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
  const hostUsername = host.username?.trim();
  const hostHasManualSshCredentials = !host.identityId && Boolean(
    (hostUsername && hostUsername !== 'root') ||
    host.password !== undefined ||
    host.savePassword === false ||
    host.identityFileId ||
    host.identityFilePaths?.length,
  );
  const shouldSkipGroupSshCredentialBundle = Boolean(host.identityId) || (
    Boolean(groupDefaults.identityId) &&
    (host.identityId === '' || hostHasManualSshCredentials)
  );
  const primaryTelnetHasManualSharedCredentials = host.protocol === 'telnet' && Boolean(
    (hostUsername && hostUsername !== 'root') ||
    host.password !== undefined ||
    host.savePassword === false
  );
  const hostHasManualTelnetCredentials = !host.telnetIdentityId && (
    host.telnetUsername !== undefined ||
    host.telnetPassword !== undefined ||
    primaryTelnetHasManualSharedCredentials
  );

  for (const key of INHERITABLE_KEYS) {
    if (shouldSkipGroupSshCredentialBundle && SSH_CREDENTIAL_KEYS.has(key)) continue;
    if (key === 'telnetIdentityId' && hostHasManualTelnetCredentials) continue;
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
