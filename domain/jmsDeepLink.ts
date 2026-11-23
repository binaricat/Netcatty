import type { Host } from "./models";

export interface JmsDeepLinkTarget {
  protocol: string;
  hostname: string;
  port: number;
  username: string;
  password: string;
  label: string;
}

export type JmsDeepLinkParseResult =
  | { ok: true; target: JmsDeepLinkTarget }
  | { ok: false; reason: "unsupported_protocol"; protocol: string }
  | { ok: false; reason: "invalid" };

export interface JmsDeepLinkDraftOptions {
  id: string;
  now: number;
}

const JMS_PROTOCOL_PREFIX = "jms://";

const decodeBase64Payload = (encoded: string): string | null => {
  let normalized = encoded.replace(/-/g, "+").replace(/_/g, "/");
  while (normalized.length % 4 !== 0) {
    normalized += "=";
  }
  try {
    if (typeof Buffer !== "undefined") {
      return Buffer.from(normalized, "base64").toString("utf8");
    }
    const binary = globalThis.atob(normalized);
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    return new TextDecoder().decode(bytes);
  } catch {
    return null;
  }
};

const parsePort = (value: unknown): number | null => {
  if (typeof value !== "number" && typeof value !== "string") {
    return null;
  }
  const port = typeof value === "string" ? Number(value.trim()) : value;
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return null;
  }
  return port;
};

const nonEmptyString = (value: unknown): string | null => {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export const isSupportedJmsProtocol = (protocol: string): boolean => {
  const normalized = protocol.toLowerCase();
  return normalized === "ssh" || normalized === "sftp" || normalized === "telnet";
};

const parseJmsPayload = (rawUrl: string): Record<string, unknown> | null => {
  if (typeof rawUrl !== "string") return null;
  const trimmed = rawUrl.trim();
  if (!trimmed.toLowerCase().startsWith(JMS_PROTOCOL_PREFIX)) return null;

  const encoded = trimmed.slice(JMS_PROTOCOL_PREFIX.length).replace(/\/+$/, "");
  if (!encoded) return null;

  const jsonText = decodeBase64Payload(encoded);
  if (!jsonText) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    return null;
  }

  if (!isRecord(parsed)) return null;
  return parsed;
};

const extractJmsTarget = (
  payload: Record<string, unknown>,
  protocol: string,
): JmsDeepLinkTarget | null => {
  const token = isRecord(payload.token) ? payload.token : undefined;
  const tokenId = nonEmptyString(token?.id ?? payload.id);
  const tokenValue = nonEmptyString(token?.value ?? payload.value);
  if (!tokenId || !tokenValue) return null;

  const endpoint = isRecord(payload.endpoint) ? payload.endpoint : undefined;
  const hostname = nonEmptyString(endpoint?.host);
  const port = parsePort(endpoint?.port);
  if (!hostname || port === null) return null;

  const asset = isRecord(payload.asset) ? payload.asset : undefined;
  const label = nonEmptyString(asset?.name) || nonEmptyString(payload.name) || hostname;

  return {
    protocol,
    hostname,
    port,
    username: `JMS-${tokenId}`,
    password: tokenValue,
    label,
  };
};

export const parseJmsDeepLinkResult = (rawUrl: string): JmsDeepLinkParseResult => {
  const payload = parseJmsPayload(rawUrl);
  if (!payload) return { ok: false, reason: "invalid" };

  const protocol = nonEmptyString(payload.protocol)?.toLowerCase();
  if (!protocol) return { ok: false, reason: "invalid" };

  if (!isSupportedJmsProtocol(protocol)) {
    return { ok: false, reason: "unsupported_protocol", protocol };
  }

  const target = extractJmsTarget(payload, protocol);
  if (!target) return { ok: false, reason: "invalid" };

  return { ok: true, target };
};

export const parseJmsDeepLink = (rawUrl: string): JmsDeepLinkTarget | null => {
  const payload = parseJmsPayload(rawUrl);
  if (!payload) return null;

  const protocol = nonEmptyString(payload.protocol)?.toLowerCase();
  if (!protocol) return null;

  return extractJmsTarget(payload, protocol);
};

export const buildJmsDeepLinkEphemeralHost = (
  target: JmsDeepLinkTarget,
  options: JmsDeepLinkDraftOptions,
): Host => {
  return {
    id: options.id,
    label: target.label,
    hostname: target.hostname,
    username: target.username,
    port: target.port,
    password: target.password,
    authMethod: "password",
    savePassword: false,
    ephemeral: true,
    protocol: "ssh",
    // JumpServer sftp payloads target file transfer: connect the gateway
    // shell and surface Netcatty's SFTP side panel for that session.
    ...(target.protocol === "sftp" ? { autoOpenSftpPanel: true } : {}),
    group: "",
    tags: [],
    os: "linux",
    createdAt: options.now,
    moshEnabled: false,
    etEnabled: false,
  };
};
