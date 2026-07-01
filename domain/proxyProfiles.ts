import { isEncryptedCredentialPlaceholder, sanitizeCredentialValue } from "./credentials";
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
  const normalized: ProxyConfig = {
    type: config.type,
    host: config.host.trim(),
    port: Number(config.port),
  };
  if (config.identityId) {
    normalized.identityId = config.identityId;
  } else {
    normalized.username = config.username?.trim() || undefined;
    normalized.password = config.password || undefined;
  }
  return normalized;
};

export const updateProxyConfigField = (
  config: ProxyConfig | undefined,
  field: keyof ProxyConfig,
  value: ProxyConfig[keyof ProxyConfig],
): ProxyConfig => {
  const next: ProxyConfig = {
    type: config?.type || "http",
    host: config?.host || "",
    port: config?.port || 8080,
    ...config,
    [field]: value,
  };
  if (field === "identityId") {
    delete next.username;
    delete next.password;
    if (!value) delete next.identityId;
  } else if (field === "username" || field === "password") {
    delete next.identityId;
  } else if (field === "type") {
    if (value === "command") {
      delete next.identityId;
      delete next.username;
      delete next.password;
    } else {
      delete next.command;
    }
  }
  return next;
};

const findIdentity = (
  identityId: string | undefined,
  identities: Identity[] = [],
): Identity | undefined => {
  if (!identityId) return undefined;
  return identities.find((identity) => identity.id === identityId);
};

export const findMissingProxyIdentityId = (
  config: ProxyConfig | undefined,
  identities: Identity[] = [],
): string | undefined => {
  if (!config?.identityId) return undefined;
  return findIdentity(config.identityId, identities) ? undefined : config.identityId;
};

export const findIncompleteProxyIdentityId = (
  config: ProxyConfig | undefined,
  identities: Identity[] = [],
): string | undefined => {
  if (!config?.identityId) return undefined;
  const identity = findIdentity(config.identityId, identities);
  if (!identity) return undefined;
  if (!identity.username?.trim()) return config.identityId;
  if (isEncryptedCredentialPlaceholder(identity.password)) return undefined;
  return sanitizeCredentialValue(identity.password)
    ? undefined
    : config.identityId;
};

export const hasMissingProxyIdentity = (
  config: ProxyConfig | undefined,
  identities: Identity[] = [],
): boolean => {
  return Boolean(findMissingProxyIdentityId(config, identities));
};

export const hasIncompleteProxyIdentity = (
  config: ProxyConfig | undefined,
  identities: Identity[] = [],
): boolean => {
  return Boolean(findIncompleteProxyIdentityId(config, identities));
};

export const formatMissingProxyIdentityMessage = (
  ownerLabel: string,
): string => {
  return `Proxy identity for "${ownerLabel}" is missing. Open settings and select a valid proxy identity.`;
};

export const formatIncompleteProxyIdentityMessage = (
  ownerLabel: string,
): string => {
  return `Proxy identity for "${ownerLabel}" is incomplete. Select an identity with a username and password, or enter proxy credentials manually.`;
};

export const resolveProxyConfigAuth = (
  config: ProxyConfig,
  identities?: Identity[],
): ProxyConfig => {
  const identity = findIdentity(config.identityId, identities);
  const username = config.identityId
    ? identity?.username?.trim()
    : config.username?.trim();
  const password = config.identityId
    ? sanitizeCredentialValue(identity?.password)
    : sanitizeCredentialValue(config.password);

  const resolved: ProxyConfig = {
    type: config.type,
    host: config.host,
    port: config.port,
    username: username || undefined,
    password,
  };
  if (config.command !== undefined) {
    resolved.command = config.command;
  }
  return resolved;
};

export const hasUnreadableProxyCredential = (
  config: ProxyConfig | undefined,
  identities?: Identity[],
): boolean => {
  if (!config) return false;
  const identity = findIdentity(config.identityId, identities);
  const username = config.identityId
    ? identity?.username?.trim()
    : config.username?.trim();
  const rawPassword = config.identityId ? identity?.password : config.password;
  return Boolean(username) &&
    isEncryptedCredentialPlaceholder(rawPassword) &&
    !sanitizeCredentialValue(rawPassword);
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
