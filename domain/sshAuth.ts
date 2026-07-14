import type { GroupConfig, Host, HostAuthMethod, Identity, SSHKey } from "./models";
import { sanitizeCredentialValue } from "./credentials";
import { applyGroupDefaults } from "./groupConfig";
import { isSshAgentNoneValue } from "./sshAgentSettings";

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
  identityFilePath?: string;
};

const hasAgentEnablingDirectives = (
  host: Pick<Host, "addKeysToAgent" | "useKeychain">,
  identityAgent?: string,
): boolean => Boolean(
  identityAgent
  || (
    typeof host.addKeysToAgent === "string"
    && host.addKeysToAgent.trim().length > 0
    && host.addKeysToAgent.trim().toLowerCase() !== "no"
  )
  || host.useKeychain === true,
);

export const resolveHostAuthMethodSelection = (
  host: Pick<Host, "authMethod" | "authPolicyVersion" | "identityFileId" | "identityFilePaths" | "password" | "useSshAgent">,
): HostAuthMethod => host.authMethod || (
  host.useSshAgent === true
    ? "auto"
    : host.identityFileId || host.identityFilePaths?.length
    ? "key"
    : host.password && host.authPolicyVersion !== 1
      ? "password"
      : "auto"
);

export const applyHostAuthMethodSelection = <T extends Host>(
  host: T,
  authMethod: HostAuthMethod,
  previousMethod: HostAuthMethod = resolveHostAuthMethodSelection(host),
): T => {
  if (previousMethod === authMethod) {
    return {
      ...host,
      authMethod,
      authPolicyVersion: 1,
    };
  }

  const isAutomatic = authMethod === "auto";

  const automaticIdentityAgent = isAutomatic && isSshAgentNoneValue(host.identityAgent)
    ? undefined
    : host.identityAgent;
  const hasAutomaticAgentSettings = hasAgentEnablingDirectives(host, automaticIdentityAgent);

  return {
    ...host,
    authMethod,
    authPolicyVersion: 1,
    identityId: "",
    identityFileId: undefined,
    identityFilePaths: undefined,
    ...(isAutomatic
      ? { identityAgent: automaticIdentityAgent, identitiesOnly: undefined }
      : {}),
    useSshAgent: isAutomatic
      ? (hasAutomaticAgentSettings ? true : undefined)
      : authMethod === "key" && previousMethod === "key"
        ? host.useSshAgent
        : false,
  };
};

export const resolveSshAgentToggleUpdate = (
  host: Pick<Host, "identityAgent" | "addKeysToAgent" | "useKeychain">,
  authMethod: HostAuthMethod,
  enabling: boolean,
): Pick<Host, "useSshAgent" | "identityAgent"> => {
  const identityAgent = enabling && isSshAgentNoneValue(host.identityAgent)
    ? undefined
    : host.identityAgent;
  const hasExplicitAgentSettings = hasAgentEnablingDirectives(host, identityAgent);
  return {
    useSshAgent: enabling
      ? (authMethod === "auto" && !hasExplicitAgentSettings ? undefined : true)
      : false,
    identityAgent,
  };
};

const inferAuthMethod = (opts: {
  explicit?: HostAuthMethod;
  keyId?: string;
  password?: string;
  hostAuthMethod?: HostAuthMethod;
  key?: SSHKey;
}): HostAuthMethod => {
  if (opts.explicit) return opts.explicit;
  if (opts.hostAuthMethod === "auto") return "auto";
  if (opts.keyId) {
    if (opts.hostAuthMethod === "key" || opts.hostAuthMethod === "certificate") {
      return opts.hostAuthMethod;
    }
    return opts.key?.certificate ? "certificate" : "key";
  }
  if (opts.hostAuthMethod) return opts.hostAuthMethod;
  if (opts.password) return "password";
  return "auto";
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

  const selectedAuthMethod = (
    override?.authMethod ||
    identity?.authMethod ||
    host.authMethod ||
    (
      host.useSshAgent === true
        ? "auto"
        : host.identityFilePaths?.length
          ? "key"
          : host.authPolicyVersion === 1 && !host.identityFileId
            ? "auto"
            : undefined
    )
  ) as HostAuthMethod | undefined;

  // Don't load key when password auth is selected.
  // This ensures the user's auth method selection is strictly respected.
  const keyId = selectedAuthMethod === "password"
    ? undefined
    : (override?.keyId || identity?.keyId || host.identityFileId || undefined);


  const key = keyId ? keys.find((k) => k.id === keyId) : undefined;

  const password = override?.password ?? identity?.password ?? host.password;

  const authMethod = inferAuthMethod({
    explicit: override?.authMethod,
    hostAuthMethod: selectedAuthMethod,
    keyId,
    password,
    key,
  });

  const passphrase = override?.passphrase || key?.passphrase || undefined;

  const identityFilePath = key?.source === 'reference' && key.filePath
    ? key.filePath
    : undefined;

  return {
    identity,
    authMethod,
    username,
    password,
    keyId,
    key,
    passphrase,
    identityFilePath,
  };
};

