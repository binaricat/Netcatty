import test from "node:test";
import assert from "node:assert/strict";

import { applyHostAuthMethodSelection, hasBridgeSshCredentials, hasRequiredHostAuthCredential, resolveBridgeKeyAuth, resolveBridgeSshAgentAuth, resolveHostAuth, resolveHostAuthMethodForPersistence, resolveHostAuthMethodSelection, resolveHostAutofillPassword, resolveSshAgentToggleUpdate } from "./sshAuth.ts";
import { applyGroupDefaults, sanitizeGroupConfig } from "./groupConfig.ts";
import { sanitizeHost } from "./host.ts";
import type { Host, Identity, SSHKey } from "./models.ts";

const referenceKey: SSHKey = {
  id: "key-1",
  label: "Reference key",
  type: "ED25519",
  privateKey: "",
  source: "reference",
  category: "key",
  created: 1,
  filePath: "/Users/alice/.ssh/id_ed25519",
};

test("resolveBridgeKeyAuth passes reference keys as identity file paths", () => {
  assert.deepEqual(
    resolveBridgeKeyAuth({
      key: referenceKey,
      fallbackIdentityFilePaths: ["/legacy/key"],
      passphrase: "saved-passphrase",
    }),
    {
      privateKey: undefined,
      identityFilePaths: ["/Users/alice/.ssh/id_ed25519"],
      passphrase: "saved-passphrase",
    },
  );
});

test("resolveBridgeKeyAuth ignores undecryptable passphrase placeholders", () => {
  assert.equal(
    resolveBridgeKeyAuth({
      key: {
        ...referenceKey,
        passphrase: "enc:v1:djEwdGVzdAAAAAAAAAAAAAAAAA==",
      },
    }).passphrase,
    undefined,
  );
});

test("resolveBridgeKeyAuth ignores undecryptable private key placeholders", () => {
  assert.equal(
    resolveBridgeKeyAuth({
      key: {
        ...referenceKey,
        source: "imported",
        filePath: undefined,
        privateKey: "enc:v1:djEwdGVzdAAAAAAAAAAAAAAAAA==",
      },
    }).privateKey,
    undefined,
  );
});

test("resolveBridgeKeyAuth preserves imported key material", () => {
  const importedKey: SSHKey = {
    ...referenceKey,
    source: "imported",
    privateKey: "PRIVATE KEY",
    filePath: undefined,
  };

  assert.deepEqual(
    resolveBridgeKeyAuth({
      key: importedKey,
      fallbackIdentityFilePaths: ["/legacy/key"],
    }),
    {
      privateKey: "PRIVATE KEY",
      identityFilePaths: ["/legacy/key"],
      passphrase: undefined,
    },
  );
});

test("resolveBridgeSshAgentAuth carries system agent settings without private material", () => {
  assert.deepEqual(
    resolveBridgeSshAgentAuth({
      ...autofillBaseHost,
      useSshAgent: true,
      identityAgent: "$SSH_AUTH_SOCK",
      identitiesOnly: true,
      addKeysToAgent: "yes",
      useKeychain: true,
    }),
    {
      useSshAgent: true,
      identityAgent: "$SSH_AUTH_SOCK",
      identitiesOnly: true,
      addKeysToAgent: "yes",
      useKeychain: true,
    },
  );
});

test("resolveBridgeSshAgentAuth forces agent auth for FIDO2 SK vault keys", () => {
  const skKey: SSHKey = {
    id: "sk-1",
    label: "YubiKey",
    type: "ED25519-SK",
    privateKey: "-----BEGIN OPENSSH PRIVATE KEY-----\nsk-ssh-ed25519@openssh.com\n-----END OPENSSH PRIVATE KEY-----",
    publicKey: "sk-ssh-ed25519@openssh.com AAAAGnNrLXNzaC1lZDI1NTE5QG9wZW5zc2guY29tAAAAIAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAIAAAABHNzaDo= yubi",
    source: "imported",
    category: "key",
    created: 1,
  };

  assert.deepEqual(
    resolveBridgeSshAgentAuth({ ...autofillBaseHost, useSshAgent: false }, skKey, "key"),
    {
      useSshAgent: true,
      identityAgent: undefined,
      identitiesOnly: true,
      addKeysToAgent: "yes",
      useKeychain: undefined,
      agentPublicKeys: [skKey.publicKey!],
    },
  );

  assert.equal(
    resolveBridgeKeyAuth({ key: skKey }).privateKey?.includes("OPENSSH PRIVATE KEY"),
    true,
  );
});

