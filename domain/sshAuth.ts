import type { Host, Identity, SSHKey } from "./models";

type HostAuthMethod = "password" | "key" | "certificate";

type HostAuthOverride = {
  authMethod?: HostAuthMethod;
  username?: string;
  password?: string;
  keyId?: string;
  passphrase?: string;
};

type ResolvedHostAuth = {
  identity?: Identity;
  authMethod: HostAuthMethod;
  username: string;
  password?: string;
  keyId?: string;
  key?: SSHKey;
  passphrase?: string;
};

const inferAuthMethod = (opts: {
  explicit?: HostAuthMethod;
  keyId?: string;
  password?: string;
  hostAuthMethod?: HostAuthMethod;
  key?: SSHKey;
}): HostAuthMethod => {
  if (opts.explicit) return opts.explicit;
  if (opts.keyId) {
    if (opts.hostAuthMethod === "key" || opts.hostAuthMethod === "certificate") {
      return opts.hostAuthMethod;
    }
    return opts.key?.certificate ? "certificate" : "key";
  }
  if (opts.hostAuthMethod) return opts.hostAuthMethod;
  if (opts.password) return "password";
  return "password";
};

export const resolveHostAuth = (args: {
  host: Host;
  keys: SSHKey[];
  identities?: Identity[];
  override?: HostAuthOverride | null;
}): ResolvedHostAuth => {
  const { host, keys, identities = [], override } = args;

  const identity = host.identityId
    ? identities.find((i) => i.id === host.identityId)
    : undefined;

  const username =
    override?.username?.trim() ||
    identity?.username?.trim() ||
    host.username?.trim() ||
    "";

  // Don't load key when explicit password auth is requested
  // This ensures user's auth method selection is strictly respected
  const keyId = override?.authMethod === 'password'
    ? undefined
    : (override?.keyId || identity?.keyId || host.identityFileId || undefined);


  const key = keyId ? keys.find((k) => k.id === keyId) : undefined;

  const password = override?.password ?? identity?.password ?? host.password;

  const authMethod = inferAuthMethod({
    explicit: override?.authMethod,
    hostAuthMethod: (identity?.authMethod || host.authMethod) as HostAuthMethod | undefined,
    keyId,
    password,
    key,
  });

  const passphrase = override?.passphrase || key?.passphrase || undefined;

  return {
    identity,
    authMethod,
    username,
    password,
    keyId,
    key,
    passphrase,
  };
};
