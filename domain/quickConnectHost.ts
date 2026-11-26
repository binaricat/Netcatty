import { sanitizeCredentialValue } from "./credentials";
import type { Host, Identity, RdpConfig, SSHKey, VncConfig } from "./models";
import type { QuickConnectTarget } from "./quickConnect";
import {
  buildStandaloneRdpHost,
  buildStandaloneVncHost,
  DEFAULT_RDP_PORT,
  DEFAULT_VNC_PORT,
} from "./remoteDesktop";

export type QuickConnectProtocol = "ssh" | "mosh" | "et" | "telnet" | "rdp" | "vnc";
export type QuickConnectAuthMethod = "password" | "key" | "certificate";

export const getQuickConnectDefaultPort = (
  protocol: QuickConnectProtocol,
): number => {
  if (protocol === "telnet") return 23;
  if (protocol === "rdp") return DEFAULT_RDP_PORT;
  if (protocol === "vnc") return DEFAULT_VNC_PORT;
  return 22;
};

export const isQuickConnectIdentityUsable = (
  identity: Identity | undefined,
  keys: SSHKey[],
  protocol: QuickConnectProtocol = "ssh",
): boolean => {
  if (!identity || protocol === "telnet") return false;
  if (protocol === "vnc") {
    return identity.authMethod === "password"
      && Boolean(sanitizeCredentialValue(identity.password));
  }
  if (!identity.username.trim()) return false;
  if (protocol === "rdp") {
    return identity.authMethod === "password"
      && Boolean(sanitizeCredentialValue(identity.password));
  }
  if (identity.authMethod === "password") {
    return Boolean(sanitizeCredentialValue(identity.password));
  }
  return Boolean(identity.keyId && keys.some((key) => key.id === identity.keyId));
};

export const isQuickConnectIdentityCompatible = (
  identity: Identity,
  target: QuickConnectTarget,
): boolean => !target.isJumpServerLogin
  || identity.username === target.username;

type BuildQuickConnectHostInput = {
  id: string;
  createdAt: number;
  target: QuickConnectTarget;
  protocol: QuickConnectProtocol;
  port: number;
  username: string;
  authMethod: QuickConnectAuthMethod;
  password?: string;
  domain?: string;
  rdpConfig?: RdpConfig;
  vncConfig?: VncConfig;
  selectedKeyId?: string | null;
  selectedIdentityId?: string | null;
  save?: boolean;
};

export const buildQuickConnectHost = ({
  id,
  createdAt,
  target,
  protocol,
  port,
  username,
  authMethod,
  password,
  domain,
  rdpConfig,
  vncConfig,
  selectedKeyId,
  selectedIdentityId,
  save = false,
}: BuildQuickConnectHostInput): Host => {
  if (protocol === "rdp") {
    const effectiveDomain = domain?.trim() || target.domain?.trim() || rdpConfig?.domain?.trim() || undefined;
    const applicableIdentityId = selectedIdentityId || undefined;
    return buildStandaloneRdpHost({
      id,
      createdAt,
      label: target.hostname,
      hostname: target.hostname,
      port: port || DEFAULT_RDP_PORT,
      username: username ?? "",
      identityId: applicableIdentityId,
      password: !applicableIdentityId ? password : undefined,
      ephemeral: !save,
      rdpConfig: {
        ...(rdpConfig ?? {}),
        port: port || DEFAULT_RDP_PORT,
        ...(effectiveDomain ? { domain: effectiveDomain } : {}),
      },
    });
  }

  if (protocol === "vnc") {
    const applicableIdentityId = selectedIdentityId || undefined;
    return buildStandaloneVncHost({
      id,
      createdAt,
      label: target.hostname,
      hostname: target.hostname,
      port: port || DEFAULT_VNC_PORT,
      username: username ?? "",
      identityId: applicableIdentityId,
      password: !applicableIdentityId ? password : undefined,
      ephemeral: !save,
      vncConfig: {
        ...(vncConfig ?? {}),
        port: port || DEFAULT_VNC_PORT,
      },
    });
  }

  const isTelnet = protocol === "telnet";
  const applicableIdentityId = isTelnet ? undefined : selectedIdentityId || undefined;

  return {
    id,
    label: target.hostname,
    hostname: target.hostname,
    port,
    username,
    group: "",
    tags: [],
    os: "linux",
    protocol: protocol === "mosh" || protocol === "et" ? "ssh" : protocol,
    authMethod,
    sshInputCompatibility: false,
    identityId: applicableIdentityId,
    password: !applicableIdentityId && authMethod === "password" ? password : undefined,
    identityFileId:
      !applicableIdentityId && authMethod !== "password"
        ? selectedKeyId || undefined
        : undefined,
    moshEnabled: protocol === "mosh",
    etEnabled: protocol === "et",
    etPort: protocol === "et" ? 2022 : undefined,
    telnetEnabled: isTelnet,
    telnetPort: isTelnet ? port : undefined,
    ephemeral: !save,
    createdAt,
  };
};