test("resolveBridgeSshAgentAuth keeps certificate authentication independent", () => {
  assert.deepEqual(
    resolveBridgeSshAgentAuth({
      ...autofillBaseHost,
      useSshAgent: true,
    }, { certificate: "ssh-ed25519-cert-v01@openssh.com AAAATEST" }),
    { useSshAgent: false },
  );
});

test("resolveBridgeSshAgentAuth keeps agent path for FIDO SK certificates", () => {
  const skCertKey: SSHKey = {
    id: "sk-cert-1",
    label: "YubiKey cert",
    type: "ED25519-SK",
    privateKey: "-----BEGIN OPENSSH PRIVATE KEY-----\nsk-ssh-ed25519@openssh.com\n-----END OPENSSH PRIVATE KEY-----",
    publicKey: "sk-ssh-ed25519-cert-v01@openssh.com AAAAGnNrLXNzaC1lZDI1NTE5LWNlcnQtdjAxQG9wZW5zc2guY29tAAAA yubi",
    certificate: "sk-ssh-ed25519-cert-v01@openssh.com AAAAGnNrLXNzaC1lZDI1NTE5LWNlcnQtdjAxQG9wZW5zc2guY29tAAAA yubi",
    source: "imported",
    category: "certificate",
    created: 1,
  };

  assert.deepEqual(
    resolveBridgeSshAgentAuth({ ...autofillBaseHost, useSshAgent: false }, skCertKey, "certificate"),
    {
      useSshAgent: true,
      identityAgent: undefined,
      identitiesOnly: true,
      addKeysToAgent: "yes",
      useKeychain: undefined,
      agentPublicKeys: [skCertKey.publicKey!],
    },
  );
});

test("resolveBridgeSshAgentAuth selects staged SK certificate under IdentitiesOnly", () => {
  const barePub =
    "sk-ssh-ed25519@openssh.com AAAAGnNrLXNzaC1lZDI1NTE5QG9wZW5zc2guY29tAAAAIAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAIAAAABHNzaDo= yubi";
  const cert =
    "sk-ssh-ed25519-cert-v01@openssh.com AAAAGnNrLXNzaC1lZDI1NTE5LWNlcnQtdjAxQG9wZW5zc2guY29tAAAA yubi";
  const skCertKey: SSHKey = {
    id: "sk-cert-bare-1",
    label: "YubiKey cert staged",
    type: "ED25519-SK",
    privateKey: "-----BEGIN OPENSSH PRIVATE KEY-----\nsk-ssh-ed25519@openssh.com\n-----END OPENSSH PRIVATE KEY-----",
    publicKey: barePub,
    certificate: cert,
    source: "imported",
    category: "certificate",
    created: 1,
  };

  assert.deepEqual(
    resolveBridgeSshAgentAuth({ ...autofillBaseHost, useSshAgent: false }, skCertKey, "certificate"),
    {
      useSshAgent: true,
      identityAgent: undefined,
      identitiesOnly: true,
      addKeysToAgent: "yes",
      useKeychain: undefined,
      agentPublicKeys: [barePub, cert],
    },
  );
});

test("resolveBridgeSshAgentAuth forces agent for path-only SK vault type", () => {
  const skRef: SSHKey = {
    id: "sk-ref-1",
    label: "YubiKey file",
    type: "ED25519-SK",
    source: "reference",
    filePath: "/home/user/.ssh/id_ed25519_sk",
    category: "key",
    created: 1,
  };

  assert.deepEqual(
    resolveBridgeSshAgentAuth({ ...autofillBaseHost, useSshAgent: false }, skRef, "key"),
    {
      useSshAgent: true,
      identityAgent: undefined,
      identitiesOnly: true,
      addKeysToAgent: "yes",
      useKeychain: undefined,
    },
  );
});

test("resolveBridgeSshAgentAuth forwards a selected vault public key", () => {
  assert.deepEqual(
    resolveBridgeSshAgentAuth({
      ...autofillBaseHost,
      useSshAgent: true,
      identitiesOnly: true,
    }, { publicKey: "ssh-ed25519 AAAATEST" }),
    {
      useSshAgent: true,
      identityAgent: undefined,
      identitiesOnly: true,
      addKeysToAgent: undefined,
      useKeychain: undefined,
      agentPublicKeys: ["ssh-ed25519 AAAATEST"],
    },
  );
});

