import type { GroupConfig, Host, RdpConfig, VncConfig } from './models';
import { migrateDeprecatedFontOverride } from '../infrastructure/config/fonts';
import {
  getActiveGlobalDefaultProxyProfileId,
  normalizeGlobalDefaultProxyProfileId,
} from './globalDefaultProxy';
import { sanitizeRdpConfig, sanitizeVncConfig } from './remoteDesktop';

const sanitizeGroupRdpConfig = (config: RdpConfig | undefined): RdpConfig | undefined => {
  if (!config) return undefined;
  const sanitized = sanitizeRdpConfig(config);
  if (config.identityId === '') {
    return { ...(sanitized ?? {}), identityId: '' };
  }
  return sanitized;
};

const sanitizeGroupVncConfig = (config: VncConfig | undefined): VncConfig | undefined => {
  if (!config) return undefined;
  const sanitized = sanitizeVncConfig(config);
  if (config.identityId === '') {
    return { ...(sanitized ?? {}), identityId: '' };
  }
  return sanitized;
};

export const hasManualGroupRdpCredentials = (config: Partial<RdpConfig> | undefined): boolean =>
  Boolean(config && (config.username !== undefined || config.useHostCredentials === true));

export const hasManualGroupVncCredentials = (config: Partial<VncConfig> | undefined): boolean =>
  Boolean(config && (config.username !== undefined || config.useHostCredentials === true));

const mergeRemoteDesktopConfigLayer = <T extends RdpConfig | VncConfig>(
  parent: T | undefined,
  child: T | undefined,
): T | undefined => {
  if (!parent) return child ? { ...child } : undefined;
  if (!child) return { ...parent };
  const merged: Record<string, unknown> = { ...parent };

  if (child.useHostCredentials === true) {
    delete merged.identityId;
    delete merged.username;
  } else if (child.identityId !== undefined) {
    delete merged.username;
    if (child.identityId !== '') {
      delete merged.useHostCredentials;
    }
  } else if (child.username !== undefined) {
    delete merged.identityId;
    if (child.useHostCredentials === undefined) {
      delete merged.useHostCredentials;
    }
  }

  for (const [key, value] of Object.entries(child)) {
    if (value !== undefined) {
      merged[key] = value;
    }
  }
  return merged as T;
};

/**
 * Migrate deprecated primary-font ids out of a GroupConfig's
 * font-override fields. Symmetrical to sanitizeHost; both run on load
 * to keep the same proportional-font protection working for group
 * defaults too.
 */
export function sanitizeGroupConfig(config: GroupConfig): GroupConfig {
  const migrated = migrateDeprecatedFontOverride(config);
  const hasLegacyPasswordOnlyCredentials = migrated.authMethod === undefined
    && Boolean(migrated.password?.length)
    && !migrated.identityId
    && !migrated.identityFileId
    && !migrated.identityFilePaths?.length;

  let next: GroupConfig = hasLegacyPasswordOnlyCredentials
    ? { ...migrated, authMethod: 'password' as const }
    : { ...migrated };
  if (Object.prototype.hasOwnProperty.call(next, 'rdpConfig')) {
    const rdpConfig = sanitizeGroupRdpConfig(next.rdpConfig);
    if (rdpConfig) next.rdpConfig = rdpConfig;
    else delete next.rdpConfig;
  }
  if (Object.prototype.hasOwnProperty.call(next, 'vncConfig')) {
    const vncConfig = sanitizeGroupVncConfig(next.vncConfig);
    if (vncConfig) next.vncConfig = vncConfig;
    else delete next.vncConfig;
  }
  if (!Object.prototype.hasOwnProperty.call(next, 'singleChannelSsh')) return next;
  const cleaned = { ...next };
  delete (cleaned as { singleChannelSsh?: unknown }).singleChannelSsh;
  return cleaned;
}

