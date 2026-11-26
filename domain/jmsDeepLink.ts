import type { Host, RdpConfig, VncConfig } from "./models";
import { parsedRdpFileToRdpConfig, parseRdpFile } from "./rdpFileParser";
import { buildStandaloneRdpHost, buildStandaloneVncHost } from "./remoteDesktop";

export interface JmsDeepLinkTarget {
  protocol: string;
  hostname: string;
  port: number;
  username: string;
  password: string;
  label: string;
  domain?: string;
  rdpConfig?: RdpConfig;
  vncConfig?: VncConfig;
  /** Raw `.rdp` content from JumpServer v4 embedded file payloads (for System RDP Client mode). */
  rawRdpFileContent?: string;
  /** Original `.rdp` filename from JumpServer v4 embedded file payloads. */
  rawRdpFileName?: string;
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
  return (
    normalized === "ssh"
    || normalized === "sftp"
    || normalized === "telnet"
    || normalized === "rdp"
    || normalized === "vnc"
  );
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

const extractEmbeddedRdpTarget = (
  payload: Record<string, unknown>,
): JmsDeepLinkTarget | null => {
  const file = isRecord(payload.file) ? payload.file : undefined;
  const rawContent = typeof file?.content === "string" ? file.content : "";
  if (!rawContent.trim()) return null;

  const parsed = parseRdpFile(rawContent);
  if (!parsed.hostname) return null;

  const token = isRecord(payload.token) ? payload.token : undefined;
  const tokenId = nonEmptyString(token?.id ?? payload.id);
  const tokenValue = nonEmptyString(token?.value ?? payload.value);
  const asset = isRecord(payload.asset) ? payload.asset : undefined;
  const fileName = nonEmptyString(file?.name);
  const fileBaseName = fileName?.replace(/\.rdp$/i, "").trim() || null;

  const label = nonEmptyString(asset?.name)
    || nonEmptyString(payload.name)
    || fileBaseName
    || parsed.hostname;
  const username = parsed.username || (tokenId ? `JMS-${tokenId}` : "");
  const rdpConfig = parsedRdpFileToRdpConfig(parsed);

  return {
    protocol: "rdp",
    hostname: parsed.hostname,
    port: parsed.port,
    username,
    password: tokenValue ?? "",
    label,
    ...(parsed.domain ? { domain: parsed.domain } : {}),
    rdpConfig,
    rawRdpFileContent: rawContent,
    ...(fileName ? { rawRdpFileName: fileName } : {}),
  };
};

const extractJmsTarget = (
  payload: Record<string, unknown>,
  protocol: string,
): JmsDeepLinkTarget | null => {
  if (protocol === "rdp") {
    const embedded = extractEmbeddedRdpTarget(payload);
    if (embedded) return embedded;
  }

  const token = isRecord(payload.token) ? payload.token : undefined;
  const tokenId = nonEmptyString(token?.id ?? payload.id);
  const tokenValue = nonEmptyString(token?.value ?? payload.value);
  if (!tokenId || !tokenValue) return null;

  const endpoint = isRecord(payload.endpoint) ? payload.endpoint : undefined;
  const hostname = nonEmptyString(endpoint?.host);
  const rawPort = protocol === "rdp"
    ? (endpoint?.port ?? endpoint?.rdp_port)
    : protocol === "vnc"
      ? (endpoint?.port ?? endpoint?.vnc_port)
      : endpoint?.port;
  const port = parsePort(rawPort);
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
  const normalizedProtocol = target.protocol.toLowerCase();

  if (normalizedProtocol === "rdp") {
    return buildStandaloneRdpHost({
      id: options.id,
      label: target.label,
      hostname: target.hostname,
      port: target.port,
      username: target.username,
      password: target.password || undefined,
      savePassword: false,
      ephemeral: true,
      createdAt: options.now,
      rdpConfig: target.rdpConfig
        ? { ...target.rdpConfig, ...(target.domain ? { domain: target.domain } : {}) }
        : { port: target.port, ...(target.domain ? { domain: target.domain } : {}) },
    });
  }

  if (normalizedProtocol === "vnc") {
    return buildStandaloneVncHost({
      id: options.id,
      label: target.label,
      hostname: target.hostname,
      port: target.port,
      username: target.username,
      password: target.password || undefined,
      savePassword: false,
      ephemeral: true,
      createdAt: options.now,
      vncConfig: target.vncConfig ? { ...target.vncConfig } : { port: target.port },
    });
  }

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
    ...(normalizedProtocol === "sftp" ? { autoOpenSftpPanel: true } : {}),
    group: "",
    tags: [],
    os: "linux",
    createdAt: options.now,
    moshEnabled: false,
    etEnabled: false,
  };
};
