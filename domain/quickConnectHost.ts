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
  /** Host IDs of the jump chain (first = closest to client). */
  chainHostIds?: string[];
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
  chainHostIds,
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
    ...(chainHostIds && chainHostIds.length > 0
      ? { hostChain: { hostIds: chainHostIds } }
      : {}),
    ephemeral: !save,
    createdAt,
  };
};

/**
 * SSH hosts for the jump hops of a multi-@ quick connect target
 * (issue #3523). They are registered alongside the quick connect host so the
 * existing jump chain machinery can resolve them by id. Jump hops for a
 * one-off connect stay ephemeral; hops saved with the host become vault hosts.
 */
export const buildQuickConnectJumpHost = ({
  id,
  createdAt,
  jump,
  save = false,
}: {
  id: string;
  createdAt: number;
  jump: QuickConnectTarget;
  save?: boolean;
}): Host => ({
  id,
  label: jump.username ? `${jump.username}@${jump.hostname}` : jump.hostname,
  hostname: jump.hostname,
  port: jump.port ?? getQuickConnectDefaultPort("ssh"),
  username: jump.username ?? "",
  group: "",
  tags: [],
  os: "linux",
  protocol: "ssh",
  authMethod: "auto",
  ephemeral: !save,
  createdAt,
});
