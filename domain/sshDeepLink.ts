import type { Host } from "./models";

export interface SshDeepLinkTarget {
  rawUrl: string;
  username?: string;
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

  return {
    rawUrl: trimmed,
    ...(username ? { username } : {}),
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
