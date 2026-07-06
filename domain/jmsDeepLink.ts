import type { Host } from "./models";

export interface JmsDeepLinkTarget {
  protocol: string;
  hostname: string;
  port: number;
  username: string;
  password: string;
  label: string;
}

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
  const port = typeof value === "string" ? Number(value.trim()) : Number(value);
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

export const isSupportedJmsProtocol = (protocol: string): boolean => {
  const normalized = protocol.toLowerCase();
  return normalized === "ssh" || normalized === "sftp" || normalized === "telnet";
};

export const parseJmsDeepLink = (rawUrl: string): JmsDeepLinkTarget | null => {
  if (typeof rawUrl !== "string") return null;
  const trimmed = rawUrl.trim();
  if (!trimmed.toLowerCase().startsWith(JMS_PROTOCOL_PREFIX)) return null;

  const encoded = trimmed.slice(JMS_PROTOCOL_PREFIX.length).replace(/\/+$/, "");
  if (!encoded) return null;

  const jsonText = decodeBase64Payload(encoded);
  if (!jsonText) return null;

  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(jsonText) as Record<string, unknown>;
  } catch {
    return null;
  }

  const protocol = String(payload.protocol || "").toLowerCase();
  if (!protocol) return null;

  const tokenId = nonEmptyString(
    (payload.token as Record<string, unknown> | undefined)?.id ?? payload.id,
  );
  const tokenValue = nonEmptyString(
    (payload.token as Record<string, unknown> | undefined)?.value ?? payload.value,
  );
  if (!tokenId || !tokenValue) return null;

  const endpoint = payload.endpoint as Record<string, unknown> | undefined;
  const hostname = nonEmptyString(endpoint?.host);
  const port = parsePort(endpoint?.port);
  if (!hostname || port === null) return null;

  const asset = payload.asset as Record<string, unknown> | undefined;
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
