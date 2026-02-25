import type {
  Host,
  HostChainConnectionMode,
  Identity,
  SSHKey,
} from "./models";
import { resolveHostAuth, type HostAuthOverride } from "./sshAuth";

export const DEFAULT_HOST_CHAIN_MODE: HostChainConnectionMode = "proxy-tunnel";

export type JumpHostAuthPlan = {
  hostname: string;
  port: number;
  username: string;
  authMethod: "password" | "key" | "certificate";
  password?: string;
  privateKey?: string;
  certificate?: string;
  passphrase?: string;
  publicKey?: string;
  keyId?: string;
  keySource?: "generated" | "imported";
  label?: string;
};

export type HostAuthPlan = {
  authMethod: "password" | "key" | "certificate";
  username: string;
  password?: string;
  privateKey?: string;
  certificate?: string;
  passphrase?: string;
  publicKey?: string;
  keyId?: string;
  keySource?: "generated" | "imported";
};

const toHostAuthPayload = (
  resolved: ReturnType<typeof resolveHostAuth>,
): HostAuthPlan => {
  const passwordOnly = resolved.authMethod === "password";
  const key = passwordOnly ? undefined : resolved.key;
  return {
    authMethod: resolved.authMethod,
    username: resolved.username || "root",
    password: resolved.password,
    privateKey: key?.privateKey,
    certificate: key?.certificate,
    passphrase: passwordOnly ? undefined : (resolved.passphrase || key?.passphrase),
    publicKey: key?.publicKey,
    keyId: passwordOnly ? undefined : resolved.keyId,
    keySource: passwordOnly ? undefined : key?.source,
  };
};

export const resolveHostChainConnectionMode = (
  host: Host,
): HostChainConnectionMode => {
  return host.hostChain?.connectionMode || DEFAULT_HOST_CHAIN_MODE;
};

export const resolveChainHostsForHost = (
  host: Host,
  allHosts: Host[],
): Host[] => {
  if (!host.hostChain?.hostIds || host.hostChain.hostIds.length === 0) {
    return [];
  }
  return host.hostChain.hostIds
    .map((id) => allHosts.find((candidate) => candidate.id === id))
    .filter((candidate): candidate is Host => !!candidate);
};

export const buildJumpHostAuthPlans = (args: {
  jumpHosts: Host[];
  keys: SSHKey[];
  identities?: Identity[];
}): JumpHostAuthPlan[] => {
  const { jumpHosts, keys, identities = [] } = args;
  return jumpHosts.map((jumpHost) => {
    const resolved = resolveHostAuth({
      host: jumpHost,
      keys,
      identities,
    });
    const payload = toHostAuthPayload(resolved);
    return {
      hostname: jumpHost.hostname,
      port: jumpHost.port || 22,
      username: payload.username,
      authMethod: payload.authMethod,
      password: payload.password,
      privateKey: payload.privateKey,
      certificate: payload.certificate,
      passphrase: payload.passphrase,
      publicKey: payload.publicKey,
      keyId: payload.keyId,
      keySource: payload.keySource,
      label: jumpHost.label,
    };
  });
};

export const buildHostAuthPlan = (args: {
  host: Host;
  keys: SSHKey[];
  identities?: Identity[];
  override?: HostAuthOverride | null;
}): HostAuthPlan => {
  const resolved = resolveHostAuth(args);
  return toHostAuthPayload(resolved);
};
