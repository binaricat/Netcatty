import type { ProxyConfig } from "../models";
import { decodeCsvProxy } from "./csvCredentialFields";

// CSV representation of a per-host proxy configuration:
//   http://[user[:pass]@]host:port
//   socks5://[user[:pass]@]host:port
//   command://<command text, verbatim after the scheme>
const PROXY_SCHEME_PATTERN = /^(http|socks5|command):\/\/(.*)$/is;
const PROXY_AUTHORITY_PATTERN = /^(?:([^@:/?#\s]+)(?::([^@/?#]*))?@)?(\[[^\[\]@/?#\s]+\]|[^\[\]@:/?#\s]+):(\d+)$/u;

const decodeAuthorityPart = (value: string | undefined): string | undefined => {
  if (value === undefined) return undefined;
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
};

export const formatCsvProxy = (config: ProxyConfig): string => {
  if (config.type === "command") {
    return `command://${config.command ?? ""}`;
  }
  const scheme = config.type === "socks5" ? "socks5" : "http";
  const username = config.username?.trim();
  const auth = username
    ? `${encodeURIComponent(username)}${config.password ? `:${encodeURIComponent(config.password)}` : ""}@`
    : "";
  const host = config.host.trim();
  const authorityHost = host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
  return `${scheme}://${auth}${authorityHost}:${config.port}`;
};

export const parseCsvProxy = (raw: string): ProxyConfig | undefined => {
  const value = decodeCsvProxy(raw.trim());
  if (!value) return undefined;
  const match = value.match(PROXY_SCHEME_PATTERN);
  if (!match) return undefined;
  const scheme = match[1].toLowerCase();
  if (scheme === "command") {
    const command = match[2].trim();
    if (!command) return undefined;
    return { type: "command", host: "", port: 0, command };
  }
  if (/[\s\0]/.test(match[2])) return undefined;
  const authority = match[2].match(PROXY_AUTHORITY_PATTERN);
  if (!authority) return undefined;
  const host = (authority[3] ?? "").trim().replace(/^\[(.*)\]$/u, "$1");
  const port = Number(authority[4]);
  if (!host || !Number.isInteger(port) || port < 1 || port > 65535) return undefined;
  const config: ProxyConfig = {
    type: scheme === "socks5" ? "socks5" : "http",
    host,
    port,
  };
  const username = decodeAuthorityPart(authority[1]);
  const password = decodeAuthorityPart(authority[2]);
  if (username) config.username = username;
  if (password) config.password = password;
  return config;
};
