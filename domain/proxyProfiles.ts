import type { GroupConfig, Host, Identity, ProxyConfig, ProxyProfile } from "./models";

const cloneProxyConfig = (config: ProxyConfig): ProxyConfig => ({
  ...config,
});

export const isValidProxyPort = (port: unknown): boolean => {
  const value = Number(port);
  return Number.isInteger(value) && value >= 1 && value <= 65535;
};

export const isProxyCommandConfig = (config: ProxyConfig | undefined): boolean => {
  return config?.type === "command";
};

export const isEmptyProxyConfigDraft = (config: ProxyConfig | undefined): boolean => {
  if (!config) return true;
  if (isProxyCommandConfig(config)) return !config.command?.trim();
  return !config.host.trim() && !config.username?.trim() && !config.password?.trim();
};

export const isCompleteProxyConfig = (config: ProxyConfig | undefined): boolean => {
  if (isProxyCommandConfig(config)) return Boolean(config?.command?.trim());
  return Boolean(config?.host.trim()) && isValidProxyPort(config?.port);
};

export const normalizeManualProxyConfig = (
  config: ProxyConfig | undefined,
): ProxyConfig | undefined => {
  if (!config || isEmptyProxyConfigDraft(config)) return undefined;
  if (isProxyCommandConfig(config)) {
    return {
      type: "command",
      host: "",
      port: 0,
      command: config.command?.trim(),
    };
  }
  return {
    ...config,
    host: config.host.trim(),
    username: config.username?.trim() || undefined,
    password: config.password || undefined,
  };
};

export const resolveProxyConfigAuth = (
  config: ProxyConfig | undefined,
  identities: Identity[] = [],
): ProxyConfig | undefined => {
  if (!config) return undefined;
  if (!config.identityId) return cloneProxyConfig(config);
  const identity = identities.find((candidate) => candidate.id === config.identityId);
  if (!identity) return cloneProxyConfig(config);
  return {
    ...config,
    username: identity.username?.trim() || undefined,
    password: identity.password,
  };
};

export type ProxyConfigIdentityIssue = "missing-identity" | "missing-password";

export const getProxyConfigIdentityIssue = (
  config: ProxyConfig | undefined,
  identities: Identity[] = [],
): ProxyConfigIdentityIssue | undefined => {
  if (!config?.identityId || isProxyCommandConfig(config)) return undefined;
  const identity = identities.find((candidate) => candidate.id === config.identityId);
  if (!identity) return "missing-identity";
  if (identity.password === undefined) return "missing-password";
  return undefined;
};

export const hasUsableProxyConfig = (config: ProxyConfig | undefined): boolean => {
  return isCompleteProxyConfig(config);
};

export const formatProxyConfigEndpoint = (config: ProxyConfig | undefined): string => {
  if (!config) return "";
  if (isProxyCommandConfig(config)) return "ProxyCommand";
  return `${config.host}:${config.port}`;
};

export const formatProxyConfigType = (config: ProxyConfig | undefined): string => {
  if (!config) return "";
  if (isProxyCommandConfig(config)) return "ProxyCommand";
  return config.type.toUpperCase();
};

export function findProxyProfile(
  proxyProfileId: string | undefined,
  proxyProfiles: ProxyProfile[],
): ProxyProfile | undefined {
  if (!proxyProfileId) return undefined;
  return proxyProfiles.find((profile) => profile.id === proxyProfileId);
}

export function materializeHostProxyProfile<T extends Host>(
  host: T,
  proxyProfiles: ProxyProfile[],
): T {
  if (host.proxyConfig || !host.proxyProfileId) return host;
  const profile = findProxyProfile(host.proxyProfileId, proxyProfiles);
  if (!profile) return host;
  return {
    ...host,
    proxyConfig: cloneProxyConfig(profile.config),
  };
}

const clearProxyProfileId = <T extends { proxyProfileId?: string }>(
  item: T,
  proxyProfileId: string,
): T => {
  if (item.proxyProfileId !== proxyProfileId) return item;
  const { proxyProfileId: _proxyProfileId, ...rest } = item;
  return rest as T;
};

export function removeProxyProfileReferences(
  proxyProfileId: string,
  data: {
    hosts: Host[];
    groupConfigs: GroupConfig[];
  },
): {
  hosts: Host[];
  groupConfigs: GroupConfig[];
} {
  return {
    hosts: data.hosts.map((host) => clearProxyProfileId(host, proxyProfileId)),
    groupConfigs: data.groupConfigs.map((config) => clearProxyProfileId(config, proxyProfileId)),
  };
}
