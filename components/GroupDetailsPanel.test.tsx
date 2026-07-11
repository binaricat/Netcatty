import test from "node:test";
import assert from "node:assert/strict";

import {
  hasGroupSshFields,
  hasGroupTelnetFields,
  includeMissingIdentityOption,
  resolveGroupFormIdentityId,
  selectGroupSshIdentity,
  selectGroupTelnetIdentity,
} from "./GroupDetailsPanel.tsx";

test("GroupDetailsPanel treats an empty SSH identity as an explicit setting", () => {
  assert.equal(hasGroupSshFields({ identityId: "" }), true);
  assert.equal(hasGroupSshFields({}), false);
});

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

test("GroupDetailsPanel explicitly clears inherited identities for manual credentials", () => {
  const ssh = selectGroupSshIdentity({}, undefined, "", "parent-ssh-identity");
  const telnet = selectGroupTelnetIdentity({}, "", "parent-telnet-identity");

  assert.equal(ssh.identityId, "");
  assert.equal(telnet.telnetIdentityId, "");
});

test("GroupDetailsPanel clears key authentication before switching to a manual password", () => {
  const selected = selectGroupSshIdentity(
    {},
    {
      id: "key-identity",
      label: "Key identity",
      username: "admin",
      authMethod: "key",
      keyId: "key-1",
      created: 1,
    },
  );
  const cleared = selectGroupSshIdentity(selected, undefined);
  const manual = { ...cleared, username: "operator", password: "secret" };

  assert.equal(manual.identityId, undefined);
  assert.equal(manual.authMethod, undefined);
  assert.equal(manual.username, "operator");
  assert.equal(manual.password, "secret");
});

test("GroupDetailsPanel keeps a deleted identity visible so it can be cleared", () => {
  const options = includeMissingIdentityOption([], "deleted-identity", "Identity not found");

  assert.deepEqual(options, [{ value: "deleted-identity", label: "Identity not found" }]);
});

test("GroupDetailsPanel shows saved child manual credentials instead of a parent identity", () => {
  assert.equal(
    resolveGroupFormIdentityId(
      { username: "child-user", password: "child-password" },
      "parent-ssh-identity",
      "ssh",
    ),
    undefined,
  );
  assert.equal(
    resolveGroupFormIdentityId(
      { telnetUsername: "child-user", telnetPassword: "child-password" },
      "parent-telnet-identity",
      "telnet",
    ),
    undefined,
  );
});
