import { sanitizeCredentialValue } from "./credentials";
import type { Host, Identity, SSHKey } from "./models";
import type { QuickConnectTarget } from "./quickConnect";

export type QuickConnectProtocol = "ssh" | "mosh" | "et" | "telnet";
export type QuickConnectAuthMethod = "password" | "key" | "certificate";

export const getQuickConnectDefaultPort = (
  protocol: QuickConnectProtocol,
): number => protocol === "telnet" ? 23 : 22;

export const isQuickConnectIdentityUsable = (
  identity: Identity | undefined,
  keys: SSHKey[],
  protocol: QuickConnectProtocol = "ssh",
): boolean => {
  if (!identity?.username.trim() || protocol === "telnet") return false;
  if (identity.authMethod === "password") {
    return Boolean(sanitizeCredentialValue(identity.password));
  }
  return Boolean(identity.keyId && keys.some((key) => key.id === identity.keyId));
};

type BuildQuickConnectHostInput = {
  id: string;
  createdAt: number;
  target: QuickConnectTarget;
  protocol: QuickConnectProtocol;
  port: number;
  username: string;
  authMethod: QuickConnectAuthMethod;
  password?: string;
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
  selectedKeyId,
  selectedIdentityId,
  save = false,
}: BuildQuickConnectHostInput): Host => {
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