test("resolveBridgeSshAgentAuth keeps agent login for a selected reference key", () => {
  assert.deepEqual(
    resolveBridgeSshAgentAuth({
      ...autofillBaseHost,
      useSshAgent: true,
      identitiesOnly: false,
    }, referenceKey, "key"),
    {
      useSshAgent: true,
      identityAgent: undefined,
      identitiesOnly: true,
      addKeysToAgent: undefined,
      useKeychain: undefined,
    },
  );
});

test("resolveBridgeSshAgentAuth keeps agent login for a selected local key file", () => {
  assert.deepEqual(
    resolveBridgeSshAgentAuth({
      ...autofillBaseHost,
      authMethod: "key",
      useSshAgent: true,
      identitiesOnly: false,
      identityFilePaths: ["~/.ssh/id_work"],
    }, undefined, "key"),
    {
      useSshAgent: true,
      identityAgent: undefined,
      identitiesOnly: true,
      addKeysToAgent: undefined,
      useKeychain: undefined,
    },
  );
});

test("resolveBridgeSshAgentAuth preserves an explicit agent opt-out", () => {
  assert.deepEqual(
    resolveBridgeSshAgentAuth({
      ...autofillBaseHost,
      useSshAgent: false,
      identityAgent: "none",
    }),
    { useSshAgent: false },
  );
});

test("resolveBridgeSshAgentAuth treats an unset agent toggle as disabled", () => {
  assert.deepEqual(
    resolveBridgeSshAgentAuth(autofillBaseHost),
    { useSshAgent: false },
  );
});

test("resolveBridgeSshAgentAuth leaves the ambient agent available in automatic mode", () => {
  assert.deepEqual(
    resolveBridgeSshAgentAuth(autofillBaseHost, undefined, "auto"),
    {},
  );
  assert.deepEqual(
    resolveBridgeSshAgentAuth({ ...autofillBaseHost, useSshAgent: false }, undefined, "auto"),
    { useSshAgent: false },
  );
});

test("resolveBridgeSshAgentAuth keeps an explicit forwarding agent separate from login", () => {
  assert.deepEqual(
    resolveBridgeSshAgentAuth({
      ...autofillBaseHost,
      authMethod: "password",
      useSshAgent: false,
      agentForwarding: true,
      identityAgent: "/tmp/forwarding-agent.sock",
    }, undefined, "password"),
    {
      useSshAgent: false,
      identityAgent: "/tmp/forwarding-agent.sock",
    },
  );
});

test("resolveBridgeSshAgentAuth does not forward the login-only IdentityAgent none directive", () => {
  assert.deepEqual(
    resolveBridgeSshAgentAuth({
      ...autofillBaseHost,
      authMethod: "password",
      useSshAgent: false,
      agentForwarding: true,
      identityAgent: "none",
    }, undefined, "password"),
    { useSshAgent: false },
  );
});

test("resolveBridgeSshAgentAuth lets explicit auth override a stale agent toggle", () => {
  const staleAgentHost = { ...autofillBaseHost, useSshAgent: true };
  assert.deepEqual(
    resolveBridgeSshAgentAuth(staleAgentHost, undefined, "password"),
    { useSshAgent: false },
  );
  assert.deepEqual(
    resolveBridgeSshAgentAuth(staleAgentHost, undefined, "certificate"),
    { useSshAgent: false },
  );
  assert.deepEqual(
    resolveBridgeSshAgentAuth({ ...staleAgentHost, authMethod: "key" }, undefined, "key"),
    { useSshAgent: false },
  );
});

test("resolveBridgeSshAgentAuth restricts explicit agent-backed key auth to the selected key", () => {
  assert.deepEqual(
    resolveBridgeSshAgentAuth(
      { ...autofillBaseHost, useSshAgent: true, identitiesOnly: false },
      { publicKey: "ssh-ed25519 AAAASELECTED" },
      "key",
    ),
    {
      useSshAgent: true,
      identityAgent: undefined,
      identitiesOnly: true,
      addKeysToAgent: undefined,
      useKeychain: undefined,
      agentPublicKeys: ["ssh-ed25519 AAAASELECTED"],
    },
  );
});

