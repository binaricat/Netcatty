import assert from "node:assert/strict";
import test from "node:test";

import { applyGroupDefaults } from "../../domain/groupConfig";
import { resolveHostAuth } from "../../domain/sshAuth";
import type { Host, Identity } from "../../types";
import { buildSavedAuthHostUpdate } from "./hooks/useTerminalAuthState";

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
