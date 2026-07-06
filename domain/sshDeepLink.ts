import type { Host } from "./models";

export interface SshDeepLinkTarget {
  rawUrl: string;
  username?: string;
  password?: string;
  hostname: string;
  port?: number;
}

export interface SshDeepLinkDraftOptions {
  id: string;
  now: number;
}

const DEFAULT_SSH_PORT = 22;
const URL_SCHEME_PATTERN = /^[a-z][a-z0-9+.-]*:/i;

const normalizeHostname = (value: string): string =>
  value.trim().replace(/^\[(.*)\]$/, "$1").toLowerCase();

const decodeUrlComponent = (value: string): string => {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
};

const getHostPort = (host: Host): number => host.port ?? DEFAULT_SSH_PORT;

const isPrimarySshHost = (host: Host): boolean =>
  host.protocol === undefined || host.protocol === "ssh";

export const parseSshDeepLink = (rawUrl: string): SshDeepLinkTarget | null => {
  if (typeof rawUrl !== "string") return null;
  const trimmed = rawUrl.trim();
  if (!trimmed) return null;

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return null;
  }

  if (parsed.protocol !== "ssh:") return null;

  const hostname = normalizeHostname(parsed.hostname);
  if (!hostname) return null;

  const portText = parsed.port;
  const port = portText ? Number(portText) : undefined;
  if (port !== undefined && (!Number.isInteger(port) || port < 1 || port > 65535)) {
    return null;
  }

  const username = parsed.username
    ? decodeUrlComponent(parsed.username).trim()
    : undefined;
  const password = parsed.password
    ? decodeUrlComponent(parsed.password)
    : undefined;

  return {
    rawUrl: trimmed,
    ...(username ? { username } : {}),
    ...(password ? { password } : {}),
    hostname,
    ...(port ? { port } : {}),
  };
};

export const shouldHandleSshDeepLink = (rawUrl: string, enabled: boolean): boolean =>
  enabled && parseSshDeepLink(rawUrl) !== null;

export const findSshDeepLinkHost = (
  hosts: Host[],
  target: SshDeepLinkTarget,
): Host | null => {
  const targetHost = normalizeHostname(target.hostname);
  const targetPort = target.port ?? DEFAULT_SSH_PORT;
  const candidates = hosts.filter((host) => {
    if (!isPrimarySshHost(host)) return false;
    if (normalizeHostname(host.hostname) !== targetHost) return false;
    if (target.username && (host.username || "").trim() !== target.username) return false;
    if (getHostPort(host) !== targetPort) return false;
    return true;
  });

  return candidates.length === 1 ? candidates[0] : null;
};

export const buildSshDeepLinkConnectionHost = (host: Host): Host => ({
  ...host,
  protocol: "ssh",
  moshEnabled: false,
  etEnabled: false,
});

export const buildSshDeepLinkOpenHost = (
  hosts: Host[],
  target: SshDeepLinkTarget,
  options: SshDeepLinkDraftOptions,
): Host => buildSshDeepLinkConnectionHost(
  findSshDeepLinkHost(hosts, target) ?? buildSshDeepLinkHostDraft(target, options),
);

export const buildSshDeepLinkEphemeralHost = (
  target: SshDeepLinkTarget,
  options: SshDeepLinkDraftOptions,
): Host => ({
  ...buildSshDeepLinkHostDraft(target, options),
  ...(target.password ? { password: target.password, authMethod: "password" as const } : {}),
  savePassword: false,
  ephemeral: true,
  moshEnabled: false,
  etEnabled: false,
});

/**
 * Ephemeral host for a password deep link that uniquely matches a saved
 * vault host: keep the saved host's non-credential settings (proxy, jump
 * chain, charset, ...) but authenticate with exactly the URL credentials,
 * so vault identities and key references never override the one-time
 * password.
 *
 * Pass the group-resolved effective host (not the raw vault host): group
 * defaults must already be materialized here, because this builder clears
 * `group` so that later effective-host resolution cannot re-inherit group
 * credentials (identity, key, password) over the URL password.
 */
export const buildSshDeepLinkEphemeralHostFromSaved = (
  effectiveSavedHost: Host,
  target: SshDeepLinkTarget,
  options: SshDeepLinkDraftOptions,
): Host => ({
  ...effectiveSavedHost,
  id: options.id,
  createdAt: options.now,
  ...(target.username ? { username: target.username } : {}),
  ...(target.password ? { password: target.password, authMethod: "password" as const } : {}),
  identityId: undefined,
  identityFileId: undefined,
  identityFilePaths: undefined,
  savePassword: false,
  group: "",
  ephemeral: true,
  protocol: "ssh",
  moshEnabled: false,
  etEnabled: false,
});

export const buildSshDeepLinkHostDraft = (
  target: SshDeepLinkTarget,
  options: SshDeepLinkDraftOptions,
): Host => ({
  id: options.id,
  label: target.username ? `${target.username}@${target.hostname}` : target.hostname,
  hostname: target.hostname,
  username: target.username || "",
  ...(target.port !== undefined ? { port: target.port } : {}),
  group: "",
  tags: [],
  os: "linux",
  protocol: "ssh",
  createdAt: options.now,
});

const normalizeBareHostReference = (value: string): string | null => {
  const decoded = decodeUrlComponent(value).trim().replace(/^\.\/+/, "").replace(/\/+$/, "");
  if (!decoded || decoded.includes(" ") || decoded.startsWith("#") || decoded.startsWith("/")) return null;
  if (URL_SCHEME_PATTERN.test(decoded)) return null;
  return decoded;
};

const isDocumentRelativeLink = (value: string): boolean => {
  const trimmed = value.trim();
  return trimmed.startsWith("#")
    || trimmed.startsWith("/")
    || trimmed.startsWith("./")
    || trimmed.startsWith("../")
    || trimmed.includes("/")
    || trimmed.includes("?")
    || trimmed.includes("#");
};

const parseBareHostReference = (value: string): SshDeepLinkTarget | null => {
  const reference = normalizeBareHostReference(value);
  if (!reference) return null;
  return parseSshDeepLink(`ssh://${reference}`);
};

const findHostByLabel = (hosts: Host[], label: string): Host | null => {
  const needle = label.trim().toLowerCase();
  if (!needle) return null;
  const candidates = hosts.filter((host) =>
    isPrimarySshHost(host) && (host.label || "").trim().toLowerCase() === needle,
  );
  return candidates.length === 1 ? candidates[0] : null;
};

export const buildSshNoteLinkOpenHost = (
  hosts: Host[],
  href: string,
  label: string | undefined,
  options: SshDeepLinkDraftOptions,
): Host | null => {
  const normalizedHref = href.trim();
  const deepLinkTarget = parseSshDeepLink(href);
  if (deepLinkTarget) {
    return buildSshDeepLinkOpenHost(hosts, deepLinkTarget, options);
  }

  if (URL_SCHEME_PATTERN.test(normalizedHref)) {
    return null;
  }
  if (isDocumentRelativeLink(normalizedHref)) {
    return null;
  }

  const references = [href, label]
    .filter((value): value is string => Boolean(value?.trim()));
  for (const reference of references) {
    const target = parseBareHostReference(reference);
    if (!target) continue;
    const host = findSshDeepLinkHost(hosts, target);
    if (host) return buildSshDeepLinkConnectionHost(host);
  }

  for (const reference of references) {
    const host = findHostByLabel(hosts, reference);
    if (host) return buildSshDeepLinkConnectionHost(host);
  }

  return null;
};
