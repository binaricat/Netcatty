import type { Host } from "./models";

export interface TelnetDeepLinkTarget {
  rawUrl: string;
  username?: string;
  password?: string;
  hostname: string;
  port?: number;
}

export interface TelnetDeepLinkDraftOptions {
  id: string;
  now: number;
}

const DEFAULT_TELNET_PORT = 23;

const normalizeHostname = (value: string): string =>
  value.trim().replace(/^\[(.*)\]$/, "$1").toLowerCase();

const decodeUrlComponent = (value: string): string => {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
};

const getHostPort = (host: Host): number =>
  host.telnetPort ?? (host.protocol === "telnet" ? host.port : undefined) ?? DEFAULT_TELNET_PORT;

const getHostUsername = (host: Host): string =>
  (host.telnetUsername !== undefined ? host.telnetUsername : host.username || "").trim();

const isTelnetHost = (host: Host): boolean =>
  host.protocol === "telnet" || host.telnetEnabled === true;

export const parseTelnetDeepLink = (rawUrl: string): TelnetDeepLinkTarget | null => {
  if (typeof rawUrl !== "string") return null;
  const trimmed = rawUrl.trim();
  if (!trimmed) return null;

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return null;
  }

  if (parsed.protocol !== "telnet:") return null;

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

export const shouldHandleTelnetDeepLink = (rawUrl: string, enabled: boolean): boolean =>
  enabled && parseTelnetDeepLink(rawUrl) !== null;

export const findTelnetDeepLinkHost = (
  hosts: Host[],
  target: TelnetDeepLinkTarget,
): Host | null => {
  const targetHost = normalizeHostname(target.hostname);
  const targetPort = target.port ?? DEFAULT_TELNET_PORT;
  const candidates = hosts.filter((host) => {
    if (!isTelnetHost(host)) return false;
    if (normalizeHostname(host.hostname) !== targetHost) return false;
    if (target.username && getHostUsername(host) !== target.username) return false;
    if (getHostPort(host) !== targetPort) return false;
    return true;
  });

  return candidates.length === 1 ? candidates[0] : null;
};

export const buildTelnetDeepLinkConnectionHost = (host: Host): Host => ({
  ...host,
  protocol: "telnet",
  telnetEnabled: true,
  telnetPort: host.telnetPort ?? host.port ?? DEFAULT_TELNET_PORT,
  moshEnabled: false,
  etEnabled: false,
});

export const buildTelnetDeepLinkHostDraft = (
  target: TelnetDeepLinkTarget,
  options: TelnetDeepLinkDraftOptions,
): Host => ({
  id: options.id,
  label: target.username ? `${target.username}@${target.hostname}` : target.hostname,
  hostname: target.hostname,
  username: target.username || "",
  port: target.port ?? DEFAULT_TELNET_PORT,
  group: "",
  tags: [],
  os: "linux",
  protocol: "telnet",
  telnetEnabled: true,
  telnetPort: target.port ?? DEFAULT_TELNET_PORT,
  ...(target.username ? { telnetUsername: target.username } : {}),
  ...(target.password ? { telnetPassword: target.password } : {}),
  savePassword: false,
  ephemeral: true,
  moshEnabled: false,
  etEnabled: false,
  createdAt: options.now,
});

export const buildTelnetDeepLinkOpenHost = (
  hosts: Host[],
  target: TelnetDeepLinkTarget,
  options: TelnetDeepLinkDraftOptions,
): Host =>
  buildTelnetDeepLinkConnectionHost(
    findTelnetDeepLinkHost(hosts, target) ?? buildTelnetDeepLinkHostDraft(target, options),
  );