test("hasRequiredHostAuthCredential rejects empty explicit key and certificate selections", () => {
  assert.equal(hasRequiredHostAuthCredential({
    host: { ...autofillBaseHost, authMethod: "key" },
    keys: [],
  }), false);
  assert.equal(hasRequiredHostAuthCredential({
    host: { ...autofillBaseHost, authMethod: "certificate" },
    keys: [],
  }), false);
  assert.equal(hasRequiredHostAuthCredential({
    host: { ...autofillBaseHost, authMethod: "key", identityFilePaths: ["~/.ssh/id_work"] },
    keys: [],
  }), true);
  assert.equal(hasRequiredHostAuthCredential({
    host: { ...autofillBaseHost, protocol: "telnet", authMethod: "key" },
    keys: [],
  }), true);
  assert.equal(hasRequiredHostAuthCredential({
    host: applyGroupDefaults({ ...autofillBaseHost, username: "" }, { identityId: "deleted-identity" }),
    keys: [],
    identities: [],
  }), false);
});

test("hasBridgeSshCredentials accepts an agent-only host", () => {
  assert.equal(hasBridgeSshCredentials({ useSshAgent: true }), true);
  assert.equal(hasBridgeSshCredentials({}), false);
});

test("hasBridgeSshCredentials accepts automatic local authentication", () => {
  assert.equal(hasBridgeSshCredentials({ authMethod: "auto" }), true);
});

test("resolveHostAuth respects password auth over stale key selections", () => {
  const host: Host = {
    id: "host-1",
    label: "Host",
    hostname: "example.com",
    username: "root",
    authMethod: "password",
    identityFileId: "key-1",
  };

  const resolved = resolveHostAuth({
    host,
    keys: [referenceKey],
    identities: [],
  });

  assert.equal(resolved.authMethod, "password");
  assert.equal(resolved.key, undefined);
  assert.equal(resolved.keyId, undefined);
});

test("resolveHostAuth infers key auth from imported IdentityFile paths", () => {
  const resolved = resolveHostAuth({
    host: {
      ...autofillBaseHost,
      identityFilePaths: ["~/.ssh/id_work"],
    },
    keys: [],
  });

  assert.equal(resolved.authMethod, "key");
});

test("resolveHostAuth treats a legacy host without credentials as automatic", () => {
  const resolved = resolveHostAuth({
    host: autofillBaseHost,
    keys: [],
  });

  assert.equal(resolved.authMethod, "auto");
});

test("resolveHostAuth keeps a legacy saved password in password-only mode", () => {
  const resolved = resolveHostAuth({
    host: { ...autofillBaseHost, password: "saved-secret" },
    keys: [],
  });

  assert.equal(resolved.authMethod, "password");
});

test("a new automatic host keeps its saved password as a fallback", () => {
  const host = {
    ...autofillBaseHost,
    authPolicyVersion: 1 as const,
    authMethod: undefined,
    password: "fallback-secret",
  } as Host;

  assert.equal(resolveHostAuthMethodSelection(host), "auto");
  assert.equal(resolveHostAuth({ host, keys: [] }).authMethod, "auto");
});

test("a migrated host keeps an inherited legacy group password password-only", () => {
  const host = sanitizeHost({
    ...autofillBaseHost,
    authMethod: "password",
    authPolicyVersion: undefined,
    password: undefined,
    group: "team",
  });
  const groupDefaults = sanitizeGroupConfig({
    path: "team",
    password: "group-secret",
  });

  assert.equal(host.authMethod, undefined);
  assert.equal(groupDefaults.authMethod, "password");
  assert.equal(resolveHostAuth({
    host: applyGroupDefaults(host, groupDefaults),
    keys: [],
  }).authMethod, "password");
});

test("migrated hosts keep inferred vault key and certificate authentication", () => {
  const certificateKey = {
    ...referenceKey,
    id: "certificate-1",
    certificate: "ssh-ed25519-cert-v01@openssh.com AAAA",
    category: "certificate" as const,
  };

  for (const [key, expectedMethod] of [
    [referenceKey, "key"],
    [certificateKey, "certificate"],
  ] as const) {
    const host = sanitizeHost({
      ...autofillBaseHost,
      authMethod: undefined,
      authPolicyVersion: undefined,
      identityFileId: key.id,
    });

    assert.equal(host.authMethod, undefined);
    assert.equal(host.authPolicyVersion, 1);
    assert.equal(resolveHostAuth({ host, keys: [key] }).authMethod, expectedMethod);
  }
});

