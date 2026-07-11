import test from "node:test";
import assert from "node:assert/strict";

import {
  hasGroupTelnetFields,
  selectGroupSshIdentity,
  selectGroupTelnetIdentity,
} from "./GroupDetailsPanel.tsx";

test("GroupDetailsPanel treats cleared telnet credentials as explicit settings", () => {
  assert.equal(hasGroupTelnetFields({ telnetUsername: "" }), true);
  assert.equal(hasGroupTelnetFields({ telnetPassword: "" }), true);
  assert.equal(hasGroupTelnetFields({ telnetIdentityId: "identity-1" }), true);
  assert.equal(hasGroupTelnetFields({}), false);
});

test("GroupDetailsPanel replaces manual SSH credentials with a reusable identity", () => {
  const result = selectGroupSshIdentity(
    {
      username: "manual",
      password: "secret",
      identityFileId: "key-1",
      identityFilePaths: ["~/.ssh/id_ed25519"],
    },
    {
      id: "identity-1",
      label: "Shared admin",
      username: "admin",
      authMethod: "password",
      created: 1,
    },
  );

  assert.equal(result.identityId, "identity-1");
  assert.equal(result.username, "admin");
  assert.equal(result.password, undefined);
  assert.equal(result.identityFileId, undefined);
  assert.equal(result.identityFilePaths, undefined);
});

test("GroupDetailsPanel replaces manual Telnet credentials with a reusable identity", () => {
  const result = selectGroupTelnetIdentity(
    { telnetUsername: "manual", telnetPassword: "secret" },
    "identity-1",
  );

  assert.equal(result.telnetIdentityId, "identity-1");
  assert.equal(result.telnetUsername, undefined);
  assert.equal(result.telnetPassword, undefined);
});