export interface ApplyGroupDefaultsOptions {
  validProxyProfileIds?: ReadonlySet<string>;
  /**
   * Saved proxy used when the host and its groups do not set one.
   * An empty string forces no global default. When the property is omitted,
   * the active app setting is used.
   */
  globalProxyProfileId?: string;
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

const resolveGlobalProxyProfileId = (
  options?: ApplyGroupDefaultsOptions,
): string | undefined => {
  const hasExplicit = Boolean(options)
    && Object.prototype.hasOwnProperty.call(options, 'globalProxyProfileId');
  const raw = hasExplicit
    ? options?.globalProxyProfileId
    : getActiveGlobalDefaultProxyProfileId();
  const id = normalizeGlobalDefaultProxyProfileId(raw);
  if (!id) return undefined;
  if (options?.validProxyProfileIds && !options.validProxyProfileIds.has(id)) return undefined;
  return id;
};

const withoutInheritedProxy = (host: Host): Host => {
  if (host.proxyProfileId === undefined && host.proxyConfig === undefined) return host;
  const next = { ...host };
  delete next.proxyProfileId;
  delete next.proxyConfig;
  return next;
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
        if (key !== 'path' && key !== 'notes' && value !== undefined) {
          if (key === 'rdpConfig') {
            merged.rdpConfig = mergeRemoteDesktopConfigLayer(
              merged.rdpConfig as RdpConfig | undefined,
              value as RdpConfig,
            );
            continue;
          }
          if (key === 'vncConfig') {
            merged.vncConfig = mergeRemoteDesktopConfigLayer(
              merged.vncConfig as VncConfig | undefined,
              value as VncConfig,
            );
            continue;
          }
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
  'port', 'protocol', 'deviceType', 'agentForwarding', 'x11Forwarding', 'proxyProfileId', 'proxyConfig', 'hostChain', 'startupCommand', 'startupCommandRunMode',
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

// SSH transport/input settings the local-shell editor does not expose: input
// remapping (backspace), Mosh/Eternal-Terminal transports, and SSH-only
// algorithm/agent/X11/chain flags. A local shell never runs through SSH, so these
// defaults would either remap local PTY input (`backspaceBehavior`,
// createXTermRuntime) or make flag-first consumers report a purely local
// session as Mosh/ET — with no way to override them in the local editor.
const SSH_ONLY_TRANSPORT_KEYS = new Set<keyof GroupConfig>([
  'agentForwarding',
  'x11Forwarding',
  'legacyAlgorithms',
  'skipEcdsaHostKey',
  'algorithms',
  'hostChain',
  'moshEnabled',
  'moshServerPath',
  'etEnabled',
  'etPort',
  'backspaceBehavior',
]);

// VNC/RDP hosts inherit network routing (SSH jump chains and proxies) from
// their group, but skip SSH-specific credentials, ports, startup commands,
// device type, charset, and terminal appearance overrides.
const REMOTE_DESKTOP_INHERITABLE_KEYS = new Set<keyof GroupConfig>([
  'hostChain',
  'proxyProfileId',
  'proxyConfig',
]);

const STANDALONE_REMOTE_DESKTOP_SKIP_KEYS = new Set<string>([
  'enabled',
  'defaultConnect',
  'tunnelViaHostSsh',
  'tunnelTargetHost',
  'useHostCredentials',
]);

const COMPANION_REMOTE_DESKTOP_SKIP_KEYS = new Set<string>([
  'enabled',
  'defaultConnect',
]);

const applyRemoteDesktopGroupConfig = <T extends RdpConfig | VncConfig>(
  host: Host,
  hostConfig: T | undefined,
  groupConfig: T | undefined,
  isStandalone: boolean,
): { config: T | undefined; inheritedPort?: number } => {
  if (!groupConfig) return { config: hostConfig };
  const merged: Record<string, unknown> = hostConfig ? { ...hostConfig } : {};
  const skipKeys = isStandalone
    ? STANDALONE_REMOTE_DESKTOP_SKIP_KEYS
    : COMPANION_REMOTE_DESKTOP_SKIP_KEYS;

  const standaloneHasExplicitCreds = isStandalone && (
    host.identityId !== undefined
    || Boolean(host.username?.trim())
    || host.password !== undefined
    || host.savePassword === false
    || hostConfig?.identityId !== undefined
    || Boolean(hostConfig?.username?.trim())
  );

  const companionHasUseHostCreds = !isStandalone && hostConfig?.useHostCredentials === true;
  const companionHasExplicitIdentity = !isStandalone && hostConfig?.identityId !== undefined;
  const companionHasManualUsername = !isStandalone && Boolean(hostConfig?.username?.trim());

  let inheritedPort: number | undefined;
  for (const [key, value] of Object.entries(groupConfig)) {
    if (value === undefined || skipKeys.has(key)) continue;
    if (key === 'port') {
      if (isStandalone) {
        if (host.port !== undefined || hostConfig?.port !== undefined) continue;
        inheritedPort = value as number;
      } else if (hostConfig?.port !== undefined) {
        continue;
      }
    }
    if (key === 'identityId') {
      if (value === '') continue;
      if (isStandalone && standaloneHasExplicitCreds) continue;
      if (!isStandalone && (companionHasUseHostCreds || companionHasExplicitIdentity || companionHasManualUsername)) {
        continue;
      }
    }
    if (key === 'username') {
      if (value === '') continue;
      if (isStandalone && standaloneHasExplicitCreds) continue;
      if (!isStandalone && (companionHasUseHostCreds || companionHasExplicitIdentity || companionHasManualUsername)) {
        continue;
      }
    }
    if (key === 'useHostCredentials') {
      if (
        hostConfig?.useHostCredentials !== undefined
        || companionHasExplicitIdentity
        || companionHasManualUsername
      ) {
        continue;
      }
    }
    if (merged[key] === undefined) {
      merged[key] = value;
    }
  }

  return {
    config: Object.keys(merged).length > 0 ? (merged as T) : undefined,
    inheritedPort,
  };
};

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
    (host.authPolicyVersion === 1 && host.authMethod !== undefined) ||
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
  // Serial hosts: username/password on a serial host are the auto-login
  // credentials (#3417) sent to whatever device answers on the port. Group
  // defaults are SSH credentials — never inherit them into a serial host, or
  // connecting a serial editor with blank credential fields would transmit the
  // group's SSH password to anything that prints a login prompt.
  const isSerialHost = host.protocol === 'serial';

  // Local-shell hosts run on the user's own machine. Group defaults are
  // SSH/remote-oriented: the SSH credential bundle and a saved startup
  // command were written for the group's remote hosts and must never be
  // inherited into a local shell, or clicking a local entry would
  // type/execute that command on the local machine — and "Copy Credentials"
  // on a local shell would copy an unrelated remote password. `deviceType`
  // is equally remote-only: a saved "network" device type would make a
  // local CMD/PowerShell/POSIX shell be treated as a network-device CLI
  // (no normal autocomplete, network semantics for AI/command execution).
  const isLocalShellHost = host.protocol === 'local';
  const isRemoteDesktopHost = host.protocol === 'vnc' || host.protocol === 'rdp';
  // X11 forwarding only applies to plain SSH. Use the host value when it is
  // set, otherwise the group transport, so a group Mosh/ET/Telnet default
  // does not also turn X11 on.
  const effectiveProtocol = host.protocol ?? groupDefaults.protocol;
  const inheritsX11Forwarding = (!effectiveProtocol || effectiveProtocol === 'ssh')
    && !(host.moshEnabled ?? groupDefaults.moshEnabled)
    && !(host.etEnabled ?? groupDefaults.etEnabled);

  for (const key of INHERITABLE_KEYS) {
    if (isRemoteDesktopHost && !REMOTE_DESKTOP_INHERITABLE_KEYS.has(key)) continue;
    if (shouldSkipGroupSshCredentialBundle && SSH_CREDENTIAL_KEYS.has(key)) continue;
    if (isSerialHost && SSH_CREDENTIAL_KEYS.has(key)) continue;
    if (isLocalShellHost && (SSH_CREDENTIAL_KEYS.has(key) || SSH_ONLY_TRANSPORT_KEYS.has(key) || key === 'startupCommand' || key === 'deviceType')) continue;
    if (key === 'x11Forwarding' && !inheritsX11Forwarding) continue;
    if (key === 'password' && effective.savePassword === false) continue;
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
  // Explicit direct beats a host proxy, the nearest group proxy, and the
  // global default. Clearing the host setting leaves directProxy unset and
  // still inherits.
  const isPluginHost = typeof host.protocol === 'string' && host.protocol.startsWith('plugin:');
  if (!isLocalShellHost && !isSerialHost && !isPluginHost) {
    const isStandaloneRdp = host.protocol === 'rdp';
    const hasCompanionRdpEnabled = !isStandaloneRdp && host.rdpConfig?.enabled === true;
    if ((isStandaloneRdp || hasCompanionRdpEnabled) && groupDefaults.rdpConfig) {
      const { config, inheritedPort } = applyRemoteDesktopGroupConfig(
        host,
        effective.rdpConfig,
        groupDefaults.rdpConfig,
        isStandaloneRdp,
      );
      if (config) effective.rdpConfig = config;
      if (isStandaloneRdp && inheritedPort !== undefined && effective.port === undefined) {
        effective.port = inheritedPort;
      }
    }

    const isStandaloneVnc = host.protocol === 'vnc';
    const hasCompanionVncEnabled = !isStandaloneVnc && host.vncConfig?.enabled === true;
    if ((isStandaloneVnc || hasCompanionVncEnabled) && groupDefaults.vncConfig) {
      const { config, inheritedPort } = applyRemoteDesktopGroupConfig(
        host,
        effective.vncConfig,
        groupDefaults.vncConfig,
        isStandaloneVnc,
      );
      if (config) effective.vncConfig = config;
      if (isStandaloneVnc && inheritedPort !== undefined && effective.port === undefined) {
        effective.port = inheritedPort;
      }
    }
  }
  if (host.directProxy === true) return withoutInheritedProxy(effective);
  if (!effective.proxyConfig && !effective.proxyProfileId) {
    const globalProxyProfileId = resolveGlobalProxyProfileId(options);
    if (globalProxyProfileId) effective.proxyProfileId = globalProxyProfileId;
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