test("resolveHostAuthMethodSelection gives legacy hosts a visible mode", () => {
  assert.equal(resolveHostAuthMethodSelection(autofillBaseHost), "auto");
  assert.equal(resolveHostAuthMethodSelection({ ...autofillBaseHost, password: "secret" }), "password");
  assert.equal(resolveHostAuthMethodSelection({ ...autofillBaseHost, identityFilePaths: ["~/.ssh/id_work"] }), "key");
  assert.equal(resolveHostAuthMethodSelection({ ...autofillBaseHost, identityFilePaths: ["~/.ssh/id_work"], useSshAgent: true }), "auto");
});

test("resolveHostAuth preserves legacy agent plus identity-file hosts as automatic", () => {
  const resolved = resolveHostAuth({
    host: {
      ...autofillBaseHost,
      identityFilePaths: ["~/.ssh/id_work"],
      useSshAgent: true,
    },
    keys: [],
  });
  assert.equal(resolved.authMethod, "auto");
});

test("applyHostAuthMethodSelection clears incompatible per-host credentials", () => {
  const keyedHost = {
    ...autofillBaseHost,
    authMethod: "key",
    identityId: "identity-1",
    identityFileId: "key-1",
    identityFilePaths: ["~/.ssh/id_work"],
    useSshAgent: true,
  } as Host;

  assert.deepEqual(applyHostAuthMethodSelection(keyedHost, "certificate"), {
    ...keyedHost,
    authMethod: "certificate",
    authPolicyVersion: 1,
    identityId: "",
    identityFileId: undefined,
    identityFilePaths: undefined,
    useSshAgent: false,
  });
  assert.deepEqual(applyHostAuthMethodSelection(keyedHost, "auto"), {
    ...keyedHost,
    authMethod: "auto",
    authPolicyVersion: 1,
    identityId: "",
    identityFileId: undefined,
    identityFilePaths: undefined,
    identityAgent: undefined,
    identitiesOnly: undefined,
    useSshAgent: undefined,
  });
  assert.deepEqual(applyHostAuthMethodSelection(keyedHost, "key"), {
    ...keyedHost,
    authPolicyVersion: 1,
  });

  const passwordIdentityHost = {
    ...autofillBaseHost,
    authMethod: "password",
    identityId: "identity-password",
    useSshAgent: false,
  } as Host;
  assert.deepEqual(applyHostAuthMethodSelection(passwordIdentityHost, "password"), {
    ...passwordIdentityHost,
    authPolicyVersion: 1,
  });

  const passwordHost = {
    ...autofillBaseHost,
    authMethod: "password",
    useSshAgent: false,
  } as Host;
  const automaticHost = applyHostAuthMethodSelection(passwordHost, "auto");
  assert.equal(automaticHost.useSshAgent, undefined);
  assert.deepEqual(resolveBridgeSshAgentAuth(automaticHost, undefined, "auto"), {});
});

test("resolveSshAgentToggleUpdate keeps the default automatic agent optional", () => {
  assert.deepEqual(resolveSshAgentToggleUpdate({}, "auto", true), {
    useSshAgent: undefined,
    identityAgent: undefined,
  });
  assert.deepEqual(resolveSshAgentToggleUpdate({}, "auto", false), {
    useSshAgent: false,
    identityAgent: undefined,
  });
  assert.deepEqual(resolveSshAgentToggleUpdate({ identityAgent: "none" }, "auto", true), {
    useSshAgent: undefined,
    identityAgent: undefined,
  });
  assert.deepEqual(resolveSshAgentToggleUpdate({ identityAgent: "/tmp/custom-agent.sock" }, "auto", true), {
    useSshAgent: true,
    identityAgent: "/tmp/custom-agent.sock",
  });
  assert.deepEqual(resolveSshAgentToggleUpdate({}, "key", true), {
    useSshAgent: true,
    identityAgent: undefined,
  });
});

test("per-host auth selection opts out of an inherited group identity", () => {
  const selected = applyHostAuthMethodSelection({
    ...autofillBaseHost,
    group: "Production",
    identityId: "group-identity",
  } as Host, "password");
  const effective = applyGroupDefaults(selected, { identityId: "group-identity" });
  const resolved = resolveHostAuth({
    host: effective,
    keys: [referenceKey],
    identities: [{
      id: "group-identity",
      label: "Group key",
      username: "deploy",
      authMethod: "key",
      keyId: referenceKey.id,
      created: 1,
    }],
  });

  assert.equal(effective.identityId, "");
  assert.equal(resolved.authMethod, "password");
  assert.equal(resolved.key, undefined);
});

