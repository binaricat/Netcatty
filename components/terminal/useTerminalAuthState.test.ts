import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";

import { applyGroupDefaults } from "../../domain/groupConfig";
import { resolveHostAuth } from "../../domain/sshAuth";
import type { Host, Identity } from "../../types";
import {
  buildSavedAuthHostUpdate,
  isAuthPasswordProvided,
  useTerminalAuthState,
} from "./hooks/useTerminalAuthState";
import { createTerminalSessionStarters, type PendingAuth } from "./runtime/createTerminalSessionStarters";
import { createMockTerminalBackend, createStarterContext, createTermStub } from "./runtime/testSupport/starterHarness";

const baseHost: Host = {
  id: "host-1",
  label: "Test Host",
  hostname: "example.com",
  port: 22,
  username: "olduser",
  authMethod: "key",
  identityId: "identity-1",
  identityFileId: "key-1",
  tags: [],
  os: "linux",
};

test("isAuthPasswordProvided accepts whitespace-only passwords (#2036)", () => {
  assert.equal(isAuthPasswordProvided(""), false);
  assert.equal(isAuthPasswordProvided(" "), true);
  assert.equal(isAuthPasswordProvided("  "), true);
  assert.equal(isAuthPasswordProvided("secret"), true);
});

test("auth failure prefill reaches the auth hook and remains editable until explicit submit", async () => {
  const environment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
  const previous = environment.IS_REACT_ACT_ENVIRONMENT;
  environment.IS_REACT_ACT_ENVIRONMENT = true;
  const host: Host = {
    ...baseHost, authMethod: "password", identityId: "", identityFileId: undefined,
    password: "saved-secret", savePassword: true,
  };
  const pendingAuthRef = { current: null as PendingAuth };
  const term = createTermStub();
  let auth: ReturnType<typeof useTerminalAuthState>;
  let submissions = 0;
  let renderer: ReactTestRenderer | undefined;
  const Form = () => {
    auth = useTerminalAuthState({
      host, identities: [], pendingAuthRef, termRef: { current: term as never },
      onStartSession: () => { submissions += 1; },
      setStatus: () => {}, setProgressLogs: () => {},
    });
    return null;
  };

  try {
    await act(async () => { renderer = create(createElement(Form)); });
    await act(async () => {
      await createTerminalSessionStarters(createStarterContext({
        host, pendingAuthRef,
        terminalBackend: createMockTerminalBackend({
          startSSHSession: async () => { throw new Error("Authentication failed"); },
        }),
        setNeedsAuth: auth!.setNeedsAuth,
        setAuthRetryMessage: auth!.setAuthRetryMessage,
        setAuthPassword: auth!.setAuthPassword,
      }) as never).startSSH(term as never);
    });
    assert.equal(auth!.needsAuth, true);
    assert.equal(auth!.authUsername, host.username);
    assert.equal(auth!.authMethod, "password");
    assert.equal(auth!.authPassword, "saved-secret");
    assert.equal(auth!.selectedIdentityId, null);
    assert.equal(auth!.showAuthPassword, false);
    assert.equal(auth!.isValid, true);
    assert.equal(submissions, 0);
    assert.equal(pendingAuthRef.current, null);

    await act(async () => { auth!.setAuthPassword(""); });
    assert.equal(auth!.authPassword, "");
    assert.equal(auth!.isValid, false);
    await act(async () => { auth!.submit({ saveToHost: false }); });
    assert.equal(submissions, 0);

    await act(async () => { auth!.setAuthPassword("corrected-secret"); });
    assert.equal(auth!.isValid, true);
    assert.equal(submissions, 0);
    await act(async () => { auth!.submit({ saveToHost: false }); });
    assert.equal(submissions, 1);
    assert.equal(pendingAuthRef.current?.password, "corrected-secret");
    assert.equal(host.password, "saved-secret");
  } finally {
    if (renderer) await act(async () => { renderer?.unmount(); });
    if (previous === undefined) delete environment.IS_REACT_ACT_ENVIRONMENT;
    else environment.IS_REACT_ACT_ENVIRONMENT = previous;
  }
});

test("password save clears identityId and identityFileId", () => {
  const updated = buildSavedAuthHostUpdate(baseHost, {
    authMethod: "password",
    username: "root",
    password: "secret",
    keyId: null,
  });

  assert.equal(updated.identityId, "");
  assert.equal(updated.identityFileId, undefined);
  assert.equal(updated.password, "secret");
  assert.equal(updated.savePassword, true);
  assert.equal(updated.authMethod, "password");
  assert.equal(updated.username, "root");
});

test("password save preserves a single-space password (#2036)", () => {
  const updated = buildSavedAuthHostUpdate(baseHost, {
    authMethod: "password",
    username: "root",
    password: " ",
    keyId: null,
  });

  assert.equal(updated.password, " ");
  assert.equal(updated.savePassword, true);
});

test("key save clears identityId and sets identityFileId", () => {
  const updated = buildSavedAuthHostUpdate(baseHost, {
    authMethod: "key",
    username: "deploy",
    password: "",
    keyId: "key-2",
  });

  assert.equal(updated.identityId, "");
  assert.equal(updated.identityFileId, "key-2");
  assert.equal(updated.password, undefined);
});

test("resolveHostAuth uses saved host credentials after identityId is cleared", () => {
  const identity: Identity = {
    id: "identity-1",
    label: "old",
    username: "olduser",
    authMethod: "password",
    password: "wrong",
    created: 0,
  };

  const updated = buildSavedAuthHostUpdate(
    { ...baseHost, identityId: "identity-1" },
    {
      authMethod: "password",
      username: "root",
      password: "correct",
      keyId: null,
    },
  );

  const resolved = resolveHostAuth({
    host: updated,
    keys: [],
    identities: [identity],
  });

  assert.equal(resolved.username, "root");
  assert.equal(resolved.password, "correct");
});

test("saved credentials override a group-inherited identity", () => {
  const identity: Identity = {
    id: "identity-1",
    label: "old",
    username: "olduser",
    authMethod: "password",
    password: "wrong",
    created: 0,
  };

  const updated = buildSavedAuthHostUpdate(
    { ...baseHost, identityId: undefined },
    {
      authMethod: "password",
      username: "root",
      password: "correct",
      keyId: null,
    },
  );

  const effective = applyGroupDefaults(updated, { identityId: "identity-1" });

  assert.equal(effective.identityId, "");

  const resolved = resolveHostAuth({
    host: effective,
    keys: [],
    identities: [identity],
  });

  assert.equal(resolved.username, "root");
  assert.equal(resolved.password, "correct");
});
