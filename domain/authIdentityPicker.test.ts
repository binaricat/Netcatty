import test from "node:test";
import assert from "node:assert/strict";

import { listPasswordAuthIdentities } from "./authIdentityPicker.ts";
import type { Identity } from "./models.ts";

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