test("saving keeps inherited group authentication inherited", () => {
  const identity = {
    id: "group-identity",
    label: "Group identity",
    username: "deploy",
    authMethod: "certificate" as const,
    keyId: referenceKey.id,
    created: 1,
  };
  const cases = [
    [{ authMethod: "password" as const, password: "secret" }, "password"],
    [{ authMethod: "key" as const, identityFileId: referenceKey.id }, "key"],
    [{ authMethod: "certificate" as const, identityFileId: referenceKey.id }, "certificate"],
    [{ identityId: identity.id }, "certificate"],
  ] as const;

  for (const [groupDefaults, expectedMethod] of cases) {
    const host = { ...autofillBaseHost, username: "", authMethod: undefined } as Host;
    assert.equal(resolveHostAuthMethodForPersistence({
      host,
      keys: [referenceKey],
      identities: [identity],
      groupDefaults,
    }), undefined);
    assert.equal(resolveHostAuth({
      host: applyGroupDefaults(host, groupDefaults),
      keys: [referenceKey],
      identities: [identity],
    }).authMethod, expectedMethod);
  }
});

test("saving a legacy password host keeps password-only after discarding the secret", () => {
  const host = {
    ...autofillBaseHost,
    authMethod: undefined,
    password: "temporary-secret",
    savePassword: false,
  } as Host;

  assert.equal(resolveHostAuthMethodForPersistence({ host, keys: [] }), "password");
});

test("an untouched host keeps following authentication added to its group later", () => {
  const host = { ...autofillBaseHost, username: "", authMethod: undefined } as Host;
  assert.equal(resolveHostAuthMethodForPersistence({ host, keys: [] }), undefined);

  const futureEffectiveHost = applyGroupDefaults(host, {
    authMethod: "password",
    password: "future-group-secret",
  });
  assert.equal(resolveHostAuth({ host: futureEffectiveHost, keys: [] }).authMethod, "password");
});

test("legacy agent settings do not override inherited strict group authentication", () => {
  const groupDefaults = { authMethod: "password" as const, password: "group-secret" };
  for (const useSshAgent of [false, true]) {
    const host = {
      ...autofillBaseHost,
      username: "",
      authMethod: undefined,
      useSshAgent,
      identityAgent: "/tmp/legacy-agent.sock",
      identitiesOnly: true,
    } as Host;
    assert.equal(resolveHostAuthMethodForPersistence({ host, keys: [], groupDefaults }), undefined);
    assert.equal(resolveHostAuth({
      host: applyGroupDefaults(host, groupDefaults),
      keys: [],
    }).authMethod, "password");
  }
});

test("saving does not replace an effective group method with stale host credentials", () => {
  const cases = [
    [{ password: "stale-host-password", savePassword: false }, {
      authMethod: "key" as const,
      identityFileId: referenceKey.id,
    }, "key"],
    [{ identityFileId: referenceKey.id, identityFilePaths: ["~/.ssh/id_stale"] }, {
      authMethod: "password" as const,
      password: "group-password",
    }, "password"],
  ] as const;

  for (const [hostCredentials, groupDefaults, expectedMethod] of cases) {
    const host = {
      ...autofillBaseHost,
      username: "",
      authMethod: undefined,
      ...hostCredentials,
    } as Host;
    const methodBeforeSave = resolveHostAuth({
      host: applyGroupDefaults(host, groupDefaults),
      keys: [referenceKey],
    }).authMethod;
    const persistedMethod = resolveHostAuthMethodForPersistence({
      host,
      keys: [referenceKey],
      groupDefaults,
    });
    const methodAfterSave = resolveHostAuth({
      host: applyGroupDefaults({ ...host, authMethod: persistedMethod }, groupDefaults),
      keys: [referenceKey],
    }).authMethod;

    assert.equal(methodBeforeSave, expectedMethod);
    assert.equal(persistedMethod, undefined);
    assert.equal(methodAfterSave, expectedMethod);
  }
});

