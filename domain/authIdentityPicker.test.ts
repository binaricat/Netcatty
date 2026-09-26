import test from "node:test";
import assert from "node:assert/strict";

import { listPasswordAuthIdentities, resolvePasswordAuthSftpHost } from "./authIdentityPicker.ts";
import type { Identity } from "./models.ts";
import type { Host } from "./models.ts";

const passwordIdentity = (overrides: Partial<Identity> = {}): Identity => ({
  id: "id-1",
  label: "Default password",
  username: "root",
  authMethod: "password",
  password: "secret",
  created: 0,
  ...overrides,
});

test("keeps only password identities with a usable stored password", () => {
  const identities: Identity[] = [
    passwordIdentity(),
    passwordIdentity({ id: "id-2", label: "Password B", username: "deploy" }),
    passwordIdentity({ id: "id-3", authMethod: "key", keyId: "key-1" }),
    passwordIdentity({ id: "id-4", password: undefined }),
    passwordIdentity({ id: "id-5", password: "" }),
    passwordIdentity({ id: "id-6", password: "enc:v1:djEwdGVzdAAAAAAAAAAAAAAAAA==" }),
    passwordIdentity({ id: "id-7", username: "" }),
    passwordIdentity({ id: "id-8", username: "   " }),
  ];

  const result = listPasswordAuthIdentities(identities);

  assert.deepEqual(
    result.map((identity) => identity.id),
    ["id-1", "id-2"],
  );
});

test("tolerates missing identity lists", () => {
  assert.deepEqual(listPasswordAuthIdentities(undefined), []);
  assert.deepEqual(listPasswordAuthIdentities([]), []);
});

test("temporary deploy identity carries into SFTP without changing the saved host", () => {
  const host = { id: "host-1", hostname: "example.test", username: "root", identityId: "root-id" } as Host;
  const identities = [
    passwordIdentity({ id: "root-id", password: "bad-root" }),
    passwordIdentity({ id: "deploy-id", username: "deploy", password: "good-deploy" }),
  ];
  const auth = { authMethod: "password", username: "deploy", password: "good-deploy", savedToHost: false };
  assert.deepEqual(resolvePasswordAuthSftpHost(host, identities, auth), {
    ...host, username: "deploy", identityId: "deploy-id",
  });
  assert.equal(host.username, "root");
  assert.equal(host.identityId, "root-id");
  assert.equal(resolvePasswordAuthSftpHost(host, identities, { ...auth, password: "manual" }), host);
  assert.equal(resolvePasswordAuthSftpHost(host, identities, { ...auth, savedToHost: true }), host);
  assert.equal(resolvePasswordAuthSftpHost(host, identities, null), host);
});
