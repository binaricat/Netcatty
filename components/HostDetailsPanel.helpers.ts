import type { GroupConfig } from "../domain/models";
import {
  findProxyProfile,
  hasIncompleteProxyIdentity,
  hasMissingProxyIdentity,
  hasUnreadableProxyCredential,
  isCompleteProxyConfig,
  normalizeManualProxyConfig,
} from "../domain/proxyProfiles";
import type { Host, Identity, ProxyConfig, ProxyProfile } from "../types";
import {
  LINUX_DISTRO_OPTIONS,
  NETWORK_DEVICE_OPTIONS,
  POSIX_PLATFORM_OPTIONS,
} from "../domain/host";

export const parseOptionalPortInput = (value: string): number | undefined =>
  value ? Number(value) : undefined;

export const resolvePrimaryProtocolSwitchPort = (
  currentPort: number | undefined,
  nextProtocol: "ssh" | "telnet",
  hasGroupTelnetPortDefault: boolean,
  hasGroupSshPortDefault: boolean,
): number | undefined => {
  if (nextProtocol === "telnet") {
    // Don't override if group provides a Telnet default
    if (hasGroupTelnetPortDefault || hasGroupSshPortDefault) return currentPort;
    if (currentPort === 22 || currentPort === undefined) return 23;
    return currentPort;
  }
  if (nextProtocol === "ssh") {
    if (hasGroupSshPortDefault) return currentPort;
    if (currentPort === 23 || currentPort === undefined) return 22;
    return currentPort;
  }
  return currentPort;
};

export const resolvePrimaryProtocolSavePort = (
  protocol: Host["protocol"],
  currentPort: number | undefined,
  hasGroupSshPortDefault: boolean,
  hasGroupTelnetPortDefault: boolean,
): number | undefined => {
  if (protocol === "telnet") {
    if (currentPort !== undefined) return currentPort;
    if (hasGroupTelnetPortDefault || hasGroupSshPortDefault) return undefined;
    return 23;
  }
  return currentPort ?? (hasGroupSshPortDefault ? undefined : 22);
};

export const resolveDetailsTelnetPort = (
  host: Host,
  groupDefaults?: Partial<GroupConfig>,
): number => {
  if (host.telnetPort !== undefined && host.telnetPort !== null) return host.telnetPort;
  if (groupDefaults?.telnetPort !== undefined && groupDefaults.telnetPort !== null) {
    return groupDefaults.telnetPort;
  }
  if (host.protocol === "telnet") {
    if (host.port !== undefined && host.port !== null) return host.port;
    if (groupDefaults?.port !== undefined && groupDefaults.port !== null) return groupDefaults.port;
  }
  return 23;
};

export const resolveDetailsTelnetUsername = (
  host: Host,
  groupDefaults?: Partial<GroupConfig>,
): string =>
  host.telnetUsername !== undefined
    ? host.telnetUsername
    : groupDefaults?.telnetUsername !== undefined
      ? groupDefaults.telnetUsername
      : host.username ?? groupDefaults?.username ?? "";

export const resolveDetailsTelnetPassword = (
  host: Host,
  groupDefaults?: Partial<GroupConfig>,
): string =>
  host.telnetPassword !== undefined
    ? host.telnetPassword
    : groupDefaults?.telnetPassword !== undefined
      ? groupDefaults.telnetPassword
      : host.password ?? groupDefaults?.password ?? "";

export const prepareTelnetCredentialsForSave = (host: Host): Host =>
  host.telnetIdentityId
    ? {
      ...host,
      telnetUsername: undefined,
      telnetPassword: undefined,
    }
    : host;

export const LINUX_DISTRO_OPTION_IDS = [
  ...LINUX_DISTRO_OPTIONS,
  ...POSIX_PLATFORM_OPTIONS,
  ...NETWORK_DEVICE_OPTIONS,
];

export type ProxySaveValidationError =
  | "required"
  | "port"
  | "missingSaved"
  | "missingIdentity"
  | "incompleteIdentity"
  | "unreadableIdentity";

export const validateProxyConfigForSave = ({
  proxyConfig,
  proxyProfileId,
  proxyProfiles,
  identities,
}: {
  proxyConfig?: ProxyConfig;
  proxyProfileId?: string;
  proxyProfiles?: ProxyProfile[];
  identities?: Identity[];
}): ProxySaveValidationError | null => {
  const selectedProxyProfile = findProxyProfile(proxyProfileId, proxyProfiles ?? []);
  if (proxyProfileId && !selectedProxyProfile) return "missingSaved";

  const normalizedProxyConfig = normalizeManualProxyConfig(proxyConfig);
  if (normalizedProxyConfig && !isCompleteProxyConfig(normalizedProxyConfig)) {
    return normalizedProxyConfig.host ? "port" : "required";
  }

  const effectiveProxyConfig = selectedProxyProfile?.config ?? proxyConfig;
  if (hasMissingProxyIdentity(effectiveProxyConfig, identities ?? [])) {
    return "missingIdentity";
  }
  if (hasIncompleteProxyIdentity(effectiveProxyConfig, identities ?? [])) {
    return "incompleteIdentity";
  }
  if (hasUnreadableProxyCredential(effectiveProxyConfig, identities ?? [])) {
    return "unreadableIdentity";
  }

  return null;
};

export const prepareProxyConfigForSave = (params: {
  proxyConfig?: ProxyConfig;
  proxyProfileId?: string;
  proxyProfiles?: ProxyProfile[];
  identities?: Identity[];
}): {
  error?: ProxySaveValidationError;
  normalizedProxyConfig?: ProxyConfig;
} => {
  const error = validateProxyConfigForSave(params);
  if (error) return { error };
  return {
    normalizedProxyConfig: normalizeManualProxyConfig(params.proxyConfig),
  };
};
