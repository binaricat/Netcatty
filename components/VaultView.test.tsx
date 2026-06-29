import test from "node:test";
import assert from "node:assert/strict";

import type { Host, Identity } from "../types.ts";
import { resolveHostCopyCredentialValues } from "./VaultView.tsx";

const identity: Identity = {
  id: "identity-1",
  label: "Telnet Login",
  username: "telnet-user",
  authMethod: "password",
  password: "telnet-secret",
  created: 1,
};

const host: Host = {
  id: "host-1",
  label: "Router",
  hostname: "router.example.com",
  username: "",
  tags: [],
  os: "linux",
  protocol: "telnet",
  telnetEnabled: true,
  identityId: identity.id,
};

test("resolveHostCopyCredentialValues uses keychain identity credentials for telnet hosts", () => {
  assert.deepEqual(resolveHostCopyCredentialValues(host, [identity]), {
    username: "telnet-user",
    rawPassword: "telnet-secret",
  });
});

test("resolveHostCopyCredentialValues preserves explicitly cleared telnet credentials", () => {
  assert.deepEqual(
    resolveHostCopyCredentialValues({
      ...host,
      telnetUsername: "",
      telnetPassword: "",
    }, [identity]),
    {
      username: "",
      rawPassword: "",
    },
  );
});