export const resolveHostAuthMethodForPersistence = (args: {
  host: Host;
  keys: SSHKey[];
  identities?: Identity[];
  groupDefaults?: Partial<GroupConfig>;
}): HostAuthMethod | undefined => {
  const { host, keys, identities, groupDefaults } = args;
  if (host.authMethod) return host.authMethod;

  const resolveEffectiveMethod = (candidate: Host) => resolveHostAuth({
    host: groupDefaults ? applyGroupDefaults(candidate, groupDefaults) : candidate,
    keys,
    identities,
  }).authMethod;
  const methodBeforeSave = resolveEffectiveMethod(host);
  const methodAfterSave = resolveEffectiveMethod(
    host.savePassword === false ? { ...host, password: undefined } : host,
  );
  return methodBeforeSave === methodAfterSave ? undefined : methodBeforeSave;
};

/**
 * Resolve the password to use for sudo/su autofill the same way SSH login does
 * (through resolveHostAuth), so a password stored in a referenced Keychain
 * identity (host.identityId) is found — not just host.password (issue #1284).
 * Returns undefined when the host opts out of saving its password, or none is
 * available (pure key auth, or an undecryptable placeholder).
 * Used for both sudo and su confirm-to-fill hints (#2156).
 */
export const resolveHostAutofillPassword = (args: {
  host: Host;
  keys: SSHKey[];
  identities?: Identity[];
}): string | undefined => {
  if (args.host.savePassword === false) return undefined;
  return sanitizeCredentialValue(resolveHostAuth(args).password) || undefined;
};

export const resolveBridgeKeyAuth = (args: {
  key?: SSHKey | null;
  fallbackIdentityFilePaths?: string[];
  passphrase?: string;
}): {
  privateKey?: string;
  identityFilePaths?: string[];
  passphrase?: string;
} => {
  const { key, fallbackIdentityFilePaths, passphrase } = args;
  const identityFilePaths = key?.source === "reference" && key.filePath
    ? [key.filePath]
    : fallbackIdentityFilePaths;

  return {
    privateKey: key?.source === "reference" ? undefined : sanitizeCredentialValue(key?.privateKey),
    identityFilePaths,
    passphrase: sanitizeCredentialValue(passphrase ?? key?.passphrase),
  };
};

export const resolveBridgeSshAgentAuth = (
  host: Pick<Host, "authMethod" | "useSshAgent" | "identityAgent" | "identityFilePaths" | "identitiesOnly" | "addKeysToAgent" | "useKeychain">,
  key?: Pick<SSHKey, "certificate" | "publicKey" | "source" | "filePath">,
  authMethod?: HostAuthMethod,
): {
  useSshAgent?: boolean;
  identityAgent?: string;
  identitiesOnly?: boolean;
  addKeysToAgent?: string;
  useKeychain?: boolean;
  agentPublicKeys?: string[];
} => {
  if (authMethod === "password" || authMethod === "certificate" || key?.certificate?.trim()) {
    return { useSshAgent: false };
  }
  if (authMethod === "key") {
    const hasAgentSelector = Boolean(
      key?.publicKey?.trim()
      || (key?.source === "reference" && key.filePath?.trim())
      || host.identityFilePaths?.some((filePath) => filePath.trim()),
    );
    if (host.useSshAgent !== true || !hasAgentSelector) {
      return { useSshAgent: false };
    }
    return {
      useSshAgent: true,
      identityAgent: host.identityAgent,
      identitiesOnly: true,
      addKeysToAgent: host.addKeysToAgent,
      useKeychain: host.useKeychain,
      ...(key?.publicKey?.trim() ? { agentPublicKeys: [key.publicKey] } : {}),
    };
  }
  if (host.useSshAgent !== true) {
    return authMethod === "auto" && host.useSshAgent !== false
      ? {}
      : { useSshAgent: false };
  }
  return {
    useSshAgent: true,
    identityAgent: host.identityAgent,
    identitiesOnly: host.identitiesOnly,
    addKeysToAgent: host.addKeysToAgent,
    useKeychain: host.useKeychain,
    ...(key?.publicKey?.trim() ? { agentPublicKeys: [key.publicKey] } : {}),
  };
};

export const hasRequiredHostAuthCredential = (args: {
  host: Host;
  keys: SSHKey[];
  identities?: Identity[];
}): boolean => {
  if (args.host.protocol && args.host.protocol !== "ssh") return true;
  if (args.host.identityId && !args.identities?.some((identity) => identity.id === args.host.identityId)) {
    return false;
  }
  const resolved = resolveHostAuth(args);
  if (resolved.authMethod === "key") {
    return Boolean(resolved.key || args.host.identityFilePaths?.some((value) => value.trim()));
  }
  if (resolved.authMethod === "certificate") {
    return Boolean(resolved.key?.certificate?.trim());
  }
  return true;
};

export const hasMacKeychainAgentDirectives = (
  host: Pick<Host, "addKeysToAgent" | "useKeychain">,
): boolean => host.useKeychain === true
  && host.addKeysToAgent?.toLowerCase() === "yes";

export const hasBridgeSshCredentials = (auth: {
  authMethod?: HostAuthMethod;
  password?: string;
  privateKey?: string;
  identityFilePaths?: string[];
  useSshAgent?: boolean;
}): boolean => Boolean(
  auth.authMethod === "auto" ||
  auth.password ||
  auth.privateKey ||
  auth.identityFilePaths?.length ||
  auth.useSshAgent,
);