test("manual host credentials suppress an inherited group identity", () => {
  const groupDefaults = { identityId: "group-identity" };
  const passwordHost = applyGroupDefaults({
    ...autofillBaseHost,
    authMethod: "password",
    password: "host-secret",
  }, groupDefaults);
  const keyHost = applyGroupDefaults({
    ...autofillBaseHost,
    authMethod: "key",
    identityFileId: referenceKey.id,
  }, groupDefaults);

  assert.equal(passwordHost.identityId, undefined);
  assert.equal(keyHost.identityId, undefined);
  assert.equal(resolveHostAuth({ host: passwordHost, keys: [referenceKey] }).authMethod, "password");
  assert.equal(resolveHostAuth({ host: keyHost, keys: [referenceKey] }).authMethod, "key");
});

test("switching to automatic keeps visible custom agent settings active", () => {
  const selected = applyHostAuthMethodSelection({
    ...autofillBaseHost,
    authMethod: "password",
    useSshAgent: false,
    identityAgent: "/tmp/custom-agent.sock",
    identitiesOnly: true,
  } as Host, "auto");

  assert.equal(selected.useSshAgent, true);
  assert.equal(selected.identitiesOnly, undefined);
  assert.deepEqual(resolveBridgeSshAgentAuth(selected, undefined, "auto"), {
    useSshAgent: true,
    identityAgent: "/tmp/custom-agent.sock",
    identitiesOnly: undefined,
    addKeysToAgent: undefined,
    useKeychain: undefined,
  });
});

test("switching to automatic clears stale strict agent settings", () => {
  const selected = applyHostAuthMethodSelection({
    ...autofillBaseHost,
    authMethod: "key",
    identityFileId: referenceKey.id,
    useSshAgent: true,
    identityAgent: "none",
    identitiesOnly: true,
  } as Host, "auto");

  assert.equal(selected.useSshAgent, undefined);
  assert.equal(selected.identityAgent, undefined);
  assert.equal(selected.identitiesOnly, undefined);
});

test("negative SSH directives do not make automatic auth require an agent", () => {
  const host = {
    ...autofillBaseHost,
    authMethod: "key",
    identityFilePaths: ["~/.ssh/id_work"],
    useSshAgent: false,
    addKeysToAgent: "no",
    useKeychain: false,
  } as Host;

  const selected = applyHostAuthMethodSelection(host, "auto");
  assert.equal(selected.useSshAgent, undefined);
  assert.deepEqual(resolveSshAgentToggleUpdate(host, "auto", true), {
    useSshAgent: undefined,
    identityAgent: undefined,
  });
});

test("an explicit automatic host remains automatic when its group supplies a key", () => {
  const effective = applyGroupDefaults({
    ...autofillBaseHost,
    authMethod: "auto",
  }, {
    authMethod: "key",
    identityFileId: referenceKey.id,
  });

  assert.equal(resolveHostAuth({ host: effective, keys: [referenceKey] }).authMethod, "auto");
});

const autofillBaseHost = {
  id: "h1",
  label: "Host",
  hostname: "h.example.test",
  username: "alice",
} as Host;

test("resolveHostAutofillPassword uses the host's own saved password", () => {
  assert.equal(
    resolveHostAutofillPassword({ host: { ...autofillBaseHost, password: "direct-secret" }, keys: [] }),
    "direct-secret",
  );
});

test("resolveHostAutofillPassword resolves a referenced keychain identity's password", () => {
  // host stores no password of its own; the credential lives in a Keychain
  // identity it references (host.identityId) — the #1284 scenario.
  const identity = {
    id: "id-1",
    label: "alice@prod",
    username: "alice",
    authMethod: "password",
    password: "identity-secret",
    created: 1,
  } as Identity;
  assert.equal(
    resolveHostAutofillPassword({
      host: { ...autofillBaseHost, password: undefined, identityId: "id-1" },
      keys: [],
      identities: [identity],
    }),
    "identity-secret",
  );
});

test("resolveHostAutofillPassword returns undefined when the host opts out of saving", () => {
  assert.equal(
    resolveHostAutofillPassword({ host: { ...autofillBaseHost, password: "x", savePassword: false }, keys: [] }),
    undefined,
  );
});

test("resolveHostAutofillPassword returns undefined when no password is available", () => {
  assert.equal(
    resolveHostAutofillPassword({ host: { ...autofillBaseHost, password: undefined }, keys: [] }),
    undefined,
  );
});

test("resolveHostAutofillPassword ignores undecryptable password placeholders", () => {
  assert.equal(
    resolveHostAutofillPassword({ host: { ...autofillBaseHost, password: "enc:v1:djEwdGVzdAAAAAAAAAAAAAAAAA==" }, keys: [] }),
    undefined,
  );
});
